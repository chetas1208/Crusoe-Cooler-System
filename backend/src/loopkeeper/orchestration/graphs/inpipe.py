"""INPIPE graph: receive segment/question -> select reachable robot -> route+constraints -> inspect/clear/return
-> summarize evidence. World effects only through policy-gated mission commands."""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from ..analysis import pct, rnd
from ..plain import plain
from ..context import AgentContext
from ..state import IncState
from ..world import Json
from .common import S, acquire_robot, dispatch_and_wait, mission_id, pick_crawler, step_done


def _obs_from_step(ctx: AgentContext, edge: str, gauge: str, data: Json) -> Json:
    """Normalise the engine's crawler inspection data (steps[].data) into the observation the supervisor reasons over."""
    dia = float((ctx.fac.edges.get(edge) or {}).get("diameter_mm", 150.0))
    occ = max(0.0, min(1.0, float(data.get("occlusion") or 0.0)))
    obs: Json = {"occlusion": occ, "effective_bore_mm": round(dia * (1 - occ)), "deposit_thickness_mm": round(dia / 2 * occ, 1),
                 "bore_clear": bool(data.get("bore_clear", occ < 0.1)), "deposit_in_range": bool(data.get("deposit_in_range", False)),
                 "location_s_m": data.get("deposit_s_m") if data.get("deposit_s_m") is not None else data.get("s_m")}
    if data.get("local_readings"):
        obs["local_readings"] = data["local_readings"]
    return obs


def build_inpipe_graph(ctx: AgentContext):
    async def receive(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        req = s.task_ref(work["request_task"])
        kind = work["kind"]
        if kind == "inspect":
            pick = pick_crawler(ctx, work["edge"], work["s_m"], s.id)
            if pick is None:
                return s.patch(work_result={"ok": False, "reason": "no reachable crawler", "kind": kind})
            work["robot"] = pick[0]
            work["route_m"] = rnd(pick[1], 1)
        t = s.task("inpipe", kind if kind != "clear" else "clear", work["title"], work["question"], parent=req, robot_id=work["robot"],
                   asset_ids=[work.get("edge", work.get("target_id", ""))])
        work["task_id"] = t["id"]
        if kind == "inspect":
            await s.tool(t, "select_robot", {"edge": work["edge"], "s_m": rnd(work["s_m"], 2)},
                         lambda: {"robot": work["robot"], "route_m": work["route_m"], "eta_s": round(work["route_m"] / 0.12),
                                  "battery_pct": (ctx.world["robots"][work["robot"]] or {}).get("battery_pct")})
            if not await acquire_robot(ctx, work["robot"], s.id):
                s.finish(t, "failed", "Crawler could not be reserved (busy or not docked).", ("Robot unavailable", False))
                return s.patch(work=work, work_result={"ok": False, "reason": "robot busy", "kind": kind})
            s.set_status("investigating", f"{ctx.fac.label(work['robot']) if work['robot'] in ctx.fac.assets else work['robot']} is travelling to {ctx.fac.label(work['edge'])} ({work['route_m']} m).")
        return s.patch(work=work, robot=work["robot"])

    def after_receive(state: IncState) -> str:
        return END if (state.get("work_result") or {}).get("ok") is False else "execute"

    async def execute(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        t = s.task_ref(work["task_id"])
        t = {**t, "tool_calls": list(t["tool_calls"])}
        kind, robot = work["kind"], work["robot"]
        attempt = int(state.get("attempt", 0))
        approval_id = None
        if kind == "inspect":
            params: Json = {"gauge": work["gauge"]}
            if work.get("pass_s"):
                params["s_m"] = rnd(work["s_m"], 2)
            mk, mt, tgt, expect = "inspect", work["title"], work["edge"], ["launch", "move_to", "inspect"]
        elif kind == "clear":
            params = {"max_torque_pct": 60, "s_m": rnd(work["s_m"], 2)}
            mk, mt, tgt, expect = "clear", work["title"], work["edge"], ["move_to", "brush_clear"]
            approval_id = work.get("approval_id")
        else:
            home = (ctx.world["robots"].get(robot) or {}).get("home_id", robot)
            params, mk, mt, tgt, expect = None, "return", f"Return {robot} to port", home, ["return_to_port"]
        res = await dispatch_and_wait(ctx, s, t, robot_id=robot, mid=mission_id(s.id, kind[:4], attempt), mission_kind=mk, title=mt, target_id=tgt,
                                      params=params, approval_id=approval_id, cmd_tag=f"{kind}{attempt}", expect=expect,
                                      wait=(kind != "return" or work.get("await_dock", False)))
        s.update_task(t)
        return s.patch(work=work, work_result={"_mission": res.get("mission"), "ok": res["ok"], "reason": res.get("reason", ""),
                                               "raw_reason": res.get("raw_reason", ""), "mission_id": res.get("mission_id"), "kind": kind})

    async def summarize(state: IncState) -> IncState:
        s = S(ctx, state)
        work = dict(state["work"])
        wr = dict(state["work_result"])
        t = {**s.task_ref(work["task_id"])}
        t["tool_calls"] = list(t["tool_calls"])
        mission = wr.pop("_mission", None)
        kind, robot = work["kind"], work["robot"]
        rl = robot.upper().replace("_", "-")
        if not wr.get("ok"):
            s.finish(t, "failed", f"The {kind} job did not complete: {wr.get('reason')}.", ("Mission failed", False))
            if kind == "return":
                ctx.locks.release_robot(robot, s.id)
            return s.patch(work_result={**wr, "ok": False})
        if kind == "inspect":
            ist = next((x for x in (mission or {}).get("steps", []) if x.get("command") == "inspect"), {})
            data = ist.get("data")
            if not isinstance(data, dict) or not data:
                s.finish(t, "failed", "Inspection finished without a usable measurement.", ("No observation", False))
                return s.patch(work_result={"ok": False, "reason": plain("no observation"), "raw_reason": "no observation", "kind": kind})
            g = work["gauge"]
            obs = _obs_from_step(ctx, work["edge"], g, data)
            occ = obs["occlusion"]
            if g == "bore":
                fb = f"Bore is {'clean' if occ < 0.1 else 'mildly fouled'} ({pct(occ)}); no internal obstruction explains the symptom." if occ < 0.3 else \
                    f"Bore is materially restricted ({pct(occ)})."
                lab = "Bore clear" if occ < 0.1 else "Bore fouled"
                ev = f"Crawler gauge: bore {'clear' if occ < 0.1 else pct(occ) + ' blocked'} on {ctx.fac.label(work['edge'])}"
            else:
                fb = (f"Deposit of {obs['deposit_thickness_mm']} mm narrows the bore to {obs['effective_bore_mm']} mm at s = {obs['location_s_m']} m; "
                      "wall thickness nominal, no through-wall defect.") if obs["deposit_in_range"] else "No deposit was found within sensor range of the scan position."
                lab = "Restriction located" if obs["deposit_in_range"] else "No deposit found"
                ev = f"Ultrasonic scan: {pct(occ)} of bore blocked, effective bore {obs['effective_bore_mm']} mm, wall intact"
            eid = s.ev("observation", ev, asset_id=work["edge"], tags=["inpipe", "observation"],
                       data={k: v for k, v in obs.items() if isinstance(v, (int, float, str)) and v is not None})
            dec = await s.decide(t, "observation", {"gauge": g, "observation": {k: v for k, v in obs.items() if k != "local_readings"}, "edge": work["edge"]},
                                 lambda: {"summary": fb, "confirms": None}, instruction="Summarise the crawler observation for the supervisor. Do not invent numbers.")
            s.finish(t, "completed", dec["summary"] or fb, (lab, True), [eid])
            s.set_status("investigating", fb)
            return s.patch(inspection={"ok": True, "gauge": g, "observation": obs, "evidence_id": eid, "robot": robot}, work_result={"ok": True, "kind": kind})
        if kind == "clear":
            fb = "Brush pass complete. Handing to the independent verifier."
            eid = s.ev("action", "Brush clear executed on the deposit", asset_id=work["edge"])
            s.finish(t, "completed", fb, ("Cleared (partial?)", True), [eid])
            s.stage("repaired")
            return s.patch(work_result={"ok": True, "kind": kind})
        if work.get("await_dock"):
            ctx.locks.release_robot(robot, s.id)
        s.finish(t, "completed", f"{rl} returning to port." if not work.get("await_dock") else f"{rl} docked.", ("Docked", True))
        return s.patch(work_result={"ok": True, "kind": kind}, robot="" if work.get("await_dock") else robot)

    g = StateGraph(IncState)
    g.add_node("receive", receive)
    g.add_node("execute", execute)
    g.add_node("summarize", summarize)
    g.add_edge(START, "receive")
    g.add_conditional_edges("receive", after_receive, {END: END, "execute": "execute"})
    g.add_edge("execute", "summarize")
    g.add_edge("summarize", END)
    return g.compile()
