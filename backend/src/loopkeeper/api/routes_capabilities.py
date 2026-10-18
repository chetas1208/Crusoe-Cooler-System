"""GET /robots/{id}/capabilities and GET /robots/capabilities (V12, agent DRV-E): a truthful, live "what can this robot do right now".
Read-only: evaluated from engine.world() (battery, mode, lease, mission, fitted tools, arm state) by engine/robots/capabilities.py."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from ..engine.robots.capabilities import engine_limits, evaluate_fleet, evaluate_robot
from .context import RunScope, run_scope
from .safe_reads import SafeReadRoute
from .scrub import scrub

log = logging.getLogger("loopkeeper.api")
router = APIRouter(route_class=SafeReadRoute)


def _world(sc: RunScope) -> dict:
    try:
        return sc.engine.world()
    except Exception:
        log.exception("engine.world() failed")
        raise HTTPException(503, "engine unavailable")


def _both(path: str):
    def deco(fn):
        router.get(path)(fn)
        router.get(f"/runs/{{run_id}}{path}")(fn)
        return fn
    return deco


@_both("/robots/capabilities")
def fleet_capabilities(sc: RunScope = Depends(run_scope("read"))):
    w = _world(sc)
    out = evaluate_fleet(w.get("robots", {}), viewer=sc.principal.id, sim_status=str(w.get("sim_status") or "running"), limits=engine_limits(sc.engine))
    return scrub({"run_id": sc.run_id, "sim_time_s": w.get("sim_time_s"), **out})


@_both("/robots/{robot_id}/capabilities")
def robot_capabilities(robot_id: str, sc: RunScope = Depends(run_scope("read"))):
    w = _world(sc)
    r = w.get("robots", {}).get(robot_id)
    if r is None:
        raise HTTPException(404, "unknown robot")
    out = evaluate_robot(r, viewer=sc.principal.id, sim_status=str(w.get("sim_status") or "running"), limits=engine_limits(sc.engine))
    return scrub({"run_id": sc.run_id, "sim_time_s": w.get("sim_time_s"), **out})
