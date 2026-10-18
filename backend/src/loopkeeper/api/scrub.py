"""Outbound sanitiser: nothing secret and no hidden reasoning leaves the API.

backend.md §9: "No API keys, hidden chain-of-thought, or raw sensitive prompts in the browser."
Applied to every WebSocket frame and to REST payloads that carry agent data (trace, replay, graph).
Keys are matched case-insensitively after normalising ``-``/``_``; secret-looking string values are masked.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

REDACTED = "[redacted]"

_SECRET_KEY = re.compile(
    r"(api_?key|secret|password|passwd|authorization|bearer|access_?token|refresh_?token|"
    r"private_?key|credential|session_?token|auth_?token|cookie|database_url|dsn)",
    re.I,
)
_HIDDEN_REASONING_KEY = re.compile(
    r"^(chain_?of_?thought|cot|reasoning_?(content|trace|tokens)?|scratchpad|raw_?prompt|"
    r"system_?prompt|raw_?response|raw_?completion|thinking|hidden_?reasoning)$",
    re.I,
)
_SECRET_VALUE = re.compile(
    r"(\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(sk|crusoe|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}|\bcsk[-_][A-Za-z0-9_-]{8,}|\bnpg_[A-Za-z0-9]{8,}|"
    r"postgres(ql)?(\+\w+)?://[^\s:@/]+:[^\s@/]+@)",
    re.I,
)


@lru_cache(maxsize=4096)
def _key_blocked(key: str) -> bool:
    k = key.replace("-", "_")
    return bool(_SECRET_KEY.search(k) or _HIDDEN_REASONING_KEY.match(k))


_VALUE_HINTS = ("bearer", "sk-", "sk_", "csk-", "csk_", "crusoe-", "crusoe_", "ghp-", "ghp_", "xox", "postgres", "npg_")


def _maybe_secret(s: str) -> bool:
    """Cheap necessary condition for `_SECRET_VALUE`: replay windows carry ~10^5 short strings, a regex on each was the bulk of the request time."""
    if len(s) < 8:
        return False
    low = s.lower()
    return any(h in low for h in _VALUE_HINTS)


def scrub(obj: Any) -> Any:
    """Return a deep copy of ``obj`` with secret keys dropped and secret-looking strings masked.

    Structure is rebuilt only where something changed would be cheaper, but correctness first:
    we always rebuild containers (payloads are small; world.diff ~ few KB).
    """
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if isinstance(k, str) and _key_blocked(k):
                continue
            out[k] = scrub(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [scrub(v) for v in obj]
    if isinstance(obj, str) and _maybe_secret(obj) and _SECRET_VALUE.search(obj):
        return _SECRET_VALUE.sub(REDACTED, obj)
    return obj


def contains_secret(obj: Any) -> bool:
    """True if ``obj`` still carries a blocked key or secret-looking value (used by tests / assertions)."""
    if isinstance(obj, dict):
        return any((isinstance(k, str) and _key_blocked(k)) or contains_secret(v) for k, v in obj.items())
    if isinstance(obj, (list, tuple)):
        return any(contains_secret(v) for v in obj)
    return isinstance(obj, str) and _maybe_secret(obj) and bool(_SECRET_VALUE.search(obj))
