"""SENTINEL supervisor graph (one LangGraph thread per incident).

observe -> classify -> spawn {hydraulics, thermal, accessibility} reviewer subgraphs -> reconcile
-> bounded probes -> request inspection (INPIPE) -> evaluate observations -> choose intervention
-> safety policy -> approval/veto window -> dispatch (INPIPE | OUTRIG) -> stabilisation wait
-> independent verification -> close OR recurse (replan / escalate).
The LLM proposes at decision points; policy + the engine decide what is admissible.
"""
from __future__ import annotations

import asyncio

from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from ..analysis import (compute_metrics, fallback_hypotheses, healthy_reference, hyp_label, pct, rnd)
from ..context import AgentContext
from ..policy import ACTIONS, GAUGES, HIGH_IMPACT_STEPS, INPIPE_STEPS, OUTRIG_STEPS
from ..session import IncidentSession, PolicyReject, inc_num
from ..state import RESET, IncState
from ..world import Json, rd
from ..plain import plain
from .common import S, fire_return, mission_id, pick_crawler, sentinel_root, worst_margin
from .inpipe import build_inpipe_graph
from .outrig import build_outrig_graph, work_order
from .probes import build_probe_graph
from .reviewers import REVIEW_Q, build_reviewer_graph
from .verifier import build_verifier_graph
from . import dod_nodes as dn
from loopkeeper.memory.hooks import memory_read, memory_write
from .. import dod as dod_mod
from ..policy import PROBE_TOOLS as _PT


def pol_probe_tools():
    return _PT

KINDS = ("hydraulics", "thermal", "accessibility")


def update_hypotheses(s: IncidentSession, det: Json, confirmed: str, note: str, refuted: list[str] | None = None) -> None:
    hs = s.inc["hypotheses"]
    if not hs:
        return
    top = hs[0]["cause"]
    pick = next((h for h in hs if h["cause"] == confirmed and h["target_id"] == det["target_id"]), None) or next((h for h in hs if h["cause"] == confirmed), None)
    for h in hs:
        if h is pick:
            h["confidence"], h["status"] = 0.96, "confirmed"
            h["evidence_for"].append(note)
        elif h["cause"] in (refuted or []) or top == confirmed:
            h["confidence"], h["status"] = min(h["confidence"], 0.03), "refuted"
    hs.sort(key=lambda h: -h["confidence"])
    s.inc["cause"] = confirmed
    s.touch()


def target_for(det: Json) -> dict[str, str]:
    return {a: det["target_id"] for a in ACTIONS}


def build_incident_graph(ctx: AgentContext, checkpointer: Any):
    fac, pol, lim = ctx.fac, ctx.policy, ctx.limits
    review_graph = build_reviewer_graph(ctx)
    probe_graph = build_probe_graph(ctx)
    inpipe_graph = build_inpipe_graph(ctx)
    outrig_graph = build_outrig_graph(ctx)
    verifier_graph = build_verifier_graph(ctx)

    # ───────────────────────────── classify ─────────────────────────────
    async def classify(state: IncState) -> IncState:
        s = S(ctx, state)
        det = state["det"]
        racks = fac.scope_racks(det["cause"], det["target_id"]) or list(fac.racks)
        s.set_status("investigating", "SENTINEL is classifying the anomaly.")
        for e in det.get("evidence", []):
            s.ev("telemetry", e, asset_id=det["anchor_id"])
        root = s.task("sentinel", "classify", "Observe & classify", f'What changed in the plant, and which mechanism fits "{det["title"]}"?',
                      asset_ids=det["affected"][:3])
        w = ctx.world
        lf = ctx.monitor.loop_flows(w)
        await s.tool(root, "read_telemetry", {"assets": det["affected"][:4], "window_s": 120}, lambda: {
            "samples": len(ctx.history.buf), "worst_margin_k": rnd(worst_margin(ctx, racks), 1),
            "tcs_flow_kg_s": rnd(lf["tcs"], 2), "fws_flow_kg_s": rnd(lf["fws"], 2)})

        def resid() -> Json:
            out: Json = {}
            ref = ctx.monitor.ref_q
            if ref.get("tcs"):
                out["tcs_flow_residual_pct"] = rnd((lf["tcs"] - ref["tcs"] * ctx.monitor.speed_ratio(w)) / ref["tcs"] * 100, 1)
            for z in fac.zones:
                zr = fac.zone_racks(z)
                refz = sum(ctx.monitor.ref_rack_flow(r, w) for r in zr)
                if refz:
                    out[f"{z}_residual_pct"] = rnd((sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in zr) - refz) / refz * 100, 1)
            return out

        residuals = await s.tool(root, "query_twin_residual", {"healthy_twin": True, "setpoints": "current"}, resid)

        # Wire Laya System 1 Non-Autoregressive triage & fast routing
        laya_decision = None
        try:
            from loopkeeper.intelligence.laya_classifier import get_laya_classifier
            laya = get_laya_classifier()
            inc_dict = {
                "incident_id": s.id,
                "asset_id": det.get("target_id") or det.get("anchor_id", ""),
                "summary": det.get("summary", ""),
                "title": det.get("title", ""),
                "delta_kpa": float(residuals.get("tcs_flow_residual_pct", 0.0)),
                "thermal_margin_c": float(worst_margin(ctx, racks)),
            }
            cp = getattr(ctx.engine, "comm_provider", None)
            pkey = f"laya:{s.id}:{root['id']}"
            if cp is not None:
                cp("started", provider="laya", model_id="laya-router", purpose="triage", incident_id=s.id, task_id=root["id"], key=pkey)
            try:
                laya_decision = await asyncio.to_thread(laya.classify_incident, inc_dict)      # model inference must not block the engine loop
            except Exception as lex:
                if cp is not None:
                    cp("error", provider="laya", model_id="laya-router", purpose="triage", incident_id=s.id, task_id=root["id"], key=pkey, reason=type(lex).__name__)
                raise
            if cp is not None:
                cp("completed", provider="laya", model_id="laya-router", purpose="triage", incident_id=s.id, task_id=root["id"], key=pkey,
                   latency_ms=int(getattr(laya_decision, "latency_ms", 0) or 0))
            await s.tool(root, "laya_triage_incident", {"incident_id": s.id, "target": inc_dict["asset_id"]},
                         lambda: laya_decision.to_dict())
            s.ev("observation", f"Laya triage: {laya_decision.task_family} (conf={laya_decision.confidence:.2f}, {laya_decision.latency_ms:.1f}ms, urg={laya_decision.urgency})",
                 asset_id=det["anchor_id"])
            s.inc["laya_triage"] = laya_decision.to_dict()
        except Exception as ex:
            log.warning("Laya triage step skipped: %s", ex)

        baseline = state.get("baseline")
        if baseline is None:
            baseline = compute_metrics(ctx, det, s.id, healthy_reference(ctx, racks, set()))
        fb = f"{det['summary']} Opening an incident and delegating hydraulic, thermal and accessibility review."
        dec_payload = {
            "title": det["title"], "summary": det["summary"], "detector_cause": det["cause"], "residuals": residuals,
            "laya_triage": laya_decision.to_dict() if laya_decision else None,
            "allowed_mechanisms": ["fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike", "unknown"],
        }
        dec = await s.decide(root, "classify", dec_payload,
                             lambda: {"mechanism": det["cause"], "summary": fb}, instruction="Classify the anomaly mechanism from the facts.")
        summary = dec["summary"] or fb
        if dec["mechanism"] not in (det["cause"], "unknown"):
            summary += f" (model suggested {dec['mechanism']}; detector evidence retained as the working cause pending review)"
        s.finish(root, "completed", summary, ("Incident opened", True))
        return s.patch(baseline=baseline)

    # ───────────────────────────── reviewers (fan-out) ─────────────────────────────
    async def spawn_reviewers(state: IncState) -> IncState:
        s = S(ctx, state)
        root = sentinel_root(state)
        det = state["det"]
        ids = []
        for k in KINDS:
            t = s.task("sentinel", f"review.{k}", f"{k.capitalize()} reviewer", REVIEW_Q[k], parent=root, asset_ids=det["affected"][:3])
            ids.append(t["id"])
        return s.patch(child_tasks=ids)

    def fanout(state: IncState) -> list[Send]:
        return [Send("reviewer", {"kind": state["tasks"][tid]["kind"].split(".")[1], "task_id": tid, "incident": state["incident"], "det": state["det"],
                                  "tasks": {tid: state["tasks"][tid]}, "tokens_used": state.get("tokens_used", 0)}) for tid in state["child_tasks"]]

    async def reviewer(payload: Json, config: RunnableConfig) -> Json:
        out = await review_graph.ainvoke(payload, config)
        return {"tasks": out["out_tasks"], "new_evidence": out.get("out_evidence", []), "tokens_used": out.get("tokens_used", 0)}

    # ───────────────────────────── reconcile ─────────────────────────────
    async def reconcile(state: IncState) -> IncState:
        s = S(ctx, state)
        det, root = state["det"], sentinel_root(state)
        for e in sorted(state.get("new_evidence") or [], key=lambda e: e["id"]):
            s.inc["evidence"].append(e)
        revs = [state["tasks"][i] for i in state["child_tasks"]]
        rec = s.task("sentinel", "reconcile", "Reconcile hypotheses", "Which hypothesis is best supported by the evidence and counter-evidence?",
                     parent=root, caused_by=revs)
        await s.tool(rec, "rank_hypotheses", {"candidates": "auto", "evidence": len(s.inc["evidence"])}, lambda: {"ranked": True})
        fb = fallback_hypotheses(ctx, det)
        valid_ids = sorted(dod_mod.scope_assets(ctx, det) | set(fac.flow_sensors) | set(fac.strainers) | set(fac.pumps))[:60]
        payload = {"detector": {"cause": det["cause"], "target": det["target_id"], "title": det["title"]},
                   "reviewer_summaries": [r.get("summary", "") for r in revs],
                   "evidence": [e["summary"] for e in s.inc["evidence"]][:10], "candidate_prior": fb,
                   "valid_target_ids": valid_ids, "valid_probe_tools": sorted(pol_probe_tools()), "valid_causes": ["fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike", "leak"],
                   "rule": "every target_id MUST be copied exactly from valid_target_ids; at most 3 hypotheses and 2 followups"}

        def validate(d: Any) -> list[str]:
            return pol.validate_hypotheses(d, det["cause"]) + pol.validate_followups(d.followups)

        dec = await s.decide(rec, "reconcile", payload, lambda: {"hypotheses": fb, "summary": "", "followups": []}, validate,
                             instruction="Rank hypotheses (confidence sums to about 1). Propose follow-up probes only for specific unresolved sub-questions; tools: read_telemetry, query_topology, check_mass_balance, check_flow_normality. Use ONLY ids from valid_target_ids.",
                             max_tokens=450, closed={"target_id": valid_ids})
        hyps, notes = _normalize_hyps(ctx, s, det, dec["hypotheses"], fb)
        s.inc["hypotheses"] = hyps
        s.inc["cause"] = hyps[0]["cause"]
        s.stage("hypothesized")
        top = hyps[0]
        if notes:
            await s.tool(rec, "policy.cap_hypotheses", {"proposed": len(dec["hypotheses"])}, lambda: {"adjustments": notes})
        reqs: list[Json] = []
        fups = dec.get("followups", [])
        if fups:
            cap = lim.max_concurrent
            for f in fups[:cap]:
                reqs.append({**f, "parent_id": rec["id"], "task_id": s._tid()})
            await s.tool(rec, "cap_followups", {"requested": len(fups)}, lambda: {"accepted": len(reqs), "concurrency_cap": cap, "depth_cap": lim.max_depth})
        extra = f" {dec['summary']}" if dec.get("summary") else ""
        s.finish(rec, "completed", f"Leading hypothesis: {top['label']} ({pct(top['confidence'])}). " + " - ".join(f"{h['label']} {pct(h['confidence'])}" for h in hyps[1:]) + "." + extra,
                 (top["label"], True))
        s.set_status("investigating", f"Leading hypothesis: {top['label']} ({pct(top['confidence'])}).")
        return s.patch(new_evidence=RESET, child_tasks=RESET, probe_requests=reqs, probe_depth=2)

    # ───────────────────────────── inspection request ─────────────────────────────
    async def plan_inspection(state: IncState) -> IncState:
        s = S(ctx, state)
        det, root = state["det"], sentinel_root(state)
        cause = det["cause"]
        gauge = next(iter(GAUGES.get(cause, set())), None)
        if not gauge:
            return s.patch(work={}, inspection={})
        tgt = det["target_id"]
        if cause == "fouling":
            edge, sm = tgt, fac.edges[tgt]["length_m"] / 2
            pass_s = False  # the engine's crawler search resolves the deposit position itself
            title, q = f"Inspect {fac.label(edge)}", f"Is {fac.label(edge)} actually restricted, where, and by how much?"
        elif cause == "valve_stuck":
            edge = fac.zone_header(fac.rack_zone(tgt.replace("valve_", "rack_")) or "") or ""
            sm = fac.edges[edge]["length_m"] / 2 if edge else 0.0
            pass_s = True
            title = f"Rule out obstruction in {fac.label(edge)}"
            q = f"Is the header ahead of rack {tgt.replace('valve_', '').upper()} clean? (rule out internal obstruction)"
        else:
            edge = fac.assets[tgt]["edge_id"]
            sm = float(fac.assets[tgt].get("s_m") or fac.edges[edge]["length_m"] / 2)
            pass_s = True
            title, q = f"Corroborate {fac.label(tgt)}", f"Is the pipe at {fac.label(tgt)} actually restricted, or is only the meter wrong? (in-pipe bore check)"
        pick = pick_crawler(ctx, edge, sm, s.id) if edge else None
        if pick is None:
            s.ev("topology", "No crawler route to the target - inspection skipped; proceeding on telemetry evidence", asset_id=tgt, tags=["access"])
            return s.patch(work={}, inspection={})
        req = s.task("sentinel", "mission.request", f"Request {pick[0].upper().replace('_', '-')} inspection",
                     "Which robot can legally reach the target, and does the mission fit within battery and route constraints?", parent=root, asset_ids=[edge])
        dec = await s.decide(req, "inspection", {"cause": cause, "allowed_gauges": sorted(GAUGES[cause]), "robot": pick[0], "route_m": rnd(pick[1], 1)},
                             lambda: {"inspect": True, "gauge": gauge, "rationale": "Crawler can legally reach the segment; physical confirmation precedes any intervention."},
                             lambda d: pol.validate_inspection(d, cause) + ([] if d.inspect else ["inspection is required while a legal crawler route exists"]),
                             instruction="Choose the gauge for the crawler inspection.")
        gauge = dec["gauge"] or gauge
        r = ctx.world["robots"][pick[0]]
        await s.tool(req, "propose_mission", {"robot": pick[0], "target": edge, "s_m": rnd(sm, 2), "tool": gauge},
                     lambda: {"route_m": rnd(pick[1], 1), "eta_s": round(pick[1] / 0.12), "battery_reserve_ok": float(r.get("battery_pct", 0)) > 40})
        s.finish(req, "completed", f"{r.get('name', pick[0])} is the closest legal option ({pick[1]:.1f} m). Mission approved within policy.", ("Dispatched", True))
        work = {"kind": "inspect", "request_task": req["id"], "edge": edge, "s_m": sm, "gauge": gauge, "title": title, "question": q, "robot": pick[0], "pass_s": pass_s}
        return s.patch(work=work, work_result={}, inspection={})

    def after_plan_inspection(state: IncState) -> str:
        return "inpipe_inspect" if state.get("work") else "evaluate"

    # ───────────────────────────── evaluate observations ─────────────────────────────
    async def evaluate(state: IncState) -> IncState:
        s = S(ctx, state)
        det = state["det"]
        cause = det["cause"]
        insp = state.get("inspection") or {}
        contradiction = ""
        expected = cause in GAUGES
        if expected and insp.get("ok"):
            obs = insp["observation"]
            if cause == "fouling":
                if float(obs.get("occlusion", 0)) < 0.08:
                    contradiction = "Crawler scan found the bore clear - the pressure-drop symptom is not explained by internal fouling."
                else:
                    update_hypotheses(s, det, "fouling", f"Crawler scan: {pct(float(obs['occlusion']))} of bore blocked", ["valve_stuck", "sensor_drift", "strainer_blockage"])
            elif cause == "valve_stuck":
                update_hypotheses(s, det, "valve_stuck", f"Header bore {pct(float(obs.get('occlusion', 0)))} blocked - clean" if float(obs.get("occlusion", 0)) < 0.2 else "Header partially blocked", ["fouling", "sensor_drift"])
                if float(obs.get("occlusion", 0)) >= 0.3:
                    contradiction = "Header ahead of the starved branch is materially fouled; the valve is not the sole cause."
            elif cause == "sensor_drift":
                if float(obs.get("occlusion", 0)) >= 0.3:
                    contradiction = "The pipe at the suspect meter is materially restricted, so the flow imbalance may be real rather than an instrument fault."
                else:
                    update_hypotheses(s, det, "sensor_drift", f"Bore at {fac.label(det['target_id'])} is clear while rack meters agree with each other", ["fouling", "valve_stuck"])
        elif cause == "strainer_blockage":
            update_hypotheses(s, det, cause, f"dP across {fac.label(det['target_id'])} {ctx.monitor.strainer_ratio(det['target_id'], ctx.world):.1f}x design", ["pump_degradation", "fouling"])
        elif cause == "pump_degradation":
            update_hypotheses(s, det, cause, "Head below curve with elevated vibration", ["strainer_blockage", "sensor_drift"])
        elif cause == "workload_spike":
            update_hypotheses(s, det, cause, "Flow and dP nominal; power up", ["valve_stuck", "fouling"])
        else:
            update_hypotheses(s, det, cause, "Detector evidence retained (no corroborating inspection available)", [])
        s.stage("investigated")
        return s.patch(contradiction=contradiction)

    # ───────────────────────────── choose intervention ─────────────────────────────
    async def choose(state: IncState) -> IncState:
        s = S(ctx, state)
        det, root = state["det"], sentinel_root(state)
        cause, attempts = det["cause"], s.inc["attempts"]
        mem = await memory_read(ctx, det, s.inc)            # shared brain advice (flag MEMORY_ENABLED, default off -> {}); policy still validates every decision
        contract = await dn.ensure_contract(ctx, s, state, det, root) if attempts == 0 else state.get("dod")      # SEN-01 drafts, the compiler FREEZES it before any repair
        if contract is not None and attempts > 0 and s.inc.get("verification"):
            contract = await dn.revise_for_replan(ctx, s, state, det, contract, [c["id"] for c in s.inc["verification"].get("checks", []) if not c["pass"]], root)
        dodp = {"dod": contract} if contract is not None else {}
        insp = state.get("inspection") or {}
        occ = float((insp.get("observation") or {}).get("occlusion", 0.6 if cause == "fouling" else 0.0)) if cause == "fouling" else 0.0
        brush_ok = cause == "fouling" and bool(state.get("robot")) and occ <= 0.68 and attempts == 0
        options = pol.options_for(cause, attempts, brush_ok)
        kind = "replan" if attempts > 0 else "intervention"
        title = "Replan after rejected repair" if attempts > 0 else "Choose intervention"
        q = "Why did the intervention fail and what must change?" if attempts > 0 else "Can the crawler clear this deposit, or does the segment need a physical repair?" if cause == "fouling" else "Which whitelisted intervention fixes the confirmed cause at least cost to the plant?"
        if cause == "workload_spike":
            title, q = "Decide: no dispatch", "Is a robot dispatch justified, or is this a load-driven thermal event?"
        t = s.task("sentinel", "replan" if attempts > 0 else "decide", title, q, parent=root, asset_ids=[det["target_id"]])
        reason = state.get("contradiction") or ""
        if attempts > lim.max_replans:
            reason = reason or f"The automatic repair attempts reached their limit ({lim.max_replans} retries)."
        if not options:
            reason = reason or "No further automatic repair options remain for this fault."
        if reason:
            s.finish(t, "blocked", reason, ("Escalate", False))
            return s.patch(plan={"action": "escalate", "target_id": det["target_id"], "decide_task": t["id"], "attempt": attempts}, esc_reason=reason, **dodp)
        failing = []
        if attempts > 0 and s.inc.get("verification"):
            failing = [c["id"] for c in s.inc["verification"].get("checks", []) if not c["pass"]]
            await s.tool(t, "diagnose_failure", {"failed": (state.get("plan") or {}).get("action"), "checks": failing},
                         lambda: {"reason": s.inc["verification"].get("failed_reason", ""), "remaining_options": options})
        tf = target_for(det)
        await s.tool(t, "evaluate_options", {"options": options, "deposit_pct": rnd(occ * 100, 0) if cause == "fouling" else None},
                     lambda: {"chosen": options[0], "rationale": "least invasive admissible option on the ladder"})
        ratio_note = f"Deposit ({pct(occ)}) is within the crawler's limited brush scope - try clearing first, verify, then escalate if it does not recover." if options[0] == "brush_clear" else \
            "Deposit is too heavy for limited in-pipe clearing - replacing the section needs isolation." if options[0] == "replace_section" else \
            {"replace_strainer": "Series blockage at the strainer: duplex changeover replaces the basket without interrupting flow.",
             "service_valve": "Inspection ruled out header obstruction; the actuator needs service inside an isolated, cordoned zone.",
             "service_pump": "Standby pump takes duty, then the degraded pump is serviced offline.",
             "recalibrate_sensor": "The plant is healthy; the instrument needs recalibration against the rack meters.",
             "monitor_only": "Hydraulics are healthy; the rack simply draws more power. Dispatching a robot would be a false positive - monitoring instead."}.get(options[0], "")
        dec = await s.decide(t, kind, {"cause": cause, "options": options, "targets": {o: tf[o] for o in options}, "attempt": attempts, "failed_checks": failing,
                                       "deposit_fraction": rnd(occ, 2) if cause == "fouling" else None, "confirmed": s.inc["cause"], **mem},
                             lambda: {"action": options[0], "target_id": tf[options[0]], "rationale": ratio_note, "confidence": 0.8},
                             lambda d: pol.validate_intervention(d, cause, options, tf),
                             instruction="Choose exactly one action from 'options' with its listed target. Least invasive first.")
        action = dec["action"]
        if attempts > 0:
            stop = dn.guard_progress(ctx, s, contract, {"action": action, "target_id": dec["target_id"]})
            if stop:
                s.finish(t, "blocked", stop, ("Escalate", False))
                return s.patch(plan={"action": "escalate", "target_id": det["target_id"], "decide_task": t["id"], "attempt": attempts}, esc_reason=stop, **dodp)
        s.finish(t, "completed", dec.get("rationale") or ratio_note, ({"brush_clear": "Brush clear", "replace_section": "Replace section", "monitor_only": "No dispatch"}.get(action, action.replace("_", " ").capitalize()), True))
        if attempts > 0:
            s.stage("investigated")
        return s.patch(plan={"action": action, "target_id": dec["target_id"], "decide_task": t["id"], "attempt": attempts, "occ": occ}, esc_reason="", **dodp)

    def after_choose(state: IncState) -> str:
        a = state["plan"]["action"]
        if a == "escalate":
            return "escalate"
        if a == "monitor_only":
            return "monitor"
        return "prep_return" if (state.get("robot") and a != "brush_clear") else "safety"

    # ───────────────────────────── crawler return (non-brush paths) ─────────────────────────────
    async def prep_return(state: IncState) -> IncState:
        s = S(ctx, state)
        root = sentinel_root(state)
        robot = state["robot"]
        work = {"kind": "return", "request_task": root["id"], "robot": robot, "await_dock": True, "title": f"{robot} return to port",
                "question": "Return safely to the launch port with battery reserve intact.", "edge": ""}
        return s.patch(work=work, work_result={})

    # ───────────────────────────── safety policy ─────────────────────────────
    async def safety(state: IncState) -> IncState:
        s = S(ctx, state)
        det, plan, root = state["det"], state["plan"], sentinel_root(state)
        action = plan["action"]
        spec = ACTIONS[action]
        decide_t = s.task_ref(plan["decide_task"])
        t = s.task("sentinel", "safety", "Safety & policy review", "Is every step whitelisted, physically safe and covered by an approval policy?",
                   parent=root, caused_by=[decide_t], asset_ids=[det["target_id"]])
        iso_zone, cmds = None, []
        if spec["robot"] == "outrig":
            wo = work_order(ctx, action, plan["target_id"], det)
            if not wo["ok"]:
                s.finish(t, "blocked", f"The work order cannot be composed ({plain(wo['reason'])}).", ("Blocked", False))
                return s.patch(safety={"ok": False, "approval": False, "task_id": t["id"]},
                               esc_reason=f"The work order could not be prepared ({plain(wo['reason'])}).")
            cmds = list(wo["commands"])
            iso_zone = wo["isolation"]["zone"] if wo["isolation"] else None
        else:
            cmds = ["brush_clear"]
        racks = fac.zone_racks(f"zone_{iso_zone}") if iso_zone else []
        others = [r for r in fac.racks if r not in racks]
        if iso_zone and ctx.locks.isolation_owner not in (None, s.id):
            # another incident has a zone out of service: wait for it, then let the plant thermally settle
            await ctx.wait_until(lambda: ctx.locks.isolation_owner in (None, s.id), ctx.limits.mission_timeout_s)
            await ctx.sleep_sim(45)
        # Isolating a zone (after its load is moved off) only redirects flow to the remaining racks, so their margin never
        # blocks the repair; it is reported in the tool output for the operator.
        low = [r for r in others if (rd(ctx.world, r, "margin_k", 99.0) or 99.0) < fac.crit_k] if iso_zone else []
        edges = fac.zone_edges(f"zone_{iso_zone}") if iso_zone else set()
        inside = [rid for rid, r in (ctx.world.get("robots") or {}).items() if r.get("class") == "inpipe" and (r.get("pose") or {}).get("segment_id") in edges and r.get("mode") != "DOCKED"]
        whitelisted = all(c in (INPIPE_STEPS | OUTRIG_STEPS) for c in cmds)
        needs_appr = pol.approval_required(action)
        style = "operator approval" if pol.mode == "supervised" else "operator veto window"
        out = await s.tool(t, "check_safety_policy", {"steps": len(cmds), "isolation": bool(iso_zone), "action": action}, lambda: {
            "whitelisted": whitelisted, "isolation_required": bool(iso_zone), "cordon": [r.replace("rack_", "").upper() for r in racks],
            "crawler_inside_segment": bool(inside), "thermal_impact": (f"{len(racks)} racks leave service; remaining racks absorb no extra heat" if iso_zone else "none"),
            "other_racks_already_low_margin": low, "isolation_effect": "flow is redirected to the remaining racks", "approval": style if needs_appr else "policy auto-approved"})
        ok = whitelisted
        if not ok:
            why = "The planned action contains steps outside the safety whitelist."
            s.finish(t, "blocked", why, ("Blocked", False))
            return s.patch(safety={"ok": False, "approval": False, "task_id": t["id"]}, esc_reason=why)
        if iso_zone:
            msg = (f"Isolation is required: racks {' & '.join(r.replace('rack_', '').upper() for r in racks)} must be cordoned first so no workload loses cooling. "
                   f"Crawler must be out of the segment. High-impact -> {style}.")
        elif needs_appr:
            msg = f"{action.replace('_', ' ').capitalize()} is whitelisted for this bore; {style} applies."
        else:
            msg = "Work stays within the whitelist and needs no isolation. Policy auto-approves."
        s.finish(t, "completed", msg, ("Approval needed" if needs_appr else "Within policy", True))
        return s.patch(safety={"ok": True, "approval": needs_appr, "task_id": t["id"], "steps": cmds})

    def after_safety(state: IncState) -> str:
        sf = state["safety"]
        return "escalate" if not sf["ok"] else ("approval" if sf["approval"] else "dispatch_prepare")

    # ───────────────────────────── approval / veto window ─────────────────────────────
    async def approval(state: IncState) -> IncState:
        s = S(ctx, state)
        det, plan, sf = state["det"], state["plan"], state["safety"]
        task = s.task_ref(sf["task_id"])
        task = {**task, "tool_calls": list(task["tool_calls"])}
        action = plan["action"]
        aid = f"ap_{inc_num(s.id)}_{plan['attempt'] + 1}"
        supervised = pol.mode == "supervised"
        label = fac.label(det["target_id"])
        text = {"brush_clear": f"Crawler brush-clears {label}", "replace_section": f"Isolate zone and replace the fouled section of {label}",
                "service_valve": f"Isolate zone and service {label} actuator"}.get(action, f"{action.replace('_', ' ')} on {label}")
        def world_ap() -> Json | None:
            inc = next((i for i in (ctx.world.get("incidents") or []) if i.get("id") == s.id), None)
            ap = (inc or {}).get("approval")
            return ap if ap and ap.get("id") == aid else None

        # approval DECISIONS are owned by the engine (operator approve/hold, auto-approve at auto_approve_at_s); we only request.
        existing = world_ap()
        a = dict(existing) if existing else {"id": aid, "incident_id": s.id, "task_id": task["id"], "action": text, "steps": sf.get("steps", []),
                                              "requested_tick": ctx.tick, "auto_approve_at_s": None if supervised else ctx.now + pol.window, "status": "pending"}
        s.inc["approval"] = a
        s.set_status("awaiting_approval", f"Waiting for operator approval: {text}")
        await s.tool(task, "request_approval", {"action": text, "mode": "explicit" if supervised else "veto-window", "window_s": None if supervised else pol.window},
                     lambda: {"approval_id": aid, "status": a["status"]})

        def cond() -> bool:
            w = world_ap()
            return bool(w and w.get("status") in ("approved", "expired"))

        ok = await ctx.wait_until(cond, lim.hold_timeout_s)
        s.update_task(task)
        w = world_ap()
        if w:
            s.inc["approval"] = dict(w)
        if not ok or not w or w.get("status") != "approved":
            s.inc["approval"]["status"] = "expired"
            s.touch()
            return s.patch(esc_reason="The operator hold or approval window ended without an approval.", safety={**sf, "ok": False})
        s.touch()
        return s.patch(safety={**sf, "approval_id": aid})

    def after_approval(state: IncState) -> str:
        return "dispatch_prepare" if state["safety"]["ok"] else "escalate"

    # ───────────────────────────── dispatch ─────────────────────────────
    async def dispatch_prepare(state: IncState) -> IncState:
        s = S(ctx, state)
        det, plan, sf = state["det"], state["plan"], state["safety"]
        a = plan["action"]
        if a == "brush_clear":
            obs = (state.get("inspection") or {}).get("observation") or {}
            edge = fac.edge_of(det["target_id"]) or det["target_id"]      # a detection can name an edge-mounted asset (e.g. a rack valve)
            sm = float(obs.get("location_s_m", (fac.edges.get(edge) or {}).get("length_m", 2.0) / 2))
            work = {"kind": "clear", "request_task": sf["task_id"], "robot": state["robot"], "edge": edge, "s_m": sm, "approval_id": sf.get("approval_id"),
                    "title": f"Brush-clear {fac.label(edge)}", "question": "Remove as much deposit as the brush can reach without damaging the wall."}
            s.set_status("mitigating", f"{state['robot']} is clearing the deposit in {fac.label(edge)}.")
        else:
            work = {"action": a, "target_id": plan["target_id"], "request_task": sf["task_id"], "approval_id": sf.get("approval_id")}
        return s.patch(work=work, work_result={})

    def route_dispatch(state: IncState) -> str:
        return "inpipe_clear" if state["plan"]["action"] == "brush_clear" else "outrig"

    async def post_clear(state: IncState) -> IncState:
        s = S(ctx, state)
        wr = state.get("work_result") or {}
        robot = state.get("robot")
        if robot:  # the crawler heads home while the plant settles (engine executes; we do not block on it)
            await fire_return(ctx, s, robot, sentinel_root(state), f"retclr{plan_attempt(state)}",
                              f"{robot.upper().replace('_', '-')} is returning to port while the verifier watches the plant.")
        if not wr.get("ok"):
            return s.patch(verify={"ok": False, "failed": ["mission"], "reason": f"the clearing job did not complete ({wr.get('reason')})"})
        return s.patch(verify=None)

    def after_post_clear(state: IncState) -> str:
        v = state.get("verify") or {}
        return "close" if v.get("ok") is False and v.get("failed") == ["mission"] else "verify"

    async def service_failed(state: IncState) -> IncState:
        """A failed/declined service job is a failed ATTEMPT: close() counts it and SENTINEL replans (escalating only after the caps)."""
        s = S(ctx, state)
        wr = state.get("work_result") or {}
        s.ev("action", f"The service job did not complete: {wr.get('reason') or 'declined'}", asset_id=state["det"]["target_id"])
        await ctx.sleep_sim(10)  # let transient conditions (locks, draining) clear before the next attempt
        return s.patch(verify={"ok": False, "failed": ["mission"], "reason": f"the service job did not complete ({wr.get('reason') or 'declined'})"})

    def after_outrig(state: IncState) -> str:
        return "verify" if (state.get("work_result") or {}).get("ok") else "service_failed"

    # ───────────────────────────── close / recurse ─────────────────────────────
    async def close(state: IncState) -> IncState:
        s = S(ctx, state)
        det = state["det"]
        v = state["verify"]
        await memory_write(ctx, state)
        if v["ok"]:
            s.stage("verified", "ok")
            reason = f"Verified: physics recovered within the stabilisation window ({fac.label(det['target_id'])})."
            s.inc.update(status="resolved", severity="nominal", closed_tick=ctx.tick, close_reason=reason, summary=reason)
            ctx.emit("incident.closed", s.id, {"incident": s.inc})
            s.incident_dirty = True
            ctx.lock_suppress([det["target_id"], *det["affected"]], ctx.now + 70)
            return s.patch(outcome="resolved", verify=None)
        s.inc["attempts"] += 1
        s.inc["stage_log"].append({"stage": "verified", "tick": ctx.tick, "outcome": "rejected"})
        s.inc["stage"] = "investigated"
        s.set_status("replanning", f"Verification rejected the repair - replanning (attempt {s.inc['attempts'] + 1}).")
        return s.patch(outcome="", attempt=s.inc["attempts"])

    def after_close(state: IncState) -> str:
        return END if state.get("outcome") == "resolved" else "choose"

    # ───────────────────────────── escalate ─────────────────────────────
    async def escalate(state: IncState) -> IncState:
        s = S(ctx, state)
        det, root = state["det"], sentinel_root(state)
        wr = state.get("work_result") or {}
        reason = state.get("esc_reason") or (f"The repair job stopped: {wr.get('reason')}." if wr.get("ok") is False and wr.get("reason") else "") or \
            (f"Verification kept failing: {(state.get('verify') or {}).get('reason')}." if (state.get("verify") or {}).get("reason") else "") or \
            "The automatic repair options for this fault have been exhausted."
        t = s.task("sentinel", "escalate", "Escalate to operator", "What cannot be resolved within the autonomous whitelist?", parent=root)
        fb = f"{reason} An operator should review this incident; monitoring continues."
        dec = await s.decide(t, "escalate", {"reason": reason, "cause": det["cause"], "attempts": s.inc["attempts"]}, lambda: {"summary": fb},
                             instruction="State briefly, in plain language, why the autonomous policy cannot continue.")
        s.finish(t, "blocked", dec["summary"] or fb, ("Escalated", False))
        s.set_status("escalated", dec["summary"] or fb)
        dc = state.get("dod")
        if dc is not None and dc.get("terminal_state") != "VERIFIED":
            low = reason.lower()
            dc["terminal_state"] = dod_mod.terminal_of(dc, escalated=True, timed_out=("ended without" in low or "timed out" in low or "timeout" in low))
            dc["state"] = "ESCALATED"
            dc["escalation_reason"] = reason[:300]
            dn.emit(ctx, dc)
        robot = state.get("robot")
        if robot and (ctx.world["robots"].get(robot) or {}).get("mode") != "DOCKED":
            await fire_return(ctx, s, robot, root, "retesc", "Crawler returning to port.")
        return s.patch(outcome="escalated", **({"dod": dc} if dc is not None else {}))

    # ───────────────────────────── workload: decide NOT to dispatch ─────────────────────────────
    async def monitor_only(state: IncState) -> IncState:
        s = S(ctx, state)
        det = state["det"]
        r = det["target_id"]
        ema = ctx.monitor._ema.get(r) or rd(ctx.world, r, "power_kw", 1.0) or 1.0
        t0 = ctx.now
        s.set_status("investigating", f"Monitoring rack {r.replace('rack_', '').upper()}: workload-driven, no repair required.")
        await ctx.wait_until(lambda: (rd(ctx.world, r, "power_kw", 0.0) or 0.0) / max(ema, 1.0) <= 1.06 or ctx.now - t0 > 400)
        root = sentinel_root(state)
        v = s.task("sentinel", "verify", "Confirm load has subsided", "Did the rack return to baseline with margin intact?", parent=root, caused_by=[s.task_ref(state["plan"]["decide_task"])])
        m = ctx.monitor.margin(r, ctx.world)
        await s.tool(v, "read_telemetry", {"rack": r, "window_s": 60}, lambda: {"margin_k": rnd(m, 1), "power_kw": rnd(rd(ctx.world, r, "power_kw", 0.0) or 0.0, 0)})
        s.finish(v, "verified", f"Rack {r.replace('rack_', '').upper()} settled at {m:.1f} K margin. No robot work was needed.", ("Dismissed", True))
        reason = "Workload surge subsided; thermal margin remained safe. No dispatch."
        s.inc["attempts"] = 0
        s.inc["stage_log"].append({"stage": "verified", "tick": ctx.tick, "outcome": "ok"})
        s.inc.update(stage="verified", status="dismissed", severity="nominal", closed_tick=ctx.tick, close_reason=reason, summary=reason)
        ctx.emit("incident.closed", s.id, {"incident": s.inc})
        ctx.lock_suppress([r], ctx.now + 60)
        s.incident_dirty = True
        return s.patch(outcome="dismissed")

    # ───────────────────────────── assemble ─────────────────────────────
    g = StateGraph(IncState)
    for name, fn in [("classify", classify), ("spawn_reviewers", spawn_reviewers), ("reviewer", reviewer), ("reconcile", reconcile),
                     ("plan_inspection", plan_inspection), ("evaluate", evaluate), ("choose", choose), ("prep_return", prep_return),
                     ("safety", safety), ("approval", approval), ("dispatch_prepare", dispatch_prepare), ("post_clear", post_clear),
                     ("close", close), ("service_failed", service_failed), ("escalate", escalate), ("monitor", monitor_only)]:
        g.add_node(name, fn)
    g.add_node("probes", probe_graph)
    g.add_node("inpipe_inspect", inpipe_graph)
    g.add_node("inpipe_return", inpipe_graph)
    g.add_node("inpipe_clear", inpipe_graph)
    g.add_node("outrig", outrig_graph)
    g.add_node("verify", verifier_graph)

    g.add_edge(START, "classify")
    g.add_edge("classify", "spawn_reviewers")
    g.add_conditional_edges("spawn_reviewers", fanout, ["reviewer"])
    g.add_edge("reviewer", "reconcile")
    g.add_edge("reconcile", "probes")
    g.add_edge("probes", "plan_inspection")
    g.add_conditional_edges("plan_inspection", after_plan_inspection, {"inpipe_inspect": "inpipe_inspect", "evaluate": "evaluate"})
    g.add_edge("inpipe_inspect", "evaluate")
    g.add_edge("evaluate", "choose")
    g.add_conditional_edges("choose", after_choose, {"escalate": "escalate", "monitor": "monitor", "prep_return": "prep_return", "safety": "safety"})
    g.add_edge("prep_return", "inpipe_return")
    g.add_edge("inpipe_return", "safety")
    g.add_conditional_edges("safety", after_safety, {"escalate": "escalate", "approval": "approval", "dispatch_prepare": "dispatch_prepare"})
    g.add_conditional_edges("approval", after_approval, {"dispatch_prepare": "dispatch_prepare", "escalate": "escalate"})
    g.add_conditional_edges("dispatch_prepare", route_dispatch, {"inpipe_clear": "inpipe_clear", "outrig": "outrig"})
    g.add_edge("inpipe_clear", "post_clear")
    g.add_conditional_edges("post_clear", after_post_clear, {"close": "close", "verify": "verify"})
    g.add_conditional_edges("outrig", after_outrig, {"verify": "verify", "service_failed": "service_failed"})
    g.add_edge("service_failed", "close")
    g.add_edge("verify", "close")
    g.add_conditional_edges("close", after_close, {END: END, "choose": "choose"})
    g.add_edge("escalate", END)
    g.add_edge("monitor", END)
    return g.compile(checkpointer=checkpointer)


def plan_attempt(state: IncState) -> int:
    return int((state.get("plan") or {}).get("attempt", 0))


def _normalize_hyps(ctx: AgentContext, s: IncidentSession, det: Json, proposed: list[Json], fb: list[Json]) -> tuple[list[Json], list[str]]:
    notes: list[str] = []
    items = [dict(p) for p in proposed if ctx.fac.exists(p["target_id"])]
    if not any(p["cause"] == det["cause"] and p["target_id"] == det["target_id"] for p in items):
        base = next((f for f in fb if f["cause"] == det["cause"]), None)
        if base:
            items.insert(0, dict(base))
            notes.append("detector hypothesis re-added")
    for p in items:
        contradicts = p["cause"] != det["cause"]
        if contradicts and p["confidence"] > 0.45:
            p["confidence"] = 0.45
            notes.append(f"capped {p['cause']} at 0.45 (contradicts detector evidence until physically confirmed)")
    mine = [p for p in items if p["cause"] == det["cause"]]
    others = [p for p in items if p not in mine]
    if mine and others:  # detector evidence stays the working cause until a robot/verifier physically confirms otherwise
        mine[0]["confidence"] = min(1.0, max(mine[0]["confidence"], max(p["confidence"] for p in others) + 0.01))
    total = sum(p["confidence"] for p in items) or 1.0
    ev_ids = {e["id"] for e in s.inc["evidence"]}
    out = []
    for p in items:
        ef = [x for x in p.get("evidence_for", []) if x in ev_ids] or ([e["id"] for e in s.inc["evidence"]][:3] if p["cause"] == det["cause"] else [])
        out.append({"id": f"h_{s.id}_{p['cause']}_{p['target_id']}", "cause": p["cause"], "label": hyp_label(ctx, p["cause"], p["target_id"]),
                    "target_id": p["target_id"], "confidence": round(p["confidence"] / total, 2), "status": "candidate",
                    "evidence_for": ef, "evidence_against": [str(x)[:160] for x in p.get("evidence_against", [])][:4]})
    out.sort(key=lambda h: -h["confidence"])
    if out:
        out[0]["status"] = "supported"
    return out, notes
