"""Spatial partition of the live V6 topology into streamable zones.

Pure function of the topology dict (``build_partition(topo)``): same topology -> same zones, same ids, same bounds.
Zone ids are derived from topology ids only, so they are stable across LODs, runs and processes.

Ownership rule: every entity (asset, pipe edge, support, fitting, wall...) has exactly ONE primary zone
(``entity_zone``).  LOD0 and LOD1 geometry of an entity lives in that zone's tile; LOD2/LOD3 tiles only ADD detail
(see docs/engineering/v7-assets.md "refinement rules").
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .meshes import fillet_polyline, polyline_length

Json = dict[str, Any]
PIPE_CHUNK_M = 4.0           # target length of a pipe-segment neighbourhood
Y_TOP = 3.5                  # pipes run up to y = 3.2 (+ radius)


@dataclass
class Zone:
    zone_id: str
    kind: str                       # shell|row|road|cross_aisle|plant|trunk|dock|rack|service|pipe
    label: str
    bounds_min: list[float]
    bounds_max: list[float]
    parent: str | None = None
    entity_ids: list[str] = field(default_factory=list)       # entities whose PRIMARY zone this is
    neighbors: list[str] = field(default_factory=list)
    meta: Json = field(default_factory=dict)

    def to_json(self) -> Json:
        d: Json = {"zone_id": self.zone_id, "kind": self.kind, "label": self.label,
                   "bounds_min_m": [round(v, 3) for v in self.bounds_min], "bounds_max_m": [round(v, 3) for v in self.bounds_max],
                   "parent": self.parent, "neighbors": sorted(set(self.neighbors)), "entity_count": len(self.entity_ids)}
        if self.meta:
            d["meta"] = self.meta
        return d


@dataclass
class Partition:
    zones: dict[str, Zone]
    entity_zone: dict[str, str]               # entity_id -> primary zone
    entity_kind: dict[str, str]               # entity_id -> asset type / 'edge' / 'support' / 'fitting' / 'wall' ...
    pipe_chunks: dict[str, list[Json]]        # edge_id -> [{zone_id, index, s_lo_m, s_hi_m}]  (polyline arclength)
    edge_zone: dict[str, str]

    def zone_for_point(self, x: float, z: float, y: float = 0.0, kinds: tuple[str, ...] = ("rack", "dock", "road", "row", "cross_aisle", "plant")) -> str | None:
        best, best_a = None, 1e18
        for z_ in self.zones.values():
            if z_.kind not in kinds:
                continue
            if z_.bounds_min[0] <= x <= z_.bounds_max[0] and z_.bounds_min[2] <= z <= z_.bounds_max[2]:
                a = (z_.bounds_max[0] - z_.bounds_min[0]) * (z_.bounds_max[2] - z_.bounds_min[2])
                if a < best_a:
                    best, best_a = z_.zone_id, a
        return best


def _aabb(points: np.ndarray, pad: float = 0.0) -> tuple[list[float], list[float]]:
    p = np.asarray(points, dtype=float).reshape(-1, 3)
    return (p.min(axis=0) - pad).tolist(), (p.max(axis=0) + pad).tolist()


def _union(boxes: list[tuple[list[float], list[float]]]) -> tuple[list[float], list[float]]:
    lo = np.min([b[0] for b in boxes], axis=0)
    hi = np.max([b[1] for b in boxes], axis=0)
    return lo.tolist(), hi.tolist()


def _asset_box(a: Json) -> tuple[list[float], list[float]]:
    x, y, z = a["position_xyz_m"]
    sx, sy, sz = a.get("size_m") or (0.3, 0.3, 0.3)
    if a["type"] in ("valve", "sensor", "port", "strainer"):
        sx = sy = sz = max(sx, 0.4)
        return [x - sx / 2, y - sy / 2, z - sz / 2], [x + sx / 2, y + sy / 2, z + sz / 2]
    yaw = abs(math.sin(a.get("yaw_rad", 0.0)))  # quarter-turn aware extent
    ex, ez = (sx, sz) if yaw < 0.7 else (sz, sx)
    return [x - ex / 2, y, z - ez / 2], [x + ex / 2, y + sy, z + ez / 2]


def _rack_short(rid: str) -> str:
    return rid.split("_", 1)[1].upper() if "_" in rid else rid.upper()


def build_partition(topo: Json) -> Partition:
    fac = topo["facility"]
    lay = topo["facility_layout_v6"]
    assets = {a["id"]: a for a in topo["assets"]}
    edges = {e["id"]: e for e in topo["edges"]}
    zones: dict[str, Zone] = {}
    ent_zone: dict[str, str] = {}
    ent_kind: dict[str, str] = {}
    edge_zone: dict[str, str] = {}

    def add_zone(z: Zone) -> Zone:
        zones[z.zone_id] = z
        return z

    def own(entity_id: str, zone_id: str, kind: str) -> None:
        ent_zone[entity_id] = zone_id
        ent_kind[entity_id] = kind
        zones[zone_id].entity_ids.append(entity_id)

    add_zone(Zone("SHELL", "shell", "Facility shell", list(fac["bounds_min"]), list(fac["bounds_max"])))

    # --- rows (bays): racks + both headers + all rack drops + their valves/sensors
    edge_pts = {eid: np.asarray(e["centerline_xyz_m"], dtype=float) for eid, e in edges.items()}
    rack_edges: dict[str, list[str]] = {}
    for row in lay["rows"]:
        rid = row["row_id"]
        rk = [assets[r] for r in row["rack_ids"]]
        eids = [row["supply_header_edge"], row["return_header_edge"]]
        for r in rk:
            eids += [r["supply_drop_edge_id"], r["return_drop_edge_id"]]
            rack_edges[r["id"]] = [r["supply_drop_edge_id"], r["return_drop_edge_id"]]
        boxes = [_asset_box(r) for r in rk] + [_aabb(edge_pts[e], 0.1) for e in eids if e in edge_pts]
        lo, hi = _union(boxes)
        hi[1] = max(hi[1], Y_TOP)
        add_zone(Zone(rid, "row", f"Row {row['letter'].upper()} ({rid})", lo, hi, parent="SHELL",
                      meta={"row_id": rid, "service_road": row["service_road"], "rack_ids": row["rack_ids"], "zone_id_v6": row["zone_id"]}))
        for e in eids:
            if e in edges:
                edge_zone[e] = rid
        for r in rk:
            own(r["id"], rid, "rack")

    # --- roads (cells by sector), cross aisles
    cell_of_road: dict[str, list[str]] = {}
    for road in lay["roads"]:
        hw = road["clear_width_m"] / 2
        for sec in ("west", "east"):
            x0, x1 = road["sectors"][sec]
            zid = f"{road['road_id']}-{sec[0].upper()}"
            add_zone(Zone(zid, "road", f"{road['road_id']} {sec} cell", [x0, 0.0, road["z_m"] - hw], [x1, Y_TOP, road["z_m"] + hw],
                          parent="SHELL", meta={"road_id": road["road_id"], "sector": sec, "between_rows": road["between_rows"],
                                                "clear_width_m": road["clear_width_m"]}))
            cell_of_road.setdefault(road["road_id"], []).append(zid)
        a, b = cell_of_road[road["road_id"]]
        zones[a].neighbors.append(b)
        zones[b].neighbors.append(a)
        for rw in road["between_rows"]:
            zones[a].neighbors.append(rw)
            zones[b].neighbors.append(rw)
            zones[rw].neighbors += [a, b]
    for xa in lay["cross_aisles"]:
        add_zone(Zone(xa["id"], "cross_aisle", f"Cross-aisle {xa['id'][-1]}", [xa["x_min_m"], 0.0, xa["z_min_m"]],
                      [xa["x_max_m"], Y_TOP, xa["z_max_m"]], parent="SHELL", meta={"connects_roads": xa["connects_roads"]}))
        for rd in xa["connects_roads"]:
            for cz in cell_of_road.get(rd, []):
                if (xa["id"] == "XA-W") == cz.endswith("-W"):
                    zones[xa["id"]].neighbors.append(cz)
                    zones[cz].neighbors.append(xa["id"])

    # --- plant / trunk
    plant_assets = [a for a in topo["assets"] if a.get("room_id") in ("room_mech", "yard") and a["type"] in ("cdu", "pump", "chiller", "strainer", "dock")]
    plant_assets += [dict(c, type="equipment") for c in topo.get("context_equipment", [])]
    fws_edges = [e for e in edges.values() if e["loop"] == "fws"]
    trunk_edges = [e for e in edges.values() if e["id"] not in edge_zone and e["loop"] != "fws"]
    pboxes = [_asset_box(a) for a in plant_assets if "position_xyz_m" in a] + [_aabb(edge_pts[e["id"]], 0.15) for e in fws_edges]
    lo, hi = _union(pboxes)
    add_zone(Zone("PLANT", "plant", "Mechanical plant, CDU and yard", lo, hi, parent="SHELL", meta={"cdu": "cdu_01"}))
    tz = _aabb(np.vstack([edge_pts[e["id"]] for e in trunk_edges]), 0.2)
    add_zone(Zone("TRUNK-TCS", "trunk", "TCS trunks and tees", tz[0], tz[1], parent="SHELL"))
    for e in fws_edges:
        edge_zone[e["id"]] = "PLANT"
    for e in trunk_edges:
        edge_zone[e["id"]] = "TRUNK-TCS"
    for a in plant_assets:
        if a["type"] == "dock" or a["id"] not in assets:
            continue
    for a in plant_assets:
        if a["type"] == "strainer" and edge_zone.get(a.get("edge_id", "")) == "TRUNK-TCS":
            own(a["id"], "TRUNK-TCS", "strainer")
        elif a["type"] == "equipment":
            own(a["id"], "PLANT", "equipment")
        else:
            own(a["id"], "PLANT", a["type"])
    for eid, zid in edge_zone.items():
        own(eid, zid, "edge")
    zones["PLANT"].neighbors += ["TRUNK-TCS", "XA-W"]
    zones["TRUNK-TCS"].neighbors += ["PLANT", "XA-W", "XA-E"] + [r["row_id"] for r in lay["rows"]]
    zones["XA-W"].neighbors += ["PLANT", "TRUNK-TCS"]
    zones["XA-E"].neighbors += ["TRUNK-TCS"]

    # --- docks: own zones, geometry rides in the road-cell tile
    for a in topo["assets"]:
        if a["type"] != "dock":
            continue
        x, _, z = a["position_xyz_m"]
        sx, _, sz = a.get("size_m") or (1.4, 0.05, 1.0)
        parent = zones_at(zones, x, z, ("road",)) or "PLANT"
        zid = f"DOCK-{a['id'][5:]}" if a["id"].startswith("dock_") else f"DOCK-{a['id']}"
        add_zone(Zone(zid, "dock", a.get("name", a["id"]), [x - sx / 2 - 0.3, 0.0, z - sz / 2 - 0.3], [x + sx / 2 + 0.3, 2.4, z + sz / 2 + 0.3],
                      parent=parent, meta={"dock_id": a["id"]}))
        zones[zid].neighbors.append(parent)
        zones[parent].neighbors.append(zid)
        own_to = parent
        ent_zone[a["id"]] = own_to      # geometry lives in the parent cell; DOCK zone is the interest/selection region
        ent_kind[a["id"]] = "dock"
        zones[own_to].entity_ids.append(a["id"])
        zones[zid].meta["owner_zone"] = own_to

    # --- other assets (valves, sensors, ports): follow their edge, else row, else plant
    for a in topo["assets"]:
        if a["id"] in ent_zone or a["type"] in ("dock",):
            continue
        z = edge_zone.get(a.get("edge_id", ""))
        if z is None and a.get("row_id") in zones:
            z = a["row_id"]
        if z is None:
            z = "PLANT"
        own(a["id"], z, a["type"])

    # --- racks (L2 detail zones) + service (repair) zones
    for rid, row in ((r["id"], r) for r in (assets[x] for x in assets if assets[x]["type"] == "rack")):
        rk = assets[rid]
        boxes = [_asset_box(rk)] + [_aabb(edge_pts[e], 0.1) for e in rack_edges[rid] if e in edge_pts]
        for a in topo["assets"]:
            if a.get("edge_id") in rack_edges[rid]:
                boxes.append(_asset_box(a))
        lo, hi = _union(boxes)
        zid = f"RACK-{_rack_short(rid)}"
        add_zone(Zone(zid, "rack", f"Rack {rk['label']}", lo, hi, parent=rk["row_id"],
                      meta={"rack_id": rid, "row_id": rk["row_id"], "slot": rk["slot"], "instrumented": rk.get("telemetry") == "instrumented"}))
        zones[zid].neighbors.append(rk["row_id"])
        zones[rk["row_id"]].neighbors.append(zid)
    for a in topo["assets"]:
        if a["type"] in ("strainer", "pump", "cdu") and a.get("service_xyz_m") and "outrig" in a.get("accessible_by", []):
            sx, sy, sz = a["service_xyz_m"]
            lo, hi = _union([_asset_box(a), ([sx - 0.8, 0.0, sz - 0.8], [sx + 0.8, 0.1, sz + 0.8])])
            parent = ent_zone[a["id"]]
            zid = f"SVC-{a['id']}"
            add_zone(Zone(zid, "service", f"Service bay {a.get('label', a['id'])}", lo, hi, parent=parent,
                          meta={"asset_id": a["id"], "service_xyz_m": [sx, sy, sz]}))
            zones[zid].neighbors.append(parent)
            zones[parent].neighbors.append(zid)

    # --- pipe-segment neighbourhoods (robot-passable edges)
    chunks: dict[str, list[Json]] = {}
    node_ends: dict[str, list[tuple[str, int, str]]] = {}
    from .meshes import split_polyline
    for eid in sorted(edges):
        e = edges[eid]
        if not e.get("robot_passable"):
            continue
        fp = fillet_polyline(edge_pts[eid], float(e.get("fillet_radius_m") or 0.0))
        flen = polyline_length(fp)
        scale = float(e["length_m"]) / flen if flen > 0 else 1.0     # arclength -> edge.length_m (the coordinate nav.s_m uses)
        n = max(1, math.ceil(float(e["length_m"]) / PIPE_CHUNK_M))
        rad = e["diameter_mm"] / 2000.0
        lst = []
        parent = edge_zone[eid]
        for k, (cp, lo_s, hi_s) in enumerate(split_polyline(fp, n)):
            zid = f"PS-{eid}-{k + 1:02d}"
            lo, hi = _aabb(cp, rad + 0.15)
            lo_m, hi_m = lo_s * scale, hi_s * scale
            add_zone(Zone(zid, "pipe", f"{e.get('name', eid)} [{k + 1}/{n}]", lo, hi, parent=parent,
                          meta={"edge_id": eid, "index": k, "of": n, "s_lo_m": round(lo_m, 4), "s_hi_m": round(hi_m, 4),
                                "loop": e["loop"], "role": e["role"], "diameter_mm": e["diameter_mm"]}))
            lst.append({"zone_id": zid, "index": k, "s_lo_m": lo_m, "s_hi_m": hi_m, "points": cp, "s_scale": scale, "s_lo_raw": lo_s})
            if k:
                zones[zid].neighbors.append(lst[k - 1]["zone_id"])
                zones[lst[k - 1]["zone_id"]].neighbors.append(zid)
        chunks[eid] = lst
        node_ends.setdefault(e["from"], []).append((eid, 0, lst[0]["zone_id"]))
        node_ends.setdefault(e["to"], []).append((eid, 1, lst[-1]["zone_id"]))
    for nid, ends in node_ends.items():           # junction: chunks that meet at a node see each other
        for _, _, za in ends:
            for _, _, zb in ends:
                if za != zb:
                    zones[za].neighbors.append(zb)

    # --- zone-level entities (selectable regions) + structural entities (walls, columns) belong to the shell
    for row in lay["rows"]:
        own(row["row_id"], row["row_id"], "row")
    for road in lay["roads"]:
        own(road["road_id"], cell_of_road[road["road_id"]][0], "road")
    for xa in lay["cross_aisles"]:
        own(xa["id"], xa["id"], "cross_aisle")
    own("floor", "SHELL", "floor")
    for w in topo["site"].get("walls", []):
        own(w["id"], "SHELL", "wall")
    for c in topo["site"].get("columns", []):
        own(c["id"], "SHELL", "column")
    for s in topo.get("supports", []):
        ez = edge_zone.get(s["edge_id"], "SHELL")
        ent_zone[s["id"]], ent_kind[s["id"]] = ez, "support"
        zones[ez].entity_ids.append(s["id"])
    for f in topo.get("fittings", []):
        ez = edge_zone.get(f.get("edge_id") or (f.get("edge_ids") or [""])[0], "SHELL")
        ent_zone[f["id"]], ent_kind[f["id"]] = ez, "fitting"
        zones[ez].entity_ids.append(f["id"])
    for z in zones.values():
        z.entity_ids = sorted(set(z.entity_ids))
        z.neighbors = sorted({n for n in z.neighbors if n != z.zone_id and n in zones})
    return Partition(dict(sorted(zones.items())), ent_zone, ent_kind, chunks, edge_zone)


def zones_at(zones: dict[str, Zone], x: float, z: float, kinds: tuple[str, ...]) -> str | None:
    for zid in sorted(zones):
        zz = zones[zid]
        if zz.kind in kinds and zz.bounds_min[0] <= x <= zz.bounds_max[0] and zz.bounds_min[2] <= z <= zz.bounds_max[2]:
            return zid
    return None
