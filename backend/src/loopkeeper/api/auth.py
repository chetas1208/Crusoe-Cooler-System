"""Auth hook point: bearer-token principals from the environment + a per-run authorization stub.

This is deliberately small. It is the seam where a real IdP (OIDC/JWT) plugs in: pass any
``Authenticator`` (a callable ``(token | None) -> Principal | None``) to ``create_app``.

``API_AUTH_TOKEN`` (single shared secret) maps to the admin principal ``api``.

Env format ``LOOPKEEPER_API_TOKENS`` (comma separated)::

    <token>:<principal-id>:<role>[:<run-id>|<run-id>...]

* ``role``  - ``viewer`` (read only) < ``operator`` (commands, robot control) < ``admin`` (create/fork runs,
  scenarios). Use ``*`` (default) for "every run".
* Secure by default: every non-health route and the WS handshake need a valid token. No tokens configured
  => everything non-health answers 401 (fail closed).
* Dev escape hatch: ``LOOPKEEPER_ENV=dev`` + ``LOOPKEEPER_AUTH_DISABLED=1`` makes every caller the anonymous
  ``dev`` admin. It is ignored in prod. The stock frontends need it because
  ``packages/core/src/client/live.ts`` does not yet send credentials (open issue, see README).
* WebSocket: token via ``Authorization`` header, the ``Sec-WebSocket-Protocol`` entry ``bearer.<token>``, or a
  first ``{"type":"auth","token":...}`` message. Never in the URL (URLs end up in logs).
"""
from __future__ import annotations

import hmac
from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

Role = Literal["viewer", "operator", "admin"]
Action = Literal["read", "command", "drive", "fork", "admin"]
_RANK = {"viewer": 0, "operator": 1, "admin": 2}
_NEEDS = {"read": "viewer", "command": "operator", "drive": "operator", "fork": "operator", "admin": "admin"}


@dataclass(frozen=True)
class Principal:
    id: str
    role: Role = "viewer"
    runs: frozenset[str] = field(default_factory=lambda: frozenset({"*"}))
    anonymous: bool = False

    def can(self, action: Action, run_id: Optional[str] = None) -> bool:
        """Per-run authorization stub: role covers the action AND the run is in the principal's allow-list."""
        if _RANK[self.role] < _RANK[_NEEDS[action]]:  # type: ignore[index]
            return False
        if run_id is None or "*" in self.runs:
            return True
        return run_id in self.runs


Authenticator = Callable[[Optional[str]], Optional[Principal]]

DEV_PRINCIPAL = Principal(id="dev", role="admin", anonymous=True)


def parse_tokens(spec: str) -> dict[str, Principal]:
    out: dict[str, Principal] = {}
    for item in (s.strip() for s in spec.split(",")):
        if not item:
            continue
        parts = item.split(":")
        if len(parts) < 3 or parts[2] not in _RANK:
            raise ValueError("LOOPKEEPER_API_TOKENS entries must look like token:principal:role[:run|run]")
        runs = frozenset(parts[3].split("|")) if len(parts) > 3 and parts[3] else frozenset({"*"})
        out[parts[0]] = Principal(id=parts[1], role=parts[2], runs=runs)  # type: ignore[arg-type]
    return out


def env_authenticator(tokens: dict[str, Principal], disabled: bool = False) -> Authenticator:
    def authenticate(token: Optional[str]) -> Optional[Principal]:
        if disabled:
            return DEV_PRINCIPAL
        if not token:
            return None
        found: Optional[Principal] = None
        for known, principal in tokens.items():  # no early exit: constant-time per token
            if hmac.compare_digest(known.encode(), token.encode()):
                found = principal
        return found

    return authenticate


def bearer_from_header(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    scheme, _, rest = value.partition(" ")
    return rest.strip() or None if scheme.lower() == "bearer" else None
