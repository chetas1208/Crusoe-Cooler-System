"""Sensors (truth + bounded seeded noise + drift offsets) and per-asset status derivation.

Status is derived from physics so the frontend severity colours are backend-owned:
  * racks    - thermal margin (chip limit - measured junction temp), flow deficit vs the healthy twin
  * pipes    - measured dP vs design resistance at the estimated flow (rack meters beat a drifting header meter)
  * strainer - same, against its design K
  * pumps    - vibration signature; `service` when isolated
  * sensors  - mass-balance disagreement with the rack meters beneath -> `suspect`
  * CDU      - approach temperature
Sampling happens inside step() on a fixed cadence; assets()/world() only read the cache, so call patterns
never perturb the RNG stream (determinism).
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .plant import FacilityPlant

Json = dict[str, Any]
PUMPS = ("pump_t1", "pump_t2", "pump_f1", "pump_f2")


def _r(x: float, d: int = 4) -> float:
    return round(float(x), d)


def sample(p: "FacilityPlant") -> Json:
    """Draw one measurement set. Fixed draw order -> deterministic."""
    nz = p.cfg["physics"]["noise"]
    rng, bs = p.rng_sensor, nz["bound_sigmas"]
    n = lambda sig: rng.bounded_normal(sig, bs)  # noqa: E731
    h, t, f = p.hyd, p.thermal, p.faults
    off = f.sensor_offset
    rho_t, rho_f = p.rho_loc("tcs"), p.rho_loc("fws")
    m: Json = {"t": p.time}
    m["tcs_supply"] = t.t_supply + n(nz["temp"])
    m["tcs_return"] = t.t_return + n(nz["temp"])
    m["fws_in"] = p.fws_in_c + n(nz["temp"])
    m["fws_out"] = t.fws.t_c + n(nz["temp"])
    m["tcs_q"] = h.q["tcs"] * rho_t + n(nz["flow"]) + off.get("sn_flow_trunk", 0.0)
    m["fws_q"] = h.q["fws"] * rho_f + n(nz["flow"] * 2)
    m["head_tcs"] = h.pump_head_pa["tcs"] / 1e3 + n(nz["pump_head"])
    m["head_fws"] = h.pump_head_pa["fws"] / 1e3 + n(nz["pump_head"])
    m["hx_kw"] = t.q_hx_w / 1e3 + n(2.0)
    m["rack"] = {}
    for r in p.racks:
        rt = t.rack[r]
        m["rack"][r] = {
            "flow": max(h.rack_q[r] * rho_t + n(nz["flow"]), 0.0),
            "chip": rt.t_chip_c + n(nz["temp"]),
            "out": rt.t_out_c + n(nz["temp"]),
            "power": p.load_w(r) / 1e3 + n(nz["power"]),
        }
    # aux racks draw from their own noise stream, so the draw order of everything above/below is unchanged
    an = lambda sig: p.rng_aux.bounded_normal(sig, bs)  # noqa: E731
    m["aux"] = {}
    for r in p.aux:
        rt = t.rack[r]
        m["aux"][r] = {
            "flow": max(h.rack_q[r] * rho_t + an(nz["flow"] * 0.5), 0.0),
            "chip": rt.t_chip_c + an(nz["temp"]),
            "out": rt.t_out_c + an(nz["temp"]),
            "power": max(p.load_w(r) / 1e3 + an(nz["power"] * 0.3), 0.0),
        }
    m["edge_flow"], m["edge_dp"] = {}, {}
    for e in p.topo["edges"]:
        eid = e["id"]
        q = h.edge_q[eid] * (rho_f if e["loop"] == "fws" else rho_t)
        q += sum(off.get(sid, 0.0) for sid, ed in p.flow_sensors.items() if ed == eid)
        m["edge_flow"][eid] = max(q + n(nz["flow"]), 0.0)
        m["edge_dp"][eid] = max(h.edge_dp_pa[eid] / 1e3 + n(nz["dp"]), 0.0)
    m["strainer_dp"] = {s: max(h.strainer_dp_pa[s] / 1e3 + n(nz["dp"]), 0.0) for s in ("strainer_01", "strainer_02")}
    m["vib"] = {pid: max(p.vib[pid] + n(nz["vib"]), 0.0) for pid in PUMPS}
    return m


def build_assets(p: "FacilityPlant", m: Json) -> tuple[Json, Json]:
    """Return (assets, kpis) from a measurement set."""
    cfg = p.cfg["physics"]
    st = cfg["status"]
    lim = p.topo["limits"]
    warn_k, crit_k = lim["margin_warn_k"], lim["margin_crit_k"]
    f, c = p.faults, p.ctl
    iso = c["isolated"]
    assets: Json = {}
    rho_t = p.rho_loc("tcs")
    zone_off = {z: bool(iso.get(f"valve_z{z}")) for z in p.zones}

    # rack-meter based flow estimates (kg/s)
    def zone_sum(z: str | None) -> float:
        return (sum(m["rack"][r]["flow"] for r in p.racks if z is None or p.rack_zone[r] == z)
                + sum(m["aux"][r]["flow"] for r in p.aux if z is None or p.rack_zone[r] == z))

    def flow_est(eid: str) -> float:
        zs = p.edge_zones.get(eid)
        if zs:
            return sum(zone_sum(z) for z in zs)
        return m["edge_flow"][eid]

    def dp_ratio(eid: str) -> float:
        k = p.kdm.get(eid)
        if not k:
            return 1.0
        q = max(flow_est(eid), 0.25)
        return max(m["edge_dp"][eid] * 1e3, 10.0) / (k * q * q)

    def strainer_ratio(sid: str) -> float:
        q = max(m["fws_q"] if sid == "strainer_01" else flow_est("p_10"), 0.5)
        return max(m["strainer_dp"][sid] * 1e3, 10.0) / (p.kdm[sid] * q * q)

    ref_q = {r: p.ref.rack_q[r] * rho_t for r in p.racks}
    deficit: dict[str, float] = {}
    min_margin = 99.0
    for r in p.racks:
        mr = m["rack"][r]
        deficit[r] = (ref_q[r] - mr["flow"]) / ref_q[r] if ref_q[r] > 0.2 else 0.0
        margin = lim["chip_limit_c"] - mr["chip"]
        min_margin = min(min_margin, margin)
        offline = p.load_w(r) < 30e3 or zone_off[p.rack_zone[r]] or bool(iso.get(f"valve_{r}"))
        status = "critical" if margin < crit_k else "warning" if margin < warn_k else "watch" if deficit[r] > 0.1 else "nominal"
        if offline and margin > warn_k:
            status = "isolated"
        assets[f"rack_{r}"] = {"status": status, "readings": {
            "power_kw": _r(mr["power"]), "flow_kg_s": _r(mr["flow"]), "t_in_c": _r(m["tcs_supply"]),
            "t_out_c": _r(mr["out"]), "t_chip_c": _r(mr["chip"]), "margin_k": _r(margin)}}

    # auxiliary racks: telemetry + thermal-margin status only (no detectors, no fault targets)
    for r in p.aux:
        ma = m["aux"][r]
        margin = lim["chip_limit_c"] - ma["chip"]
        z_off = zone_off[p.rack_zone[r]]
        assets[f"rack_{r}"] = {"status": "isolated" if z_off else "critical" if margin < crit_k else "warning" if margin < warn_k else "nominal",
                               "readings": {"power_kw": _r(ma["power"]), "flow_kg_s": _r(ma["flow"]), "t_in_c": _r(m["tcs_supply"]),
                                            "t_out_c": _r(ma["out"]), "t_chip_c": _r(ma["chip"]), "margin_k": _r(margin)}}
        assets[f"valve_{r}"] = {"status": "isolated" if z_off else "nominal", "readings": {
            "opening_pct": 0.0 if z_off else _r(p.hyd_cfg["valve_balanced_opening"] * 100), "flow_kg_s": _r(ma["flow"])}}
    for r in p.all_racks:
        q = m["rack"][r]["flow"] if r in m["rack"] else m["aux"][r]["flow"]
        assets[f"sn_rack_{r}"] = {"status": "nominal", "readings": {"flow_kg_s": _r(q)}}

    foul_watch = set(st["foul_watch"])
    pr = st["pipe_dp_ratio"]
    for e in p.topo["edges"]:
        eid = e["id"]
        q = m["edge_flow"][eid]
        area = math.pi * (e["diameter_mm"] / 2000) ** 2
        rho = p.rho_loc("fws") if e["loop"] == "fws" else rho_t
        ratio = dp_ratio(eid) if eid in foul_watch else 1.0
        locked = bool(e.get("zone_id")) and zone_off.get(str(e["zone_id"])[5:], False)
        status = "isolated" if locked else "critical" if ratio > pr["critical"] else "warning" if ratio > pr["warning"] else "watch" if ratio > pr["watch"] else "nominal"
        a: Json = {"status": status, "readings": {
            "flow_kg_s": _r(q), "dp_kpa": _r(m["edge_dp"][eid]), "velocity_m_s": _r(q / (rho * area)),
            "pressure_kpa": _r(p.hyd.edge_p_pa.get(eid, 0.0) / 1e3, 2)}}
        if f.occl.get(eid):
            a["fault"] = {"occlusion": _r(f.occl[eid]), "location_s_m": _r(f.occl_s.get(eid, 0.0), 3)}
        assets[eid] = a

    sr = st["strainer_ratio"]
    for sid in ("strainer_01", "strainer_02"):
        ratio = strainer_ratio(sid)
        a = {"status": "critical" if ratio > sr["critical"] else "warning" if ratio > sr["warning"] else "watch" if ratio > sr["watch"] else "nominal",
             "readings": {"strainer_dp_kpa": _r(m["strainer_dp"][sid]), "flow_kg_s": _r(m["fws_q"] if sid == "strainer_01" else m["tcs_q"])}}
        if f.occl.get(sid):
            a["fault"] = {"occlusion": _r(f.occl[sid])}
        assets[sid] = a

    vb = st["pump_vib_mm_s"]
    for pid in PUMPS:
        tcs = pid.startswith("pump_t")
        duty = c["tcs_duty" if tcs else "fws_duty"] == pid
        run = p.pump_running(pid)
        health = f.pump_health.get(pid, 1.0)
        vib = m["vib"][pid]
        status = "service" if iso.get(pid) else "critical" if c["tripped"].get(pid) else (
            "warning" if (vib > vb["warning"] and duty) else "watch" if (vib > vb["watch"] and duty) else "nominal")
        a = {"status": status, "readings": {
            "speed_pct": _r((c["tcs_speed"] if tcs else c["fws_speed"]) * 100 if run else 0.0),
            "head_kpa": _r((m["head_tcs"] if tcs else m["head_fws"]) if run else 0.0),
            "flow_kg_s": _r((m["tcs_q"] if tcs else m["fws_q"]) if run else 0.0),
            "vibration_mm_s": _r(vib)}}
        if health < 0.995 or c["tripped"].get(pid):
            a["fault"] = {"health": _r(0.0 if c["tripped"].get(pid) else health)}
        assets[pid] = a

    for r in p.racks:
        cmd = c["valve_cmd"][r]
        eff = f.valve_stuck.get(r, cmd)
        zheader = p.zone_hdr[p.rack_zone[r]]["supply"]
        sib = next(x for x in p.racks if x != r and p.rack_zone[x] == p.rack_zone[r])
        a = {"status": "service" if iso.get(f"valve_{r}") else (
                "watch" if deficit[r] > 0.12 and deficit[sib] < 0.07 and dp_ratio(zheader) < 1.3 else "nominal"),
             "readings": {"opening_pct": _r(cmd * 100), "flow_kg_s": _r(m["rack"][r]["flow"])}}
        if abs(eff - cmd) > 1e-9:
            a["fault"] = {"opening": _r(eff), "commanded_opening": _r(cmd)}
        assets[f"valve_{r}"] = a
    for z in p.zones:
        closed = bool(iso.get(f"valve_z{z}"))
        assets[f"valve_z{z}"] = {"status": "isolated" if closed else "nominal", "readings": {
            "opening_pct": 0.0 if closed else 100.0, "flow_kg_s": _r(m["edge_flow"][p.zone_hdr[z]["supply"]])}}

    trunk_racks = zone_sum(None)
    sens = {sid: (ed, sum(zone_sum(z) for z in p.edge_zones[ed]) if ed in p.edge_zones else trunk_racks) for sid, ed in p.flow_sensors.items()}
    for sid, (edge, base) in sens.items():
        rel = abs(m["edge_flow"][edge] - base) / max(base, 0.5)
        suspect = rel > st["sensor_suspect_rel"]
        a = {"status": ("warning" if rel > 0.12 else "watch") if suspect else "nominal",
             "readings": {"flow_kg_s": _r(m["edge_flow"][edge])}}
        if suspect:
            a["suspect"] = ["flow_kg_s"]
            assets[edge]["suspect"] = ["flow_kg_s"]
        assets[sid] = a

    approach = m["tcs_supply"] - m["fws_in"]
    ca = st["cdu_approach_k"]
    assets["cdu_01"] = {"status": "warning" if approach > ca["warning"] else "watch" if approach > ca["watch"] else "nominal",
                        "readings": {"heat_duty_kw": _r(m["hx_kw"]), "tcs_supply_c": _r(m["tcs_supply"]), "tcs_return_c": _r(m["tcs_return"]),
                                     "fws_in_c": _r(m["fws_in"]), "fws_out_c": _r(m["fws_out"]), "approach_k": _r(approach),
                                     "tcs_flow_kg_s": _r(m["tcs_q"]), "fws_flow_kg_s": _r(m["fws_q"])}}
    assets["chiller_01"] = {"status": "nominal", "readings": {"fws_in_c": _r(m["fws_in"]), "fws_out_c": _r(m["fws_out"])}}
    kpis = {"min_margin_k": _r(min_margin), "total_heat_kw": _r(sum(m["rack"][r]["power"] for r in p.racks) + sum(m["aux"][r]["power"] for r in p.aux)),
            "tcs_flow_kg_s": _r(m["tcs_q"]), "fws_flow_kg_s": _r(m["fws_q"]), "tcs_supply_c": _r(m["tcs_supply"]),
            "tcs_return_c": _r(m["tcs_return"]), "open_incidents": 0, "resolved_incidents": 0}
    return assets, kpis
