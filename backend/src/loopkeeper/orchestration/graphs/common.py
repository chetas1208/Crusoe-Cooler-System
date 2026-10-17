"""Helpers shared by the SENTINEL / INPIPE / OUTRIG / verifier graphs."""
from __future__ import annotations

from typing import Any

from ..analysis import rnd
from ..context import AgentContext
from ..plain import plain
from ..session import IncidentSession, PolicyReject, inc_num
from ..world import Json, rd

DOCKED_MODES = {"DOCKED", "IDLE"}


def S(ctx: AgentContext, state: Json, prefix: str = "") -> IncidentSession:
    return IncidentSession(ctx, state, ev_prefix=prefix)


def sentinel_root(state: Json) -> Json:
    return state["tasks"][state["incident"]["task_ids"][0]]


def mission_id(inc_id: str, tag: str, attempt: int) -> str:
    return f"m_{inc_num(inc_id)}_{tag}{attempt}"


def mission_status(world: Json, mid: str) -> tuple[str, Json | None]:
    m = (world.get("missions") or {}).get(mid)
    if not m:
        return "pending", None
    steps = m.get("steps") or []
    if m.get("outcome") in ("failed", "aborted") or any(s.get("status") == "failed" for s in steps) or m.get("status") in ("FAILED", "ABORTED"):
        return "failed", m
    if m.get("closed_tick") is not None or (steps and all(s.get("status") in ("done", "skipped") for s in steps)):
        return "done", m
    return "running", m


def step_done(world: Json, mid: str, command: str) -> bool:
    m = (world.get("missions") or {}).get(mid) or {}
    return any(s.get("command") == command and s.get("status") == "done" for s in m.get("steps", []))


def _tools(r: Json) -> list[str]:
    return [str(t).lower() for t in ((r.get("capabilities") or {}).get("tools") or [])]


def pick_crawler(ctx: AgentContext, edge: str, s_m: float, inc: str, prefer_tool: str | None = "brush") -> tuple[str, float] | None:
    """Nearest reachable, unreserved crawler. Crawlers that carry `prefer_tool` (the brush) win over inspection-only units, because the
    same unit is reused if the incident turns into a cleaning job; an inspection-only unit is used when no brush unit can get there."""
    best: tuple[str, float] | None = None
    best_key: tuple[int, float] | None = None
    for rid, r in (ctx.world.get("robots") or {}).items():
        if r.get("class") != "inpipe" or r.get("mode") in ("FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD", "BLOCKED"):
            continue
        if ctx.locks.robot_owner.get(rid) not in (None, inc):
            continue
        pose = r.get("pose") or {}
        seg = pose.get("segment_id")
        if not seg:
            continue
        min_bore = (r.get("capabilities") or {}).get("min_bore_mm") or 0
        if min_bore and float((ctx.fac.edges.get(edge) or {}).get("diameter_mm", 1e9)) < float(min_bore):
            continue
        rt = ctx.fac.route((seg, float(pose.get("s_m") or 0.0)), (edge, s_m))
        if not rt:
            continue
        key = (0 if (not prefer_tool or prefer_tool in " ".join(_tools(r))) else 1, rt[0])
        if best_key is None or key < best_key:
            best, best_key = (rid, rt[0]), key
    return best


def nav_target(ctx: AgentContext, target: str) -> Any:
    """Graph-resolvable target for an agent job: an asset with a service pose, the isolation valve of a pipe's zone, or a plan-view point."""
    fac = ctx.fac
    a = fac.assets.get(target)
    if a and a.get("service_xyz_m"):
        return target
    e = fac.edges.get(target)
    if e:
        z = e.get("zone_id")
        zv = fac.zone_valve(z) if z else None
        if zv and fac.assets.get(zv, {}).get("service_xyz_m"):
            return zv
        pts = e["centerline_xyz_m"]
        m = pts[len(pts) // 2]
        return {"x": m[0], "z": m[2]}
    if a:
        return {"x": a["position_xyz_m"][0], "z": a["position_xyz_m"][2]}
    return target


def pick_outrig(ctx: AgentContext, inc: str, action: str, target: str, urgency: float = 1.0) -> str | None:
    """Feasible-robot scoring (no LLM): the unit must carry the action's tool, be free for this incident, have battery, and have a legal
    route (reach, access, turn clearance, traffic); the score is ETA including reservation waits + a busy penalty + a low-battery penalty.
    The winning ETA / route plan id are recorded in ctx.assignments[incident] and, once the robot arrives, compared with the actual arrival."""
    from loopkeeper.engine.robots.actions import ACTIONS, tool_matches
    spec = ACTIONS.get(action)
    kw = tuple(spec.tools) if spec and spec.tools else ()
    nav = getattr(ctx.engine, "navigation", None)
    tgt = nav_target(ctx, target)
    sp = (ctx.fac.assets.get(target) or {}).get("service_xyz_m") or ctx.fac.pos_of(target)
    rows: list[Json] = []
    for rid, r in sorted((ctx.world.get("robots") or {}).items()):
        if r.get("class") != "outrig" or ctx.locks.robot_owner.get(rid) not in (None, inc):
            continue
        if (r.get("mode") or "").upper() in ("FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD", "BLOCKED"):
            continue
        tools_ok = not kw or tool_matches(" ".join(_tools(r)), kw)
        if not tools_ok or float(r.get("battery_pct") or 0.0) < 25.0:
            rows.append({"robot": rid, "feasible": False, "reason": "TOOL" if not tools_ok else "BATTERY"})
            continue
        if nav is not None:
            sc = nav.score(rid, tgt, tools_ok=True, urgency=urgency)
            if not sc.get("feasible"):
                rows.append({"robot": rid, "feasible": False, "reason": sc.get("reason"), "detail": sc.get("detail")})
                continue
            rows.append({"robot": rid, "feasible": True, "score": sc["score"], "eta_s": sc["eta_s"], "route_plan_id": sc["route_plan_id"],
                         "length_m": sc["length_m"], "wait_s": sc.get("wait_s", 0.0)})
        else:
            p = (r.get("pose") or {}).get("position_xyz_m") or [0, 0, 0]
            d = ((p[0] - sp[0]) ** 2 + (p[2] - sp[2]) ** 2) ** 0.5
            idle = (r.get("mode") or "").upper() in ("DOCKED", "IDLE")
            rows.append({"robot": rid, "feasible": True, "score": d + (0 if idle else 60.0), "eta_s": d / 0.4, "route_plan_id": None})
    ok = sorted((x for x in rows if x["feasible"]), key=lambda x: (x["score"], x["robot"]))
    if not ok:
        ctx.assignments[inc] = {"robot": None, "candidates": rows[:10]}
        return None
    best = ok[0]
    ctx.assignments[inc] = {"robot": best["robot"], "eta_s": best["eta_s"], "route_plan_id": best["route_plan_id"], "score": best["score"],
                            "candidates": rows[:10], "at_s": ctx.now}
    return best["robot"]


def tool_calls_from_mission(s: IncidentSession, task: Json, mission: Json | None) -> None:
    """Append one completed tool call per executed mission step (real engine results only; raw detail stays here, redacted)."""
    from ..context import redact
    if not mission:
        return
    for st in mission.get("steps", []):
        if st.get("status") not in ("done", "failed"):
            continue
        cid = f"tc_{task['id']}_s_{st.get('id')}"
        if any(c["id"] == cid for c in task["tool_calls"]):
            continue
        out: Json = {"result": st.get("result", "")}
        if isinstance(st.get("data"), dict):
            out["observation"] = {k: v for k, v in st["data"].items() if isinstance(v, (int, float, str, bool)) or v is None}
        call = {"id": cid, "task_id": task["id"], "name": st.get("command", "step"), "input": redact({"label": st.get("label", ""), **(st.get("args") or {})}),
                "status": "ok" if st.get("status") == "done" else "error", "tick": st.get("ended_tick") or s.ctx.tick, "output": redact(out)}
        task["tool_calls"].append(call)
        s.ctx.emit("agent.tool", task["id"], {"task_id": task["id"], "tool_call": call})


async def dispatch_and_wait(ctx: AgentContext, s: IncidentSession, task: Json, *, robot_id: str, mid: str, mission_kind: str,
                            title: str, target_id: str, params: Json | None = None, approval_id: str | None = None,
                            cmd_tag: str = "mission", wait: bool = True, expect: list[str] | None = None) -> Json:
    """Policy-gate + submit a mission (engine plans the steps), then wait on world state. Returns {ok, mission, reason, raw_reason}."""
    args: Json = {"robot_id": robot_id, "mission_id": mid, "kind": mission_kind, "title": title, "target_id": target_id,
                  "incident_id": s.id, "agent_task_id": task["id"]}
    if params:
        args["params"] = params
    if approval_id:
        args["approval_id"] = approval_id
    cmd = ctx.make_cmd("robot.mission.assign", f"{s.id}:{task['id']}:{cmd_tag}", incident_id=s.id, task_id=task["id"],
                       role=task["role"], target_id=target_id, args=args)
    box: Json = {}

    async def _submit() -> Json:
        ack, verdict = await ctx.submit(cmd, s.id)
        box["ack"], box["verdict"] = ack, verdict
        if not ack.get("accepted"):
            raise PolicyReject(ack.get("reason", "rejected"))
        return {"accepted": True, "mission_id": ack.get("mission_id", mid), "gates": [g["gate"] for g in verdict.gates if g["ok"]][:8],
                "expected_steps": expect or []}

    await s.tool(task, "dispatch_mission", {"robot": robot_id, "mission": mid, "kind": mission_kind, "params": params or {}}, _submit)
    ack = box.get("ack", {})
    if not ack.get("accepted"):
        return {"ok": False, "raw_reason": ack.get("reason", "rejected"), "reason": plain(ack.get("reason", "rejected")), "mission": None, "mission_id": mid}
    mid = ack.get("mission_id") or mid
    if mid not in s.inc["mission_ids"]:
        s.inc["mission_ids"].append(mid)
        s.touch()
    if not wait:
        return {"ok": True, "mission": None, "mission_id": mid}
    done = await ctx.wait_until(lambda: mission_status(ctx.world, mid)[0] in ("done", "failed"), ctx.limits.mission_timeout_s)
    st, m = mission_status(ctx.world, mid)
    if not done:
        c = ctx.make_cmd("robot.mission.cancel", f"{s.id}:{task['id']}:cancel", incident_id=s.id, task_id=task["id"], role=task["role"],
                         target_id=mid, args={"mission_id": mid, "reason": "orchestrator timeout"})
        await ctx.submit(c, s.id)
        tool_calls_from_mission(s, task, m)
        return {"ok": False, "raw_reason": "mission timeout", "reason": plain("timeout"), "mission": m, "mission_id": mid}
    tool_calls_from_mission(s, task, m)
    raw = next((x.get("result", "") for x in (m or {}).get("steps", []) if x.get("status") == "failed"), "") or (m or {}).get("failure_reason") or ""
    return {"ok": st == "done", "raw_reason": raw, "reason": "" if st == "done" else plain(raw or "failed"), "mission": m, "mission_id": mid}


async def acquire_robot(ctx: AgentContext, robot_id: str, inc: str) -> bool:
    """Atomic check-and-claim (no await between the check and the claim)."""
    def claim() -> bool:
        r = (ctx.world.get("robots") or {}).get(robot_id) or {}
        owner = ctx.locks.robot_owner.get(robot_id)
        if owner == inc or (owner is None and r.get("mode") in DOCKED_MODES):
            return ctx.locks.try_robot(robot_id, inc)
        return False

    return await ctx.wait_until(claim, ctx.limits.mission_timeout_s)


def worst_margin(ctx: AgentContext, racks: list[str]) -> float:
    return min([ctx.monitor.margin(r, ctx.world) for r in racks] or [99.0])


def zone_suppress_keys(ctx: AgentContext, zone_id: str) -> list[str]:
    z = ctx.fac.zone_short(zone_id)
    racks = ctx.fac.zone_racks(zone_id)
    ids = [*ctx.fac.zone_edges(zone_id), f"valve_z{z}"]
    for r in racks:
        ids += [r, r.replace("rack_", "valve_")]
    ids += [s for s in ctx.fac.flow_sensors if ctx.fac.edge_zone(ctx.fac.assets[s]["edge_id"]) == zone_id]
    return ids


async def fire_return(ctx: AgentContext, s: IncidentSession, robot: str, parent: Json, tag: str, text: str) -> None:
    """Send a crawler home (engine executes; the graph does not block on it)."""
    t = s.task("inpipe", "return", f"{robot.upper().replace('_', '-')} return to port", "Return safely to the launch port with battery reserve intact.",
               parent=parent, robot_id=robot)
    home = (ctx.world["robots"].get(robot) or {}).get("home_id", robot)
    res = await dispatch_and_wait(ctx, s, t, robot_id=robot, mid=mission_id(s.id, "ret", len(s.inc["mission_ids"])), mission_kind="return",
                                  title=f"Return {robot} to port", target_id=home, cmd_tag=tag, wait=False, expect=["return_to_port"])
    if res["ok"]:
        s.finish(t, "completed", text, ("Returning", True))
    else:
        s.finish(t, "failed", f"The return job was declined: {res.get('reason')}.", ("Return declined", False))
