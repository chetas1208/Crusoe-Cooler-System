"""V7 navigation API (deterministic, LLM-free): graphs, reachability, route plan / commit / cancel, traffic state.

Reads and plan previews need no lease; commit / cancel / closures are commands through the single writer (`engine.submit`), carry the
authenticated principal, and commit is optimistic on the graph / traffic revision (never on the world tick). Every refusal carries
one reason code from nav.reasons.REASONS and the exact constraint."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Literal, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query
from .safe_reads import SafeReadRoute
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .context import RunScope, run_scope, submit_as
from .scrub import scrub

log = logging.getLogger("loopkeeper.api.nav")
router = APIRouter(route_class=SafeReadRoute)

STATUS = {"UNKNOWN_ROBOT": 404, "UNKNOWN_TARGET": 404, "UNKNOWN_PLAN": 404, "LEASE_REQUIRED": 403}


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Point(_Body):
    x: float
    z: float


class RoutePlanRequest(_Body):
    target: Union[str, Point]
    start_after_s: float = Field(default=0.0, ge=0.0, le=600.0)


class RouteCommitRequest(_Body):
    plan_id: str = Field(min_length=1, max_length=128)
    graph_revision: Optional[str] = Field(default=None, max_length=64)
    traffic_revision: Optional[int] = Field(default=None, ge=0)
    lease_id: Optional[str] = Field(default=None, max_length=128)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class RouteCancelRequest(_Body):
    reason: str = Field(default="operator", max_length=64)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class ClosureRequest(_Body):
    edge_ids: list[str] = Field(min_length=1, max_length=40)
    closed: bool = True


def _nav(sc: RunScope) -> Any:
    nav = getattr(sc.engine, "navigation", None)
    if nav is None:
        raise HTTPException(501, "this engine has no navigation service")
    return nav


def _refusal(body: dict) -> JSONResponse:
    return JSONResponse(scrub({"accepted": False, **body}), status_code=STATUS.get(body.get("reason", ""), 409))


def _target(t: Union[str, Point]) -> Any:
    return {"x": t.x, "z": t.z} if isinstance(t, Point) else t


@router.get("/runs/{run_id}/navigation/graphs")
def graphs(kind: Literal["exterior", "interior"] = Query(default="exterior"), sc: RunScope = Depends(run_scope("read"))):
    return scrub(_nav(sc).graphs(kind))


@router.get("/runs/{run_id}/navigation/reachability")
def reachability(robot_id: str = Query(min_length=1, max_length=64), target_id: str = Query(min_length=1, max_length=128),
                 sc: RunScope = Depends(run_scope("read"))):
    out = _nav(sc).reachability(robot_id, target_id)
    if out.get("ok") is False:
        return _refusal(out)
    return scrub({**out, "run_id": sc.run_id})


@router.get("/runs/{run_id}/navigation/traffic")
def traffic(sc: RunScope = Depends(run_scope("read"))):
    nav = _nav(sc)
    now = float(sc.engine.world().get("sim_time_s", 0.0))
    return scrub({"run_id": sc.run_id, "graph_revision": nav.graph_revision, "traffic_revision": nav.traffic_revision, "sim_time_s": now,
                  "table": nav.table.summary(), "active_routes": {r: nav.public_plan(nav.plans[p]) for r, p in nav.active.items() if p in nav.plans},
                  "waits": dict(nav.waits), "stats": dict(nav.stats), "closed_edges": sorted(nav.ext.closed | nav.inp.closed),
                  "reservations": [{"resource": res, "rows": rows} for res, rows in sorted(nav.table.by_resource.items())][:200]})


@router.post("/runs/{run_id}/robots/{robot_id}/route/plan")
async def route_plan(robot_id: str, body: RoutePlanRequest, sc: RunScope = Depends(run_scope("read"))):
    """Preview only: nothing is reserved, no lease needed. The answer carries the plan id to commit and the revisions it is valid for."""
    nav = _nav(sc)
    plan = nav.plan(robot_id, _target(body.target), preview=True, start_after_s=body.start_after_s)
    if not plan.get("ok"):
        return _refusal(plan)
    return scrub({"accepted": True, **nav.public_plan(plan), "run_id": sc.run_id})


async def _submit(sc: RunScope, kind: str, robot_id: str | None, args: dict, idem: Optional[str]) -> JSONResponse:
    cid = sc.ctx.idem.command_id(sc.principal.id, sc.run_id, robot_id or "-", kind, idem) if idem else str(uuid.uuid4())
    cmd = {"command_id": cid, "kind": kind, "args": args, "actor_type": "operator", "principal": sc.principal.id, "run_id": sc.run_id}
    if robot_id:
        cmd["target_id"] = robot_id
    try:
        res = dict(await submit_as(sc.engine, cmd))
    except Exception:
        log.exception("engine.submit failed")
        raise HTTPException(503, "engine unavailable")
    if not res.get("accepted"):
        body = res if res.get("reason") in STATUS or "detail" in res else {"reason": str(res.get("reason") or "refused")}
        if "detail" not in body:                       # reason string "CODE: detail" from the command bus
            code, _, detail = str(res.get("reason") or "").partition(": ")
            body = {"reason": code if code.isupper() else "NO_ACCESS", "detail": detail or str(res.get("reason") or "refused")}
        return _refusal({**{k: v for k, v in res.items() if k not in ("command_id", "accepted")}, **body})
    res.pop("accepted", None)
    return JSONResponse(scrub({"accepted": True, **res, "command_id": cid}))


@router.post("/runs/{run_id}/robots/{robot_id}/route/commit")
async def route_commit(robot_id: str, body: RouteCommitRequest, sc: RunScope = Depends(run_scope("drive"))):
    args = {k: v for k, v in body.model_dump().items() if k != "idempotency_key" and v is not None}
    return await _submit(sc, "robot.route.commit", robot_id, args, body.idempotency_key)


@router.post("/runs/{run_id}/robots/{robot_id}/route/cancel")
async def route_cancel(robot_id: str, body: RouteCancelRequest, sc: RunScope = Depends(run_scope("drive"))):
    return await _submit(sc, "robot.route.cancel", robot_id, {"reason": body.reason}, body.idempotency_key)


@router.post("/runs/{run_id}/navigation/closures")
async def closures(body: ClosureRequest, sc: RunScope = Depends(run_scope("command"))):
    """Close / reopen graph edges (aisle blocked by equipment, pipe out of service): changes the graph revision; committed routes crossing a
    closed edge are replanned or reported as lost reachability."""
    return await _submit(sc, "nav.closure.set", None, {"edge_ids": body.edge_ids, "closed": body.closed}, None)
