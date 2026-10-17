"""OUTRIG graph: approved work request -> plan route/tools/isolation -> prepare (standby swap, cordon, isolation locks)
-> execute the engine-planned service mission -> collect result. The LLM never overrides isolation constraints."""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from ..analysis import rnd
from ..context import AgentContext
from ..plain import plain
from ..policy import CORDON_MAX_FRACTION
from ..session import PolicyReject
from ..state import IncState
from ..world import Json, rd
from .common import S, acquire_robot, pick_outrig, dispatch_and_wait, mission_id, mission_status, step_done, tool_calls_from_mission, zone_suppress_keys

ACTION_SPEC = {
    "replace_section": "pipe clamp & spool kit", "replace_strainer": "strainer basket", "service_valve": "valve actuator kit",
    "service_pump": "pump service kit", "recalibrate_sensor": "calibration kit",
}


def work_order(ctx: AgentContext, action: str, target: str, det: Json) -> Json:
    """Human-readable plan + the engine mission parameters. The engine expands `params` into its whitelisted step list."""
    fac, L = ctx.fac, ctx.fac.label
    iso = None
    if action == "replace_section":
        z = fac.edge_zone(target)
        iso = {"zone": fac.zone_short(z), "valve": fac.zone_valve(z)} if z and fac.zone_valve(z) else None
        title = f"Replace fouled section of {L(target)}"
    elif action == "service_valve":
        z = fac.rack_zone(target.replace("valve_", "rack_"))
        iso = {"zone": fac.zone_short(z), "valve": fac.zone_valve(z)} if z and fac.zone_valve(z) else None
        title = f"Service {L(target)} actuator"
    elif action == "replace_strainer":
        title = f"Replace {L(target)} basket"
    elif action == "service_pump":
        title = f"Service {L(target)}"
    elif action == "recalibrate_sensor":
        title = f"Recalibrate {L(target)}"
    else:
        return {"ok": False, "reason": f"no OUTRIG work order for {action}"}
    if action in ("replace_section", "service_valve") and iso is None:
        return {"ok": False, "reason": f"no isolation valve known for {target}"}
    steps = ["Fetch tool", f"Navigate to {L(target)} service pose", "Scan"]
    if iso:
        steps += [f"Isolate {L(iso['valve'])}"]
    steps += [title]
    if iso:
        steps += ["Pressure test at 1.5x operating", f"Re-open {L(iso['valve'])}"]
    steps += ["Return to charging bay"]
    params: Json = {"action": action}
    if iso:
        params["isolate_valve"] = iso["valve"]
    cmds = ["fetch_tool", "navigate", "scan"] + (["isolate_valve"] if iso else []) + [action] + (["pressure_test", "reopen_valve"] if iso else []) + ["return_to_dock"]
    return {"ok": True, "title": title, "tool": ACTION_SPEC[action], "isolation": iso, "steps": steps, "commands": cmds, "params": params,
            "repair_cmd": action, "nav": target}


def build_outrig_graph(ctx: AgentContext):
    zone_key = lambda iso: f"zone_{iso['zone']}"

    async def set_loads(s, task: Json, racks: list[str], factor: float, tag: str) -> bool:
        ok = True
        for r in racks:
            ack, _ = await ctx.submit(ctx.make_cmd("workload.set_load", f"{s.id}:{task['id']}:{tag}:{r}", incident_id=s.id, task_id=task["id"], role="sentinel",
                                                   target_id=r, args={"load_factor": factor}), s.id)
            ok = ok and bool(ack.get("accepted"))
        return ok

    async def receive(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        req = s.task_ref(work["request_task"])
        wo = work_order(ctx, work["action"], work["target_id"], state["det"])
        robot = pick_outrig(ctx, s.id, work["action"], work["target_id"])
        if robot is None or not wo["ok"]:
            return s.patch(work_result={"ok": False, "reason": plain(wo.get("reason", "no robot")), "raw_reason": wo.get("reason", "no OUTRIG robot available"), "kind": "service"})
        t = s.task("outrig", "service", wo["title"], "Execute the approved work order with accessible, interlocked service actions only.",
                   parent=req, robot_id=robot, asset_ids=[work["target_id"]])
        asg = ctx.assignments.get(s.id) or {}
        await s.tool(t, "select_robot", {"target": work["target_id"], "tool": wo["tool"]},
                     lambda: {"robot": robot, "eta_s": asg.get("eta_s"), "route_plan_id": asg.get("route_plan_id"), "score": asg.get("score"),
                              "candidates": [{k: v for k, v in c.items() if k in ("robot", "feasible", "score", "eta_s", "reason")} for c in asg.get("candidates", [])]})
        await s.tool(t, "compose_work_order", {"target": work["target_id"], "tool": wo["tool"]},
                     lambda: {"steps": wo["steps"], "isolation": wo["isolation"], "est_duration_s": 90 + 45 * len(wo["steps"])})
        await s.tool(t, "plan_route", {"to": wo["nav"], "planner": "A* 0.25 m grid - 0.55 m clearance"}, lambda: {"waypoints": "engine-planned", "target": wo["nav"]})
        work.update(task_id=t["id"], robot=robot, wo=wo)
        return s.patch(work=work)

    def after_receive(state: IncState) -> str:
        return END if (state.get("work_result") or {}).get("ok") is False else "prepare"

    async def prepare(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        wo, robot, act = work["wo"], work["robot"], work["action"]
        t = {**s.task_ref(work["task_id"])}
        t["tool_calls"] = list(t["tool_calls"])
        req = s.task_ref(work["request_task"])
        root = s.task_ref(s.inc["task_ids"][0])

        def fail(raw: str, label: str) -> IncState:
            s.finish(t, "failed", f"The work order could not start: {plain(raw)}.", (label, False))
            ctx.locks.release_all(s.id)
            for r in [r for r, (o, _) in ctx.maint.items() if o == s.id]:
                ctx.maint[r] = (s.id, ctx.now + ctx.limits.settle_grace_s)
            return s.patch(work_result={"ok": False, "reason": plain(raw), "raw_reason": raw, "kind": "service"})

        if not await acquire_robot(ctx, robot, s.id):
            return fail("robot busy", "Robot unavailable")
        if act == "service_pump":
            pump = work["target_id"]
            standby = next((p for p in ctx.fac.tcs_pumps if p != pump), None)
            mit = s.task("sentinel", "mitigate", "Swap to standby pump", "Can we restore flow immediately without a physical repair?", parent=root,
                         caused_by=[req], asset_ids=[pump, standby or ""])
            box: Json = {}

            async def _swap() -> Json:
                ack, _ = await ctx.submit(ctx.make_cmd("pump.switch_duty", f"{s.id}:{mit['id']}:swap", incident_id=s.id, task_id=mit["id"], role="sentinel",
                                                       target_id=standby, args={}), s.id)
                box["ack"] = ack
                if not ack.get("accepted"):
                    raise PolicyReject(ack.get("reason", "rejected"))
                return {"duty": standby}

            if standby:
                await s.tool(mit, "command_bus.switch_duty", {"from": pump, "to": standby, "preconditions": ["standby_healthy"]}, _swap)
            if not standby or not box.get("ack", {}).get("accepted"):
                s.finish(mit, "failed", "The standby pump could not take over, so the degraded pump stays on duty.", ("Swap rejected", False))
                return fail("standby swap rejected", "Swap rejected")
            await ctx.wait_until(lambda: (rd(ctx.world, standby, "speed_pct", 0.0) or 0.0) > 0, 60)
            s.ev("action", f"Duty swapped from {ctx.fac.label(pump)} to {ctx.fac.label(standby)}", asset_id=standby)
            s.finish(mit, "completed", f"{ctx.fac.label(standby)} is now duty. Flow is recovering while {ctx.fac.label(pump)} is serviced offline - no isolation needed.",
                     ("Standby on duty", True))
            await ctx.sleep_sim(20)
        iso = wo["isolation"]
        if iso:
            ok = await ctx.wait_until(lambda: ctx.locks.try_isolation(s.id), ctx.limits.mission_timeout_s)
            if not ok:
                return fail("isolation lock busy", "Isolation busy")
            z = zone_key(iso)
            ctx.lock_suppress(zone_suppress_keys(ctx, z))
            for r in ctx.fac.zone_racks(z):
                ctx.maint[r] = (s.id, float("inf"))
            edges = ctx.fac.zone_edges(z)
            crawlers_out = lambda: not any(r.get("class") == "inpipe" and (r.get("pose") or {}).get("segment_id") in edges and r.get("mode") != "DOCKED"
                                           for r in (ctx.world.get("robots") or {}).values())
            zone_unlocked = lambda: crawlers_out() and (not hasattr(ctx, "engine") or not hasattr(ctx.engine, "locks") or ctx.engine.locks.conflicts(f"zone:{z}", s.id, True) is None)
            await ctx.wait_until(zone_unlocked, ctx.limits.mission_timeout_s)
            racks = ctx.fac.zone_racks(z)
            names = " & ".join(r.replace("rack_", "").upper() for r in racks)
            s.set_status("mitigating", f"Moving workload off racks {names} before isolating the zone.")
            cord = s.task("sentinel", "cordon", "Cordon racks", "Migrate workload off the affected racks so isolation costs no compute.", parent=root, caused_by=[req])

            async def _migrate() -> Json:
                if not await set_loads(s, cord, racks, 0.1, "cordon"):
                    raise PolicyReject("workload move rejected")
                return {"status": "draining", "target_load_pct": 10}

            await s.tool(cord, "migrate_workload", {"racks": racks, "target_load_pct": 10}, _migrate)
            low = lambda: all((rd(ctx.world, r, "power_kw", 0.0) or 0.0) <= CORDON_MAX_FRACTION * ctx.fac.nominal_rack_kw for r in racks)
            if not await ctx.wait_until(low, 240):
                await set_loads(s, cord, racks, 1.0, "uncordon")
                s.finish(cord, "failed", "Racks did not drain in time; isolation was not attempted.", ("Cordon failed", False))
                return fail("cordon failed", "Cordon failed")
            s.ev("action", f"Workload moved off racks {names} (load reduced to 10%)", asset_id=racks[0])
            s.finish(cord, "completed", f"Racks {names} drained to idle; heat load removed before isolation.", ("Racks cordoned", True))
        else:
            ctx.lock_suppress([work["target_id"]])
            s.set_status("mitigating", "OUTRIG is preparing the work.")
        s.update_task(t)
        return s.patch(work=work)

    def after_prepare(state: IncState) -> str:
        return END if (state.get("work_result") or {}).get("ok") is False else "execute"

    async def execute(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        wo, robot = work["wo"], work["robot"]
        t = {**s.task_ref(work["task_id"])}
        t["tool_calls"] = list(t["tool_calls"])
        attempt = int(state.get("attempt", 0))
        s.set_status("mitigating", f"OUTRIG is executing: {wo['title']}.")
        iso = wo["isolation"]
        z = zone_key(iso) if iso else None
        target = work["target_id"]
        mid = mission_id(s.id, "svc", attempt)

        if hasattr(ctx, "engine") and hasattr(ctx.engine, "locks"):
            def locks_ready():
                if ctx.engine.locks.conflicts(f"asset:{target}", mid, True):
                    return False
                if z and ctx.engine.locks.conflicts(f"zone:{z}", mid, True):
                    return False
                return True
            await ctx.wait_until(locks_ready, ctx.limits.mission_timeout_s)

        res = await dispatch_and_wait(ctx, s, t, robot_id=robot, mid=mid, mission_kind="service", title=wo["title"],
                                      target_id=target, params=wo["params"], approval_id=work.get("approval_id"), cmd_tag=f"svc{attempt}",
                                      wait=False, expect=wo["commands"])
        for retry in range(4):
            if res["ok"] or "resource_locked" not in (res.get("raw_reason") or ""):
                break
            await ctx.sleep_sim(15)
            res = await dispatch_and_wait(ctx, s, t, robot_id=robot, mid=mid, mission_kind="service", title=wo["title"],
                                          target_id=target, params=wo["params"], approval_id=work.get("approval_id"), cmd_tag=f"svc{attempt}_r{retry}",
                                          wait=False, expect=wo["commands"])

        if not res["ok"]:
            s.finish(t, "failed", f"The work order was declined: {res.get('reason')}.", ("Rejected", False))
            if iso:
                await set_loads(s, t, ctx.fac.zone_racks(zone_key(iso)), 1.0, f"restore{attempt}")
            ctx.locks.release_all(s.id)
            return s.patch(work_result={"ok": False, "reason": res.get("reason"), "raw_reason": res.get("raw_reason"), "kind": "service"})
        mid = res["mission_id"]
        ok = await ctx.wait_until(lambda: step_done(ctx.world, mid, wo["repair_cmd"]) or mission_status(ctx.world, mid)[0] == "failed", ctx.limits.mission_timeout_s)
        failed = mission_status(ctx.world, mid)[0] == "failed" or not ok
        if not failed:
            s.stage("repaired")
            if wo["isolation"]:
                await ctx.wait_until(lambda: step_done(ctx.world, mid, "reopen_valve") or mission_status(ctx.world, mid)[0] == "failed", ctx.limits.mission_timeout_s)
        iso = wo["isolation"]
        if iso:
            s.ev("action", f"Zone {iso['zone'].upper()} re-opened; restoring workload", asset_id=iso["valve"])
            await set_loads(s, t, ctx.fac.zone_racks(zone_key(iso)), 1.0, f"restore{attempt}")
        await ctx.wait_until(lambda: mission_status(ctx.world, mid)[0] in ("done", "failed"), ctx.limits.mission_timeout_s)
        st, m = mission_status(ctx.world, mid)
        tool_calls_from_mission(s, t, m)
        s.update_task(t)
        good = st == "done" and not failed
        raw = next((x.get("result", "") for x in (m or {}).get("steps", []) if x.get("status") == "failed"), "") or (m or {}).get("failure_reason") or "work order did not complete"
        return s.patch(work_result={"ok": good, "reason": "" if good else plain(raw), "raw_reason": "" if good else raw, "kind": "service", "mission_id": mid})

    async def finish(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        wr = dict(state["work_result"])
        wo, robot = work["wo"], work["robot"]
        t = {**s.task_ref(work["task_id"])}
        t["tool_calls"] = list(t["tool_calls"])
        iso = wo["isolation"]
        ctx.locks.release_robot(robot, s.id)
        ctx.locks.release_isolation(s.id)
        zkeys = zone_suppress_keys(ctx, zone_key(iso)) if iso else [work["target_id"]]
        ctx.lock_suppress(zkeys, ctx.now + ctx.limits.settle_grace_s)
        if iso:
            for r in ctx.fac.zone_racks(zone_key(iso)):
                ctx.maint[r] = (s.id, ctx.now + ctx.limits.settle_grace_s)
        if not wr.get("ok"):
            s.finish(t, "failed", f"The work order did not complete: {wr.get('reason')}. Zone state needs operator review.", ("Work failed", False))
            return s.patch(work_result=wr)
        if work["action"] == "service_pump":
            pump = work["target_id"]
            standby = next((p for p in ctx.fac.tcs_pumps if p != pump), None)
            back = s.task("sentinel", "trial", f"Trial run {ctx.fac.label(pump)}", "Does the serviced pump deliver its curve under load?",
                          parent=s.task_ref(s.inc["task_ids"][0]), asset_ids=[pump])

            async def _back() -> Json:
                ack, _ = await ctx.submit(ctx.make_cmd("pump.switch_duty", f"{s.id}:{back['id']}:swapback", incident_id=s.id, task_id=back["id"], role="sentinel",
                                                       target_id=pump, args={}), s.id)
                if not ack.get("accepted"):
                    raise PolicyReject(ack.get("reason", "rejected"))
                return {"duty": pump}

            await s.tool(back, "command_bus.switch_duty", {"from": standby, "to": pump}, _back)
            await ctx.wait_until(lambda: (rd(ctx.world, pump, "speed_pct", 0.0) or 0.0) > 0, 60)
            s.finish(back, "completed", f"{ctx.fac.label(pump)} returned to duty for the verification trial.", ("Trial started", True))
            await ctx.sleep_sim(12)
        s.finish(t, "completed", f"Work order complete: {wo['title']}.", ("Work complete", True))
        return s.patch(work_result=wr)

    g = StateGraph(IncState)
    g.add_node("receive", receive)
    g.add_node("prepare", prepare)
    g.add_node("execute", execute)
    g.add_node("finish", finish)
    g.add_edge(START, "receive")
    g.add_conditional_edges("receive", after_receive, {END: END, "prepare": "prepare"})
    g.add_conditional_edges("prepare", after_prepare, {END: END, "execute": "execute"})
    g.add_edge("execute", "finish")
    g.add_edge("finish", END)
    return g.compile()
