"""FastAPI app factory: ``create_app(engine_service)``.

Everything under ``/api/v1``. The app holds no world state and has no physics: it reads from the engine facade
and submits validated commands to it.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
import re
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..interfaces import AgentRuntime
from .auth import Authenticator, Principal, env_authenticator, parse_tokens
from .config import Settings
from .context import ApiContext, ReadOnlyRun
from .routes_nav import router as nav_router
from .routes_comms import router as comms_router
from .routes_dod import router as dod_router
from .manifest import asset_router, router as manifest_router
from .routes import router
from .routes_scenario_requests import router as scenario_requests_router
from .security import SecurityMiddleware, code_for_status, json_error
from .service import RunManager, run_manager_for
from .stream import stream_endpoint

log = logging.getLogger("loopkeeper.api")
API_PREFIX = "/api/v1"
_CONTROL_PATH = re.compile(r"/robots/[^/]+/(drive|control/(lease|heartbeat|release))$")


def _tokens(settings: Settings) -> dict[str, Principal]:
    tokens = parse_tokens(settings.api_tokens) if settings.api_tokens else {}
    if settings.api_auth_token:
        tokens.setdefault(settings.api_auth_token, Principal(id="api", role="admin"))
    return tokens


def create_app(
    engine_service: Any,
    *,
    agent_runtime: Optional[AgentRuntime] = None,
    run_manager: Optional[RunManager] = None,
    settings: Optional[Settings] = None,
    authenticator: Optional[Authenticator] = None,
) -> FastAPI:
    """Build the API around an ``EngineFacade`` (package B; or a test double).

    ``authenticator`` is the auth hook point; default = bearer tokens from env (see auth.py).
    """
    settings = settings or Settings.from_env()
    auth = authenticator or env_authenticator(_tokens(settings), settings.auth_disabled)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        start_fn = getattr(engine_service, "start", None)
        if callable(start_fn):
            res = start_fn()
            if asyncio.iscoroutine(res):
                await res
        yield
        stop_fn = getattr(engine_service, "stop", None)
        if callable(stop_fn):
            res = stop_fn()
            if asyncio.iscoroutine(res):
                await res

    app = FastAPI(
        title="Cruso Cooler System API", version="1", openapi_url=f"{API_PREFIX}/openapi.json" if settings.expose_docs else None,
        docs_url=f"{API_PREFIX}/docs" if settings.expose_docs else None, redoc_url=None,
        lifespan=lifespan,
    )
    app.state.ctx = ApiContext(
        engine=engine_service, runtime=agent_runtime, runs=run_manager or run_manager_for(engine_service),
        settings=settings, authenticate=auth,
    )

    # CORS: explicit allowlist (never "*"; credentials are not used - bearer tokens travel in a header).
    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.cors_origins), allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=False, allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Accept", "Idempotency-Key"], max_age=600,
    )
    app.add_middleware(SecurityMiddleware, max_body_bytes=settings.max_body_bytes)
    # replay windows / topology are large, highly repetitive JSON (the v6 hall: ~21 MB of replay frames -> ~2 MB gzipped); WebSockets are not touched
    from starlette.middleware.gzip import GZipMiddleware
    app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5)

    app.include_router(router, prefix=API_PREFIX)
    from .health_detail import router as health_detail_router; app.include_router(health_detail_router, prefix=API_PREFIX)  # V12 ops: GET /health/detail (agent W)
    app.include_router(dod_router, prefix=API_PREFIX)             # V11 Definition of Done + team graph
    app.include_router(comms_router, prefix=API_PREFIX)           # V10 communications: typed runtime events, filters, replay-safe cursor
    app.include_router(nav_router, prefix=API_PREFIX)               # V7 navigation: graphs, reachability, route plan/commit/cancel, traffic
    app.include_router(manifest_router, prefix=API_PREFIX)        # V7 render manifest + /api/v1/assets/sha256/{hash}
    app.include_router(scenario_requests_router, prefix=API_PREFIX) # V9 natural language scenario launcher
    app.include_router(asset_router)                               # /assets/sha256/{hash}: BEFORE the SPA /assets static mount below
    app.add_api_websocket_route(f"{API_PREFIX}/stream", stream_endpoint)

    if settings.expose_docs:                                          # one schema, every spelling clients try (the SPA fallback must never answer these with HTML)
        def _openapi() -> JSONResponse:
            return JSONResponse(app.openapi())

        for alias_path in ("/openapi.json", "/api/openapi.json"):
            app.add_api_route(alias_path, _openapi, methods=["GET", "HEAD"], include_in_schema=False)

    dist_dir = Path(__file__).resolve().parents[4] / "apps" / "web" / "dist"
    if (dist_dir / "index.html").is_file():
        from starlette.staticfiles import StaticFiles
        from starlette.responses import FileResponse

        if (dist_dir / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=str(dist_dir / "assets")), name="web_assets")

        @app.get("/favicon.svg", include_in_schema=False)
        def favicon():
            return FileResponse(dist_dir / "favicon.svg")

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        def root(request: Request):
            accept = request.headers.get("accept", "")
            if "text/html" in accept or "application/xhtml+xml" in accept or not accept:
                return FileResponse(dist_dir / "index.html")
            return {"name": "loopkeeper-api", "api": API_PREFIX}

        @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def spa_fallback(request: Request, full_path: str):
            if full_path.startswith("api/") or full_path.startswith("api"):
                raise StarletteHTTPException(status_code=404, detail="not found")
            target = dist_dir / full_path
            if target.is_file():
                return FileResponse(target)
            return FileResponse(dist_dir / "index.html")
    else:
        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        def root() -> dict:
            return {"name": "loopkeeper-api", "api": API_PREFIX}

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        headers = dict(getattr(exc, "headers", None) or {})
        code = headers.pop("X-Problem-Code", None) or ("read_only" if isinstance(exc, ReadOnlyRun) else code_for_status(exc.status_code))
        if _CONTROL_PATH.search(request.url.path) and request.method == "POST" and exc.status_code not in (401, 413):
            # the control client reads `accepted/code/reason` regardless of status
            c, st = ("replay_readonly", 403) if isinstance(exc, ReadOnlyRun) else (
                ("unknown_robot", 404) if exc.status_code == 404 else ("bad_request", exc.status_code))
            body = {"accepted": False, "code": c, "reason": str(exc.detail), **json_error(str(exc.detail), code)}
            return JSONResponse(body, status_code=st, headers=headers or None)
        return JSONResponse(json_error(str(exc.detail), code), status_code=exc.status_code, headers=headers or None)

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, exc: RequestValidationError) -> JSONResponse:
        # never echo request input back (it may contain secrets); loc + message only
        detail = [{"loc": [str(x) for x in e.get("loc", ())], "msg": e.get("msg", "invalid")} for e in exc.errors()]
        log.info("422 %s %s: %s", request.method, request.url.path, "; ".join(f"{'.'.join(d['loc'])}: {d['msg']}" for d in detail)[:300])
        if request.url.path.endswith("/commands"):  # frontend does res.json() as CommandAck regardless of status
            body = exc.body if isinstance(exc.body, dict) else {}
            cid = body.get("command_id") if isinstance(body.get("command_id"), str) else ""
            return JSONResponse({"command_id": cid[:128], "accepted": False,
                                 "reason": "invalid command: " + "; ".join(f"{'.'.join(d['loc'][1:])}: {d['msg']}" for d in detail)[:300],
                                 "detail": detail}, status_code=422)
        if _CONTROL_PATH.search(request.url.path):
            return JSONResponse({"accepted": False, "code": "bad_request", "reason": "invalid request",
                                 **json_error("invalid request", "invalid"), "detail": detail}, status_code=422)
        return JSONResponse({**json_error("invalid request", "invalid"), "detail": detail}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error on %s %s: %s", request.method, request.url.path, type(exc).__name__)
        return JSONResponse(json_error("internal error", "internal"), status_code=500)

    return app
