"""Independent verifier graph: stabilisation window -> counterfactual before/after comparison -> verdict.

The verdict is computed deterministically from measurements; the model may only phrase the summary.
A rejected result stays rejected (stage_log outcome='rejected') and triggers a replan in SENTINEL.
"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from ..analysis import (checks_for, compute_metrics, healthy_reference, other_affected, rnd, twin_counterfactual)
from ..context import AgentContext
from ..state import IncState
from ..world import Json
from .common import S

WINDOW_SCALE = {"pump_degradation": 45.0 / 55.0, "sensor_drift": 35.0 / 55.0}


def build_verifier_graph(ctx: AgentContext):
    async def verify(state: IncState) -> IncState:
        s = S(ctx, state)
        det, plan = state["det"], state["plan"]
        lim = ctx.limits
        window = lim.verify_window_s * WINDOW_SCALE.get(det["cause"], 1.0)
        parent = s.task_ref(plan["decide_task"])
        t = s.task("sentinel", "verify", "Independent verification",
                   "Did measured hydraulics and thermal margin genuinely recover - without new problems downstream?", parent=parent)
        attempt = s.inc["attempts"] + 1
        v: Json = {"id": f"ver_{s.id}_{attempt}", "incident_id": s.id, "attempt": attempt, "status": "pending", "window_s": window,
                   "elapsed_s": 0.0, "progress": 0.0, "checks": [], "confidence": 0.0, "started_tick": ctx.tick}
        s.inc["verification"] = v
        s.set_status("verifying", "Stabilisation window running - verifier is watching flow, dP and thermal margin.")
        ctx.emit("verification.result", s.id, {"verification": v})
        racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
        mine = int(s.id.split("-")[-1])

        loop_wide = ("strainer_blockage", "pump_degradation")

        def overlapping() -> bool:
            """Judge after concurrent repairs that distort this verdict have settled. Same-rack incidents: older ones first
            (deadlock-free by age). Loop-wide faults (strainer, pump) shift EVERY flow, so branch-level verdicts wait for them
            (loop-wide incidents only wait for older loop-wide ones: the dependency graph stays acyclic)."""
            for i in ctx.ledger.incidents.values():
                if i["id"] == s.id or i.get("closed_tick") is not None or i.get("status") == "escalated":
                    continue
                if i.get("cause") == "workload_spike" or str(i.get("title", "")).endswith("load surge"):
                    continue
                older = int(i["id"].split("-")[-1]) < mine
                if i.get("cause") in loop_wide and (older or det["cause"] not in loop_wide):
                    return True
                if older and set(racks) & {a for a in i.get("affected_asset_ids", []) if a.startswith("rack_")}:
                    return True
            return False

        if overlapping():
            s.ev("verification", "Verification is waiting for an earlier repair on the same racks to settle", asset_id=det["target_id"])
            await ctx.wait_until(lambda: not overlapping(), 1200)
        t0 = ctx.now
        before = state.get("baseline") or {}
        extensions = 0
        after: Json = {}
        src = "calibrated-healthy-reference"
        while True:
            while v["elapsed_s"] < v["window_s"]:
                await ctx.sleep_sim(min(4.0, max(v["window_s"] - v["elapsed_s"], 0.5)))
                v["elapsed_s"] = min(ctx.now - t0, v["window_s"])
                v["progress"] = rnd(min(v["elapsed_s"] / v["window_s"], 1.0), 3)
                ctx.emit("verification.result", s.id, {"verification": v})

            if ctx.locks.isolation_owner not in (None, s.id):   # another zone is out of service: flows are not comparable right now
                await ctx.wait_until(lambda: ctx.locks.isolation_owner in (None, s.id), 900)
                await ctx.sleep_sim(30)

            async def compare() -> Json:
                nonlocal after, src
                cf = await twin_counterfactual(ctx, det, f"{s.id}:{t['id']}:cf{attempt}{'x' * extensions}", s.id, t["id"])
                if cf is None:
                    cf = healthy_reference(ctx, racks, other_affected(ctx, s.id))
                src = cf["source"]
                after = compute_metrics(ctx, det, s.id, cf, before.get("_clean"))
                return {"before": {k: rnd(x, 3) for k, x in before.items() if not k.startswith("_")}, "after": {k: rnd(x, 3) for k, x in after.items() if not k.startswith("_")}, "reference": src}

            await s.tool(t, "compare_windows", {"pre": "incident open", "post": f"last {round(v['window_s'])}s", "metrics": sorted(k for k in before if not k.startswith("_"))}, compare)
            failing = [c for c in checks_for(ctx, det, before, after) if not c["pass"]]
            rising = any(ctx.history.slope(r, "margin_k", 20) > 0.002 for r in racks)
            if extensions < 2 and failing and all(c["id"] == "margin" for c in failing) and rising:
                extensions += 1
                v["window_s"] += lim.verify_extension_s
                s.ev("verification", "Hydraulics recovered; thermal margin still rising - extending the stabilisation window", asset_id=det["target_id"])
                continue
            break
        checks = checks_for(ctx, det, before, after)
        ok = bool(checks) and all(c["pass"] for c in checks)
        v.update(checks=checks, status="verified" if ok else "rejected", progress=1.0, elapsed_s=rnd(v["elapsed_s"], 1),
                 confidence=rnd(min(0.97, 0.82 + 0.02 * len(checks)) if ok else 0.3, 2), completed_tick=ctx.tick)
        if not ok:
            v["failed_reason"] = "; ".join(f"{c['label']} {c['after']} {c['unit']} (needs {'>=' if c['direction'] == 'min' else '<='} {c['target']})"
                                           for c in checks if not c["pass"]) or "no checks could be evaluated"
        s.inc["verification"] = v
        ctx.emit("verification.result", s.id, {"verification": v})
        eid = s.ev("verification", (f"Verified after {round(v['window_s'])}s window: " + " - ".join(f"{c['label']} {c['after']} {c['unit']}" for c in checks)) if ok
                   else f"Rejected: {v['failed_reason']}", asset_id=det["target_id"])
        fb = (f"All {len(checks)} checks passed over a {round(v['window_s'])}s stabilisation window. No new anomalies downstream." if ok
              else f"Repair did not restore the plant: {v['failed_reason']}.")
        dec = await s.decide(t, "verify", {"verdict": "verified" if ok else "rejected", "checks": checks, "reference": src}, lambda: {"summary": fb},
                             instruction="Phrase the verifier's verdict. The verdict is fixed; do not change it.")
        s.finish(t, "verified" if ok else "rejected", dec["summary"] or fb, ("Verified" if ok else "Rejected", ok), [eid])
        s.touch()
        return s.patch(verify={"ok": ok, "failed": [c["id"] for c in checks if not c["pass"]], "reason": v.get("failed_reason", "")})

    g = StateGraph(IncState)
    g.add_node("verify", verify)
    g.add_edge(START, "verify")
    g.add_edge("verify", END)
    return g.compile()
