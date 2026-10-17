"""REST routes. Legacy (unprefixed-by-run) paths map to the active live run; run-scoped paths mirror backend.md §9.

Hard rules: reads come from the engine facade; the ONLY write path is ``engine.submit(command)``.
No physics here. Request bodies are ``extra=forbid``; errors are generic (no stack traces).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from pydantic import ValidationError

from . import models as M
from . import models_control as C
from . import models_runs as R
from .context import ReadOnlyRun, RunScope, ctx_of, principal_of, rate_limit, run_scope
from .projections import agent_graph
from .scrub import scrub
from .security import json_error
from .service import (CMD_DRIVE, CMD_LEASE_ACQUIRE, CMD_LEASE_HEARTBEAT, CMD_LEASE_RELEASE, NotSupported, RunError, RunNotFound, now_iso)
from ..engine.eventlog import to_envelope
from ..storage.base import StorageError
from ..scenarios import build_recorded_episode, clock_payload, get_definition, list_definitions

log = logging.getLogger("loopkeeper.api")
EXC = dict(response_model_exclude_unset=True)
router = APIRouter()


def both(method: str, path: str, **kw: Any):
    """Register one handler at the legacy path AND the run-scoped path."""

    def deco(fn):
        getattr(router, method)(path, **kw)(fn)
        getattr(router, method)(f"/runs/{{run_id}}{path}", **kw)(fn)
        return fn

    return deco


def _world(sc: RunScope) -> dict:
    try:
        return sc.engine.world()
    except Exception:
        log.exception("engine.world() failed")
        raise HTTPException(503, "engine unavailable")


# ───────────────────────────────── reads ─────────────────────────────────


@router.get("/topology", response_model=M.Topology, **EXC)
@router.get("/facilities/{facility_id}/topology", response_model=M.Topology, **EXC)
@router.get("/runs/{run_id}/topology", response_model=M.Topology, **EXC)
def topology(sc: RunScope = Depends(run_scope("read")), facility_id: Optional[str] = None):
    topo = sc.engine.topology()
    if facility_id and facility_id != topo.get("facility", {}).get("id"):
        raise HTTPException(404, "unknown facility")
    return topo


@both("get", "/world", response_model=M.WorldSnapshot, **EXC)
def world(sc: RunScope = Depends(run_scope("read"))):
    return _world(sc)


@both("get", "/incidents", response_model=list[M.Incident], **EXC)
def incidents(status: Optional[str] = Query(default=None, pattern="^open$"), sc: RunScope = Depends(run_scope("read"))):
    incs = sorted(_world(sc).get("incidents", []), key=lambda i: -i.get("opened_tick", 0))
    return [i for i in incs if not i.get("closed_tick")] if status == "open" else incs


@both("get", "/incidents/{incident_id}/trace", response_model=M.IncidentTrace, **EXC)
def trace(incident_id: str, sc: RunScope = Depends(run_scope("read"))):
    if not any(i.get("id") == incident_id for i in _world(sc).get("incidents", [])):
        raise HTTPException(404, "unknown incident")
    ext = getattr(sc.engine, "trace", None)
    tasks = ext(incident_id) if callable(ext) else None
    if tasks is None:
        tasks = sc.ctx.projection(sc.run_id, sc.engine).trace(incident_id)
    return scrub({"incident_id": incident_id, "tasks": tasks})


@both("get", "/telemetry", response_model=M.TelemetrySeries, **EXC)
def telemetry(
    asset_id: str = Query(min_length=1, max_length=128),
    metric: str = Query(min_length=1, max_length=64),
    window_s: float = Query(default=600, gt=0, le=86_400),
    sc: RunScope = Depends(run_scope("read")),
):
    ext = getattr(sc.engine, "telemetry", None)
    series = ext(asset_id, metric, window_s) if callable(ext) else None
    if series is None:
        series = sc.ctx.projection(sc.run_id, sc.engine).telemetry(asset_id, metric, window_s)
    if series is None:
        raise HTTPException(404, "no such series")
    return series


@router.get("/replay", response_model=M.ReplayPage, **EXC)
def replay_events(from_seq: int = Query(default=0, ge=0), limit: int = Query(default=500, ge=1),
                  sc: RunScope = Depends(run_scope("read"))):
    """Legacy event page: events with seq >= from_seq in order. Read-only."""
    limit = min(limit, sc.ctx.settings.replay_page_max)
    evs = sc.engine.events_since(max(from_seq - 1, 0), limit)
    if not evs:
        return {"events": [], "next_seq": None}
    head = int(_world(sc).get("last_seq", 0))
    last = int(evs[-1]["seq"])
    return scrub({"events": evs[:limit], "next_seq": last + 1 if last < head else None})


@both("get", "/robots", response_model=list[M.Robot], **EXC)
def robots(sc: RunScope = Depends(run_scope("read"))):
    return list(_world(sc).get("robots", {}).values())


@both("get", "/robots/{robot_id}", response_model=M.Robot, **EXC)
def robot(robot_id: str, sc: RunScope = Depends(run_scope("read"))):
    r = _world(sc).get("robots", {}).get(robot_id)
    if r is None:
        raise HTTPException(404, "unknown robot")
    return r


@both("get", "/assets/{asset_id}")
def asset(asset_id: str, sc: RunScope = Depends(run_scope("read"))):
    topo = sc.engine.topology()
    a = next((x for x in topo.get("assets", []) if x["id"] == asset_id), None)
    e = next((x for x in topo.get("edges", []) if x["id"] == asset_id), None)
    if a is None and e is None:
        raise HTTPException(404, "unknown asset")
    return {"asset": a or e, "state": _world(sc).get("assets", {}).get(asset_id)}


@router.get("/runs/{run_id}/agents/graph")
def agents_graph(sc: RunScope = Depends(run_scope("read"))):
    ext = getattr(sc.engine, "agent_tasks", None)
    tasks = ext() if callable(ext) else sc.ctx.projection(sc.run_id, sc.engine).all_tasks()
    return scrub(agent_graph(sc.run_id, tasks))


@router.get("/agents/graph")
def agents_graph_legacy(sc: RunScope = Depends(run_scope("read"))):
    return agents_graph(sc)


# ──────────────────────────────── commands ────────────────────────────────


def _command_shape_error(body: M.CommandRequest) -> Optional[str]:
    """Shape-only validation. Ranges / physics / existence are the engine's call."""
    k, a = body.kind, body.args or {}
    if k in ("approve_action", "hold_action") and not body.target_id:
        return "target_id (approval id) is required"
    if k == "set_sim_speed" and (isinstance(a.get("speed"), bool) or not isinstance(a.get("speed"), (int, float))):
        return "args.speed must be a number"
    if k == "test.inject_fault" and not isinstance(a.get("kind"), str):
        return "args.kind (fault kind) is required"
    if len(str(a)) > 4000:
        return "args too large"
    return None


@both("post", "/commands", response_model=M.CommandAck, **EXC)
async def post_command(body: M.CommandRequest, request: Request, sc: RunScope = Depends(run_scope("command"))):
    rate_limit(request, "commands", sc.principal)

    def ack(accepted: bool, reason: Optional[str] = None, status: int = 200):
        content = {"command_id": body.command_id, "accepted": accepted}
        if reason:
            content["reason"] = reason
        return JSONResponse(content, status_code=status)

    if body.kind == "test.inject_fault" and not sc.ctx.settings.enable_test_commands:
        return ack(False, "test commands are disabled on this deployment")
    if (err := _command_shape_error(body)):
        return ack(False, err, 422)
    cmd = body.model_dump(exclude_none=True)
    cmd.update(actor_type="operator", principal=sc.principal.id, run_id=sc.run_id)
    try:
        res = await sc.engine.submit(cmd)
    except Exception:
        log.exception("engine.submit failed")
        return ack(False, "engine unavailable", 503)
    ok = bool(res.get("accepted"))
    return ack(ok, None if ok else (res.get("reason") or "rejected"))


# ─────────────────────────── robot control leases (§10) ───────────────────────────
# Wire types: packages/core/src/contracts.control.ts. Refusals are ControlRefusal bodies with the HTTP status from
# HTTP_STATUS_FOR_CODE; the API validates shape/auth/lease-holder and passes the engine's ack through (validated).


def _uuid() -> str:
    import uuid
    return str(uuid.uuid4())


def refusal(code: str, reason: str, status: Optional[int] = None, **extra: Any) -> JSONResponse:
    if code not in C.HTTP_STATUS_FOR_CODE:
        code = "not_controllable"
    body = {"accepted": False, "code": code, "reason": reason, **extra}
    return JSONResponse(scrub(body), status_code=status or C.HTTP_STATUS_FOR_CODE[code])


async def _control(sc: RunScope, request: Request, robot_id: str, kind: str, args: dict, idem: Optional[str],
                   model: type, *, limited: bool) -> JSONResponse:
    if limited:
        try:
            rate_limit(request, "drive", sc.principal)
        except HTTPException as e:
            return JSONResponse({"accepted": False, "code": "bad_request", "reason": "rate limit exceeded"},
                                status_code=e.status_code, headers=e.headers)
    if robot_id not in _world(sc).get("robots", {}):
        return refusal("unknown_robot", "unknown robot")
    lid = args.get("lease_id")
    held = sc.ctx.leases.get(lid) if lid else None
    if held and (held[0], held[1], held[2]) != (sc.principal.id, sc.run_id, robot_id):
        return refusal("no_lease", "no such lease for this principal")
    cid = sc.ctx.idem.command_id(sc.principal.id, sc.run_id, robot_id, kind, idem) if idem else _uuid()
    cmd = {"command_id": cid, "kind": kind, "target_id": robot_id, "args": args, "actor_type": "operator",
           "principal": sc.principal.id, "run_id": sc.run_id}
    try:
        res = dict(await sc.engine.submit(cmd))
    except Exception:
        log.exception("engine.submit failed")
        return refusal("not_controllable", "engine unavailable", 503)
    if not res.get("accepted"):
        code = res.get("code") if res.get("code") in C.HTTP_STATUS_FOR_CODE else "not_controllable"
        extra = {k: res[k] for k in ("holder", "current_world_version", "revoked_reason") if k in res}
        return refusal(code, str(res.get("reason") or "refused"), **extra)
    res.setdefault("robot_id", robot_id)
    res.pop("command_id", None)
    try:
        out = model.model_validate(res).model_dump(mode="json", exclude_unset=True, by_alias=True)
    except ValidationError:
        log.error("engine returned a malformed %s ack for %s", kind, robot_id)
        return refusal("not_controllable", "engine returned an invalid control response", 502)
    return JSONResponse(scrub({**out, "command_id": cid}))


@router.post("/runs/{run_id}/robots/{robot_id}/control/lease")
async def lease(robot_id: str, body: C.LeaseRequest, request: Request, sc: RunScope = Depends(run_scope("drive"))):
    args = {"idempotency_key": body.idempotency_key, "expected_world_version": body.expected_world_version,
            "topology_revision": body.topology_revision}
    resp = await _control(sc, request, robot_id, CMD_LEASE_ACQUIRE, args, body.idempotency_key, C.LeaseGrant, limited=True)
    if resp.status_code == 200:
        import json as _j
        lid = _j.loads(resp.body).get("lease_id")
        if lid:
            sc.ctx.leases[lid] = (sc.principal.id, sc.run_id, robot_id)
            if len(sc.ctx.leases) > 2048:
                sc.ctx.leases.pop(next(iter(sc.ctx.leases)))
    return resp


@router.post("/runs/{run_id}/robots/{robot_id}/control/heartbeat")
async def heartbeat(robot_id: str, body: C.HeartbeatRequest, request: Request, sc: RunScope = Depends(run_scope("drive"))):
    return await _control(sc, request, robot_id, CMD_LEASE_HEARTBEAT, body.model_dump(), None, C.HeartbeatAck, limited=True)


@router.post("/runs/{run_id}/robots/{robot_id}/control/release")
async def release(robot_id: str, body: C.ReleaseRequest, request: Request, sc: RunScope = Depends(run_scope("drive"))):
    resp = await _control(sc, request, robot_id, CMD_LEASE_RELEASE, body.model_dump(exclude_none=True), body.idempotency_key, C.ReleaseAck, limited=False)
    if resp.status_code == 200:
        sc.ctx.leases.pop(body.lease_id, None)
    return resp


@router.post("/runs/{run_id}/robots/{robot_id}/drive")
async def drive(robot_id: str, body: C.DriveIntent, request: Request, sc: RunScope = Depends(run_scope("drive"))):
    """Shape + auth + lease-holder only; the single-writer engine validates physics, lease epoch/TTL, seq at commit."""
    return await _control(sc, request, robot_id, CMD_DRIVE, body.model_dump(exclude_none=True), body.idempotency_key, C.DriveAck, limited=True)


# ──────────────────────────── runs / scenarios / replay / fork ────────────────────────────


def _problem(e: Exception) -> HTTPException:
    if isinstance(e, NotSupported):
        return HTTPException(501, str(e))
    if isinstance(e, RunNotFound):
        return HTTPException(404, "unknown run")
    assert isinstance(e, RunError)
    return HTTPException(e.status, e.message, headers={"X-Problem-Code": e.code})


@router.get("/runs", response_model=list[R.RunSummary], **EXC)
def list_runs(request: Request):
    ctx, p = ctx_of(request), principal_of(request)
    assert p is not None
    return [r for r in ctx.runs.list_runs() if p.can("read", r.get("run_id"))]


@router.get("/runs/{run_id}", response_model=R.RunSummary, **EXC)
def get_run(sc: RunScope = Depends(run_scope("read"))):
    rec = sc.ctx.runs.get_run(sc.run_id)
    if rec is None:
        raise HTTPException(404, "unknown run")
    return rec


@router.post("/runs", status_code=202, response_model=R.RunSummary, **EXC)
async def create_run(request: Request, body: dict = Body(...)):
    """Create either a legacy ScenarioSpec run or a fixed V8 crisis episode.

    The V8 path is generated from the canonical registry and records an immutable
    30:00 episode with the existing single-writer engine. Legacy authoring stays
    routed through the configured RunManager.
    """
    ctx, p = ctx_of(request), principal_of(request)
    assert p is not None
    if not p.can("admin"):
        raise HTTPException(403, "insufficient role")
    try:
        if isinstance(body, dict) and body.get("scenario_id") in {"CR-01", "CR-02", "CR-03", "CR-04", "CR-05", "CR-06", "CR-07", "MD-01", "MD-02"}:
            req = R.StartEpisodeRequest.model_validate(body)
            return await build_recorded_episode(ctx.engine, req.model_dump(), p.id)
        spec = R.ScenarioSpec.model_validate(body)
        return await ctx.runs.create_run(spec.model_dump(), p.id)
    except ValidationError as e:
        raise HTTPException(422, "invalid run request", headers={"X-Problem-Code": "invalid"}) from e
    except ValueError as e:
        raise HTTPException(409, str(e), headers={"X-Problem-Code": "invalid"}) from e
    except StorageError as e:
        raise HTTPException(503, str(e), headers={"X-Problem-Code": "storage_unavailable"}) from e
    except (NotSupported, RunError, RunNotFound) as e:
        raise _problem(e)


class StateRequest(C.StrictWire):
    state: Literal["running", "paused", "stopped"]


@router.post("/runs/{run_id}/state", response_model=R.RunSummary, **EXC)
async def set_run_state(body: StateRequest, sc: RunScope = Depends(run_scope("command"))):
    ext = getattr(sc.ctx.runs, "set_state", None)
    try:
        if callable(ext):
            return await ext(sc.run_id, body.state)
        if not sc.is_active or body.state == "stopped":
            raise NotSupported("this engine can only pause/resume the live run")
        kind = "pause" if body.state == "paused" else "resume"
        res = await sc.engine.submit({"command_id": _uuid(), "kind": kind, "actor_type": "operator",
                                      "principal": sc.principal.id, "run_id": sc.run_id})
        if not res.get("accepted"):
            raise RunError("invalid", str(res.get("reason") or "rejected"), 409)
        rec = sc.ctx.runs.get_run(sc.run_id)
        assert rec is not None
        return rec
    except (NotSupported, RunError, RunNotFound) as e:
        raise _problem(e)


@router.get("/runs/{run_id}/checkpoints", response_model=R.CheckpointList, **EXC)
def checkpoints(to_tick: Optional[int] = Query(default=None, ge=0), sc: RunScope = Depends(run_scope("read"))):
    return {"run_id": sc.run_id, "schema_version": RUNS_SCHEMA, "checkpoints": sc.ctx.runs.checkpoints(sc.run_id, to_tick)}


RUNS_SCHEMA = R.RUNS_SCHEMA_VERSION


@router.get("/runs/{run_id}/clock", response_model=R.EpisodeClock, **EXC)
def run_clock(sc: RunScope = Depends(run_scope("read"))):
    rec = sc.ctx.runs.get_run(sc.run_id)
    if rec is None:
        raise HTTPException(404, "unknown run")
    tick = int(rec.get("current_tick") or 0)
    speed = 1
    try:
        row = getattr(sc.ctx.runs, "_row")(sc.run_id) if hasattr(sc.ctx.runs, "_row") else None
        speed = int(float((row or {}).get("sim_speed") or 1))
    except Exception:
        speed = 1
    if speed not in (1, 2, 3):
        speed = 1
    return clock_payload(sc.run_id, tick, speed, world_version=tick, paused=rec.get("state") == "paused")


@router.get("/runs/{run_id}/replay", response_model=R.ReplayWindow, **EXC)
async def run_replay(start_tick: Optional[int] = Query(default=None, ge=0), end_tick: Optional[int] = Query(default=None, ge=0),
                     stride: int = Query(default=1, ge=1, le=100_000), events: int = Query(default=1, ge=0, le=1),
                     limit: int = Query(default=5000, ge=1), sc: RunScope = Depends(run_scope("read"))):
    """Read-only. Never mutates the live run; operators must fork to act on history."""
    try:
        out = await sc.ctx.runs.replay(sc.run_id, start_tick, end_tick, stride, bool(events),
                                       min(limit, sc.ctx.settings.replay_page_max * 10))
    except (NotSupported, RunError, RunNotFound) as e:
        raise _problem(e)
    return scrub(out)


@router.post("/runs/{run_id}/fork", status_code=201, response_model=R.ForkResult, **EXC)
async def fork(body: R.ForkRequest, sc: RunScope = Depends(run_scope("fork"))):
    try:
        return await sc.ctx.runs.fork(sc.run_id, body.model_dump(exclude_none=True), sc.principal.id)
    except (NotSupported, RunError, RunNotFound) as e:
        raise _problem(e)


class SpeedRequest(C.StrictWire):
    speed: int


@router.post("/runs/{run_id}/speed")
async def set_run_speed(body: SpeedRequest, sc: RunScope = Depends(run_scope("read"))):
    if body.speed not in (1, 2, 3):
        raise HTTPException(422, "speed must be 1, 2 or 3")
    if sc.is_active:
        sc.engine.clock.set_speed(body.speed)
    try:
        sc.ctx.runs._st.update_run(sc.run_id, sim_speed=float(body.speed))
    except Exception:
        pass
    rec = sc.ctx.runs.get_run(sc.run_id)
    return {"run_id": sc.run_id, "speed": body.speed, "run": rec}


@router.post("/runs/{run_id}/play")
async def play_run(sc: RunScope = Depends(run_scope("read"))):
    if sc.is_active:
        sc.engine.clock.resume()
    try:
        sc.ctx.runs._st.update_run(sc.run_id, phase="running")
    except Exception:
        pass
    return {"run_id": sc.run_id, "state": "running"}


@router.post("/runs/{run_id}/pause")
async def pause_run(sc: RunScope = Depends(run_scope("read"))):
    if sc.is_active:
        sc.engine.clock.pause()
    try:
        sc.ctx.runs._st.update_run(sc.run_id, phase="paused")
    except Exception:
        pass
    return {"run_id": sc.run_id, "state": "paused"}


@router.get("/runs/{run_id}/events")
def get_run_events(after_seq: int = 0, limit: int = 1000, sc: RunScope = Depends(run_scope("read"))):
    st = getattr(sc.ctx.runs, "_st", None)
    if st is None:
        return {"run_id": sc.run_id, "events": []}
    evs = st.load_events(sc.run_id, after_seq=after_seq, limit=min(limit, 5000))
    return {"run_id": sc.run_id, "events": [to_envelope(sc.run_id, e) for e in evs]}


@router.get("/runs/{run_id}/snapshots")
def get_run_snapshots(to_tick: Optional[int] = None, sc: RunScope = Depends(run_scope("read"))):
    st = getattr(sc.ctx.runs, "_st", None)
    if st is None:
        return {"run_id": sc.run_id, "snapshots": []}
    return {"run_id": sc.run_id, "snapshots": st.list_snapshots(sc.run_id, to_tick)}


@router.get("/runs/{run_id}/verdict")
def get_run_verdict(sc: RunScope = Depends(run_scope("read"))):
    row = getattr(sc.ctx.runs, "_row")(sc.run_id) if hasattr(sc.ctx.runs, "_row") else None
    if row is None:
        raise HTTPException(404, "unknown run")
    meta = row.get("meta") or {}
    verdict = meta.get("verdict")
    return {"run_id": sc.run_id, "scenario_id": row.get("scenario_id"), "verdict": verdict}


@router.get("/runs/{run_id}/incident-report")
def get_run_incident_report(sc: RunScope = Depends(run_scope("read"))):
    row = getattr(sc.ctx.runs, "_row")(sc.run_id) if hasattr(sc.ctx.runs, "_row") else None
    if row is None:
        raise HTTPException(404, "unknown run")
    meta = row.get("meta") or {}
    verdict = meta.get("verdict") or {}
    sid = row.get("scenario_id") or "live"
    return {
        "run_id": sc.run_id,
        "scenario_id": sid,
        "label": row.get("label") or sid,
        "status": row.get("phase") or "completed",
        "duration_sim_s": meta.get("duration_sim_s", 1800),
        "outcome": verdict.get("outcome", "CONTAINED"),
        "checks": verdict.get("checks", []),
        "min_margin_k": verdict.get("min_margin_k"),
        "truth_excerpt": verdict.get("truth_excerpt", {}),
    }


@router.post("/runs/{run_id}/exports")
def export_run_artifact(sc: RunScope = Depends(run_scope("read"))):
    row = getattr(sc.ctx.runs, "_row")(sc.run_id) if hasattr(sc.ctx.runs, "_row") else None
    if row is None:
        raise HTTPException(404, "unknown run")
    meta = row.get("meta") or {}
    st = getattr(sc.ctx.runs, "_st", None)
    snaps = st.list_snapshots(sc.run_id) if st else []
    evs = st.load_events(sc.run_id, limit=2000) if st else []
    export_payload = {
        "export_id": f"exp_{sc.run_id}_{int(time.time())}",
        "run_id": sc.run_id,
        "scenario_id": row.get("scenario_id"),
        "label": row.get("label"),
        "exported_at": now_iso(),
        "summary": {
            "ticks": row.get("last_tick", 0),
            "sim_duration_s": meta.get("duration_sim_s", 1800),
            "snapshots_count": len(snaps),
            "events_count": len(evs),
            "verdict": meta.get("verdict"),
        },
    }
    return export_payload


@router.post("/scenarios/validate", response_model=R.ScenarioValidation, **EXC)
async def validate_scenario(body: R.ScenarioValidateRequest, request: Request):
    """Shape/bounds check (+ the engine's physical admissibility if it offers one). NEVER submits to the live world."""
    ctx, p = ctx_of(request), principal_of(request)
    assert p is not None
    if not p.can("command"):
        raise HTTPException(403, "insufficient role")
    if (body.spec is None) == (body.text is None):
        raise HTTPException(422, "provide exactly one of 'spec' or 'text'")
    try:
        backend = ctx.engine.world().get("health", {}).get("backend", "live")
    except Exception:
        backend = "live"
    issues: list[dict] = []
    support: list[dict] = []
    spec_obj = None
    if body.text is not None:
        interp = getattr(ctx.runs, "interpret_scenario", None)
        if not callable(interp):
            return {"valid": False, "spec": None, "backend": backend, "support": [], "issues": [{
                "path": "text", "severity": "error", "message": "free-text scenario interpretation is not available on this server",
                "fix": "author the scenario with the structured form"}]}
        body.spec = await interp(body.text)
    try:
        spec_obj = R.ScenarioSpec.model_validate(body.spec)
    except ValidationError as e:
        for err in e.errors():
            issues.append({"path": ".".join(str(x) for x in err["loc"]), "severity": "error", "message": err["msg"]})
    if spec_obj is not None:
        check = getattr(ctx.runs, "validate_scenario", None)
        if callable(check):
            verdict = await check(spec_obj.model_dump())
            issues += list(verdict.get("issues", []))
            support += list(verdict.get("support", []))
        else:
            issues.append({"path": "", "severity": "info",
                           "message": "physical admissibility is checked by the engine when the run starts"})
    valid = spec_obj is not None and not any(i["severity"] == "error" for i in issues)
    return {"valid": valid, "spec": spec_obj.model_dump() if valid and spec_obj else None, "issues": issues,
            "support": support, "backend": backend}


@router.get("/scenarios")
def scenarios(request: Request):
    ctx = ctx_of(request)
    try:
        topo = ctx.engine.topology()
    except Exception:
        topo = None
    return {"scenarios": [d.to_wire(topo) for d in list_definitions()]}


@router.get("/scenarios/{scenario_id}")
def scenario_detail(scenario_id: R.ScenarioId, request: Request):
    ctx = ctx_of(request)
    try:
        topo = ctx.engine.topology()
    except Exception:
        topo = None
    return get_definition(scenario_id).to_wire(topo)


@router.post("/scenarios/{scenario_id}/validate")
def validate_v8_scenario(scenario_id: R.ScenarioId, request: Request):
    ctx = ctx_of(request)
    try:
        topo = ctx.engine.topology()
    except Exception:
        topo = None
    return get_definition(scenario_id).to_wire(topo)["readiness"]


# ─────────────────────────────── health / models ───────────────────────────────

_RANK = {"live": 0, "mock": 1, "unavailable": 2}


def model_status(ctx) -> dict:
    """Truthful ModelStatus: worst of {agent runtime, engine health}; unknown/unreadable => unavailable.

    Built from a whitelist of fields so nothing secret can ride along.
    """
    sources: dict[str, Optional[dict]] = {"runtime": None, "engine": None}
    detail = None
    try:
        if ctx.runtime is not None:
            sources["runtime"] = dict(ctx.runtime.model_status())
    except Exception:
        detail = "agent runtime did not answer"
    try:
        sources["engine"] = dict(ctx.engine.world().get("health", {}).get("intelligence") or {}) or None
    except Exception:
        detail = detail or "engine did not answer"
    known = [s for s in sources.values() if s and s.get("status") in _RANK]
    if not known:
        status, provider, model_id = "unavailable", "deterministic", "none"
        detail = detail or "no model status source"
        worst: dict = {}
    else:
        worst = max(known, key=lambda s: _RANK[s["status"]])
        status, provider, model_id = worst["status"], worst.get("provider", "deterministic"), worst.get("model_id", "unknown")
        if detail and status == "live":
            status = "unavailable"  # a source we could not read must not let "live" through
    interp = getattr(ctx.runs, "interpret_scenario", None)
    if callable(interp) and status == "live":
        text = {"available": True, "kind": "model"}
    elif callable(interp):
        text = {"available": True, "kind": "rules", "reason": "model unavailable; rule-based interpretation only"}
    else:
        text = {"available": False, "kind": "none", "reason": "free-text scenario interpretation is not enabled on this server"}
    out = {"provider": provider, "model_id": model_id, "status": status, "scenario_text": text,
           "last_checked_at": now_iso(), "online": status == "live", "fallback_active": status != "live"}
    if isinstance(worst.get("last_latency_ms"), (int, float)):
        out["last_latency_ms"] = worst["last_latency_ms"]
    if detail:
        out["detail"] = detail
    return out


def readiness(ctx) -> tuple[bool, list[str], Optional[dict]]:
    reasons: list[str] = []
    try:
        health = ctx.engine.world().get("health", {})
    except Exception:
        return False, ["engine unavailable"], None
    ext = getattr(ctx.engine, "readiness", None)
    if callable(ext):
        try:
            r = ext()
            if not r.get("ready", True):
                reasons += [str(x) for x in r.get("reasons", ["engine not ready"])]
        except Exception:
            reasons.append("engine readiness check failed")
    if health.get("database") == "unavailable":
        reasons.append("database unavailable")
    if (health.get("solver") or {}).get("status") == "failed":
        reasons.append("physics solver failed")
    return not reasons, reasons, health


@router.get("/health/live")
def health_live():
    return {"status": "ok"}


@router.get("/health")
@router.get("/health/ready")
def health_ready(request: Request):
    """Public + minimal. Details (engine health, model status) only for authenticated callers."""
    ctx = ctx_of(request)
    ok, reasons, health = readiness(ctx)
    body: dict[str, Any] = {"status": "ready" if ok else "not_ready"}
    if not ok:
        body["reasons"] = reasons
    if principal_of(request, optional=True) is not None and health is not None:
        body["backend"] = health.get("backend")
        body["health"] = health
        body["models"] = model_status(ctx)
    return JSONResponse(scrub(body), status_code=200 if ok else 503)


@router.get("/models/status", response_model=R.ModelStatus, **EXC)
def models_status(request: Request):
    principal_of(request)
    return scrub(model_status(ctx_of(request)))


@router.get("/providers/status")
def providers_status(request: Request):
    import os
    ctx = ctx_of(request)
    m = model_status(ctx)
    world = {}
    try:
        world = ctx.engine.world()
    except Exception:
        pass

    db_status = "connected"
    if getattr(ctx.engine, "db_down", False):
        db_status = "degraded"
    elif not getattr(ctx.settings, "database_url", None) and not os.environ.get("DATABASE_URL"):
        db_status = "unavailable"

    sim_status = world.get("sim_status", "running")
    if sim_status == "paused":
        engine_status = "pausing"
    elif getattr(ctx.engine, "db_down", False):
        engine_status = "restoring"
    else:
        engine_status = "running"

    status_str = "online" if m.get("status") == "live" else ("degraded" if m.get("status") == "degraded" else "unavailable")

    from loopkeeper.intelligence.laya_classifier import HAS_LAYA_SDK, get_laya_classifier
    laya_inst = get_laya_classifier()

    res = {
        "inference_provider": m.get("provider", "crusoe"),
        "configured_model": m.get("model_id", "nvidia/Nemotron-3-Nano-30B-A3B"),
        "last_successful_request_at": m.get("last_checked_at") if m.get("status") == "live" else None,
        "status": status_str,
        "database": db_status,
        "simulation_engine": engine_status,
        "last_world_tick": world.get("sim_tick", 0),
        "last_world_event_seq": world.get("last_seq", 0),
        "timestamp": now_iso(),
        "neon": {
            "status": db_status,
            "branch": os.environ.get("NEON_BRANCH", "production"),
        },
        "laya": _laya_summary(laya_inst),
    }
    return JSONResponse(scrub(res))


def _laya_eval_summary() -> dict:
    """Numbers come from the last real evaluation artifact (never hard-coded); None if it has not been run."""
    import json as _json
    from pathlib import Path as _P
    f = _P(__file__).resolve().parents[4] / "artifacts" / "v5" / "laya_eval.json"
    try:
        d = _json.loads(f.read_text())
    except Exception:
        return {"source": str(f.name), "available": False}
    out = {"source": "artifacts/v5/" + f.name, "available": True, "generated_at": d.get("generated_at"), "caveats": d.get("caveats", [])[:2]}
    for k, e in d.get("engines", {}).items():
        out[k] = ({"accuracy": e["accuracy"], "abstention_rate": e["abstention_rate"], "latency_p95_ms": e["latency_p95_ms"]}
                  if e.get("available") else {"available": False})
    return out


def _laya_summary(inst) -> dict:
    inst._get_router()
    return {"status": "advisory", "advisory_only": True, "repo": "https://github.com/NandhaKishorM/laya", "sdk_commit": "4ac226d5ee88ed6df8db288a05c766d7a34ee682",
            "has_sdk": __import__("loopkeeper.intelligence.laya_classifier", fromlist=["x"]).HAS_LAYA_SDK,
            "engine": inst.engine_name,
            "queries": inst.total_queries, "abstentions": inst.total_abstentions, "evaluation": _laya_eval_summary()}


@router.get("/intelligence/laya/status")
def laya_status():
    from loopkeeper.intelligence.laya_classifier import get_laya_classifier
    inst = get_laya_classifier()
    d = _laya_summary(inst)
    d.update(provider="Laya", role="System 1 incident triage (advisory; never grants authority)",
             confidence_threshold=inst.CONFIDENCE_THRESHOLD, total_queries=inst.total_queries, total_abstentions=inst.total_abstentions)
    return d


@router.post("/intelligence/laya/classify")
def laya_classify(body: dict):
    from loopkeeper.intelligence.laya_classifier import get_laya_classifier
    laya_inst = get_laya_classifier()
    dec = laya_inst.classify_incident(body)
    return dec.to_dict()

