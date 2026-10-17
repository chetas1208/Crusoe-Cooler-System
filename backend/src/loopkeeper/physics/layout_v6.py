"""facility_layout_v6: ONE parametric generator for the whole facility (five rack rows, four robot roads, cross-aisles,
mechanical/CDU bay, closed FWS + TCS circuits). It emits the `facility:` configuration dict that `topology.build_topology`,
the hydraulic/thermal plant, the robot fleet and the API all consume, plus the version-stamped manifest `layout`
(`facility_layout_v6`) published inside /topology. Nothing about geometry lives anywhere else (no frontend-only layout).

Frame: x east, y up, z south, metres, origin at the plan centre of the rack hall. Row letters a..e == ROW-01..05, racks
`rack_<row><slot>` (a1..e8), roads ROAD-01..04 lie between adjacent rows, XA-W / XA-E are the end cross-aisles.
"""
from __future__ import annotations

import math
from typing import Any

Json = dict[str, Any]
LAYOUT_VERSION = "facility_layout_v6@1"
ROW_LETTERS = "abcde"
HERO_SLOTS = {"a": (1, 2), "b": (1, 2)}               # instrumented GPU racks (CompOpt chip model); all others are lumped aux racks
SERVICE_LATERAL_M = 0.6                              # service/hold poses sit this far off a road centreline (toward the rack served / the wall)
DOCK_LATERAL_M = 0.6
DOCK_CLEAR_M = 2.6                                    # service poses are at least this far from a road end
AUX_ROLES = [("Network fabric", 5), ("Storage", 8), ("CPU / inference", 11)]


def _r(x: float, d: int = 3) -> float:
    return round(float(x), d)


def default_params() -> Json:
    return {
        "rows": 5, "racks_per_row": 8,
        "rack": {"w": 1.2, "d": 1.3, "h": 2.3, "pitch": 2.0},
        "row_pitch_m": 4.0, "row_z0": -8.0, "rows_x0": 6.5,
        "cross_aisle_w": 3.0, "hall_z_half": 11.0, "hall_x_min": -14.5,
        "robot": {"body_w": 0.62, "body_l": 0.95, "arm_envelope_w": 0.9, "height": 2.0, "stowed_arm_h": 2.2},
        "road_target_m": [2.5, 2.9],
        "external_robots_per_corridor": 2,
        "y_sup": 3.2, "y_ret": 2.8, "fillet_m": 0.28,
    }


def validate_params(p: Json) -> None:
    if int(p["rows"]) != 5 or int(p["racks_per_row"]) != 8:
        raise ValueError("facility_layout_v6 is defined for 5 rows x 8 racks")
    k = int(p["external_robots_per_corridor"])
    if k not in (1, 2):
        raise ValueError(f"EXTERNAL_ROBOTS_PER_CORRIDOR={k} is unsupported (valid: 1 or 2)")


def generate(params: Json | None = None, *, limits: Json | None = None) -> Json:
    """Return the `facility` section (see facility-v6.yaml) derived from the layout parameters."""
    P = {**default_params(), **(params or {})}
    P["rack"] = {**default_params()["rack"], **P.get("rack", {})}
    P["robot"] = {**default_params()["robot"], **P.get("robot", {})}
    validate_params(P)
    rk = P["rack"]
    W, D, H, PITCH = rk["w"], rk["d"], rk["h"], rk["pitch"]
    n_rows, n_slots = int(P["rows"]), int(P["racks_per_row"])
    zr = [P["row_z0"] + P["row_pitch_m"] * i for i in range(n_rows)]
    letters = ROW_LETTERS[:n_rows]
    x0 = P["rows_x0"]
    x1 = x0 + n_slots * PITCH
    xa_w = (x0 - P["cross_aisle_w"], x0)
    xa_e = (x1, x1 + P["cross_aisle_w"])
    hx0, hx1 = P["hall_x_min"], xa_e[1] + 0.5
    hz = P["hall_z_half"]
    y_sup, y_ret = P["y_sup"], P["y_ret"]
    off = 0.45                                            # header offset from the row centreline (inside the rack footprint)
    sup_z = {z: _r(zr[i] - off) for i, z in enumerate(letters)}
    ret_z = {z: _r(zr[i] + off) for i, z in enumerate(letters)}
    road_z = [(_r((zr[i] + zr[i + 1]) / 2)) for i in range(n_rows - 1)]
    road_w = _r(P["row_pitch_m"] - D)
    lo, hi = P["road_target_m"]
    if not lo <= road_w <= hi:
        raise ValueError(f"road clear width {road_w} m outside target {P['road_target_m']}")
    cx = [_r(x0 + PITCH * (k + 0.5)) for k in range(n_slots)]                       # rack centres (cell centre of each pitch cell)
    tx_s, tx_r = _r(xa_w[0] + 1.1), _r(xa_w[0] + 1.9)     # supply / return trunk x inside XA-W
    # service road of each row: a,b -> ROAD-01, c -> ROAD-02, d -> ROAD-03, e -> ROAD-04 (the road on the side the rack is serviced from)
    svc_road = {"a": 0, "b": 0, "c": 1, "d": 2, "e": 3}
    # a robot servicing a rack parks on the rack's side of the road (SERVICE_LATERAL_M off the road centreline), so the other half of the
    # 2.7 m road stays free for a passing robot (envelope 0.9 m + clearance)
    svc_z = {z: _r(road_z[svc_road[z]] + SERVICE_LATERAL_M * (1 if zr[i] > road_z[svc_road[z]] else -1)) for i, z in enumerate(letters)}

    # service poses stay clear of the hold bays at both road ends (bay centre x0+0.9 / x1-0.9, envelope 0.95 m + margin)
    svc_lo, svc_hi = _r(x0 + DOCK_CLEAR_M), _r(x1 - DOCK_CLEAR_M)

    def svc_x(x: float) -> float:
        return _r(min(max(x, svc_lo), svc_hi))

    # clamping alone collapses slots 1-3 (and 6-8) onto one pose, so two rovers needing different racks fought over the same spot (a livelock found
    # in the six-fault scenario). De-collide: poses of one row are at least SVC_SPACING_M apart, kept as close to the rack as the bay clearance allows.
    SVC_SPACING_M = 1.1
    base = [min(max(c - 0.2, svc_lo), svc_hi) for c in cx]
    for k in range(1, n_slots):
        base[k] = max(base[k], base[k - 1] + SVC_SPACING_M)
    for k in range(n_slots - 2, -1, -1):
        base[k] = min(base[k], base[k + 1] - SVC_SPACING_M)
    svc_x_slot = [_r(v) for v in base]

    # ------------------------------------------------------------------ racks
    racks, aux_racks = [], []
    drop_no = 0
    for i, z in enumerate(letters):
        for k in range(n_slots):
            slot = k + 1
            rid = f"{z}{slot}"
            d = {"id": rid, "zone": z, "x": cx[k], "row_id": f"ROW-{i + 1:02d}", "slot": slot,
                 "supply_drop_id": f"p_sd_{rid}", "return_drop_id": f"p_rd_{rid}"}
            if slot in HERO_SLOTS.get(z, ()):
                racks.append(d)
            else:
                role, kw = AUX_ROLES[(i * n_slots + k) % len(AUX_ROLES)]
                d.update(kw=kw, role=role)
                aux_racks.append(d)
            drop_no += 1

    # ------------------------------------------------------------------ nodes and pipes
    nodes: list = [
        ["n_fws_chiller_s", "Plant supply boundary", "fws", [-16.5, 2.0, -3.5]],
        ["n_fws_pump", "FWS pump skid", "fws", [-11.0, 0.9, -3.5]],
        ["n_cdu_fs", "CDU primary in", "fws", [-6.3, 0.9, -1.2]],
        ["n_cdu_fr", "CDU primary out", "fws", [-5.7, 0.9, -1.2]],
        ["n_fws_chiller_r", "Plant return boundary", "fws", [-16.5, 2.0, -2.6]],
        ["n_cdu_ts", "CDU secondary out", "tcs", [-5.35, 1.5, -0.45]],
        ["n_cdu_tr", "CDU secondary in", "tcs", [-5.35, 1.5, 0.45]],
    ]
    for z in letters:
        nodes.append([f"n_ts_{z}", f"Supply trunk tee row {z.upper()}", "tcs", [tx_s, y_sup, sup_z[z]]])
        nodes.append([f"n_tr_{z}", f"Return trunk tee row {z.upper()}", "tcs", [tx_r, y_ret, ret_z[z]]])
    sup_end = _r(cx[-1] - 0.2 + 0.35)
    ret_end = _r(cx[-1] + 0.2 + 0.1)
    for z in letters:
        nodes.append([f"n_{z}_s_end", f"Row {z.upper()} supply end", "tcs", [sup_end, y_sup, sup_z[z]]])
        nodes.append([f"n_{z}_r_end", f"Row {z.upper()} return end", "tcs", [ret_end, y_ret, ret_z[z]]])

    E: list[Json] = []

    def edge(eid, name, loop, role, frm, to, dn, pts, passable=True, ports=(), zone=None, reason=None):
        d = {"id": eid, "name": name, "loop": loop, "role": role, "from": frm, "to": to, "dn": dn, "passable": passable, "pts": pts}
        if ports:
            d["ports"] = list(ports)
        if zone:
            d["zone_id"] = f"zone_{zone}"
        if reason:
            d["reason"] = reason
        E.append(d)

    edge("p_01", "FWS supply · plant to pump skid", "fws", "supply", "n_fws_chiller_s", "n_fws_pump", 200,
         [[-16.5, 2.0, -3.5], [-16.5, 3.0, -3.5], [-11.0, 3.0, -3.5], [-11.0, 0.9, -3.5]], ports=["port_a1"])
    edge("p_02", "FWS supply · skid to CDU", "fws", "supply", "n_fws_pump", "n_cdu_fs", 200,
         [[-11.0, 0.9, -3.5], [-11.0, 2.7, -3.5], [-6.3, 2.7, -3.5], [-6.3, 2.7, -1.2], [-6.3, 0.9, -1.2]], ports=["port_s1"])
    edge("p_03", "FWS return · CDU to plant", "fws", "return", "n_cdu_fr", "n_fws_chiller_r", 200,
         [[-5.7, 0.9, -1.2], [-5.7, 3.2, -1.2], [-5.7, 3.2, -2.6], [-16.5, 3.2, -2.6], [-16.5, 2.0, -2.6]], ports=["port_fr1"])
    # supply trunk: CDU -> row c tee, then north (c->b->a) and south (c->d->e)
    edge("p_10", "TCS supply trunk · CDU to row C", "tcs", "supply", "n_cdu_ts", "n_ts_c", 150,
         [[-5.35, 1.5, -0.45], [-3.0, 1.5, -0.45], [-3.0, y_sup, -0.45], [tx_s, y_sup, sup_z["c"]]], ports=["port_a2"])
    edge("p_11", "TCS supply trunk · row C to B", "tcs", "supply", "n_ts_c", "n_ts_b", 150, [[tx_s, y_sup, sup_z["c"]], [tx_s, y_sup, sup_z["b"]]])
    edge("p_14", "TCS supply trunk · row B to A", "tcs", "supply", "n_ts_b", "n_ts_a", 150, [[tx_s, y_sup, sup_z["b"]], [tx_s, y_sup, sup_z["a"]]])
    edge("p_15", "TCS supply trunk · row C to D", "tcs", "supply", "n_ts_c", "n_ts_d", 150, [[tx_s, y_sup, sup_z["c"]], [tx_s, y_sup, sup_z["d"]]])
    edge("p_16", "TCS supply trunk · row D to E", "tcs", "supply", "n_ts_d", "n_ts_e", 150, [[tx_s, y_sup, sup_z["d"]], [tx_s, y_sup, sup_z["e"]]])
    # return trunk toward the CDU
    edge("p_20", "TCS return trunk · row C to CDU", "tcs", "return", "n_tr_c", "n_cdu_tr", 150,
         [[tx_r, y_ret, ret_z["c"]], [-2.0, y_ret, ret_z["c"]], [-2.0, 1.5, 0.45], [-5.35, 1.5, 0.45]], ports=["port_res"])
    edge("p_21", "TCS return trunk · row B to C", "tcs", "return", "n_tr_b", "n_tr_c", 150, [[tx_r, y_ret, ret_z["b"]], [tx_r, y_ret, ret_z["c"]]])
    edge("p_22", "TCS return trunk · row A to B", "tcs", "return", "n_tr_a", "n_tr_b", 150, [[tx_r, y_ret, ret_z["a"]], [tx_r, y_ret, ret_z["b"]]])
    edge("p_23", "TCS return trunk · row D to C", "tcs", "return", "n_tr_d", "n_tr_c", 150, [[tx_r, y_ret, ret_z["d"]], [tx_r, y_ret, ret_z["c"]]])
    edge("p_24", "TCS return trunk · row E to D", "tcs", "return", "n_tr_e", "n_tr_d", 150, [[tx_r, y_ret, ret_z["e"]], [tx_r, y_ret, ret_z["d"]]])
    hdr_ports = {"a": ["port_sa", "port_ra"], "b": ["port_sb", "port_rb"], "c": ["port_sc"], "d": ["port_sd", "port_rd"], "e": ["port_se"]}
    for z in letters:
        edge(f"p_hs_{z}", f"Row {z.upper()} supply header", "tcs", "supply", f"n_ts_{z}", f"n_{z}_s_end", 100,
             [[tx_s, y_sup, sup_z[z]], [sup_end, y_sup, sup_z[z]]], ports=[p for p in hdr_ports[z] if p.startswith("port_s")], zone=z)
        edge(f"p_hr_{z}", f"Row {z.upper()} return header", "tcs", "return", f"n_{z}_r_end", f"n_tr_{z}", 100,
             [[ret_end, y_ret, ret_z[z]], [tx_r, y_ret, ret_z[z]]], ports=[p for p in hdr_ports[z] if p.startswith("port_r")], zone=z)

    # ------------------------------------------------------------------ assets
    pumps = [
        ["pump_t1", "TCS-PMP-1", "TCS circulation pump · duty", "tcs", [-2.6, 0, -1.7], "p_10", [-0.8, 0, -2.4]],
        ["pump_t2", "TCS-PMP-2", "TCS circulation pump · standby", "tcs", [-2.6, 0, -3.1], "p_10", [-0.8, 0, -2.4]],
        ["pump_f1", "FWS-PMP-1", "FWS pump · duty", "fws", [-11.6, 0, -5.0], "p_01", [-9.0, 0, -5.7]],
        ["pump_f2", "FWS-PMP-2", "FWS pump · standby", "fws", [-11.6, 0, -6.4], "p_01", [-9.0, 0, -5.7]],
    ]
    strainers = [
        {"id": "strainer_01", "label": "S-01", "name": "FWS Y-strainer", "loop": "fws", "edge": "p_02", "s": 3.4, "service": [-9.0, 0, -4.4],
         "spec": {"Mesh": "1.5 mm", "Service": "Basket exchange"}},
        {"id": "strainer_02", "label": "S-02", "name": "TCS basket strainer", "loop": "tcs", "edge": "p_10", "s": 1.2, "service": [-4.2, 0, -2.0],
         "spec": {"Mesh": "0.8 mm", "Service": "Basket exchange"}},
    ]
    zone_valves, meters, ports = [], [], []
    for z in letters:
        zone_valves.append({"id": f"valve_z{z}", "label": f"V-Z{z.upper()}", "name": f"Row {z.upper()} isolation valve", "zone": f"zone_{z}",
                            "edge": f"p_hs_{z}", "s": 1.0, "service": [_r(tx_s + 0.4), 0, sup_z[z]]})
        meters.append({"id": f"sn_flow_z{z}", "label": f"FM-{z.upper()}", "name": f"Row {z.upper()} flow meter", "loop": "tcs", "edge": f"p_hs_{z}",
                       "s": 2.2, "service": [svc_x_slot[2], 0, svc_z[z]]})
    meters.append({"id": "sn_flow_trunk", "label": "FM-10", "name": "TCS trunk flow meter", "loop": "tcs", "edge": "p_10", "s": 8.0, "service": [1.0, 0, -2.0]})
    PORT = [
        ("port_a1", "PORT-M1", "FWS plant-gallery launch port", "fws", "p_01", 6.5, "mechanical"),
        ("port_s1", "PORT-S1", "FWS strainer inspection port", "fws", "p_02", 1.5, "strainer"),
        ("port_fr1", "PORT-F1", "FWS return service port", "fws", "p_03", 8.0, "mechanical_return"),
        ("port_a2", "PORT-C1", "TCS trunk launch port at the CDU", "tcs", "p_10", 1.0, "cdu"),
        ("port_res", "PORT-RES", "Crawler reserve staging bay (return trunk)", "tcs", "p_20", 3.0, "reserve"),
    ]
    for z in letters:
        ph_s = f"port_s{z}"
        PORT.append((ph_s, f"PORT-S{z.upper()}", f"Row {z.upper()} supply header port", "tcs", f"p_hs_{z}", 4.0, f"row_{z}_supply"))
        if f"port_r{z}" in sum(hdr_ports.values(), []):
            PORT.append((f"port_r{z}", f"PORT-R{z.upper()}", f"Row {z.upper()} return header port", "tcs", f"p_hr_{z}", 4.0, f"row_{z}_return"))
    for pid, lab, name, loop, ed, s, slot in PORT:
        ports.append({"id": pid, "label": lab, "name": name, "loop": loop, "edge": ed, "s": s, "slot": slot})

    # OUTRIG pads: 2 per road, west sector / east sector
    docks = []
    per = int(P["external_robots_per_corridor"])
    for r in range(4):
        for j in range(2):
            n = 2 * r + j + 1
            xw = _r(x0 + 0.9) if j == 0 else _r(x1 - 0.9)
            docks.append({"id": f"dock_or{n}", "label": f"DOCK-OR{n}", "name": f"ROAD-{r + 1:02d} {'west' if j == 0 else 'east'} hold bay",
                          "position": [xw, 0, _r(road_z[r] + (DOCK_LATERAL_M if j == 0 else -DOCK_LATERAL_M))], "size": [1.4, 0.05, 1.0], "room": f"road_{r + 1}", "road_id": f"ROAD-{r + 1:02d}",
                          "sector": "west" if j == 0 else "east", "enabled": j < per})
    docks = [d for d in docks if d["enabled"]]                  # unsupported pad counts are not instantiated
    for k, zz in enumerate((-8.0, 8.0)):
        docks.append({"id": f"dock_tool{k + 1}", "label": f"TOOL-{k + 1}", "name": f"Tool and charging station {k + 1}", "position": [-1.0, 0, zz],
                      "size": [1.8, 0.05, 1.4], "room": "room_mech", "road_id": None, "sector": None, "enabled": True, "station": True})

    # ------------------------------------------------------------------ site shell
    rooms = [
        {"id": "room_mech", "name": "Mechanical and CDU bay", "kind": "mechanical", "rect": [hx0, -hz, xa_w[0], hz]},
        {"id": "xa_w", "name": "West cross-aisle", "kind": "cross_aisle", "rect": [xa_w[0], -hz, xa_w[1], hz]},
        {"id": "xa_e", "name": "East cross-aisle", "kind": "cross_aisle", "rect": [xa_e[0], -hz, hx1, hz]},
        {"id": "rack_hall", "name": "Rack hall", "kind": "hall", "rect": [x0, -hz, x1, hz], "zone_id": None},
        {"id": "yard", "name": "Outdoor heat-rejection yard", "kind": "yard", "exterior": True, "rect": [hx0 - 10, -8.0, hx0, 2.0]},
    ]
    for r in range(4):
        rooms.append({"id": f"road_{r + 1}", "name": f"ROAD-{r + 1:02d}", "kind": "road",
                      "rect": [x0, _r(road_z[r] - road_w / 2), x1, _r(road_z[r] + road_w / 2)]})
    walls = [
        {"id": "wall_n", "axis": "x", "at": -hz, "from": hx0, "to": hx1, "thickness": 0.4, "exterior": True},
        {"id": "wall_s", "axis": "x", "at": hz, "from": hx0, "to": hx1, "thickness": 0.4, "exterior": True},
        {"id": "wall_w", "axis": "z", "at": hx0, "from": -hz, "to": hz, "thickness": 0.4, "exterior": True},
        {"id": "wall_e", "axis": "z", "at": hx1, "from": -hz, "to": hz, "thickness": 0.4, "exterior": True},
        {"id": "wall_mech", "axis": "z", "at": xa_w[0], "from": -hz, "to": hz, "thickness": 0.3,
         "doors": [{"id": "door_mech_n", "from": -9.6, "to": -7.2, "connects": ["room_mech", "xa_w"]},
                   {"id": "door_mech_s", "from": 7.2, "to": 9.6, "connects": ["room_mech", "xa_w"]}]},
    ]
    obstacles = []
    for i, z in enumerate(letters):
        obstacles.append({"id": f"obs_row_{z}", "rect": [_r(x0), _r(zr[i] - D / 2), _r(x1), _r(zr[i] + D / 2)], "label": f"Rack row {z.upper()}"})
    # mechanical bay: CDU, its pipework, pump skids, strainer riser footprints
    obstacles += [
        {"id": "obs_cdu", "rect": [-6.65, -1.2, -5.35, 1.2], "label": "CDU-01"},
        {"id": "obs_cdu_pipework", "rect": [-5.5, -0.8, -1.8, 0.8], "label": "CDU secondary pipework"},
        {"id": "obs_fws_skid", "rect": [-12.3, -7.0, -10.4, -3.0], "label": "FWS pump skid"},
        {"id": "obs_tcs_pumps", "rect": [-3.0, -3.5, -2.2, -1.3], "label": "TCS pumps"},
    ]
    context_equipment = [
        {"id": "ctx_expansion", "label": "EXP-01", "name": "Expansion vessel", "room": "room_mech", "rect": [-9.8, 4.2, -8.2, 5.8], "height": 2.8},
        {"id": "ctx_dosing", "label": "DOS-01", "name": "Chemical dosing skid", "room": "room_mech", "rect": [-13.2, 5.0, -11.0, 6.4], "height": 1.4},
        {"id": "ctx_switchgear", "label": "SWG-01", "name": "Medium-voltage switchgear line-up", "room": "room_mech", "rect": [-12.5, 9.2, -6.0, 10.4], "height": 2.4},
    ]

    # ------------------------------------------------------------------ manifest (facility_layout_v6)
    rows_manifest = []
    for i, z in enumerate(letters):
        rows_manifest.append({
            "row_id": f"ROW-{i + 1:02d}", "letter": z, "zone_id": f"zone_{z}", "z_m": zr[i], "x_min_m": _r(x0), "x_max_m": _r(x1),
            "rack_ids": [f"rack_{z}{k + 1}" for k in range(n_slots)], "supply_header_edge": f"p_hs_{z}", "return_header_edge": f"p_hr_{z}",
            "supply_z_m": sup_z[z], "return_z_m": ret_z[z], "service_road": f"ROAD-{svc_road[z] + 1:02d}", "service_z_m": svc_z[z],
            "heroes": [f"rack_{z}{s}" for s in HERO_SLOTS.get(z, ())]})
    roads = []
    for r in range(4):
        svc_rows = [z for z in letters if svc_road[z] == r]
        t = []
        for z in svc_rows:
            t += [f"valve_{z}{s}" for s in (1, 4, 8)] + [f"valve_z{z}", f"sn_flow_z{z}"]
        roads.append({
            "road_id": f"ROAD-{r + 1:02d}", "index": r + 1, "z_m": road_z[r], "x_min_m": _r(x0), "x_max_m": _r(x1), "clear_width_m": road_w,
            "between_rows": [f"ROW-{r + 1:02d}", f"ROW-{r + 2:02d}"], "sectors": {"west": [_r(x0), _r((x0 + x1) / 2)], "east": [_r((x0 + x1) / 2), _r(x1)]},
            "dock_ids": [d["id"] for d in docks if d.get("road_id") == f"ROAD-{r + 1:02d}"],
            "service_target_ids": t, "approach_pose_xz": [[svc_x_slot[0], svc_z[svc_rows[0]] if svc_rows else road_z[r]]]})
    cross = [
        {"id": "XA-W", "x_min_m": _r(xa_w[0]), "x_max_m": _r(xa_w[1]), "z_min_m": -hz, "z_max_m": hz, "connects_roads": [f"ROAD-{r + 1:02d}" for r in range(4)]},
        {"id": "XA-E", "x_min_m": _r(xa_e[0]), "x_max_m": _r(xa_e[1]), "z_min_m": -hz, "z_max_m": hz, "connects_roads": [f"ROAD-{r + 1:02d}" for r in range(4)]},
    ]
    ior = [("IR-01", "port_sa"), ("IR-02", "port_sb"), ("IR-03", "port_sc"), ("IR-04", "port_sd"), ("IR-05", "port_se"),
           ("IR-06", "port_rb"), ("IR-07", "port_rd"), ("IR-08", "port_a2"), ("IR-09", "port_a1"), ("IR-10", "port_res")]
    outrig = []
    for d in docks:
        if d.get("road_id"):
            n = int(d["id"].replace("dock_or", ""))
            outrig.append({"id": f"OR-{n:02d}", "road_id": d["road_id"], "sector": d["sector"], "dock_id": d["id"],
                           "start_pose": {"position_xyz_m": [d["position"][0], 0.0, d["position"][2]],
                                          "yaw_rad": _r(math.pi / 2 if d["sector"] == "west" else -math.pi / 2)}})
    layout = {
        "layout_version": LAYOUT_VERSION, "frame": "facility_world", "units": "m", "axes": "x east, y up, z south",
        "generator": {k: P[k] for k in ("rows", "racks_per_row", "rack", "row_pitch_m", "row_z0", "rows_x0", "cross_aisle_w", "external_robots_per_corridor")},
        "hall": {"x_min_m": hx0, "x_max_m": hx1, "z_min_m": -hz, "z_max_m": hz, "height_m": 6.0,
                 "derived": "x from the mechanical bay (west) through XA-W, five 10 m rows and XA-E; z = row spacing 5 x 4 m plus 2.35 m service strips"},
        "rows": rows_manifest, "roads": roads, "cross_aisles": cross,
        "mechanical_bay": {"room_id": "room_mech", "cdu": "cdu_01", "plant_boundary": ["n_fws_chiller_s", "n_fws_chiller_r"],
                           "doors": ["door_mech_n", "door_mech_s"]},
        "robots": {"outrig": outrig, "inpipe": [{"id": i, "port_id": p} for i, p in ior],
                   "sentinel": [f"SEN-{k:02d}" for k in range(1, 6)], "external_robots_per_corridor": per},
        "robot_envelope": P["robot"], "road_clear_width_m": road_w, "rack_count": n_rows * n_slots,
        "circuits": {"fws": ["p_01", "p_02", "p_03"], "tcs_supply_trunk": ["p_10", "p_11", "p_14", "p_15", "p_16"],
                     "tcs_return_trunk": ["p_20", "p_21", "p_22", "p_23", "p_24"],
                     "tcs_row_supply": [f"p_hs_{z}" for z in letters], "tcs_row_return": [f"p_hr_{z}" for z in letters]},
        "hydraulic_notes": ["quasi-steady pandapipes; rack branches are lumped at each row header end (per-tap flows are mass-conservation exact)",
                            "4 hero racks use the CompOpt GPU chip model, the other 36 racks use a lumped per-rack thermal model driven by their own solved flow"],
    }

    zones = [{"id": f"zone_{z}", "name": f"Row {z.upper()} (ROW-{i + 1:02d})", "anchor": [_r((x0 + x1) / 2), 0, zr[i]]} for i, z in enumerate(letters)]
    return {
        "id": "lab_01", "name": "Lab Hall 01", "config_version": LAYOUT_VERSION, "hash_geometry": True,
        "hall": {"min_x": hx0, "max_x": hx1, "min_z": -hz, "max_z": hz, "height": 6.0},
        "site": {"bounds_min": [hx0 - 10, 0.0, -hz - 0.5], "bounds_max": [hx1 + 0.5, 6.0, hz + 0.5], "support_spacing_m": 3.0,
                 "rooms": rooms, "walls": walls, "door_h_m": 2.4,
                 "columns": {"x": [-12.0, -6.0, 0.0, 12.0], "z": [-hz, hz], "size_m": [0.4, 6.0, 0.4]}},
        "rack": {"w": W, "h": H, "d": D},
        "row_z": {z: zr[i] for i, z in enumerate(letters)},
        "aisle_service_z": svc_z, "service_x_range": [svc_lo, svc_hi], "service_x_by_slot": svc_x_slot,
        "y_sup": y_sup, "y_ret": y_ret, "fillet_m": P["fillet_m"], "sup_z": sup_z, "ret_z": ret_z,
        "not_passable_reason": "Bore ≤ 40 mm — too small for any crawler. Inspect from outside only.",
        "limits": dict(limits or {"chip_limit_c": 90, "margin_warn_k": 11, "margin_crit_k": 5, "nominal_rack_kw": 120}),
        "racks": racks, "aux_racks": aux_racks, "zones": zones,
        "zone_headers": {z: {"supply": f"p_hs_{z}", "return": f"p_hr_{z}"} for z in letters},
        # rows whose rack flow passes through a trunk segment (for flow estimates / dP ratios on trunk edges)
        "edge_zones": {"p_10": list(letters), "p_20": list(letters), "p_11": ["b", "a"], "p_14": ["a"], "p_15": ["d", "e"], "p_16": ["e"],
                       "p_21": ["a", "b"], "p_22": ["a"], "p_23": ["d", "e"], "p_24": ["e"]},
        "nodes": nodes, "edges": E,
        "cdu": {"position": [-6.0, 0, 0.0], "size": [1.3, 2.2, 2.4], "service": [-6.0, 0, 2.6],
                "spec": {"Capacity": "1000 kW", "Heat exchanger": "Brazed plate", "Primary": "FWS (facility water)", "Secondary": "TCS (PG25)"}},
        "chiller": {"position": [-19.0, 0, -3.0], "size": [5.2, 2.2, 3.0], "spec": {"Supply setpoint": "27 °C", "Note": "Outdoor heat-rejection yard (plant boundary)"}},
        "pumps": pumps, "strainers": strainers, "zone_valves": zone_valves, "meters": meters, "ports": ports, "docks": docks,
        "context_equipment": context_equipment,
        "nav": {"cell_m": 0.25, "obstacles": obstacles},
        "layout": layout,
    }
