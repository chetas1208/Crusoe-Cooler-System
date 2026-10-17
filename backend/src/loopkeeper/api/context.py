"""Per-app context + request dependencies (authn, per-run authz, rate limits)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import HTTPException, Request

from ..interfaces import AgentRuntime, EngineFacade, Json
from .auth import Action, Authenticator, Principal, bearer_from_header
from .config import Settings
from .projections import Projection
from .security import IdempotencyCache, TokenBuckets
from .service import RunManager


@dataclass
class ApiContext:
    engine: Any                      # EngineFacade (+ optional EngineExtensions)
    runtime: Optional[AgentRuntime]
    runs: RunManager
    settings: Settings
    authenticate: Authenticator
    buckets: TokenBuckets = field(default_factory=TokenBuckets)
    idem: IdempotencyCache = field(default_factory=IdempotencyCache)
    projections: dict[str, Projection] = field(default_factory=dict)
    leases: dict[str, tuple[str, str, str]] = field(default_factory=dict)  # lease_id -> (principal, run, robot)

    @property
    def active_run_id(self) -> str:
        return self.runs.active_run_id

    def resolve_run_id(self, rid: Optional[str]) -> str:
        """``None`` / ``current`` -> the active live run (the frontend control client defaults to ``current``)."""
        # "run_live" is the long-standing name of the live baseline; after a restart that cannot resume the old run the engine
        # starts "run_live_2", ... and the old alias keeps pointing at whatever run is live now
        if rid in (None, "", "current"):
            return self.active_run_id
        if rid == "run_live" and self.active_run_id != "run_live":
            try:                                              # a STORED run really named run_live (the first run ever recorded) is addressable
                if self.runs.get_run("run_live") is not None:
                    return "run_live"
            except Exception:                                 # noqa: BLE001
                pass
            return self.active_run_id
        return rid

    def projection(self, run_id: str, engine: EngineFacade) -> Projection:
        p = self.projections.get(run_id)
        if p is None:
            p = self.projections[run_id] = Projection(engine, self.settings.ws_catchup_page)
            p.catch_up()
            p.seed_from_world(engine.world())  # after history, so it only adds a point if newer
        p.catch_up()
        return p


def ctx_of(request: Request) -> ApiContext:
    return request.app.state.ctx


def unauthorized() -> HTTPException:
    return HTTPException(401, "authentication required", headers={"WWW-Authenticate": "Bearer"})


def principal_of(request: Request, *, optional: bool = False) -> Optional[Principal]:
    ctx = ctx_of(request)
    p = ctx.authenticate(bearer_from_header(request.headers.get("authorization")))
    if p is None and not optional:
        raise unauthorized()
    return p


class ReadOnlyRun(HTTPException):
    """Raised when a write targets a stopped/failed/replay run (operators must fork first)."""

    def __init__(self) -> None:
        super().__init__(409, "read-only run: fork it to act on it")


@dataclass
class RunScope:
    ctx: ApiContext
    principal: Principal
    run_id: str
    engine: Any
    is_active: bool


def run_scope(action: Action):
    """Dependency: authenticate, resolve ``run_id`` (path; absent => active live run), authorize.

    Foreign / unknown runs answer 404 (never reveal existence); insufficient role on a visible run is 403.
    """

    def dep(request: Request) -> RunScope:
        ctx = ctx_of(request)
        principal = principal_of(request)
        assert principal is not None
        rid = ctx.resolve_run_id(request.path_params.get("run_id"))
        engine = ctx.runs.engine_for(rid) if principal.can("read", rid) else None
        if engine is None:
            raise HTTPException(404, "unknown run")
        if not principal.can(action, rid):
            raise HTTPException(403, "insufficient role")
        if action in ("command", "drive") and rid != ctx.active_run_id:
            raise ReadOnlyRun()           # only the active live run has an engine worker; stored runs and forks are replay-only (no stepping yet)
        return RunScope(ctx, principal, rid, engine, rid == ctx.active_run_id)

    return dep


def rate_limit(request: Request, bucket: str, principal: Principal) -> None:
    s = ctx_of(request).settings
    rate, burst = (s.command_rate_per_s, s.command_burst) if bucket == "commands" else (s.drive_rate_per_s, s.drive_burst)
    ok, retry = ctx_of(request).buckets.allow(bucket, principal.id, rate, burst)
    if not ok:
        raise HTTPException(429, "rate limit exceeded", headers={"Retry-After": str(max(1, int(retry + 0.999)))})
