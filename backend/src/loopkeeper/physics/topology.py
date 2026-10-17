"""Static facility topology (contracts.Topology) built from the YAML config.

Port of packages/core/src/engine/facility.ts: same ids, geometry and ordering, so the
frontend renders exactly this layout. The topology hash is computed the same way.
"""
from __future__ import annotations

import json
from typing import Any

import math

from .geometry import build_path, fnv1a_hex, js_round, project_to_path, sample_path

Json = dict[str, Any]


def build_topology(cfg: Json) -> Json:
    f = cfg["facility"]
    hall, rk = f["hall"], f["rack"]
    row_z, bay_x = f["row_z"], f.get("bay_x", [])
    y_sup, y_ret, fillet = f["y_sup"], f["y_ret"], f["fillet_m"]
    sup_z, ret_z = f["sup_z"], f["ret_z"]
    rack_h = rk["h"]
    site = f.get("site")
    aisle_z = f.get("aisle_service_z")

    sx = f.get("service_x_range")
    sxs = f.get("service_x_by_slot")

    def svc_x(x: float) -> float:
        """Service poses keep clear of the road-end hold bays (docks): a parked rover must never sit on a pose another rover has to reach.
        Arm reach (3.0 m) still covers the valve from the clamped pose."""
        return round(min(max(x, sx[0]), sx[1]), 3) if sx else x

    def svc_x_of(r: Json) -> float:
        if sxs and r.get("slot"):
            return sxs[int(r["slot"]) - 1]
        return svc_x(r["x"] - 0.2)

    def svc_z(zone: str) -> float:
        return aisle_z[zone] if aisle_z else (-1.55 if zone == "a" else 1.55)

    nodes: list[Json] = [
        {"id": i, "label": lab, "loop": loop, "position_xyz_m": list(p)} for i, lab, loop, p in f["nodes"]
    ]
    hero = f["racks"]
    aux = f.get("aux_racks", [])
    # row order mirrors RACK_SLOTS (facility.ts): zone a n=1..8 then zone b n=1..8
    racks = sorted([*hero, *aux], key=lambda r: (r["zone"], int(r["id"][1:])))
    for r in racks:
        rid, z, x = r["id"].upper(), r["zone"], r["x"]
        nodes += [
            {"id": f"n_{r['id']}_s", "label": f"{rid} supply tap", "loop": "tcs", "position_xyz_m": [x - 0.2, y_sup, sup_z[z]]},
            {"id": f"n_{r['id']}_r", "label": f"{rid} return tap", "loop": "tcs", "position_xyz_m": [x + 0.2, y_ret, ret_z[z]]},
            {"id": f"n_{r['id']}_in", "label": f"{rid} coolant in", "loop": "tcs", "position_xyz_m": [x - 0.2, rack_h, sup_z[z]]},
            {"id": f"n_{r['id']}_out", "label": f"{rid} coolant out", "loop": "tcs", "position_xyz_m": [x + 0.2, rack_h, ret_z[z]]},
        ]

    defs: list[Json] = [dict(e) for e in f["edges"]]
    for e in defs:
        e["fillet"] = fillet
    for r in racks:
        z, x = r["zone"], r["x"]
        defs.append({
            "id": r.get("supply_drop_id") or f"p_{r['supply_drop']}", "name": f"Rack {r['id'].upper()} supply drop", "loop": "tcs", "role": "supply",
            "zone_id": f"zone_{z}", "from": f"n_{r['id']}_s", "to": f"n_{r['id']}_in", "dn": 25 if "kw" in r else 40, "passable": False,
            "reason": f["not_passable_reason"], "fillet": 0.1,
            "pts": [[x - 0.2, y_sup, sup_z[z]], [x - 0.2, rack_h, sup_z[z]]],
        })
        defs.append({
            "id": r.get("return_drop_id") or f"p_{r['return_drop']}", "name": f"Rack {r['id'].upper()} return drop", "loop": "tcs", "role": "return",
            "zone_id": f"zone_{z}", "from": f"n_{r['id']}_out", "to": f"n_{r['id']}_r", "dn": 25 if "kw" in r else 40, "passable": False,
            "reason": f["not_passable_reason"], "fillet": 0.1,
            "pts": [[x + 0.2, rack_h, ret_z[z]], [x + 0.2, y_ret, ret_z[z]]],
        })

    edges: list[Json] = []
    for d in defs:
        fr = d["fillet"]
        pts = [tuple(p) for p in d["pts"]]
        e = {
            "id": d["id"], "label": d["id"].replace("p_", "P-"), "name": d["name"], "loop": d["loop"], "role": d["role"],
            "from": d["from"], "to": d["to"],
            "centerline_xyz_m": [list(p) for p in d["pts"]],
            "fillet_radius_m": fr,
            "length_m": js_round(build_path(pts, fr).length, 2),
            "diameter_mm": d["dn"],
            "clearance_mm": round(d["dn"] * 0.5 - 20) if d["passable"] else 0,
            "robot_passable": bool(d["passable"]),
            "access_port_ids": list(d.get("ports", [])),
        }
        if d.get("zone_id"):
            e["zone_id"] = d["zone_id"]
        if not d["passable"]:
            e["not_passable_reason"] = d["reason"]
        edges.append(e)
    edge_by_id = {e["id"]: e for e in edges}

    def on_edge(edge_id: str, s: float) -> list[float]:
        e = edge_by_id[edge_id]
        path = build_path([tuple(p) for p in e["centerline_xyz_m"]], e["fillet_radius_m"])
        return list(sample_path(path, s))

    zones = [
        {"id": z["id"], "name": z["name"], "rack_ids": [f"rack_{r['id']}" for r in racks if f"zone_{r['zone']}" == z["id"]],
         "anchor_xyz_m": list(z["anchor"])}
        for z in f["zones"]
    ]

    assets: list[Json] = []
    for r in racks:
        is_aux = "kw" in r
        assets.append({
            "id": f"rack_{r['id']}", "type": "rack", "label": f"R-{r['id'].upper()}",
            "name": f"Rack {r['id'].upper()} · {r['role']}" if is_aux else f"Rack {r['id'].upper()} · liquid-cooled GPU",
            "loop": "tcs", "zone_id": f"zone_{r['zone']}",
            "position_xyz_m": [r["x"], 0, row_z[r["zone"]]], "size_m": [rk["w"], rk["h"], rk["d"]],
            "yaw_rad": 0 if r["zone"] == "a" else 3.141592653589793, "accessible_by": [],
            **({"row_id": r["row_id"], "slot": r["slot"]} if r.get("row_id") else {}),
            "supply_manifold_node_id": f"n_{r['id']}_in", "return_manifold_node_id": f"n_{r['id']}_out",
            "supply_drop_edge_id": r.get("supply_drop_id") or f"p_{r['supply_drop']}",
            "return_drop_edge_id": r.get("return_drop_id") or f"p_{r['return_drop']}",
            "thermal_asset_id": f"rack_{r['id']}",
            "spec": {"Role": r["role"] if is_aux else "GPU training", "Design load": f"{r['kw'] if is_aux else 120} kW",
                     "Coolant": "PG25", "Throttle limit": "90 °C",
                     "Diagnosis": "Telemetry only" if is_aux else "Instrumented (fault target)"},
        })
    c = f["cdu"]
    assets.append({"id": "cdu_01", "type": "cdu", "label": "CDU-01", "name": "Coolant distribution unit",
                   "position_xyz_m": c["position"], "size_m": c["size"], "accessible_by": ["outrig"], "spec": c["spec"],
                   "service_xyz_m": c["service"]})
    ch = f["chiller"]
    assets.append({"id": "chiller_01", "type": "chiller", "label": "CHL-01", "name": "Dry-cooler bank (external)",
                   "position_xyz_m": ch["position"], "size_m": ch["size"], "accessible_by": [], "spec": ch["spec"]})
    for pid, label, name, loop, pos, edge_id, svc in f["pumps"]:
        spec = ({"Type": "End-suction centrifugal", "Rated flow": "8 kg/s", "Rated head": "290 kPa shut-off"} if loop == "tcs"
                else {"Type": "End-suction centrifugal", "Rated flow": "13 kg/s", "Rated head": "270 kPa"})
        assets.append({"id": pid, "type": "pump", "label": label, "name": name, "loop": loop, "position_xyz_m": pos,
                       "size_m": [0.7, 0.9, 0.5], "edge_id": edge_id, "accessible_by": ["outrig"], "service_xyz_m": svc,
                       "spec": spec})
    for s in f["strainers"]:
        assets.append({"id": s["id"], "type": "strainer", "label": s["label"], "name": s["name"], "loop": s["loop"],
                       "position_xyz_m": s.get("position") or on_edge(s["edge"], s["s"]), "edge_id": s["edge"], "s_m": s["s"], "accessible_by": ["outrig"],
                       "service_xyz_m": s["service"], "spec": s["spec"]})
    for r in racks:
        z = r["zone"]
        assets.append({
            "id": f"valve_{r['id']}", "type": "valve", "label": f"V-{r['id'].upper()}",
            "name": f"Rack {r['id'].upper()} balancing valve", "loop": "tcs", "zone_id": f"zone_{z}",
            "position_xyz_m": [r["x"] - 0.2, 2.63, sup_z[z]], "edge_id": r.get("supply_drop_id") or f"p_{r['supply_drop']}", "accessible_by": ["outrig"],
            "service_xyz_m": [svc_x_of(r), 0, svc_z(z)],
            "spec": {"Type": "Motorised ball", "Kv": "Rack-balanced", "Actuator": "Rotary 24 V"},
        })
    # per-rack branch flow meters (the redundant meters the monitor trusts over a drifting header meter)
    for r in racks:
        z = r["zone"]
        assets.append({
            "id": f"sn_rack_{r['id']}", "type": "sensor", "label": f"FM-{r['id'].upper()}",
            "name": f"Rack {r['id'].upper()} branch flow meter", "loop": "tcs", "zone_id": f"zone_{z}",
            "edge_id": r.get("supply_drop_id") or f"p_{r['supply_drop']}", "s_m": 0.42, "position_xyz_m": [r["x"] - 0.2, 2.9, sup_z[z]],
            "accessible_by": ["outrig"], "service_xyz_m": [svc_x_of(r), 0, svc_z(z)],
            "spec": {"Principle": "Ultrasonic transit-time", "Accuracy": "±1 % of reading"},
        })
    for v in f["zone_valves"]:
        assets.append({"id": v["id"], "type": "valve", "label": v["label"], "name": v["name"], "loop": "tcs",
                       "zone_id": v["zone"], "position_xyz_m": on_edge(v["edge"], v["s"]), "edge_id": v["edge"],
                       "s_m": v["s"], "accessible_by": ["outrig"], "service_xyz_m": v["service"],
                       "spec": {"Type": "Butterfly · lever"}})
    for m in f["meters"]:
        assets.append({"id": m["id"], "type": "sensor", "label": m["label"], "name": m["name"], "loop": m["loop"],
                       "edge_id": m["edge"], "s_m": m["s"], "position_xyz_m": on_edge(m["edge"], m["s"]),
                       "accessible_by": ["outrig", "inpipe"], "service_xyz_m": m["service"],
                       "spec": {"Principle": "Ultrasonic transit-time", "Accuracy": "±0.5 % of reading"}})
    for p in f["ports"]:
        assets.append({"id": p["id"], "type": "port", "label": p["label"], "name": p["name"], "loop": p["loop"],
                       "edge_id": p["edge"], "s_m": p["s"], "position_xyz_m": on_edge(p["edge"], p["s"]),
                       "accessible_by": ["inpipe"]})
    docks = f.get("docks") or [f["dock"]]
    for d in docks:
        assets.append({"id": d["id"], "type": "dock", "label": d["label"], "name": d["name"], "position_xyz_m": d["position"],
                       "size_m": d["size"], "accessible_by": []})

    first_x, last_x = (bay_x[0], bay_x[-1]) if bay_x else (0.0, 0.0)
    rows = f.get("rows")

    def row_rect(z: float) -> list[float]:
        return [first_x - rk["w"] / 2, z - rk["d"] / 2, last_x + rk["w"] / 2, z + rk["d"] / 2]

    if rows:
        obstacles = [{"id": f"obs_{r['id']}", "rect": [r["x0"] - rk["w"] / 2, r["z"] - rk["d"] / 2,
                                                       r["x0"] + r["pitch"] * (r["count"] - 1) + rk["w"] / 2, r["z"] + rk["d"] / 2],
                      "label": f"Cabinet row {r['id'][4:].upper()}"} for r in rows]
    elif bay_x:
        obstacles = [{"id": "obs_row_a", "rect": row_rect(row_z["a"]), "label": "Rack row A"},
                     {"id": "obs_row_b", "rect": row_rect(row_z["b"]), "label": "Rack row B"}]
    else:
        obstacles = []                                         # v6: row obstacles come from the generator's nav.obstacles
    obstacles += [dict(o) for o in f["nav"]["obstacles"]]
    # TS order: rows, cdu, tcs pumps, fws pumps
    expansion = []
    if not rows:
        for x in bay_x:
            for z in ("a", "b"):
                if any(r["zone"] == z and abs(r["x"] - x) < 0.01 for r in racks):
                    continue
                expansion.append({"id": f"bay_{z}_{x:.1f}", "position_xyz_m": [x, 0, row_z[z]],
                                  "size_m": [rk["w"], rk["h"], rk["d"]], "yaw_rad": 0 if z == "a" else 3.141592653589793})

    topo: Json = {
        "facility": {
            "id": f["id"], "name": f["name"], "label": "Simulated facility", "config_version": f["config_version"],
            "topology_hash": "",
            "bounds_min": [hall["min_x"] - 3, 0, hall["min_z"] - 5],
            "bounds_max": [hall["max_x"], hall["height"], hall["max_z"]],
            "interior_min": [hall["min_x"], 0, hall["min_z"]],
            "interior_max": [hall["max_x"], hall["height"], hall["max_z"]],
            "wall_height_m": hall["height"],
        },
        "expansion_bays": expansion,
        "zones": zones,
        "nodes": nodes,
        "edges": edges,
        "assets": assets,
        "nav": {"cell_m": f["nav"]["cell_m"], "obstacles": obstacles,
                "dock_ids": list(f["nav"].get("dock_ids") or [d["id"] for d in docks] + [p["id"] for p in f["ports"]])},
        "limits": dict(f["limits"]),
    }
    _v2_extras(topo, f, defs, racks, edge_by_id)
    base = {"edges": [e["id"] for e in edges], "assets": [a["id"] for a in assets]}
    if f.get("hash_geometry"):
        base["geometry"] = {
            "e": [[e["id"], [[round(c, 3) for c in p] for p in e["centerline_xyz_m"]], e["diameter_mm"]] for e in edges],
            "a": [[a["id"], [round(c, 3) for c in a["position_xyz_m"]]] for a in assets],
            "sv": [[a["id"], [round(c, 3) for c in a["service_xyz_m"]]] for a in assets if a.get("service_xyz_m")],      # robot service poses
            "o": [[o["id"], [round(c, 3) for c in o["rect"]]] for o in obstacles],                                        # nav collision volumes
            "c": [c["id"] for c in topo.get("context_cabinets", [])],
            "s": [(w["id"], w["rect_segments"]) for w in topo.get("site", {}).get("walls", [])],
        }
    topo["facility"]["topology_hash"] = fnv1a_hex(json.dumps(base, separators=(",", ":")))
    if f.get("layout"):
        lay = json.loads(json.dumps(f["layout"]))
        lay["topology_hash"] = topo["facility"]["topology_hash"]
        topo["facility_layout_v6"] = lay
        topo["facility"]["layout_version"] = lay["layout_version"]
        topo["facility"]["topology_version"] = f"{lay['layout_version']}#{topo['facility']['topology_hash']}"
    return topo


# ═════════════════════════ v2 (V4 campaign) additions ═════════════════════════
# Everything below only ADDS fields (the Pydantic wire models allow extras); the legacy keys are unchanged.

WALL_T_MM = {25: 3.4, 40: 3.7, 100: 6.0, 150: 7.1, 200: 8.2}   # steel schedule-40 style wall thickness by DN
ZONE_SUPPLY_HEADER = {"a": "p_12", "b": "p_17"}
ZONE_RETURN_HEADER = {"a": "p_22", "b": "p_27"}


def _room_of(rooms: list[Json], x: float, z: float) -> str | None:
    """Innermost (smallest-area) room containing the plan point; ties keep the first listed."""
    best, best_a = None, float("inf")
    for r in rooms:
        x0, z0, x1, z1 = r["rect"]
        if x0 - 1e-6 <= x <= x1 + 1e-6 and z0 - 1e-6 <= z <= z1 + 1e-6:
            area = (x1 - x0) * (z1 - z0)
            if area < best_a - 1e-9:
                best, best_a = r["id"], area
    return best


def _wall_segments(w: Json) -> list[list[float]]:
    doors = sorted(w.get("doors", []), key=lambda d: d["from"])
    cuts, cur = [], w["from"]
    for d in doors:
        cuts.append((cur, d["from"]))
        cur = d["to"]
    cuts.append((cur, w["to"]))
    t = w["thickness"] / 2
    out = []
    for a, b in cuts:
        if b - a < 1e-6:
            continue
        out.append([a, w["at"] - t, b, w["at"] + t] if w["axis"] == "x" else [w["at"] - t, a, w["at"] + t, b])
    return out


def _v2_extras(topo: Json, f: Json, defs: list[Json], racks: list[Json], edge_by_id: dict[str, Json]) -> None:
    edges, assets, nodes = topo["edges"], topo["assets"], topo["nodes"]
    site = f.get("site")
    rooms = site["rooms"] if site else []
    rk = f["rack"]

    # ---- site shell (rooms, walls, doors, columns, wall penetrations)
    walls_out: list[Json] = []
    if site:
        door_h = site.get("door_h_m", 2.4)
        height = f["hall"]["height"]
        doors_out: list[Json] = []
        for w in site["walls"]:
            segs = _wall_segments(w)
            walls_out.append({"id": w["id"], "axis": w["axis"], "at": w["at"], "from": w["from"], "to": w["to"],
                              "thickness_m": w["thickness"], "height_m": height, "exterior": bool(w.get("exterior")),
                              "rect_segments": segs, "door_ids": [d["id"] for d in w.get("doors", [])]})
            for d in w.get("doors", []):
                mid = 0.5 * (d["from"] + d["to"])
                doors_out.append({"id": d["id"], "wall_id": w["id"], "axis": w["axis"], "at": w["at"], "from": d["from"],
                                  "to": d["to"], "width_m": round(d["to"] - d["from"], 3), "height_m": door_h,
                                  "position_xyz_m": [mid, 0.0, w["at"]] if w["axis"] == "x" else [w["at"], 0.0, mid],
                                  "connects": d.get("connects", [])})
        cols = site.get("columns")
        columns = []
        if cols:
            for x in cols["x"]:
                for z in cols["z"]:
                    columns.append({"id": f"col_{x:+.0f}_{z:+.0f}".replace("+", "p").replace("-", "m"),
                                    "position_xyz_m": [x, 0.0, z], "size_m": list(cols["size_m"])})
        topo["site"] = {"frame": "facility_world", "units": "m", "axes": "x east, z south, y up (right-handed: x cross y = -z)",
                        "floor_id": "L0", "rooms": [dict(r, floor_y_m=0.0, height_m=height) for r in rooms],
                        "walls": walls_out, "doors": doors_out, "columns": columns, "penetrations": [],
                        "bounds_min": site["bounds_min"], "bounds_max": site["bounds_max"]}
        # wall segments are nav obstacles (exterior walls are already handled by the interior bounds)
        for w in walls_out:
            if w["exterior"]:
                continue
            for i, r in enumerate(w["rect_segments"]):
                topo["nav"]["obstacles"].append({"id": f"obs_{w['id']}_{i}", "rect": r, "label": f"Wall {w['id']}"})
        topo["facility"]["bounds_min"] = list(site["bounds_min"])
        topo["facility"]["bounds_max"] = list(site["bounds_max"])
        for ce in f.get("context_equipment", []):
            topo["nav"]["obstacles"].append({"id": f"obs_{ce['id']}", "rect": ce["rect"], "label": ce["label"]})

    for n in nodes:
        if n["id"].endswith(("_s_end", "_r_end")):
            n["terminal"] = "capped_header_end"       # blind-flanged header end; rack branches tap upstream of it
    # ---- paths, taps, per-edge schema additions
    paths = {e["id"]: build_path([tuple(p) for p in e["centerline_xyz_m"]], e["fillet_radius_m"]) for e in edges}
    taps: dict[str, list[Json]] = {}
    for r in racks:
        z = r["zone"]
        zh = f.get("zone_headers") or {k: {"supply": v, "return": ZONE_RETURN_HEADER[k]} for k, v in ZONE_SUPPLY_HEADER.items()}
        sd = r.get("supply_drop_id") or f"p_{r['supply_drop']}"
        rd = r.get("return_drop_id") or f"p_{r['return_drop']}"
        for hid, nid, did in ((zh[z]["supply"], f"n_{r['id']}_s", sd),
                              (zh[z]["return"], f"n_{r['id']}_r", rd)):
            if hid not in paths:
                continue
            node = next(n for n in nodes if n["id"] == nid)
            s, dist = project_to_path(paths[hid], tuple(node["position_xyz_m"]))
            taps.setdefault(hid, []).append({"node_id": nid, "s_m": round(s, 3), "offset_m": round(dist, 4),
                                             "drop_edge_id": did, "rack_id": f"rack_{r['id']}"})
    node_pos = {n["id"]: n["position_xyz_m"] for n in nodes}
    by_edge_assets: dict[str, list[Json]] = {}
    for a in assets:
        if a.get("edge_id"):
            by_edge_assets.setdefault(a["edge_id"], []).append(a)
    incident: dict[str, set[str]] = {}
    for e in edges:
        for n in (e["from"], e["to"]):
            incident.setdefault(n, set()).add(e["id"])
    for hid, ts in taps.items():
        for t in ts:
            incident.setdefault(t["node_id"], set()).update({hid, t["drop_edge_id"]})
    pump_edge = {a["id"]: a for a in assets if a["type"] == "pump"}
    for e in edges:
        eid, dn = e["id"], e["diameter_mm"]
        zone = e.get("zone_id")
        lay_c = {x: k for k, v in (f.get("layout", {}).get("circuits") or {}).items() for x in v}
        if eid in lay_c and e["loop"] == "tcs" and not zone:
            circuit = "tcs_trunk"
        elif e["loop"] == "fws":
            circuit = "fws_primary"
        elif zone:
            circuit = f"tcs_{zone}"
        elif eid in ("p_10", "p_20"):
            circuit = "tcs_trunk"
        else:
            circuit = "tcs_zone_" + (next((r["zone"] for r in racks if eid in (r.get("supply_drop_id") or f"p_{r['supply_drop']}",
                                                                              r.get("return_drop_id") or f"p_{r['return_drop']}")), "a"))
        on = by_edge_assets.get(eid, [])
        e["circuit_id"] = circuit
        if e["loop"] == "tcs" and e["robot_passable"]:
            ez = (f.get("edge_zones") or {}).get(eid)
            if ez:
                e["served_zones"] = list(ez)             # rows whose rack flow passes through this trunk segment
            elif zone:
                e["served_zones"] = [zone[5:]]
        e["bore_m"] = round(dn / 1000.0, 4)
        e["wall_thickness_mm"] = WALL_T_MM.get(int(dn), round(dn * 0.06, 1))
        e["floor_id"] = "L0"
        e["room_ids"] = _ordered_rooms(rooms, paths[eid]) if rooms else []
        if e["robot_passable"]:
            dev = next((a["id"] for a in on if a["type"] in ("strainer", "valve") and a.get("edge_id") == eid), None)
            e["hydraulic_solver_mapping"] = {"network": e["loop"], "pipes": [f"{eid}.pre", f"{eid}.dep", f"{eid}.post"],
                                             "series_device": dev, "model": "pandapipes: 3-section run with fouling deposit"}
        else:
            e["hydraulic_solver_mapping"] = {"network": e["loop"], "pipes": [eid], "series_device": None,
                                             "model": "pandapipes: rack branch (valve + drop + cold-plate + drop)"}
        e["service_access"] = {
            "ports": list(e["access_port_ids"]),
            "valves": [a["id"] for a in on if a["type"] == "valve"],
            "strainers": [a["id"] for a in on if a["type"] == "strainer"],
            "sensors": [a["id"] for a in on if a["type"] == "sensor"],
            "pumps": [a["id"] for a in pump_edge.values() if a.get("edge_id") == eid],
            "outrig_service_xyz_m": [a["service_xyz_m"] for a in on if a.get("service_xyz_m")],
        }
        # authority classes are advisory metadata here; the enforcing table is orchestration/authority policy (v4 milestone 4)
        if e["robot_passable"]:
            e["repair_allowed_classes"] = {"inpipe": ["L0", "L1"] if e["access_port_ids"] else ["L0"],
                                           "outrig": ["L0", "L1", "L2"] if (on or e["access_port_ids"]) else ["L0"]}
        else:
            e["repair_allowed_classes"] = {"inpipe": [], "outrig": ["L0"]}
        if eid in taps:
            e["taps"] = sorted(taps[eid], key=lambda t: t["s_m"])
        nb: set[str] = set()
        for n in (e["from"], e["to"]):
            nb |= incident.get(n, set())
        for t in e.get("taps", []):
            nb.add(t["drop_edge_id"])
        for h, ts in taps.items():
            if any(t["drop_edge_id"] == eid for t in ts):
                nb.add(h)
        nb.discard(eid)
        e["schematic_neighbors"] = sorted(nb)

    # ---- fittings (elbows, tees), supports, penetrations
    fittings: list[Json] = []
    for d in defs:
        pts = d["pts"]
        for i in range(1, len(pts) - 1):
            a, b, c = pts[i - 1], pts[i], pts[i + 1]
            u = [b[j] - a[j] for j in range(3)]
            v = [c[j] - b[j] for j in range(3)]
            lu, lv = math.hypot(*u), math.hypot(*v)
            if lu < 1e-9 or lv < 1e-9:
                continue
            cosang = max(-1.0, min(1.0, sum(u[j] * v[j] for j in range(3)) / (lu * lv)))
            ang = math.degrees(math.acos(cosang))
            if ang > 2.0:
                fittings.append({"id": f"{d['id']}.elbow{i}", "type": "elbow", "edge_id": d["id"], "loop": d["loop"],
                                 "position_xyz_m": list(b), "turn_deg": round(ang, 1), "radius_m": d["fillet"],
                                 "bore_m": round(d["dn"] / 1000.0, 4)})
    for nid, es in sorted(incident.items()):
        if len(es) >= 3:
            n = next((x for x in nodes if x["id"] == nid), None)
            if n is None:
                continue
            tap = nid.startswith("n_") and (nid.endswith("_s") or nid.endswith("_r")) and nid.count("_") == 2
            fittings.append({"id": f"tee.{nid}", "type": "tee", "node_id": nid, "loop": n["loop"],
                             "position_xyz_m": list(n["position_xyz_m"]), "edge_ids": sorted(es),
                             "branch": "rack_tap" if tap else "junction"})
    topo["fittings"] = fittings
    spacing = (site or {}).get("support_spacing_m", 0.0)
    supports: list[Json] = []
    if spacing:
        for e in edges:
            if not e["robot_passable"]:
                continue
            L = paths[e["id"]].length
            n = max(int(L // spacing), 1)
            for k in range(n):
                s = (k + 0.5) * L / n
                supports.append({"id": f"sup.{e['id']}.{k}", "edge_id": e["id"], "s_m": round(s, 2),
                                 "position_xyz_m": [round(c, 3) for c in sample_path(paths[e["id"]], s)],
                                 "type": "trapeze_hanger" if sample_path(paths[e["id"]], s)[1] > 1.2 else "floor_saddle"})
    topo["supports"] = supports
    if site:
        pens: list[Json] = []
        for w in walls_out:
            for e in edges:
                pts = paths[e["id"]].points
                for i in range(1, len(pts)):
                    a, b = pts[i - 1], pts[i]
                    ca, cb = (a[2], b[2]) if w["axis"] == "x" else (a[0], b[0])
                    if (ca - w["at"]) * (cb - w["at"]) < 0:
                        t = (w["at"] - ca) / (cb - ca)
                        p = [a[j] + (b[j] - a[j]) * t for j in range(3)]
                        along = p[0] if w["axis"] == "x" else p[2]
                        if w["from"] <= along <= w["to"] and 0 <= p[1] <= w["height_m"]:
                            pens.append({"id": f"pen.{w['id']}.{e['id']}.{len(pens)}", "wall_id": w["id"], "edge_id": e["id"],
                                         "position_xyz_m": [round(c, 3) for c in p], "sleeve": True, "height_m": round(p[1], 3)})
        topo["site"]["penetrations"] = pens

    # ---- assets: fidelity + room
    for a in topo["assets"]:
        t = a["type"]
        a["fidelity"] = "boundary" if t == "chiller" else ("infrastructure" if t in ("port", "dock") else "solver")
        if t == "rack":
            a["telemetry"] = "aux_lumped" if "Telemetry only" in str(a.get("spec", {}).get("Diagnosis", "")) else "instrumented"
            a["solver_backed"] = True
        if rooms:
            p = a["position_xyz_m"]
            a["room_id"] = _room_of(rooms, p[0], p[2])

    # ---- architectural-context cabinets + equipment (explicitly NOT solver-backed)
    ctx: list[Json] = []
    rows = f.get("rows")
    if rows:
        solver_at = {(r["zone"], round(r["x"], 2)): r["id"] for r in racks}
        for row in rows:
            for k in range(row["count"]):
                x = round(row["x0"] + row["pitch"] * k, 2)
                if row["id"].endswith("1") and (row["zone"], x) in solver_at:
                    continue          # that slot is a solver-backed rack
                ctx.append({"id": f"ctx_{row['id'][4:]}_{k + 1:02d}", "type": "cabinet", "label": f"{row['id'][4:].upper()}-{k + 1:02d}",
                            "name": f"Cabinet {row['id'][4:].upper()}-{k + 1:02d} (architectural context)",
                            "fidelity": "architectural_context", "solver_backed": False, "telemetry": "none",
                            "cooling": "air / not modeled", "row_id": row["id"], "hall_id": row["hall"],
                            "zone_id": f"zone_{row['zone']}", "slot": k + 1,
                            "position_xyz_m": [x, 0.0, row["z"]], "size_m": [rk["w"], rk["h"], rk["d"]],
                            "yaw_rad": row["yaw_rad"]})
    topo["context_cabinets"] = ctx
    topo["context_equipment"] = [{"id": c["id"], "type": "equipment", "label": c["label"], "name": c["name"],
                                  "fidelity": "architectural_context", "solver_backed": False, "room_id": c["room"],
                                  "position_xyz_m": [0.5 * (c["rect"][0] + c["rect"][2]), 0.0, 0.5 * (c["rect"][1] + c["rect"][3])],
                                  "size_m": [c["rect"][2] - c["rect"][0], c["height"], c["rect"][3] - c["rect"][1]]}
                                 for c in f.get("context_equipment", [])]
    n_solver = len([a for a in topo["assets"] if a["type"] == "rack"])
    topo["capacity"] = {"solver_backed_racks": n_solver,
                        "instrumented_racks": len([a for a in topo["assets"] if a["type"] == "rack" and a.get("telemetry") == "instrumented"]),
                        "architectural_context_cabinets": len(ctx), "cabinet_instances_total": n_solver + len(ctx),
                        "note": "Only solver_backed racks carry hydraulics/thermal telemetry. Context cabinets are drawn for "
                                "scale and are never fault targets nor measured."}


def _ordered_rooms(rooms: list[Json], path) -> list[str]:
    seen: list[str] = []
    for p in path.points:
        r = _room_of(rooms, p[0], p[2])
        if r and r not in seen:
            seen.append(r)
    return seen
