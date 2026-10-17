"""Reviewer subgraphs (hydraulics / thermal / accessibility), fanned out by SENTINEL via Send."""
from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from ..analysis import est_occlusion, est_strainer_occlusion, est_valve_opening, hyp_label, pct, rnd
from ..context import AgentContext
from ..session import IncidentSession
from ..world import Json, rd
from .common import S

REVIEW_Q = {
    "hydraulics": "Which hydraulic element explains the pressure and flow pattern?",
    "thermal": "How much thermal margin remains, and how fast is it eroding?",
    "accessibility": "Can a robot physically reach and safely service the suspected component?",
}


class ReviewState(TypedDict, total=False):
    kind: str
    task_id: str
    incident: dict
    det: dict
    tasks: dict
    tokens_used: int
    facts: dict
    fallback_summary: str
    ev_ids: list
    out_tasks: dict
    out_evidence: list


async def _hydraulics(ctx: AgentContext, s: IncidentSession, t: Json, det: Json) -> tuple[Json, str, list[str]]:
    fac, mon, w = ctx.fac, ctx.monitor, ctx.world
    c, tgt = det["cause"], det["target_id"]
    ids: list[str] = []
    facts: Json = {"cause": c, "target": tgt}
    if c == "fouling":
        ratio = mon.dp_ratio(tgt, w)
        occ = est_occlusion(ratio)
        e = fac.edges[tgt]
        await s.tool(t, "query_topology", {"edge": tgt, "neighbors": True}, lambda: {
            "edge": e["label"], "loop": e["loop"], "diameter_mm": e["diameter_mm"], "length_m": e["length_m"], "passable": e["robot_passable"]})
        zflow = mon.flow_est(tgt, w)
        await s.tool(t, "solve_twin_whatif", {"hypothesis": f"bore occlusion on {tgt}", "occlusion": rnd(occ, 2)}, lambda: {
            "observed_dp_ratio": rnd(ratio, 2), "estimated_occlusion": rnd(occ, 2), "measured_flow_kg_s": rnd(zflow, 2), "method": "calibrated dP ratio inversion"})
        ids.append(s.ev("telemetry", f"Twin what-if: ~{pct(occ)} bore restriction on {fac.label(tgt)} reproduces dP {ratio:.1f}x design",
                        local=True, asset_id=tgt, tags=["hydraulics", "what-if"]))
        facts.update(dp_ratio=rnd(ratio, 2), est_occlusion=rnd(occ, 2), flow_kg_s=rnd(zflow, 2))
        summ = (f"A localized restriction near {fac.label(tgt)} (~{pct(occ)} of bore) reproduces the measured dP ({ratio:.1f}x design) "
                f"and the flow shortfall. Measured zone flow {zflow:.2f} kg/s.")
    elif c == "strainer_blockage":
        ratio = mon.strainer_ratio(tgt, w)
        occ = est_strainer_occlusion(ratio)
        await s.tool(t, "query_topology", {"asset": tgt}, lambda: {"asset": tgt, "loop": fac.assets[tgt].get("loop"), "inline": True})
        ref = mon.ref_q.get("fws" if tgt == "strainer_01" else "tcs", 0.0)
        flow = mon.strainer_flow(tgt, w)
        loss = (1 - flow / ref) * 100 if ref else 0.0
        await s.tool(t, "solve_twin_whatif", {"hypothesis": f"basket clogging at {tgt}", "occlusion": rnd(occ, 2)},
                     lambda: {"predicted_dp_ratio": rnd(ratio, 2), "flow_loss_pct": rnd(loss, 1)})
        ids.append(s.ev("telemetry", f"Basket ~{pct(occ)} blocked explains dP {ratio:.1f}x and loop flow loss", local=True, asset_id=tgt, tags=["hydraulics"]))
        facts.update(dp_ratio=rnd(ratio, 2), flow_loss_pct=rnd(loss, 1))
        summ = (f"Strainer dP is {ratio:.1f}x design while the whole loop's flow fell uniformly - a series restriction, "
                f"not a branch problem. Basket blockage of roughly {pct(occ)} fits.")
    elif c == "valve_stuck":
        r = tgt.replace("valve_", "rack_")
        ref = mon.ref_rack_flow(r, w)
        q = rd(w, r, "flow_kg_s", 0.0) or 0.0
        est = est_valve_opening(q / ref if ref else 1.0)
        hdr = fac.zone_header(fac.rack_zone(r) or "")
        cmd_open = (rd(w, tgt, "opening_pct", 100.0) or 100.0) / 100.0
        await s.tool(t, "query_topology", {"asset": tgt, "branch": r}, lambda: {"commanded_opening_pct": round(cmd_open * 100), "header": fac.label(hdr or "")})
        await s.tool(t, "solve_twin_whatif", {"hypothesis": f"{tgt} effective opening", "opening": rnd(est, 2)},
                     lambda: {"measured_branch_flow": rnd(q, 2), "expected_flow": rnd(ref, 2), "method": "heuristic flow-fraction estimate"})
        ids.append(s.ev("telemetry", f"Branch flow implies valve effective opening ~ {pct(est)} vs {pct(cmd_open)} commanded", local=True, asset_id=tgt, tags=["hydraulics"]))
        facts.update(flow_kg_s=rnd(q, 2), expected_kg_s=rnd(ref, 2), est_opening=rnd(est, 2))
        summ = (f"Only rack {r.replace('rack_', '').upper()} is starved; its header dP and sibling rack are normal. The branch behaves like a "
                f"valve at ~{pct(est)} effective opening against {pct(cmd_open)} commanded.")
    elif c == "pump_degradation":
        sp = mon.tcs_speed(w)
        head = rd(w, tgt, "head_kpa", 0.0) or 0.0
        exp = mon.h_norm * (sp / 100) ** 2
        vib = rd(w, tgt, "vibration_mm_s", 0.0) or 0.0
        await s.tool(t, "query_pump_curve", {"pump": tgt, "speed_pct": round(sp)}, lambda: {"head_measured_kpa": rnd(head, 0), "head_on_curve_kpa": rnd(exp, 0)})
        ids.append(s.ev("telemetry", f"Pump head {head:.0f} kPa below curve with vibration {vib:.1f} mm/s", local=True, asset_id=tgt, tags=["pump"]))
        facts.update(head_kpa=rnd(head, 0), expected_kpa=rnd(exp, 0), vibration=rnd(vib, 1))
        summ = "Every branch lost flow in proportion and no dP anomaly exists in any segment: the shortfall originates at the pump. Head is below the curve and vibration is elevated."
    elif c == "sensor_drift":
        edge = fac.assets[tgt]["edge_id"]
        z = fac.edge_zone(edge)
        rs = fac.zone_all_racks(z) if z and edge in fac.zone_edges(z) else list(fac.all_racks)
        meter = rd(w, tgt, "flow_kg_s", 0.0) or 0.0
        resid = meter - sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in rs)
        await s.tool(t, "check_mass_balance", {"meters": [tgt], "reference": "rack meters"}, lambda: {"residual_kg_s": rnd(resid, 2)})
        ids.append(s.ev("telemetry", "Mass balance does not close at the suspect meter while rack meters agree with the pump curve", local=True, asset_id=tgt, tags=["sensor"]))
        facts.update(residual_kg_s=rnd(resid, 2))
        summ = (f"Rack-level meters agree with the pump curve and thermal response; only {fac.label(tgt)} disagrees. "
                "The plant is behaving normally - the instrument is the likelier culprit.")
    else:
        r = tgt if tgt.startswith("rack_") else fac.racks[0]
        ref = mon.ref_rack_flow(r, w)
        q = rd(w, r, "flow_kg_s", 0.0) or 0.0
        await s.tool(t, "check_flow_normality", {"rack": r}, lambda: {"flow_residual_pct": rnd((q - ref) / ref * 100 if ref else 0.0, 1)})
        ids.append(s.ev("telemetry", "Hydraulics nominal on every branch", local=True, tags=["hydraulics"]))
        summ = "Flow, dP and pump behaviour are all nominal. No hydraulic cause is indicated."
    facts["fallback"] = summ
    return facts, summ, ids


async def _thermal(ctx: AgentContext, s: IncidentSession, t: Json, det: Json) -> tuple[Json, str, list[str]]:
    fac, mon, w, h = ctx.fac, ctx.monitor, ctx.world, ctx.history
    racks = fac.scope_racks(det["cause"], det["target_id"]) or list(fac.racks)
    worst = min(racks, key=lambda r: mon.margin(r, w))
    m0 = mon.margin(worst, w)
    await s.tool(t, "read_telemetry", {"assets": racks, "metric": "margin_k"},
                 lambda: {"worst_rack": worst, "margin_k": rnd(m0, 1), "t_chip_c": rnd(rd(w, worst, "t_chip_c", 0.0) or 0.0, 1)})
    slope = h.slope(worst, "margin_k", 20)

    def fc() -> Json:
        to_warn = (m0 - fac.warn_k) / -slope if slope < -0.002 and m0 > fac.warn_k else None
        return {"slope_k_per_min": rnd(slope * 60, 2), "seconds_to_warning": None if to_warn is None else round(to_warn)}

    out = await s.tool(t, "forecast_margin", {"rack": worst, "horizon_s": 600}, fc)
    eid = s.ev("telemetry", f"Rack {worst.replace('rack_', '').upper()} margin {m0:.1f} K ({out.get('slope_k_per_min')} K/min)",
               local=True, asset_id=worst, tags=["thermal"])
    eta = out.get("seconds_to_warning")
    summ = (f"Rack {worst.replace('rack_', '').upper()} is the thermal limiter at {m0:.1f} K margin"
            + (f", eroding {abs(float(out['slope_k_per_min']))} K/min - warning threshold in ~{max(1, round(eta / 60))} min if nothing changes" if eta else " and stable for now") + ".")
    return {"worst_rack": worst, "margin_k": rnd(m0, 1), "slope_k_per_min": out.get("slope_k_per_min"), "seconds_to_warning": eta, "fallback": summ}, summ, [eid]


async def _access(ctx: AgentContext, s: IncidentSession, t: Json, det: Json) -> tuple[Json, str, list[str]]:
    fac = ctx.fac
    c, tgt = det["cause"], det["target_id"]
    if c == "fouling":
        edge, sm = tgt, fac.edges[tgt]["length_m"] / 2
    elif c == "valve_stuck":
        edge, sm = (fac.zone_header(fac.rack_zone(tgt.replace("valve_", "rack_")) or "") or ""), None
    elif c == "sensor_drift":
        edge, sm = fac.assets[tgt]["edge_id"], fac.assets[tgt].get("s_m")
    else:
        edge, sm = "", None
    if edge and sm is None:
        sm = fac.edges[edge]["length_m"] / 2

    def reach() -> Json:
        res: Json = {}
        for rid, r in (ctx.world.get("robots") or {}).items():
            if r.get("class") != "inpipe":
                continue
            if not edge:
                res[rid] = {"reachable": False, "reason": "target is not a serviceable pipe"}
                continue
            pose = r.get("pose") or {}
            rt = fac.route((pose.get("segment_id") or "", float(pose.get("s_m") or 0.0)), (edge, float(sm))) if pose.get("segment_id") else None
            res[rid] = {"reachable": True, "route_m": rnd(rt[0], 1), "eta_s": round(rt[0] / 0.12), "via": " > ".join(rt[1])} if rt else {"reachable": False}
        svc = fac.assets.get(tgt, {}).get("service_xyz_m")
        res["outrig"] = {"reachable": True, "service_pose": [rnd(x, 1) for x in svc]} if svc else {"reachable": False, "reason": "no direct service access"}
        return res

    out = await s.tool(t, "check_reachability", {"targets": [edge or tgt], "robot_classes": ["inpipe", "outrig"]}, reach)
    ok = [(k, v) for k, v in out.items() if k != "outrig" and isinstance(v, dict) and v.get("reachable")]
    ok.sort(key=lambda kv: kv[1]["route_m"])
    if ok:
        k, v = ok[0]
        summ = (f"{fac.label(k) if k in fac.assets else k.upper().replace('_', '-')} can reach {fac.label(edge)} via {v['via']} ({v['route_m']} m, ETA {round(v['eta_s'] / 60, 1)} min). "
                "OUTRIG has a legal service pose for exterior work.")
        evs = f"{k} can reach the segment ({v['route_m']} m)"
    else:
        summ = "No crawler can enter this component (bore or topology). OUTRIG has a legal service pose for exterior work."
        evs = "No crawler route to the target - exterior access only"
    eid = s.ev("topology", evs, local=True, asset_id=edge or tgt, tags=["access"])
    return {"reach": {k: bool(isinstance(v, dict) and v.get("reachable")) for k, v in out.items()}, "fallback": summ}, summ, [eid]


def build_reviewer_graph(ctx: AgentContext):
    async def gather(st: ReviewState) -> ReviewState:
        s = S(ctx, st, prefix=st["kind"][0])
        s.ev_seq = 0  # branch-local evidence ids: ev_<inc>_<h|t|a><n>
        t = s.known[st["task_id"]]
        t = {**t, "tool_calls": list(t["tool_calls"]), "evidence_ids": list(t["evidence_ids"])}
        s.changed[t["id"]] = t
        async with ctx.sem(s.id):
            fn = {"hydraulics": _hydraulics, "thermal": _thermal, "accessibility": _access}[st["kind"]]
            facts, summ, ids = await fn(ctx, s, t, st["det"])
        return {"facts": facts, "fallback_summary": summ, "ev_ids": ids, "tasks": {t["id"]: t}, "out_evidence": s.new_evidence}

    async def summarize(st: ReviewState) -> ReviewState:
        s = S(ctx, st)
        import copy
        t = copy.deepcopy(st["tasks"][st["task_id"]])
        fb = st["fallback_summary"]
        dec = await s.decide(t, "review", {"role": st["kind"], "cause": st["det"]["cause"], "facts": st["facts"], "title": st["det"]["title"]},
                             lambda: {"summary": fb, "findings": [], "supports": st["det"]["cause"]}, suffix=f".{st['kind']}",
                             instruction=f"You are the {st['kind']} reviewer. Summarise what the facts show; 'supports' must be a fault kind or 'none'.")
        summary = dec.get("summary") or fb
        label = {"hydraulics": "Hydraulic picture", "thermal": "Thermal risk", "accessibility": "Access assessment"}[st["kind"]]
        s.finish(t, "completed", summary, (label, True), st["ev_ids"])
        return {"out_tasks": {t["id"]: t}, "tokens_used": ctx.decisions.budget(s.id).used}

    g = StateGraph(ReviewState)
    g.add_node("gather", gather)
    g.add_node("summarize", summarize)
    g.add_edge(START, "gather")
    g.add_edge("gather", "summarize")
    g.add_edge("summarize", END)
    return g.compile()
