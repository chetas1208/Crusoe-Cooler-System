"""Crusoe Managed Inference client (OpenAI-compatible) + model status tracking.

* CRUSOE_API_KEY is read server-side only and is never logged / emitted.
* Only the configured MODEL_BASE_URL host is ever contacted (no redirects).
* Output is untrusted text; callers parse + validate with pydantic.
* When key/model is missing or failing, callers use the deterministic fallback
  and `ModelStatus` says so truthfully (never claims 'live' without a real call).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse

log = logging.getLogger("loopkeeper.intelligence")

DEFAULT_BASE_URL = "https://api.inference.crusoecloud.com/v1"
DETERMINISTIC_MODEL_ID = "policy-engine-v1"


class ModelError(Exception):
    """Any failure to obtain a usable completion (network, auth, timeout, empty)."""

    def __init__(self, msg: str, status: int | None = None):
        super().__init__(msg)
        self.status = status


@dataclass
class ModelResponse:
    text: str
    tokens_in: int | None = None
    tokens_out: int | None = None
    latency_ms: int = 0
    http_status: int | None = 200
    model_id: str = ""


class ModelClient(Protocol):
    provider: str
    model_id: str

    async def complete_json(self, *, system: str, user: str, schema_name: str,
                            max_tokens: int = 700, timeout_s: float | None = None) -> ModelResponse: ...

    async def aclose(self) -> None: ...


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S | re.I)
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)


def extract_json(text: str) -> Any:
    """Parse the first JSON object in untrusted model text. Raises ValueError."""
    t = _THINK.sub("", text or "").strip()
    m = _JSON_FENCE.search(t)
    if m:
        t = m.group(1).strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    start = t.find("{")
    if start < 0:
        raise ValueError("no JSON object in model output")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(t)):
        c = t[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return json.loads(t[start:i + 1])
    raise ValueError("unterminated JSON object in model output")


def load_dotenv_file(path: str) -> None:
    """Optional helper for the app entrypoint: load KEY=VALUE lines without overriding env."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


@dataclass
class IntelligenceConfig:
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    model_name: str = ""
    provider: str = "crusoe"
    timeout_s: float = 45.0
    max_retries: int = 2
    # tiering: frequent perception/classification kinds use model_name (cheap, fast); planning/verification kinds use
    # model_deep (falls back to model_name when unset). Measured on this account: Nano ~0.9 s, Super-120B ~1.8 s with thinking off.
    model_deep: str = ""
    seed: int | None = 7
    thinking: bool = False        # reasoning tokens off by default: faster, and avoids empty-content/whitespace failures at small max_tokens
    thinking_deep: bool = False

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "IntelligenceConfig":
        e = os.environ if env is None else env
        def _pick(*keys: str, default: str = "") -> str:
            for k in keys:
                v = (e.get(k) or "").strip()
                if v:
                    return v
            return default
        return cls(
            api_key=(e.get("CRUSOE_API_KEY") or "").strip(),
            base_url=_pick("CRUSOE_BASE_URL", "MODEL_BASE_URL", default=DEFAULT_BASE_URL),
            model_name=_pick("CRUSOE_MODEL_SPECIALIST", "CRUSOE_MODEL", "MODEL_NAME"),
            provider=(e.get("INTELLIGENCE_PROVIDER") or "crusoe").strip() or "crusoe",
            model_deep=_pick("CRUSOE_MODEL_REASONER", "MODEL_NAME_DEEP"),
            seed=int(e["MODEL_SEED"]) if (e.get("MODEL_SEED") or "").strip().lstrip("-").isdigit() else (None if (e.get("MODEL_SEED") or "").strip().lower() in ("none", "off") else 7),
            thinking=(e.get("MODEL_THINKING") or "0").strip().lower() in ("1", "true", "yes", "on"),
            thinking_deep=(e.get("MODEL_THINKING_DEEP") or "0").strip().lower() in ("1", "true", "yes", "on"),
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def validate_base_url(self) -> str:
        u = urlparse(self.base_url)
        local = (u.hostname or "") in ("localhost", "127.0.0.1", "::1")
        if u.scheme != "https" and not (u.scheme == "http" and local):
            raise ValueError("MODEL_BASE_URL must be https (http only for localhost)")
        if not u.hostname or u.username or u.password:
            raise ValueError("MODEL_BASE_URL invalid")
        if not local:
            reject_private_host(u.hostname)
        return self.base_url


_BLOCKED_SUFFIXES = (".internal", ".local", ".localdomain", ".localhost", ".nip.io", ".sslip.io", ".xip.io", ".traefik.me", ".lvh.me")


def reject_private_host(host: str) -> None:
    """Raise ValueError for hosts a model endpoint must never be: loopback / link-local / private / metadata IPs (dotted, decimal, hex, IPv6) and
    names that resolve to them by construction (`*.internal`, `*.nip.io`, ...). The base URL is env-controlled, not user-controlled: defence in depth."""
    import ipaddress
    h = (host or "").strip("[]").lower().rstrip(".")
    if not h or h in ("localhost", "metadata", "instance-data") or h.endswith(_BLOCKED_SUFFIXES):
        raise ValueError("base url host is not allowed")
    ip = None
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        try:
            ip = ipaddress.ip_address(int(h, 0)) if h.replace("0x", "").isalnum() and (h.isdigit() or h.startswith("0x")) else None
        except ValueError:
            ip = None
    if ip is not None and not ip.is_global:
        raise ValueError("base url host is not allowed")
    if ip is None and re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", h) is None and re.search(r"(?:^|\.)(?:\d{1,3}\.){3}\d{1,3}(?:\.|$)", h):
        raise ValueError("base url host is not allowed")      # a name that embeds an IPv4 literal (`169.254.169.254.example`)


class ModelStatus:
    """Truthful model status: live | degraded | unavailable | fallback."""

    def __init__(self, provider: str, model_id: str, status: str, reason: str = ""):
        self.provider, self.model_id, self.status, self.reason = provider, model_id, status, reason
        self.last_latency_ms: int | None = None
        self.consecutive_failures = 0
        self.calls = 0
        self.failures = 0
        self.invalid_outputs = 0
        self.tokens_in = 0
        self.tokens_out = 0
        self._opened_at: float | None = None
        self.cooldown_s = 30.0
        self.verified_live = False

    def allow_call(self) -> bool:
        if self.status in ("live", "degraded"):
            return True
        if self.status == "unavailable" and self.provider == "crusoe":
            # half-open: one trial call after cooldown
            if self._opened_at is not None and time.monotonic() - self._opened_at >= self.cooldown_s:
                self._opened_at = time.monotonic()
                return True
        return False

    def record_success(self, resp: ModelResponse) -> None:
        self.calls += 1
        self.consecutive_failures = 0
        self.last_latency_ms = resp.latency_ms
        self.tokens_in += resp.tokens_in or 0
        self.tokens_out += resp.tokens_out or 0
        self.verified_live = True
        self.status, self.reason, self._opened_at = "live", "", None

    def record_failure(self, reason: str) -> None:
        self.calls += 1
        self.failures += 1
        self.consecutive_failures += 1
        self.reason = reason[:200]
        if self.consecutive_failures >= 3:
            self.status = "unavailable"
            self._opened_at = time.monotonic()
        elif self.status == "live":
            self.status = "degraded"

    def record_invalid(self) -> None:
        self.invalid_outputs += 1

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "provider": self.provider, "model_id": self.model_id, "status": self.status,
        }
        if self.last_latency_ms is not None:
            d["last_latency_ms"] = self.last_latency_ms
        if self.reason:
            d["reason"] = self.reason
        d["fallback_active"] = self.status in ("unavailable", "fallback")
        d["calls"], d["failures"], d["invalid_outputs"] = self.calls, self.failures, self.invalid_outputs
        d["tokens_in"], d["tokens_out"] = self.tokens_in, self.tokens_out
        return d


# decision kinds that justify the larger model (planning / reconciliation / verification / escalation / scenario authoring)
DEEP_KINDS = frozenset({"reconcile", "intervention", "replan", "verify", "escalate", "ScenarioProposalV1", "dod_draft", "dod_revise", "dod_review"})


class CrusoeClient:
    """AsyncOpenAI against MODEL_BASE_URL. Requests carry no user-controlled URL parts."""

    provider = "crusoe"

    def __init__(self, cfg: IntelligenceConfig, *, client: Any | None = None):
        self.cfg = cfg
        self.model_id = cfg.model_name
        self.deep_model_id = cfg.model_deep or cfg.model_name
        self._json_mode = True
        self._extra_ok = True   # chat_template_kwargs/seed accepted by the server (dropped once on a 400)
        if client is not None:
            self._client = client
        else:
            import httpx
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(
                base_url=cfg.validate_base_url(), api_key=cfg.api_key,
                timeout=cfg.timeout_s, max_retries=cfg.max_retries,
                http_client=httpx.AsyncClient(follow_redirects=False, timeout=cfg.timeout_s),
            )

    async def list_models(self) -> list[str]:
        page = await self._client.models.list()
        data = getattr(page, "data", page)
        return [getattr(m, "id", None) or m.get("id") for m in data]

    async def complete_json(self, *, system: str, user: str, schema_name: str,
                            max_tokens: int = 700, timeout_s: float | None = None) -> ModelResponse:
        t0 = time.perf_counter()
        deep = schema_name in DEEP_KINDS
        kwargs: dict[str, Any] = dict(
            model=self.deep_model_id if deep else self.model_id,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.0, max_tokens=max_tokens,
        )
        if self._extra_ok:
            thinking = self.cfg.thinking_deep if deep else self.cfg.thinking
            kwargs["extra_body"] = {"chat_template_kwargs": {"enable_thinking": bool(thinking)}}
            if self.cfg.seed is not None:
                kwargs["seed"] = self.cfg.seed
            if thinking:   # reasoning tokens share the completion budget; leave room for the answer
                kwargs["max_tokens"] = max(max_tokens, 2048)
        if self._json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            try:
                r = await asyncio.wait_for(self._client.chat.completions.create(**kwargs),
                                           timeout=timeout_s or self.cfg.timeout_s + 5)
            except Exception as e:  # json mode / extra params unsupported -> retry once without
                if getattr(e, "status_code", None) == 400 and (self._json_mode or self._extra_ok):
                    self._json_mode = False
                    self._extra_ok = False
                    for k in ("response_format", "extra_body", "seed"):
                        kwargs.pop(k, None)
                    r = await asyncio.wait_for(self._client.chat.completions.create(**kwargs),
                                               timeout=timeout_s or self.cfg.timeout_s + 5)
                else:
                    raise
        except asyncio.CancelledError:
            raise
        except Exception as e:
            st = getattr(e, "status_code", None)
            raise ModelError(f"{type(e).__name__}", st) from None  # never include request details
        lat = int((time.perf_counter() - t0) * 1000)
        try:
            text = r.choices[0].message.content or ""
        except Exception:
            raise ModelError("empty completion") from None
        u = getattr(r, "usage", None)
        resp = ModelResponse(text=text, tokens_in=getattr(u, "prompt_tokens", None),
                             tokens_out=getattr(u, "completion_tokens", None), latency_ms=lat,
                             model_id=getattr(r, "model", None) or self.model_id)
        log.info("model_call provider=crusoe model=%s schema=%s latency_ms=%d tok_in=%s tok_out=%s status=200",
                 resp.model_id, schema_name, lat, resp.tokens_in, resp.tokens_out)
        return resp

    async def aclose(self) -> None:
        try:
            await self._client.close()
        except Exception:
            pass


async def probe_model(cfg: IntelligenceConfig, client: ModelClient | None = None) -> tuple[ModelStatus, ModelClient | None]:
    """Startup probe: key present -> /models list -> tiny real request. Never raises."""
    if not cfg.configured and client is None:
        return ModelStatus("deterministic", DETERMINISTIC_MODEL_ID, "fallback",
                           "CRUSOE_API_KEY not set - deterministic policy in use"), None
    try:
        cl: ModelClient = client or CrusoeClient(cfg)
    except Exception as e:
        return ModelStatus("deterministic", DETERMINISTIC_MODEL_ID, "fallback", f"client init failed: {type(e).__name__}"), None
    st = ModelStatus(cl.provider, cl.model_id or cfg.model_name, "unavailable", "probe pending")
    try:
        ids: list[str] = []
        lister = getattr(cl, "list_models", None)
        if lister:
            try:
                ids = await lister()
            except Exception as e:
                log.warning("model catalog unavailable (%s); trying a direct request", type(e).__name__)
        if not cl.model_id:
            pick = next((i for i in ids if "nemotron" in (i or "").lower()), None)
            if not pick:
                st.reason = "MODEL_NAME unset and no Nemotron model in catalog"
                return st, cl
            cl.model_id = st.model_id = pick
        elif ids and cl.model_id not in ids:
            st.reason = "configured model not in catalog (check entitlement)"
            return st, cl
        resp = await cl.complete_json(system='Reply with the JSON object {"ok": true} and nothing else.',
                                      user="ping", schema_name="probe", max_tokens=64, timeout_s=cfg.timeout_s)
        extract_json(resp.text)
        st.record_success(resp)
        st.calls = 0
    except Exception as e:
        st.status, st.reason = "unavailable", f"probe failed: {type(e).__name__}"
        st._opened_at = time.monotonic()
    log.info("model probe provider=%s model=%s status=%s", st.provider, st.model_id, st.status)
    return st, cl
