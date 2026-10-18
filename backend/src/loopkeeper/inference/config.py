"""Gateway configuration (env names per the V11 spec; the older MODEL_* names keep working as aliases)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlparse

DEFAULT_BASE_URL = "https://api.inference.crusoecloud.com/v1"
DEFAULT_REASONER = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"
DEFAULT_SPECIALIST = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
ROLES = ("reasoner", "specialist", "reviewer")
# decision kinds that justify the large model; verification goes to the isolated reviewer role (same model by default, separate context/budget line)
REASONER_KINDS = frozenset({"reconcile", "intervention", "replan", "escalate", "ScenarioProposalV1", "dod_draft", "dod_replan", "dod_revise"})
REVIEWER_KINDS = frozenset({"verify", "dod_review"})


def role_for_kind(kind: str) -> str:
    if kind in REVIEWER_KINDS:
        return "reviewer"
    if kind in REASONER_KINDS:
        return "reasoner"
    return "specialist"


def _f(e: dict, name: str, default: float) -> float:
    try:
        return float(e.get(name, default))
    except (TypeError, ValueError):
        return default


def _i(e: dict, name: str, default: int) -> int:
    try:
        return int(float(e.get(name, default)))
    except (TypeError, ValueError):
        return default


def _b(e: dict, name: str, default: bool) -> bool:
    v = (e.get(name) or "").strip().lower()
    return default if not v else v in ("1", "true", "yes", "on")


@dataclass
class GatewayConfig:
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    models: dict[str, str] = field(default_factory=lambda: {"reasoner": DEFAULT_REASONER, "specialist": DEFAULT_SPECIALIST, "reviewer": DEFAULT_REASONER})
    max_requests_per_min: int = 60
    timeout_s: float = 60.0
    max_concurrency_high: int = 2          # reasoner / reviewer calls in flight (high cost)
    max_concurrency_low: int = 4           # specialist calls in flight
    queue_max: int = 64                    # waiting requests beyond this are refused immediately (bounded queue)
    queue_timeout_s: float = 120.0
    retries: int = 3                       # extra attempts on 429 / 5xx / timeout
    backoff_base_s: float = 0.5
    backoff_cap_s: float = 20.0
    retry_after_cap_s: float = 60.0
    breaker_threshold: int = 5             # consecutive failed calls (after retries) that open the breaker
    breaker_cooldown_s: float = 30.0
    run_call_budget: int = 400             # logical calls per run (repairs count)
    run_spend_ceiling_usd: float = 2.0
    incident_spend_ceiling_usd: float = 0.5
    seed: int | None = 7
    thinking: bool = False
    thinking_reviewer: bool = False
    json_repairs: int = 1                  # spec: at most one repair attempt, then explicit failure / labelled fallback
    catalog_ttl_s: float = 6 * 3600
    # FAIL CLOSED: a model with no catalog price (or a response without usage) is charged at these worst-case prices / token counts so ceilings still trip
    worst_case_in_per_mtok: float = 5.0
    worst_case_out_per_mtok: float = 25.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "GatewayConfig":
        e = dict(os.environ if env is None else env)

        def pick(*names: str, default: str = "") -> str:
            for n in names:
                if (e.get(n) or "").strip():
                    return e[n].strip()
            return default

        reasoner = pick("CRUSOE_MODEL_REASONER", "MODEL_NAME_DEEP", default=DEFAULT_REASONER)
        specialist = pick("CRUSOE_MODEL_SPECIALIST", "MODEL_NAME", default=DEFAULT_SPECIALIST)
        seed_raw = (e.get("MODEL_SEED") or "").strip()
        seed: int | None = 7 if not seed_raw else (int(seed_raw) if seed_raw.lstrip("-").isdigit() else None)
        return cls(
            api_key=(e.get("CRUSOE_API_KEY") or "").strip(),
            base_url=pick("CRUSOE_BASE_URL", "MODEL_BASE_URL", default=DEFAULT_BASE_URL),
            models={"reasoner": reasoner, "specialist": specialist, "reviewer": pick("CRUSOE_MODEL_REVIEWER", default=reasoner)},
            max_requests_per_min=max(1, _i(e, "CRUSOE_MAX_REQUESTS_PER_MIN", 60)),
            timeout_s=_f(e, "CRUSOE_TIMEOUT_S", 60.0),
            max_concurrency_high=max(1, _i(e, "CRUSOE_MAX_CONCURRENCY_HIGH", 2)),
            max_concurrency_low=max(1, _i(e, "CRUSOE_MAX_CONCURRENCY", 4)),
            queue_max=max(1, _i(e, "CRUSOE_QUEUE_MAX", 64)),
            retries=max(0, _i(e, "CRUSOE_RETRIES", 3)),
            run_call_budget=max(1, _i(e, "CRUSOE_RUN_CALL_BUDGET", 400)),
            run_spend_ceiling_usd=_f(e, "CRUSOE_SPEND_CEILING_USD", 2.0),
            incident_spend_ceiling_usd=_f(e, "CRUSOE_INCIDENT_SPEND_CEILING_USD", 0.5),
            seed=seed,
            worst_case_in_per_mtok=_f(e, "CRUSOE_WORST_CASE_IN_PER_MTOK", 5.0),
            worst_case_out_per_mtok=_f(e, "CRUSOE_WORST_CASE_OUT_PER_MTOK", 25.0),
            thinking=_b(e, "MODEL_THINKING", False) if not e.get("CRUSOE_THINKING") else _b(e, "CRUSOE_THINKING", False),
            thinking_reviewer=_b(e, "MODEL_THINKING_DEEP", False) if not e.get("CRUSOE_THINKING_REVIEWER") else _b(e, "CRUSOE_THINKING_REVIEWER", False),
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def validate_base_url(self) -> str:
        u = urlparse(self.base_url)
        local = (u.hostname or "") in ("localhost", "127.0.0.1", "::1")
        if u.scheme != "https" and not (u.scheme == "http" and local):
            raise ValueError("base url must be https (http only for localhost)")
        if not u.hostname or u.username or u.password:
            raise ValueError("base url invalid")
        if not local:
            from ..intelligence.crusoe import reject_private_host
            reject_private_host(u.hostname)
        return self.base_url.rstrip("/")

    def public(self) -> dict:
        """Safe-to-log view (never the key)."""
        d = {k: v for k, v in self.__dict__.items() if k != "api_key"}
        d["api_key_set"] = bool(self.api_key)
        return d
