"""Independent verifier graph: stabilisation window -> counterfactual before/after comparison -> verdict.

The verdict is computed deterministically from measurements; the model may only phrase the summary.
A rejected result stays rejected (stage_log outcome='rejected') and triggers a replan in SENTINEL.
"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .. import dod
from ..analysis import (checks_for, compute_metrics, healthy_reference, other_affected, rnd, twin_counterfactual)
from . import dod_nodes as dn
from ..context import AgentContext
from ..state import IncState
from ..world import Json
from .common import S

from ..dod import WINDOW_SCALE  # noqa: E402


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
        dc = state.get("dod")                                        # frozen Definition of Done (None: legacy checks only, e.g. workload dismissals)
        cf_ref: Json | None = None

        async def get_cf(tag: str) -> Json:
            cf0 = await twin_counterfactual(ctx, det, f"{s.id}:{t['id']}:cf{attempt}{tag}", s.id, t["id"])
            return cf0 if cf0 is not None else healthy_reference(ctx, racks, other_affected(ctx, s.id))

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
        if dc is not None:
            dod.begin(ctx, dc, attempt)
            dn.emit(ctx, dc)
        extensions = 0
        after: Json = {}
        src = "calibrated-healthy-reference"
        while True:
            while v["elapsed_s"] < v["window_s"]:
                await ctx.sleep_sim(min(4.0, max(v["window_s"] - v["elapsed_s"], 0.5)))
                v["elapsed_s"] = min(ctx.now - t0, v["window_s"])
                v["progress"] = rnd(min(v["elapsed_s"] / v["window_s"], 1.0), 3)
                ctx.emit("verification.result", s.id, {"verification": v})
                if dc is not None:
                    if cf_ref is None:
                        cf_ref = await get_cf("w")
                    dod.step(ctx, dc, det, before, cf_ref, before.get("_clean"))
                    if dc["evaluation"]["samples"] % 2 == 0:
                        dn.emit(ctx, dc)

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
            if dc is not None:
                dod.step(ctx, dc, det, before, cf_ref or await get_cf("f"), before.get("_clean"))
                cs = dc["evaluation"]["checks"]
                pend = [k for k, x in cs.items() if x["status"] == "passing"]
                bad = [k for k, x in cs.items() if x["status"] in ("failing", "unknown")]
                if extensions < 3 and pend and not bad:                      # recovered, but a sustained-hold timer has not run out yet: keep watching
                    rem = max(ch["hold_sim_s"] - cs[ch["id"]]["held_s"] for ch in dc["checks"] if cs[ch["id"]]["status"] == "passing")
                    extensions += 1
                    v["window_s"] += min(lim.verify_extension_s, rem + 6.0)
                    s.ev("verification", f"Checks pass but their hold timers ({', '.join(pend)}) are still running - extending the window", asset_id=det["target_id"])
                    continue
                if extensions < 2 and bad == ["margin"] and rising:
                    extensions += 1
                    v["window_s"] += lim.verify_extension_s
                    s.ev("verification", "Hydraulics recovered; thermal margin still rising - extending the stabilisation window", asset_id=det["target_id"])
                    continue
                dc["evaluation"]["layer_a"] = dod.verdict_a(dc)
                if dc["evaluation"].get("layer_b") is None or dc["evaluation"]["layer_b"].get("for") != dc["evaluation"]["layer_a"]:
                    lb = await dn.layer_b(ctx, s, dc, det, t)
                    dc["evaluation"]["layer_b"] = {**lb, "for": dc["evaluation"]["layer_a"]}
                    dn.emit(ctx, dc)
                    if (dc["evaluation"]["layer_a"] == "PASS" and lb["verdict"] == "request_more_tests" and not dc["evaluation"].get("reviewer_extended")
                            and extensions < 3):
                        try:
                            extra = [{"type": k.type if hasattr(k, "type") else k["type"], "subject_asset_id": ""} for k in lb["extra_checks"]]
                            draft = {"goal": dc["goal"], "subject_asset_ids": [], "checks": extra,
                                     "hold_sim_seconds": int(dc["checks"][0]["hold_sim_s"] + lb["extra_hold_sim_seconds"])}
                            racks_ = ctx.fac.scope_racks(det["cause"], det["target_id"])
                            after0 = compute_metrics(ctx, det, s.id, healthy_reference(ctx, racks_, other_affected(ctx, s.id)), before.get("_clean"))
                            prop = dod.compile_contract(ctx, det, s.id, draft, dc.get("before") or {}, after0, window_s=dc["window_s"], source=dc["drafted_by"])
                            ev_keep = dc["evaluation"]
                            dc = dod.revise(ctx, dc, prop, "SEN-05 asked for more tests: " + "; ".join(lb["reasons"][:2])[:240])
                            dc["before"], dc["evaluation"] = prop.get("before") or ev_keep.get("before"), ev_keep
                            for ch in dc["checks"]:
                                dc["evaluation"]["checks"].setdefault(ch["id"], {"status": "pending", "measured": None, "target": ch["threshold"], "held_s": 0.0,
                                                                                  "best_held_s": 0.0, "streak_since_s": None, "last_pass": None})
                            dc["evaluation"]["reviewer_extended"] = True
                            dc["evaluation"]["layer_b"] = None
                            dc["state"] = "EVALUATING"
                            extensions += 1
                            v["window_s"] += max(30.0, float(lb["extra_hold_sim_seconds"]) + 6.0)
                            s.ev("verification", f"SEN-05 requested more tests: contract v{dc['version']} adds checks / a longer hold", asset_id=det["target_id"])
                            dn.emit(ctx, dc)
                            continue
                        except dod.ContractError:
                            pass
                break
            if extensions < 2 and failing and all(c["id"] == "margin" for c in failing) and rising:
                extensions += 1
                v["window_s"] += lim.verify_extension_s
                s.ev("verification", "Hydraulics recovered; thermal margin still rising - extending the stabilisation window", asset_id=det["target_id"])
                continue
            break
        checks = checks_for(ctx, det, before, after)
        ok = bool(checks) and all(c["pass"] for c in checks)
        dod_block = None
        if dc is not None:
            ev_ = dc["evaluation"]
            lb = ev_.get("layer_b") or {}
            by_old = {c["id"]: c for c in checks}
            checks = dod.eval_table(dc)
            for c_ in checks:
                bv = (by_old.get(c_["id"]) or {}).get("before")
                c_["before"] = float(bv) if isinstance(bv, (int, float)) else float((dc.get("before") or {}).get(c_["id"], 0.0) or 0.0)      # public contract: numbers only
                if not isinstance(c_.get("after"), (int, float)):
                    c_["after"] = 0.0                                                                   # no trustworthy measurement: `status` says 'unknown'

            ok = ev_["layer_a"] == "PASS" and lb.get("verdict") == "concur"
            dod_block = {"contract_id": dc["id"], "version": dc["version"], "frozen_hash": dc["frozen_hash"], "layer_a": ev_["layer_a"],
                         "layer_b": {k: lb.get(k) for k in ("verdict", "source", "model_id", "reasons")}}
        v.update(checks=checks, status="verified" if ok else "rejected", progress=1.0, elapsed_s=rnd(v["elapsed_s"], 1),
                 confidence=rnd(min(0.97, 0.82 + 0.02 * len(checks)) if ok else 0.3, 2), completed_tick=ctx.tick)
        if dod_block:
            v["dod"] = dod_block
        if not ok:
            if dc is not None and dc["evaluation"]["layer_a"] == "PASS":
                v["failed_reason"] = "SEN-05 did not concur: " + "; ".join((dc["evaluation"].get("layer_b") or {}).get("reasons") or ["no reason given"])[:200]
            elif dc is not None:
                v["failed_reason"] = "; ".join(f"{c['label']} {c['status']}" + (f" ({c['after']} {c['unit']} vs {'>=' if c['direction'] == 'min' else '<='} {c['target']}, held {c['held_s']:g}/{c['hold_sim_s']:g}s)"
                                                                         if c.get("after") is not None else " (no trustworthy measurement)") for c in checks if not c["pass"])
                if dc["evaluation"]["layer_a"] == "UNKNOWN":
                    v["failed_reason"] = "UNKNOWN - " + v["failed_reason"]
            else:
                v["failed_reason"] = "; ".join(f"{c['label']} {c['after']} {c['unit']} (needs {'>=' if c['direction'] == 'min' else '<='} {c['target']})"
                                               for c in checks if not c["pass"]) or "no checks could be evaluated"
        s.inc["verification"] = v
        ctx.emit("verification.result", s.id, {"verification": v})
        if dc is not None:
            ev_ = dc["evaluation"]
            prim = dc["checks"][0]["id"]
            m0 = (ev_["checks"].get(prim) or {}).get("measured")
            prev = (dc["history"][-1].get("primary") if dc["history"] else (dc.get("before") or {}).get({"flow": "flow", "dp": "dp_ratio", "margin": "margin"}.get(prim, prim)))
            delta = None if (m0 is None or prev is None) else rnd((m0 - prev) / max(abs(dc["checks"][0]["threshold"]), 1e-6), 3)
            dc["history"] = [*dc["history"], {"attempt": attempt, "layer_a": ev_["layer_a"], "layer_b": (ev_.get("layer_b") or {}).get("verdict"),
                                              "failed": [c_["id"] for c_ in checks if not c_["pass"]], "plan_hash": dn.plan_hash(state.get("plan") or {}),
                                              "primary": m0, "primary_delta": delta, "version": dc["version"], "tick": ctx.tick}]
            if ok:
                dc["state"], dc["terminal_state"] = "VERIFIED", "VERIFIED"
            else:
                dc["state"] = "FROZEN"
            dn.emit(ctx, dc)
        eid = s.ev("verification", (f"Verified after {round(v['window_s'])}s window: " + " - ".join(f"{c['label']} {c['after']} {c['unit']}" for c in checks)) if ok
                   else f"Rejected: {v['failed_reason']}", asset_id=det["target_id"])
        fb = (f"All {len(checks)} checks passed over a {round(v['window_s'])}s stabilisation window. No new anomalies downstream." if ok
              else f"Repair did not restore the plant: {v['failed_reason']}.")
        dec = await s.decide(t, "verify", {"verdict": "verified" if ok else "rejected", "checks": checks, "reference": src}, lambda: {"summary": fb},
                             instruction="Phrase the verifier's verdict. The verdict is fixed; do not change it.")
        s.finish(t, "verified" if ok else "rejected", dec["summary"] or fb, ("Verified" if ok else "Rejected", ok), [eid])
        s.touch()
        extra = {"dod": dc} if dc is not None else {}
        return s.patch(verify={"ok": ok, "failed": [c["id"] for c in checks if not c["pass"]], "reason": v.get("failed_reason", ""),
                               "unknown": bool(dc is not None and dc["evaluation"]["layer_a"] == "UNKNOWN")}, **extra)

    g = StateGraph(IncState)
    g.add_node("verify", verify)
    g.add_edge(START, "verify")
    g.add_edge("verify", END)
    return g.compile()
