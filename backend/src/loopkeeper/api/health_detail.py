"""``GET /api/v1/health/detail``: read-only operations view (authenticated; counters and states only, no secrets).

Engine tick lag, last commit age, outbox depth, DB pool stats, model status + breaker state, event-bus subscribers, process memory / CPU and
the disk used by ``.state``. Every section is read defensively: a section that cannot be read says so (``{"error": "<ExceptionClass>"}``)
instead of failing the whole answer, because this endpoint is what an operator opens when something is already wrong.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .context import ctx_of, principal_of
from .safe_reads import SafeReadRoute
from .scrub import scrub

router = APIRouter(route_class=SafeReadRoute)

_STARTED_AT = time.time()
_cpu_lock = threading.Lock()
_cpu_prev: Optional[tuple[float, float]] = None        # (wall, cpu seconds) at the previous call


def _state_dir() -> Path:
    env = os.environ.get("LOOPKEEPER_STATE_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[4] / ".state"


def _section(fn: Any, *a: Any) -> dict:
    try:
        return fn(*a)
    except Exception as e:                                 # noqa: BLE001
        return {"error": type(e).__name__}


def _age_s(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return round(max(0.0, time.time() - t.timestamp()), 3)
    except ValueError:
        return None


def _engine_section(engine: Any) -> dict:
    out: dict[str, Any] = {"run_id": getattr(engine, "run_id", None), "tick": getattr(engine, "tick", None),
                           "fenced": bool(getattr(engine, "fenced", False)), "db_down": bool(getattr(engine, "db_down", False)),
                           "replay": bool(getattr(engine, "replay", False))}
    clock = getattr(engine, "clock", None)
    if clock is not None:
        last = getattr(clock, "_last", None)
        # wall seconds since the engine loop last asked the clock for due ticks: ~loop_period when healthy, grows when the loop is blocked
        out["tick_lag_s"] = None if (getattr(clock, "paused", False) or last is None) else round(max(0.0, clock.wall() - last), 3)
        out["paused"] = bool(getattr(clock, "paused", False))
        out["sim_speed"] = getattr(clock, "speed", None)
        out["sim_dt_s"] = getattr(clock, "dt", None)
        out["lag_dropped_sim_s"] = round(float(getattr(clock, "lag_dropped_s", 0.0)), 3)
    cfg = getattr(engine, "cfg", None)
    if cfg is not None:
        out["loop_period_s"] = getattr(cfg, "loop_period_s", None)
    started = getattr(engine, "_started_wall", None)
    if isinstance(started, (int, float)):
        out["uptime_s"] = round(time.time() - started, 1)
    return out


def _commit_section(engine: Any) -> dict:
    """Events are published only AFTER a successful commit, so the newest published envelope dates the last durable commit."""
    bus = getattr(engine, "bus", None)
    ring = getattr(bus, "ring", None)
    last = None
    if ring:
        try:
            last = ring[-1]
        except IndexError:
            last = None
    out: dict[str, Any] = {"last_seq": last.get("seq") if last else None, "last_commit_ts": last.get("ts") if last else None}
    out["last_commit_age_s"] = _age_s(out["last_commit_ts"])
    return out


def _outbox_section(engine: Any) -> dict:
    def n(name: str) -> Optional[int]:
        v = getattr(engine, name, None)
        try:
            return len(v) if v is not None else None
        except TypeError:
            return None
    out = {"pending_events": n("pending_events"), "pending_snapshots": n("pending_snaps"), "pending_samples": n("pending_samples")}
    cmds = getattr(getattr(engine, "commands", None), "dirty", None)
    out["dirty_commands"] = len(cmds) if cmds is not None else None
    out["depth"] = sum(v for v in (out["pending_events"], out["pending_snapshots"], out["pending_samples"], out["dirty_commands"]) if v)
    return out


def _pool_stats(pool: Any) -> dict:
    s = dict(pool.get_stats())
    keep = ("pool_min", "pool_max", "pool_size", "pool_available", "requests_waiting", "requests_num", "requests_queued", "requests_wait_ms",
            "requests_errors", "usage_ms", "connections_num", "connections_errors", "connections_lost")
    return {k: s[k] for k in keep if k in s}


def _db_section(engine: Any) -> dict:
    st = getattr(engine, "storage", None)
    if st is None:
        return {"kind": "none"}
    kind = getattr(st, "kind", type(st).__name__)
    out: dict[str, Any] = {"kind": kind, "up": not bool(getattr(engine, "db_down", False))}
    pool = getattr(st, "pool", None)
    if pool is not None and hasattr(pool, "get_stats"):
        out["pool"] = _section(_pool_stats, pool)
        tp = getattr(st, "telemetry_pool", None)
        if tp is not None and tp is not pool and hasattr(tp, "get_stats"):
            out["telemetry_pool"] = _section(_pool_stats, tp)
    return out


def _runtime_gateway(ctx: Any) -> Any:
    return getattr(ctx.runtime, "gateway", None) if ctx.runtime is not None else None


def _model_section(ctx: Any) -> dict:
    from .routes import model_status
    ms = model_status(ctx)
    out: dict[str, Any] = {k: ms.get(k) for k in ("provider", "model_id", "status", "fallback_active", "last_latency_ms") if k in ms}
    rt = ctx.runtime
    if rt is not None:
        try:
            full = rt.model_status()
            for k in ("model_state", "consecutive_failures", "calls", "failures", "invalid_outputs", "tokens_in", "tokens_out", "verified_live"):
                if k in full:
                    out[k] = full[k]
            if full.get("reason"):
                out["status_reason"] = str(full["reason"])[:160]
        except Exception as e:                             # noqa: BLE001
            out["runtime_error"] = type(e).__name__
    gw = _runtime_gateway(ctx)
    if gw is not None:
        try:
            gs = gw.status()
            out["gateway"] = {k: gs.get(k) for k in ("configured", "calls", "spend_usd", "waiting", "http_attempts", "retries", "frozen_hits", "repairs",
                                                      "failures", "sink_failures") if k in gs}
            out["breakers"] = gs.get("breakers", {})
            out["breaker_state"] = ("open" if "open" in out["breakers"].values() else "half_open" if "half_open" in out["breakers"].values()
                                    else "closed")
        except Exception as e:                             # noqa: BLE001
            out["gateway_error"] = type(e).__name__
        # the gateway does not track this yet; reported when it does (attribute `last_error_class`), never invented
        out["last_error_class"] = getattr(gw, "last_error_class", None)
    else:
        out["breaker_state"] = None
        out["last_error_class"] = None
    return out


def _stream_section(request: Request, engine: Any) -> dict:
    bus = getattr(engine, "bus", None)
    subs = getattr(bus, "_subs", None)
    out: dict[str, Any] = {"event_bus_subscribers": len(subs) if subs is not None else None}   # every WebSocket holds one; agents hold their own
    ws = getattr(request.app.state, "ws_clients", None)
    if isinstance(ws, int):
        out["ws_clients"] = ws
    return out


def _process_section() -> dict:
    global _cpu_prev
    import psutil
    p = psutil.Process()
    now, times = time.time(), p.cpu_times()
    cpu = times.user + times.system
    with _cpu_lock:
        prev, _cpu_prev = _cpu_prev, (now, cpu)
    if prev and now - prev[0] >= 0.5:
        pct = (cpu - prev[1]) / (now - prev[0]) * 100.0          # since the previous call (100 = one core)
    else:
        pct = cpu / max(now - p.create_time(), 1e-6) * 100.0     # first call: average since process start
    mem = p.memory_info()
    return {"pid": p.pid, "rss_mb": round(mem.rss / 1048576, 1), "vms_mb": round(mem.vms / 1048576, 1), "cpu_percent": round(pct, 1),
            "threads": p.num_threads(), "open_fds": p.num_fds() if hasattr(p, "num_fds") else None,
            "uptime_s": round(now - p.create_time(), 1), "system_load_1m": round(os.getloadavg()[0], 2), "cpu_count": os.cpu_count()}


def _disk_section() -> dict:
    import shutil
    d = _state_dir()
    out: dict[str, Any] = {"path": str(d), "exists": d.is_dir()}
    if not d.is_dir():
        return out
    total, files, biggest = 0, 0, (None, 0)
    for f in d.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                sz = f.stat().st_size
                total += sz
                files += 1
                if sz > biggest[1]:
                    biggest = (f.name, sz)
        except OSError:
            continue
    du = shutil.disk_usage(d)
    out.update({"state_bytes": total, "state_mb": round(total / 1048576, 1), "files": files, "largest_file": biggest[0],
                "largest_file_mb": round(biggest[1] / 1048576, 1), "fs_free_gb": round(du.free / 1e9, 1), "fs_used_pct": round(du.used / du.total * 100, 1)})
    return out


def build_detail(request: Request) -> dict:
    ctx = ctx_of(request)
    engine = ctx.engine
    return {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "engine": _section(_engine_section, engine),
        "commit": _section(_commit_section, engine),
        "outbox": _section(_outbox_section, engine),
        "database": _section(_db_section, engine),
        "model": _section(_model_section, ctx),
        "stream": _section(_stream_section, request, engine),
        "process": _section(_process_section),
        "disk": _section(_disk_section),
    }


@router.get("/health/detail")
def health_detail(request: Request):
    principal_of(request)                                  # authenticated callers only (401 otherwise)
    return JSONResponse(scrub(build_detail(request)))
