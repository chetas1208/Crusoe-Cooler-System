"""Bounded recursive probe subgraph: specific unresolved sub-questions -> read-only evidence tasks.

Level N probes may propose follow-ups for level N+1. Caps: depth <= limits.max_depth, at most
limits.max_concurrent running per incident, only whitelisted read-only tools, only existing targets.
"""
from __future__ import annotations

import asyncio
from typing import Any

from langgraph.graph import END, START, StateGraph

from ..analysis import rnd
from ..context import AgentContext
from ..policy import PROBE_TOOLS
from ..session import IncidentSession, PolicyReject
from ..state import IncState
from ..world import Json, rd
from .common import S


def _probe_tool(ctx: AgentContext, tool: str, target: str) -> Json:
    fac, mon, w, h = ctx.fac, ctx.monitor, ctx.world, ctx.history
    if tool == "read_telemetry":
        r = (w.get("assets") or {}).get(target) or {}
        return {"asset": target, "status": r.get("status"), "readings": {k: rnd(v, 3) for k, v in list((r.get("readings") or {}).items())[:8]}}
    if tool == "query_topology":
        a = fac.assets.get(target) or fac.edges.get(target) or {}
        keep = ("id", "type", "label", "loop", "diameter_mm", "length_m", "robot_passable", "not_passable_reason", "edge_id", "zone_id")
        return {k: a[k] for k in keep if k in a}
    if tool == "check_mass_balance":
        edge = fac.assets.get(target, {}).get("edge_id", target)
        z = fac.edge_zone(edge)
        rs = fac.zone_all_racks(z) if z else list(fac.all_racks)
        meter = rd(w, target, "flow_kg_s", None)
        if meter is None:
            meter = rd(w, edge, "flow_kg_s", 0.0) or 0.0
        return {"meter_kg_s": rnd(meter, 2), "rack_sum_kg_s": rnd(sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in rs), 2)}
    if tool == "check_flow_normality":
        r = target if target in fac.racks else (fac.racks[0] if fac.racks else target)
        ref = mon.ref_rack_flow(r, w)
        q = rd(w, r, "flow_kg_s", 0.0) or 0.0
        return {"rack": r, "flow_residual_pct": rnd((q - ref) / ref * 100 if ref else 0.0, 1)}
    raise PolicyReject(f"probe tool {tool} not whitelisted")


def build_probe_graph(ctx: AgentContext):
    async def level(state: IncState) -> IncState:
        s = S(ctx, state, prefix="p")
        pending = list(state.get("probe_requests") or [])
        depth_ok = ctx.limits.max_depth
        nxt: list[Json] = []

        async def run_one(req: Json) -> None:
            parent = s.task_ref(req["parent_id"])
            async with ctx.sem(s.id):
                try:
                    t = s.task("sentinel", f"probe.{req['tool']}", f"Probe {req['target_id']}", req["question"], parent=parent,
                               asset_ids=[req["target_id"]], task_id=req.get("task_id"))
                except PolicyReject as e:
                    parent["tool_calls"].append({"id": f"tc_{parent['id']}_cap{len(parent['tool_calls'])}", "task_id": parent["id"], "name": "spawn_subtask",
                                                 "input": {"tool": req["tool"], "target": req["target_id"]}, "status": "rejected",
                                                 "output": {"reason": str(e)}, "tick": ctx.tick})
                    s.update_task(parent)
                    return
                facts = await s.tool(t, req["tool"], {"target": req["target_id"]}, lambda: _probe_tool(ctx, req["tool"], req["target_id"]))
                eid = s.ev("telemetry", f"{req['tool']} {req['target_id']}: {str(facts)[:140]}", asset_id=req["target_id"], tags=["probe"])
                dec = await s.decide(t, "probe", {"question": req["question"], "facts": facts, "depth": t["depth"], "can_spawn": t["depth"] < depth_ok},
                                     lambda: {"summary": f"{req['tool']} on {req['target_id']} returned the recorded readings.", "followups": []},
                                     validate=lambda d: ctx.policy.validate_followups(d.followups), suffix=f".{req['target_id']}",
                                     instruction="Summarise the probe. Propose a follow-up only for a specific unresolved sub-question.")
                s.finish(t, "completed", dec["summary"], ("Probe done", True), [eid])
                if t["depth"] < depth_ok:
                    for i, f in enumerate(dec.get("followups", [])):
                        nxt.append({**f, "parent_id": t["id"], "task_id": None, "_i": i})
                elif dec.get("followups"):
                    t["tool_calls"].append({"id": f"tc_{t['id']}_cap", "task_id": t["id"], "name": "spawn_subtask", "input": {"requested": len(dec["followups"])},
                                            "status": "rejected", "output": {"reason": f"depth cap {depth_ok} reached"}, "tick": ctx.tick})
                    s.update_task(t)

        # concurrency is bounded by the per-incident semaphore (limits.max_concurrent)
        await asyncio.gather(*(run_one(r) for r in pending[: 2 * ctx.limits.max_concurrent]))
        nxt = [r for r in nxt if r["tool"] in PROBE_TOOLS][: ctx.limits.max_concurrent]
        for r in nxt:  # deterministic task ids for the next level are assigned sequentially
            r["task_id"] = s._tid()
        return s.patch(probe_requests=nxt)

    def again(state: IncState) -> str:
        return "level" if state.get("probe_requests") else END

    g = StateGraph(IncState)
    g.add_node("level", level)
    g.add_edge(START, "level")
    g.add_conditional_edges("level", again, {"level": "level", END: END})
    return g.compile()
