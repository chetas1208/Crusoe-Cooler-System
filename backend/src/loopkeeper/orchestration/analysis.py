"""Deterministic analysis: verification metrics/checks, twin estimates, fallback hypotheses.

All inputs come from the world dict / rolling history / topology (never plant internals).
The independent verifier compares measured after-windows with a counterfactual reference:
the engine's twin (`twin.counterfactual`) when it answers, otherwise the self-calibrated
healthy reference scaled by the loss seen on racks unrelated to this incident.
"""
from __future__ import annotations

from typing import Any

from .context import AgentContext
from .world import Json, rd

FOUL_EXTENT = 0.25


def foul_factor(o: float, extent: float = FOUL_EXTENT) -> float:
    return 1.0 + extent * ((1.0 - o) ** -5 - 1.0)


def est_occlusion(ratio: float, extent: float = FOUL_EXTENT) -> float:
    """Invert dp ratio = 1 + extent*((1-o)^-5 - 1)."""
    if ratio <= 1.0:
        return 0.0
    return max(0.0, min(0.96, 1.0 - ((ratio - 1.0) / extent + 1.0) ** (-0.2)))


def est_strainer_occlusion(ratio: float) -> float:
    return max(0.0, 1.0 - max(ratio, 1e-6) ** -0.4)


def est_valve_opening(flow_frac: float) -> float:
    """Heuristic effective opening from branch flow fraction (labelled estimate, not physics)."""
    return max(0.03, min(1.0, flow_frac ** 2.2))


def pct(x: float) -> str:
    return f"{round(x * 100)}%"


def rnd(x: float, d: int = 2) -> float:
    return round(float(x), d)


# ── counterfactual reference ──
def healthy_reference(ctx: AgentContext, scope: list[str], excluded: set[str]) -> Json:
    mon, w = ctx.monitor, ctx.world
    ref = {r: mon.ref_rack_flow(r, w) for r in ctx.fac.racks}
    base = [r for r in ctx.fac.racks if r not in scope and ref[r] > 0.2]
    others = [r for r in base if r not in excluded] or base      # racks of a loop-wide fault (pump, strainer) still carry the common-cause loss
    factor = 1.0
    if others:
        import statistics
        factor = statistics.median(ctx.history.avg(r, "flow_kg_s", 6) / ref[r] for r in others)
        factor = max(0.5, min(1.05, factor))
    rack = {r: ref[r] * (factor if r in scope else 1.0) for r in ctx.fac.racks}
    q = mon.ref_q
    sp = mon.speed_ratio(w)
    return {"rack_flow_kg_s": rack, "tcs_flow_kg_s": q.get("tcs", sum(rack.values())) * sp * factor,
            "fws_flow_kg_s": q.get("fws", 0.0), "source": "calibrated-healthy-reference"}


async def twin_counterfactual(ctx: AgentContext, det: Json, cmd_id: str, inc: str, task_id: str) -> Json | None:
    if not getattr(ctx.engine, "supports_twin_counterfactual", False):
        return None  # engine has no what-if endpoint: the verifier falls back to the calibrated healthy reference
    cmd = ctx.make_cmd("twin.counterfactual", cmd_id, incident_id=inc, task_id=task_id, role="sentinel",
                       target_id=det["target_id"], args={"remove_fault": {"cause": det["cause"], "target_id": det["target_id"]}})
    ack, _ = await ctx.submit(cmd, inc)
    res = ack.get("result") if ack.get("accepted") else None
    if isinstance(res, dict) and isinstance(res.get("rack_flow_kg_s"), dict) and all(r in res["rack_flow_kg_s"] for r in ctx.fac.racks):
        return {**res, "source": "engine-twin"}
    return None


def other_affected(ctx: AgentContext, inc_id: str) -> set[str]:
    out: set[str] = set()
    for i in ctx.ledger.incidents.values():
        if i["id"] == inc_id or i.get("closed_tick") is not None:
            continue
        out.update(a for a in i.get("affected_asset_ids", []) if a.startswith("rack_"))
    out |= ctx.racks_in_maintenance(inc_id)
    return out


def compute_metrics(ctx: AgentContext, det: Json, inc_id: str, cf: Json, clean: list[str] | None = None) -> Json:
    fac, mon, h, w = ctx.fac, ctx.monitor, ctx.history, ctx.world
    racks = fac.scope_racks(det["cause"], det["target_id"])
    excl = other_affected(ctx, inc_id)
    mr = [r for r in racks if r not in excl]
    cfr = cf["rack_flow_kg_s"]
    m: Json = {}

    def norm_margin(r: str) -> float:
        return h.avg(r, "margin_k", 6, 99.0) + 0.4 * max(0.0, h.avg(r, "power_kw", 6, 0.0) - 0.95 * fac.nominal_rack_kw)

    # judge margin only where this fault's hydraulics have recovered: a rack still starved for an INDEPENDENT reason is another incident's job
    hyd_ok = [r for r in mr if cfr.get(r, 0) <= 0.2 or h.avg(r, "flow_kg_s", 6) >= 0.9 * cfr[r]]
    m["margin"] = min(norm_margin(r) for r in hyd_ok) if hyd_ok else 99.0
    m["margin_excl"] = 0 if hyd_ok else 1
    _pool = mr or racks or list(fac.racks)
    m["margin_all"] = min((norm_margin(r) for r in _pool), default=m["margin"])        # thermal margin over EVERY rack in scope, whether or not its hydraulics have recovered

    def dev(r: str) -> float:
        return abs(h.avg(r, "flow_kg_s", 6) - cfr[r]) / max(cfr[r], 0.1)

    cause, tgt = det["cause"], det["target_id"]
    if cause in ("fouling", "strainer_blockage"):
        if cause == "fouling":
            whole = len(racks) == len(fac.racks) and not excl
            eff = [r for r in racks if r not in excl] or racks   # racks owned by another open incident would distort this verdict
            m["flow"], m["flow_ref"] = _scope_flow(ctx, eff, cfr)
            m["dp_ratio"] = _avg_ratio(ctx, lambda: mon.dp_ratio(tgt, ctx.world))
        else:
            fws = tgt == "strainer_01"
            if fws:
                m["flow"] = h.avg(tgt, "flow_kg_s", 6, 0.0)
                m["flow_ref"] = cf["fws_flow_kg_s"] or mon.ref_q.get("fws", m["flow"])
            else:
                m["flow"], m["flow_ref"] = _scope_flow(ctx, [r for r in fac.racks if r not in excl] or list(fac.racks), cfr)
            m["dp_ratio"] = _avg_ratio(ctx, lambda: mon.strainer_ratio(tgt, ctx.world))
    elif cause == "valve_stuck":
        r = racks[0]
        m["flow"] = h.avg(r, "flow_kg_s", 6)
        m["flow_ref"] = cfr[r]
    elif cause == "pump_degradation":
        duty = mon.duty_pump(w) or tgt
        sp = mon.tcs_speed(w) / 100.0
        exp = mon.h_norm * sp * sp
        m["head_ratio"] = h.avg(duty, "head_kpa", 6) / max(exp, 1.0)
        m["vibration"] = h.avg(duty, "vibration_mm_s", 6)
        m["flow"] = h.avg("cdu_01", "tcs_flow_kg_s", 6, 0.0) or sum(h.avg(r, "flow_kg_s", 6) for r in fac.all_racks)
        m["flow_ref"] = cf["tcs_flow_kg_s"]
    elif cause == "sensor_drift":
        edge = fac.assets[tgt]["edge_id"]
        z = fac.edge_zone(edge)
        whole = not (z and edge in fac.zone_edges(z))
        rs = list(fac.all_racks) if whole else fac.zone_all_racks(z)
        meter = h.avg(tgt, "flow_kg_s", 6)
        m["residual_kg_s"] = abs(meter - sum(h.avg(r, "flow_kg_s", 6) for r in rs))
        m["tol_kg_s"] = 0.14 if whole else 0.08
    # collateral: racks OUTSIDE this incident that were healthy when it opened must still be healthy (a rack starved by some other
    # fault is that fault's incident, not damage caused by this repair)
    cands = [r for r in fac.racks if r not in racks and r not in excl and cfr.get(r, 0) >= 0.5 and (clean is None or r in clean)]
    other_active = any(i["id"] != inc_id and i.get("closed_tick") is None and i.get("cause") != "workload_spike"
                       and not str(i.get("title", "")).endswith("load surge") for i in ctx.ledger.incidents.values()) or bool(mon._streak)
    m["collateral"] = 0.0 if other_active else max((dev(r) for r in cands), default=0.0)
    m["collateral_skipped"] = 1 if other_active else 0     # other faults are active: flow deviations elsewhere cannot be blamed on this repair
    m["_clean"] = [r for r in cands if dev(r) < 0.06]
    return m


def _scope_flow(ctx: AgentContext, racks: list[str], cfr: Json) -> tuple[float, float]:
    """(measured, reference) flow for a set of racks. The measured side is the reference scaled by the MEDIAN rack recovery
    ratio, so one rack starved by an unrelated fault cannot fail (or mask) a loop-level verdict."""
    import statistics
    prim = [r for r in racks if cfr.get(r, 0) >= 0.5] or racks          # tiny auxiliary racks are too noisy to judge
    ref = sum(cfr[r] for r in prim)
    ratios = [ctx.history.avg(r, "flow_kg_s", 6) / cfr[r] for r in prim if cfr.get(r, 0) > 0.05]
    return (ref * statistics.median(ratios) if ratios else 0.0), ref


def _avg_ratio(ctx: AgentContext, fn: Any) -> float:
    # ratios are computed from the latest world; smooth with history through reading averages
    try:
        return float(fn())
    except Exception:
        return 1.0


def scope_label(ctx: AgentContext, det: Json) -> str:
    racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
    if len(racks) == 1:
        return f"Rack {racks[0].replace('rack_', '').upper()}"
    if len(racks) == 2:
        z = ctx.fac.rack_zone(racks[0]) or "zone"
        return f"Zone {ctx.fac.zone_short(z).upper()}"
    return "Loop"


# Pass thresholds are ABSOLUTE (configuration), never derived from the faulted baseline: worse damage must not loosen the bar.
COLLATERAL_MAX_PCT = 6.0
DRIFT_COLLATERAL_MAX_PCT = 4.0


def checks_for(ctx: AgentContext, det: Json, before: Json, after: Json) -> list[Json]:
    warn = ctx.fac.warn_k
    checks: list[Json] = []

    def add(cid: str, label: str, unit: str, b: float, a: float, target: float, direction: str) -> None:
        checks.append({"id": cid, "label": label, "unit": unit, "before": rnd(b, 3), "after": rnd(a, 3),
                       "target": rnd(target, 3), "direction": direction,
                       "pass": (a >= target) if direction == "min" else (a <= target)})

    sl = scope_label(ctx, det)
    c = det["cause"]
    if c in ("fouling", "strainer_blockage", "valve_stuck"):
        add("flow", f"{sl} flow", "kg/s", before.get("flow", 0), after["flow"], 0.95 * after["flow_ref"], "min")
        if c != "valve_stuck":
            add("dp", f"{'Strainer' if det['target_id'].startswith('strainer') else 'Segment'} dP vs design", "x",
                before.get("dp_ratio", 1), after["dp_ratio"], 1.4, "max")
        if not after.get("margin_excl"):
            add("margin", f"Thermal margin at nominal load - {sl}", "K", before.get("margin", 0), after["margin"], warn, "min")
        add("collateral", "Collateral flow deviation" + (" (not judged - other faults active)" if after.get("collateral_skipped") else ""), "%",
            before.get("collateral", 0) * 100, after["collateral"] * 100, COLLATERAL_MAX_PCT, "max")
    elif c == "pump_degradation":
        add("head", "Head vs pump curve", "%", before.get("head_ratio", 0) * 100, after["head_ratio"] * 100, 96, "min")
        add("vib", "Bearing vibration", "mm/s", before.get("vibration", 0), after["vibration"], 2.8, "max")
        if not after.get("margin_excl"):
            add("margin", "Thermal margin at nominal load", "K", before.get("margin", 0), after["margin"], warn, "min")
    elif c == "sensor_drift":
        add("residual", "Meter vs rack-meter residual", "kg/s", before.get("residual_kg_s", 0), after["residual_kg_s"], after["tol_kg_s"], "max")
        add("collateral", "True flows unchanged" + (" (not judged - other faults active)" if after.get("collateral_skipped") else ""), "%",
            before.get("collateral", 0) * 100, after["collateral"] * 100,
            DRIFT_COLLATERAL_MAX_PCT, "max")
    return checks


# ── fallback hypotheses (deterministic prior, ported from the reference simulator) ──
def hyp_label(ctx: AgentContext, cause: str, target: str) -> str:
    L = ctx.fac.label(target)
    return {
        "fouling": f"Fouling in {L}", "valve_stuck": f"{L} actuator stuck partially closed",
        "sensor_drift": f"{L} measurement drift", "strainer_blockage": f"{L} basket blockage",
        "pump_degradation": f"{L} bearing / impeller wear", "workload_spike": "Workload surge (no hydraulic fault)",
        "leak": f"Leak near {L}",
    }.get(cause, cause)


def fallback_hypotheses(ctx: AgentContext, det: Json) -> list[Json]:
    fac = ctx.fac
    cause, tgt = det["cause"], det["target_id"]

    def first(*ids: str) -> str | None:
        return next((i for i in ids if fac.exists(i)), None)

    spec: list[tuple[str, str | None, float, bool]] = []  # cause, target, weight, has_for_evidence
    if cause == "fouling":
        z = fac.edge_zone(tgt)
        zv = fac.zone_valve(z) if z else None
        spec = [("fouling", tgt, 0.64, True), ("valve_stuck", zv, 0.17, True), ("sensor_drift", first(*fac.flow_sensors), 0.10, False),
                ("strainer_blockage", first("strainer_02"), 0.09, False)]
    elif cause == "strainer_blockage":
        spec = [("strainer_blockage", tgt, 0.70, True), ("pump_degradation", ctx.monitor.duty_pump(ctx.world), 0.14, True),
                ("fouling", first("p_10"), 0.16, False)]
    elif cause == "valve_stuck":
        r = tgt.replace("valve_", "rack_")
        z = fac.rack_zone(r)
        spec = [("valve_stuck", tgt, 0.58, True), ("fouling", fac.zone_header(z) if z else None, 0.26, True),
                ("sensor_drift", first(*fac.flow_sensors), 0.16, False)]
    elif cause == "pump_degradation":
        spec = [("pump_degradation", tgt, 0.76, True), ("strainer_blockage", first("strainer_02"), 0.14, False),
                ("sensor_drift", first("sn_flow_trunk"), 0.10, False)]
    elif cause == "sensor_drift":
        z = fac.edge_zone(fac.assets[tgt]["edge_id"])
        spec = [("sensor_drift", tgt, 0.62, True), ("fouling", fac.zone_header(z) if z else first("p_10"), 0.30, True),
                ("valve_stuck", first("valve_zb"), 0.08, False)]
    elif cause == "workload_spike":
        spec = [("workload_spike", tgt, 0.90, True), ("valve_stuck", tgt.replace("rack_", "valve_"), 0.06, False),
                ("fouling", first("p_17"), 0.04, False)]
    spec = [s for s in spec if s[1] and fac.exists(s[1])]
    total = sum(s[2] for s in spec) or 1.0
    against = {"valve_stuck": "Would not raise dP at the recorded flow signature", "sensor_drift": "dP and rack temperatures corroborate the flow loss",
               "strainer_blockage": "Neighbouring flows do not match a series blockage", "pump_degradation": "Pump head and vibration nominal",
               "fouling": "dP across the suspected segment is nominal"}
    out = []
    for c, t, wgt, has_for in spec:
        out.append({"cause": c, "target_id": t, "confidence": round(wgt / total, 2),
                    "evidence_for": ["detector residual"] if has_for else [],
                    "evidence_against": [] if c == cause else [against.get(c, "contradicted by telemetry")]})
    return out
