"""Deterministic geometry compiler: V6 topology -> immutable LOD tiles (GLB) + render manifest.

Nothing here is random, time-dependent or hand-authored: every vertex derives from topology numbers (positions,
sizes, centerlines, diameters, bore, supports, fittings, service poses).  Levels that cannot be produced from topology
are *omitted* and listed under ``manifest.omitted`` with the reason.

LOD semantics (see docs/engineering/v7-assets.md):
  L0  one tile ``SHELL@L0``: floor, walls, columns, instanced racks/equipment/docks, line pipes, route corridors.
      Geometry is grouped in one node per zone so a viewer can hide a zone's L0 group once that zone's L1 is loaded
      (REPLACE).  
  L1  one tile per row / road cell / cross-aisle / plant / trunk: meshed pipes, rack bodies, valves, sensors, pads.
  L2  ADD-only detail: per rack (door, vents, LED strip, plinth, handwheels, flanges), per pipe segment (hangers,
      tee collars, spool couplings), per service bay (floor decal + leader line).
  L3  ADD-only: pipe-segment bore surface (inward-facing, ``_S_M`` along the pipe) for in-pipe / contact views.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .glb import GlbBuilder, parse_glb
from .meshes import Mesh, fillet_polyline, polyline_length
from .partition import Partition, Zone, build_partition

Json = dict[str, Any]
COMPILER_VERSION = "lk.assets.compiler/1"
MANIFEST_VERSION = "lk.render-manifest/1"
TILE_FORMAT = "lk.tile.v1"
GLB_TYPE = "model/gltf-binary"
GEOMETRIC_ERROR_M = {0: 1.0, 1: 0.25, 2: 0.05, 3: 0.01}
LEVEL_INFO = {
    0: ("shell", "floor, walls, columns, instanced racks/equipment/docks, line pipes, route corridors; always resident"),
    1: ("zone", "meshed pipes (8 radial), rack bodies, valves, sensors, ports, pads, lane edges per row/road/plant/trunk"),
    2: ("detail", "ADD-only: rack doors/vents/LED/plinth, valve handwheels, flanges, hangers, tee collars, spool couplings, service decals"),
    3: ("contact", "ADD-only: pipe-segment bore surface (24 radial, inward normals, _S_M) for in-pipe views"),
}
UNIT_BOX_FEATURE = 0


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def topology_digest(topo: Json) -> str:
    """Hash of everything the compiler reads (not the whole topology: hydraulics/spec text can change without moving geometry)."""
    keep = {"facility": topo["facility"], "assets": [{k: a.get(k) for k in ("id", "type", "position_xyz_m", "size_m", "yaw_rad", "edge_id", "s_m", "row_id", "slot",
                                                                           "supply_drop_edge_id", "return_drop_edge_id", "service_xyz_m", "accessible_by", "room_id",
                                                                           "label", "name", "telemetry")} for a in topo["assets"]],
            "edges": [{k: e.get(k) for k in ("id", "loop", "role", "from", "to", "centerline_xyz_m", "length_m", "diameter_mm", "bore_m",
                                              "fillet_radius_m", "robot_passable", "name")} for e in topo["edges"]],
            "layout": topo.get("facility_layout_v6"), "site": topo.get("site"), "supports": topo.get("supports"),
            "fittings": topo.get("fittings"), "context_equipment": topo.get("context_equipment")}
    return sha256_hex(canonical_json(keep))


@dataclass
class Tile:
    tile_id: str
    zone_id: str
    lod: int
    data: bytes
    sha256: str
    gz: bytes
    stats: Json
    bounds_min: list[float]
    bounds_max: list[float]


class TileBuilder:
    def __init__(self, tile_id: str, zone_id: str, lod: int, refine: str, meta: Json) -> None:
        self.tile_id, self.zone_id, self.lod, self.refine, self.meta = tile_id, zone_id, lod, refine, meta
        self.feats: list[str] = []
        self._fi: dict[str, int] = {}
        self.tris: dict[tuple[str, str], Mesh] = {}
        self.lines: dict[tuple[str, str], Mesh] = {}
        self.inst: dict[tuple[str, str], list[tuple]] = {}
        self.lo = np.full(3, 1e18)
        self.hi = np.full(3, -1e18)

    def fid(self, feature_id: str) -> int:
        if feature_id not in self._fi:
            self._fi[feature_id] = len(self.feats)
            self.feats.append(feature_id)
        return self._fi[feature_id]

    def tri(self, group: str, material: str) -> Mesh:
        return self.tris.setdefault((group, material), Mesh())

    def line(self, group: str, material: str) -> Mesh:
        return self.lines.setdefault((group, material), Mesh())

    def instance(self, group: str, material: str, center, size, yaw: float, feature_id: str, y_base: bool = True) -> None:
        cx, cy, cz = center
        if y_base:
            cy += size[1] / 2
        self.inst.setdefault((group, material), []).append(((cx, cy, cz), tuple(size), yaw, self.fid(feature_id)))

    def _grow(self, pts: np.ndarray) -> None:
        if len(pts):
            self.lo = np.minimum(self.lo, pts.min(axis=0))
            self.hi = np.maximum(self.hi, pts.max(axis=0))

    def build(self, asset_extras: Json) -> tuple[bytes, Json, list[float], list[float]]:
        g = GlbBuilder()
        stats = {"triangles": 0, "line_segments": 0, "instances": 0, "vertices": 0}
        order: list[str] = []
        for key in sorted({k[0] for k in (*self.tris, *self.lines, *self.inst)}):
            order.append(key)
        unit = Mesh()
        unit.box((0, 0, 0), (1, 1, 1), 0)
        upos, unrm, _, _, uidx = unit.arrays()
        unit_prim: Json | None = None
        for grp in order:
            extras = {"lk": {"zone_id": self.zone_id, "group": grp}}
            prims: list[dict] = []
            for (gk, mat), m in sorted(self.tris.items()):
                if gk != grp or m.empty():
                    continue
                pos, nrm, feat, s, idx = m.arrays()
                self._grow(pos)
                has_s = bool(np.any(s != 0)) or mat.startswith("lk.pipe")
                prims.append(g.mesh_primitive(mat, pos, idx, nrm=nrm, feat=feat, s_m=s if has_s else None))
                stats["triangles"] += len(idx) // 3
                stats["vertices"] += len(pos)
            for (gk, mat), m in sorted(self.lines.items()):
                if gk != grp or m.empty():
                    continue
                pos, _, feat, _, idx = m.arrays()
                self._grow(pos)
                prims.append(g.mesh_primitive(mat, pos, idx, feat=feat, mode=1))
                stats["line_segments"] += len(idx) // 2
                stats["vertices"] += len(pos)
            if prims:
                g.add_mesh_node(f"{grp}|geometry", prims, extras)
            for (gk, mat), lst in sorted(self.inst.items()):
                if gk != grp:
                    continue
                trans = np.array([i[0] for i in lst], dtype=np.float32)
                scale = np.array([i[1] for i in lst], dtype=np.float32)
                rot = np.array([[0, math.sin(i[2] / 2), 0, math.cos(i[2] / 2)] for i in lst], dtype=np.float32)
                fe = np.array([i[3] for i in lst], dtype=np.uint16)
                for c, s_ in zip(trans, scale):
                    ext = max(s_[0], s_[2]) / 2 * 1.4143
                    self._grow(np.array([c - (ext, s_[1] / 2, ext), c + (ext, s_[1] / 2, ext)]))
                if unit_prim is None:
                    unit_prim = g.mesh_primitive(mat, upos, uidx, nrm=unrm)
                prim = {**unit_prim, "material": g.material(mat)}
                ext_acc = {"TRANSLATION": g.accessor(trans), "ROTATION": g.accessor(rot), "SCALE": g.accessor(scale),
                           "_FEATURE_ID": g.accessor(fe)}
                g.use_extension("EXT_mesh_gpu_instancing")
                g.add_mesh_node(f"{grp}|{mat}|instanced", [prim], {"lk": {"zone_id": self.zone_id, "group": grp, "instanced": True}},
                                {"EXT_mesh_gpu_instancing": {"attributes": ext_acc}})
                stats["instances"] += len(lst)
        lo = (self.lo if self.lo[0] < 1e17 else np.zeros(3)).tolist()
        hi = (self.hi if self.hi[0] > -1e17 else np.zeros(3)).tolist()
        g.asset_extras = {"lk": {**asset_extras, "format": TILE_FORMAT, "tile_id": self.tile_id, "zone_id": self.zone_id, "lod": self.lod,
                                 "refine": self.refine, "feature_table": self.feats,
                                 "bounds_min_m": [round(v, 4) for v in lo], "bounds_max_m": [round(v, 4) for v in hi],
                                 "attributes": {"_FEATURE_ID": "uint16 index into feature_table (entity = feature_id.split('#')[0] unless mapped by features asset)",
                                                "_S_M": "float32 metres along the pipe edge in edge.length_m coordinates (pipe meshes only)"},
                                 **self.meta}}
        return g.to_bytes(), stats, [round(v, 4) for v in lo], [round(v, 4) for v in hi]


def pipe_material(e: Json) -> str:
    return f"lk.pipe.{e['loop']}.{e['role']}"


def _dir_at(pts: np.ndarray, s: float, length: float) -> np.ndarray:
    seg = np.diff(pts, axis=0)
    ln = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(ln)])
    t = s / max(length, 1e-9) * cum[-1]
    j = int(np.clip(np.searchsorted(cum, t, side="right") - 1, 0, len(seg) - 1))
    return seg[j] / max(ln[j], 1e-9)


def _point_at(pts: np.ndarray, s: float, length: float) -> np.ndarray:
    seg = np.diff(pts, axis=0)
    ln = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(ln)])
    t = s / max(length, 1e-9) * cum[-1]
    j = int(np.clip(np.searchsorted(cum, t, side="right") - 1, 0, len(seg) - 1))
    return pts[j] + seg[j] * ((t - cum[j]) / max(ln[j], 1e-9))


def _resample(pts: np.ndarray, step: float) -> np.ndarray:
    seg = np.diff(pts, axis=0)
    ln = np.linalg.norm(seg, axis=1)
    out = [pts[0]]
    for a, b, l in zip(pts[:-1], pts[1:], ln):
        n = max(1, math.ceil(l / step))
        for k in range(1, n + 1):
            out.append(a + (b - a) * (k / n))
    return np.array(out)


class Compiler:
    def __init__(self, topo: Json) -> None:
        self.topo = topo
        self.part: Partition = build_partition(topo)
        self.assets = {a["id"]: a for a in topo["assets"]}
        self.edges = {e["id"]: e for e in topo["edges"]}
        self.lay = topo["facility_layout_v6"]
        self.fac = topo["facility"]
        self.edge_pts = {k: np.asarray(e["centerline_xyz_m"], dtype=float) for k, e in self.edges.items()}
        self.edge_fp = {k: fillet_polyline(p, float(self.edges[k].get("fillet_radius_m") or 0.0)) for k, p in self.edge_pts.items()}
        self.edge_scale = {k: self.edges[k]["length_m"] / max(polyline_length(p), 1e-9) for k, p in self.edge_fp.items()}
        self.meta = {"layout_hash": self.fac["topology_hash"], "topology_version": self.fac.get("topology_version"),
                     "units": "m", "frame": "facility_world (x east, y up, z south; right-handed)"}
        self.tiles: dict[str, Tile] = {}
        self.features_used: set[str] = set()

    # ---- helpers ------------------------------------------------------
    def zone_assets(self, zone_id: str, types: tuple[str, ...] | None = None) -> list[Json]:
        z = self.part.zones[zone_id]
        out = [self.assets[e] for e in z.entity_ids if e in self.assets and (types is None or self.assets[e]["type"] in types)]
        return sorted(out, key=lambda a: a["id"])

    def zone_edges(self, zone_id: str) -> list[Json]:
        return [self.edges[e] for e in self.part.zones[zone_id].entity_ids if e in self.edges]

    def tube_edge(self, tb: TileBuilder, grp: str, e: Json, radial: int) -> None:
        r = e["diameter_mm"] / 2000.0
        tb.tri(grp, pipe_material(e)).tube(self.edge_fp[e["id"]], r, radial, tb.fid(e["id"]), s_scale=self.edge_scale[e["id"]])

    def line_edge(self, tb: TileBuilder, grp: str, e: Json) -> None:
        pts = self.edge_pts[e["id"]]
        idx = np.array([[i, i + 1] for i in range(len(pts) - 1)])
        tb.line(grp, pipe_material(e)).add(pts, None, idx, tb.fid(e["id"]))

    def small_fixture(self, tb: TileBuilder, grp: str, a: Json) -> None:
        x, y, z = a["position_xyz_m"]
        f = tb.fid(a["id"])
        t = a["type"]
        e = self.edges.get(a.get("edge_id", ""))
        r = e["diameter_mm"] / 2000.0 if e else 0.06
        if t == "valve":
            tb.tri(grp, "lk.valve").cylinder((x, y - 0.09, z), max(r * 1.7, 0.06), 0.18, 10, f)
        elif t == "sensor":
            tb.tri(grp, "lk.sensor").box((x, y, z), (0.12, 0.12, 0.12), f)
        elif t == "port":
            tb.tri(grp, "lk.fitting").box((x, y + r * 0.8, z), (0.22, 0.12, 0.22), f)

    # ---- tiles --------------------------------------------------------
    def finish(self, tb: TileBuilder, extra: Json | None = None) -> Tile:
        data, stats, lo, hi = tb.build(extra or {})
        gz = gzip.compress(data, 9, mtime=0)
        stats["bytes"] = len(data)
        stats["bytes_gzip"] = len(gz)
        t = Tile(tb.tile_id, tb.zone_id, tb.lod, data, sha256_hex(data), gz, stats, lo, hi)
        self.tiles[tb.tile_id] = t
        self.features_used.update(tb.feats)
        return t

    def l0(self) -> Tile:
        tb = TileBuilder("SHELL@L0", "SHELL", 0, "base", self.meta)
        f = self.fac
        # structure
        bmin, bmax = f["bounds_min"], f["bounds_max"]
        tb.tri("SHELL", "lk.floor").quad(((bmin[0] + bmax[0]) / 2, 0.0, (bmin[2] + bmax[2]) / 2), (bmax[0] - bmin[0], bmax[2] - bmin[2]), tb.fid("floor"))
        for w in sorted(self.topo["site"]["walls"], key=lambda w: w["id"]):
            for x0, z0, x1, z1 in w["rect_segments"]:
                h = w.get("height_m", 6.0)
                tb.tri("SHELL", "lk.wall").box(((x0 + x1) / 2, 0.0, (z0 + z1) / 2), (x1 - x0, h, z1 - z0), tb.fid(w["id"]), y_base=True)
        for d in sorted(self.topo["site"]["doors"], key=lambda d: d["id"]):
            w = next(w for w in self.topo["site"]["walls"] if w["id"] == d["wall_id"])
            lintel_h = w.get("height_m", 6.0) - d["height_m"]
            cx, _, cz = d["position_xyz_m"]
            span = d["to"] - d["from"]
            size = (w["thickness_m"], lintel_h, span) if d["axis"] == "z" else (span, lintel_h, w["thickness_m"])
            center = (cx, d["height_m"], (d["from"] + d["to"]) / 2) if d["axis"] == "z" else ((d["from"] + d["to"]) / 2, d["height_m"], cz)
            tb.tri("SHELL", "lk.wall").box(center, size, tb.fid(w["id"]), y_base=True)
        for c in sorted(self.topo["site"]["columns"], key=lambda c: c["id"]):
            tb.tri("SHELL", "lk.column").box(c["position_xyz_m"], c["size_m"], tb.fid(c["id"]), y_base=True)
        # zones
        for zid, z in self.part.zones.items():
            if z.kind == "row":
                for a in self.zone_assets(zid, ("rack",)):
                    tb.instance(zid, "lk.rack", a["position_xyz_m"], a["size_m"], a.get("yaw_rad", 0.0), a["id"])
            elif z.kind in ("road", "cross_aisle"):
                if z.kind == "road":
                    tb.tri(zid, "lk.corridor").quad(((z.bounds_min[0] + z.bounds_max[0]) / 2, 0.02, (z.bounds_min[2] + z.bounds_max[2]) / 2),
                                                    (z.bounds_max[0] - z.bounds_min[0], z.bounds_max[2] - z.bounds_min[2]), tb.fid(z.meta["road_id"]))
                else:
                    tb.tri(zid, "lk.corridor").quad(((z.bounds_min[0] + z.bounds_max[0]) / 2, 0.02, (z.bounds_min[2] + z.bounds_max[2]) / 2),
                                                    (z.bounds_max[0] - z.bounds_min[0], z.bounds_max[2] - z.bounds_min[2]), tb.fid(zid))
                for a in self.zone_assets(zid, ("dock",)):
                    tb.instance(zid, "lk.dock", a["position_xyz_m"], a["size_m"], a.get("yaw_rad", 0.0), a["id"])
            elif z.kind == "plant":
                for a in self.zone_assets(zid):
                    if a["type"] in ("cdu", "pump", "chiller", "dock") and a.get("size_m"):
                        tb.instance(zid, "lk.dock" if a["type"] == "dock" else "lk.equipment", a["position_xyz_m"], a["size_m"], a.get("yaw_rad", 0.0), a["id"])
                for c in self.topo.get("context_equipment", []):
                    tb.instance(zid, "lk.equipment", c["position_xyz_m"], c["size_m"], 0.0, c["id"])
            if z.kind in ("row", "plant", "trunk"):
                for e in self.zone_edges(zid):
                    self.line_edge(tb, zid, e)
        return self.finish(tb)

    def l1_row(self, zid: str) -> Tile:
        tb = TileBuilder(f"{zid}@L1", zid, 1, "replace_group", {**self.meta, "replaces_group": zid})
        for a in self.zone_assets(zid, ("rack",)):
            tb.tri(zid, "lk.rack").box(a["position_xyz_m"], a["size_m"], tb.fid(a["id"]), a.get("yaw_rad", 0.0), y_base=True)
        for e in self.zone_edges(zid):
            self.tube_edge(tb, zid, e, 8 if e["diameter_mm"] > 60 else 6)
        for a in self.zone_assets(zid, ("valve", "sensor", "port")):
            self.small_fixture(tb, zid, a)
        return self.finish(tb)

    def l1_road(self, zid: str) -> Tile:
        z = self.part.zones[zid]
        tb = TileBuilder(f"{zid}@L1", zid, 1, "replace_group", {**self.meta, "replaces_group": zid})
        x0, x1 = z.bounds_min[0], z.bounds_max[0]
        zc = (z.bounds_min[2] + z.bounds_max[2]) / 2
        hw = (z.bounds_max[2] - z.bounds_min[2]) / 2
        f = tb.fid(z.meta["road_id"])
        m = tb.tri(zid, "lk.corridor")
        m.quad(((x0 + x1) / 2, 0.02, zc - hw + 0.03), (x1 - x0, 0.06), f)
        m.quad(((x0 + x1) / 2, 0.02, zc + hw - 0.03), (x1 - x0, 0.06), f)
        for a in self.zone_assets(zid, ("dock",)):
            tb.tri(zid, "lk.dock").box(a["position_xyz_m"], a["size_m"], tb.fid(a["id"]), a.get("yaw_rad", 0.0), y_base=True)
        road = next(r for r in self.lay["roads"] if r["road_id"] == z.meta["road_id"])
        for ax, az in road.get("approach_pose_xz", []):
            if x0 <= ax <= x1:
                m.quad((ax, 0.021, az), (0.5, 0.5), f)
        return self.finish(tb)

    def l1_xa(self, zid: str) -> Tile:
        z = self.part.zones[zid]
        tb = TileBuilder(f"{zid}@L1", zid, 1, "replace_group", {**self.meta, "replaces_group": zid})
        m = tb.tri(zid, "lk.corridor")
        f = tb.fid(zid)
        cx = (z.bounds_min[0] + z.bounds_max[0]) / 2
        cz = (z.bounds_min[2] + z.bounds_max[2]) / 2
        w = z.bounds_max[0] - z.bounds_min[0]
        d = z.bounds_max[2] - z.bounds_min[2]
        m.quad((z.bounds_min[0] + 0.03, 0.02, cz), (0.06, d), f)
        m.quad((z.bounds_max[0] - 0.03, 0.02, cz), (0.06, d), f)
        return self.finish(tb)

    def l1_equipment_zone(self, zid: str) -> Tile:
        tb = TileBuilder(f"{zid}@L1", zid, 1, "replace_group", {**self.meta, "replaces_group": zid})
        for a in self.zone_assets(zid):
            f = tb.fid(a["id"])
            t = a["type"]
            if t in ("cdu", "pump", "chiller"):
                tb.tri(zid, "lk.equipment").box(a["position_xyz_m"], a["size_m"], f, a.get("yaw_rad", 0.0), y_base=True)
            elif t == "dock":
                tb.tri(zid, "lk.dock").box(a["position_xyz_m"], a["size_m"], f, a.get("yaw_rad", 0.0), y_base=True)
            elif t == "strainer":
                e = self.edges[a["edge_id"]]
                d = _dir_at(self.edge_pts[e["id"]], a.get("s_m", 0.0), e["length_m"])
                p = np.array(a["position_xyz_m"])
                rad = e["diameter_mm"] / 2000.0 * 1.6
                tb.tri(zid, "lk.equipment").tube(np.array([p - d * 0.3, p + d * 0.3]), rad, 12, f, caps=True)
            elif t in ("valve", "sensor", "port"):
                self.small_fixture(tb, zid, a)
        if zid == "PLANT":
            for c in sorted(self.topo.get("context_equipment", []), key=lambda c: c["id"]):
                sx, sy, sz = c["size_m"]
                p = np.array(c["position_xyz_m"], dtype=float)
                tb.tri(zid, "lk.equipment").tube(np.array([p, p + (0, sy, 0)]), min(sx, sz) / 2, 16, tb.fid(c["id"]), caps=True)
        for e in self.zone_edges(zid):
            self.tube_edge(tb, zid, e, 12 if e["diameter_mm"] >= 150 else 8)
        return self.finish(tb)

    def l2_rack(self, zid: str) -> Tile:
        z = self.part.zones[zid]
        rid = z.meta["rack_id"]
        rk = self.assets[rid]
        row = next(r for r in self.lay["rows"] if r["row_id"] == rk["row_id"])
        tb = TileBuilder(f"{zid}@L2", zid, 2, "add", {**self.meta, "adds_to": rk["row_id"]})
        x, _, zz = rk["position_xyz_m"]
        sx, sy, sz = rk["size_m"]
        fs = 1.0 if row["service_z_m"] > zz else -1.0
        zf = zz + fs * (sz / 2 + 0.012)
        det = tb.tri(zid, "lk.rack.detail")
        det.box((x, 0.12, zf), (sx * 0.92, sy * 0.82, 0.02), tb.fid(f"{rid}#door"), y_base=True)
        det.box((x + sx * 0.36, 1.1, zf + fs * 0.02), (0.03, 0.36, 0.03), tb.fid(f"{rid}#handle"), y_base=True)
        det.box((x, 0.0, zz), (sx + 0.04, 0.1, sz + 0.04), tb.fid(f"{rid}#plinth"), y_base=True)
        for k in range(8):
            det.box((x, 0.32 + 0.08 * k, zf + fs * 0.012), (sx * 0.8, 0.015, 0.012), tb.fid(f"{rid}#vent"), y_base=True)
        tb.tri(zid, "lk.sensor").box((x, sy * 0.93, zf + fs * 0.012), (sx * 0.7, 0.03, 0.01), tb.fid(f"{rid}#led"), y_base=True)
        for eid in (rk["supply_drop_edge_id"], rk["return_drop_edge_id"]):
            e = self.edges[eid]
            r = e["diameter_mm"] / 2000.0
            pts = self.edge_pts[eid]
            for p, q in ((pts[0], pts[1]), (pts[-1], pts[-2])):
                d = (q - p) / max(np.linalg.norm(q - p), 1e-9)
                p0 = p + d * 0.03 if np.allclose(p, pts[-1]) else p
                tb.tri(zid, "lk.fitting").tube(np.array([p0, p0 + d * 0.025]), r * 1.7, 14, tb.fid(f"{eid}#flange"), caps=True)
        for a in sorted(self.assets.values(), key=lambda a: a["id"]):
            if a.get("edge_id") not in (rk["supply_drop_edge_id"], rk["return_drop_edge_id"]):
                continue
            px, py, pz = a["position_xyz_m"]
            e = self.edges[a["edge_id"]]
            r = e["diameter_mm"] / 2000.0
            if a["type"] == "valve":
                tb.tri(zid, "lk.valve").cylinder((px, py + 0.09, pz), 0.008, 0.1, 6, tb.fid(f"{a['id']}#stem"))
                tb.tri(zid, "lk.valve").cylinder((px, py + 0.19, pz), 0.085, 0.014, 14, tb.fid(f"{a['id']}#handwheel"))
            elif a["type"] == "sensor":
                tb.tri(zid, "lk.sensor").box((px + r + 0.07, py, pz), (0.08, 0.12, 0.1), tb.fid(f"{a['id']}#body"))
                tb.tri(zid, "lk.fitting").box((px + r + 0.115, py + 0.02, pz), (0.01, 0.05, 0.07), tb.fid(f"{a['id']}#display"))
        return self.finish(tb)

    def l2_pipe(self, ch: Json, eid: str) -> Tile:
        e = self.edges[eid]
        zid = ch["zone_id"]
        n_of = len(self.part.pipe_chunks[eid])
        tb = TileBuilder(f"{zid}@L2", zid, 2, "add", {**self.meta, "adds_to": self.part.edge_zone[eid], "edge_id": eid})
        r = e["diameter_mm"] / 2000.0
        scale = ch["s_scale"]
        lo, hi = ch["s_lo_m"], ch["s_hi_m"]
        last = ch["index"] == n_of - 1
        for s in sorted(self.topo.get("supports", []), key=lambda s: s["id"]):
            if s["edge_id"] != eid or not (lo <= s["s_m"] < hi or (last and s["s_m"] == hi)):
                continue
            px, py, pz = s["position_xyz_m"]
            d = _dir_at(self.edge_pts[eid], s["s_m"], e["length_m"])
            if abs(d[1]) > 0.7:
                continue
            side = np.cross(d, (0, 1, 0))
            side /= max(np.linalg.norm(side), 1e-9)
            yaw = math.atan2(-side[2], side[0])
            f = tb.fid(s["id"])
            m = tb.tri(zid, "lk.support")
            m.box((px, py - r - 0.045, pz), (0.5, 0.03, 0.05), f, yaw)
            for sgn in (-1, 1):
                c = np.array([px, py - r - 0.03, pz]) + side * 0.22 * sgn
                m.box((c[0], c[1], c[2]), (0.014, 0.85, 0.014), f, yaw, y_base=True)
        for ft in sorted(self.topo.get("fittings", []), key=lambda f: f["id"]):
            fe = ft.get("edge_id") or (ft.get("edge_ids") or [""])[0]
            if fe != eid:
                continue
            p = np.array(ft["position_xyz_m"], dtype=float)
            nearest = min(self.part.pipe_chunks[eid], key=lambda c: float(np.min(np.linalg.norm(c["points"] - p, axis=1))))
            if nearest["zone_id"] != zid:
                continue
            seg = self.edge_fp[eid]
            j = int(np.argmin(np.linalg.norm(seg - p, axis=1)))
            d = seg[min(j + 1, len(seg) - 1)] - seg[max(j - 1, 0)]
            d = d / max(np.linalg.norm(d), 1e-9)
            tb.tri(zid, "lk.fitting").tube(np.array([p - d * 0.05, p + d * 0.05]), r * 1.3, 14, tb.fid(ft["id"]), caps=True)
        if not last:   # spool coupling at the chunk boundary (presentation convention, not an engineering datum)
            p = ch["points"][-1]
            d = ch["points"][-1] - ch["points"][-2]
            d = d / max(np.linalg.norm(d), 1e-9)
            tb.tri(zid, "lk.fitting").tube(np.array([p - d * 0.035, p + d * 0.035]), r * 1.12, 16, tb.fid(f"{eid}#coupling"), caps=True)
        return self.finish(tb)

    def l3_pipe(self, ch: Json, eid: str) -> Tile:
        e = self.edges[eid]
        zid = ch["zone_id"]
        tb = TileBuilder(f"{zid}@L3", zid, 3, "add", {**self.meta, "adds_to": self.part.edge_zone[eid], "edge_id": eid,
                                                     "bore_radius_m": round(e["bore_m"] / 2, 5), "s_lo_m": round(ch["s_lo_m"], 4), "s_hi_m": round(ch["s_hi_m"], 4)})
        pts = _resample(ch["points"], 0.5)
        tb.tri(zid, "lk.pipe.bore").tube(pts, e["bore_m"] / 2, 24, tb.fid(f"{eid}#bore"), inward=True, s_start=ch["s_lo_m"], s_scale=ch["s_scale"])
        return self.finish(tb)

    def l2_service(self, zid: str) -> Tile:
        z = self.part.zones[zid]
        a = self.assets[z.meta["asset_id"]]
        tb = TileBuilder(f"{zid}@L2", zid, 2, "add", {**self.meta, "adds_to": z.parent})
        sx, sy, sz = a["service_xyz_m"]
        f = tb.fid(a["id"] + "#service_pad")
        tb.tri(zid, "lk.corridor").cylinder((sx, 0.015, sz), 0.55, 0.008, 28, f)
        tb.tri(zid, "lk.dock").cylinder((sx, 0.024, sz), 0.40, 0.006, 28, f)
        px, py, pz = a["position_xyz_m"]
        tb.line(zid, "lk.corridor").add(np.array([[sx, 0.03, sz], [px, 0.03, pz]]), None, np.array([[0, 1]]), tb.fid(a["id"] + "#service_leader"))
        return self.finish(tb)

    # ---- orchestration ------------------------------------------------
    def compile_all(self) -> None:
        self.l0()
        for zid, z in self.part.zones.items():
            if z.kind == "row":
                self.l1_row(zid)
            elif z.kind == "road":
                self.l1_road(zid)
            elif z.kind == "cross_aisle":
                self.l1_xa(zid)
            elif z.kind in ("plant", "trunk"):
                self.l1_equipment_zone(zid)
            elif z.kind == "rack":
                self.l2_rack(zid)
            elif z.kind == "service":
                self.l2_service(zid)
        for eid, chunks in sorted(self.part.pipe_chunks.items()):
            for ch in chunks:
                self.l2_pipe(ch, eid)
                self.l3_pipe(ch, eid)

    def entity_of(self, fid: str) -> str:
        base = fid.split("#")[0]
        p = self.part
        if p.entity_kind.get(base) in ("support", "fitting"):
            if base.startswith("sup."):
                return next(s["edge_id"] for s in self.topo["supports"] if s["id"] == base)
            f = next(f for f in self.topo["fittings"] if f["id"] == base)
            return f.get("edge_id") or f["edge_ids"][0]
        return base

    def feature_map(self) -> Json:
        feats = {}
        for fid in sorted(self.features_used):
            ent = self.entity_of(fid)
            feats[fid] = {"entity_id": ent, "kind": self.part.entity_kind.get(ent, "unknown"), "zone_id": self.part.entity_zone.get(ent)}
        ents = {}
        for eid in sorted(self.part.entity_zone):
            ents[eid] = {"kind": self.part.entity_kind[eid], "zone_id": self.part.entity_zone[eid]}
        return {"format": "lk.features.v1", "layout_hash": self.fac["topology_hash"], "topology_version": self.fac.get("topology_version"),
                "rule": "feature_id.split('#')[0] is an entity id except supports/fittings which map to their pipe edge; ids never depend on LOD",
                "features": feats, "entities": ents}


@dataclass
class CompiledFacility:
    manifest: Json
    manifest_bytes: bytes
    manifest_id: str
    blobs: dict[str, tuple[bytes, bytes | None, str]]     # sha256 -> (identity bytes, gzip bytes | None, content-type)
    partition: Partition
    tiles: dict[str, Tile]
    topology_digest: str


def compile_facility(topo: Json) -> CompiledFacility:
    c = Compiler(topo)
    c.compile_all()
    digest = topology_digest(topo)
    fmap = c.feature_map()
    fmap_bytes = canonical_json(fmap)
    fmap_sha = sha256_hex(fmap_bytes)
    blobs: dict[str, tuple[bytes, bytes | None, str]] = {
        fmap_sha: (fmap_bytes, gzip.compress(fmap_bytes, 9, mtime=0), "application/json")}
    tiles_json = []
    for tid in sorted(c.tiles):
        t = c.tiles[tid]
        blobs[t.sha256] = (t.data, t.gz, GLB_TYPE)
        z = c.part.zones[t.zone_id]
        tiles_json.append({
            "tile_id": tid, "zone_id": t.zone_id, "lod": t.lod, "refine": "base" if t.lod == 0 else ("replace_group" if t.lod == 1 else "add"),
            "sha256": t.sha256, "url": f"/assets/sha256/{t.sha256}", "content_type": GLB_TYPE, "bytes": t.stats["bytes"], "bytes_gzip": t.stats["bytes_gzip"],
            "triangles": t.stats["triangles"], "line_segments": t.stats["line_segments"], "instances": t.stats["instances"], "vertices": t.stats["vertices"],
            "bounds_min_m": t.bounds_min, "bounds_max_m": t.bounds_max, "geometric_error_m": GEOMETRIC_ERROR_M[t.lod],
            "parent_zone": z.parent})
    lods_present = sorted({t.lod for t in c.tiles.values()})
    levels = []
    for lod in range(4):
        name, desc = LEVEL_INFO[lod]
        n = sum(1 for t in c.tiles.values() if t.lod == lod)
        levels.append({"lod": lod, "name": name, "description": desc, "geometric_error_m": GEOMETRIC_ERROR_M[lod], "available": n > 0, "tiles": n})
    zones_json = []
    for zid, z in c.part.zones.items():
        zj = z.to_json()
        zj["lods"] = {str(t.lod): t.tile_id for t in c.tiles.values() if t.zone_id == zid}
        if z.kind in ("row", "road", "cross_aisle", "plant"):
            zj["l0_group"] = zid           # node group inside SHELL@L0 to hide when this zone's L1 is resident
        if "owner_zone" in z.meta:
            zj["geometry_in_zone"] = z.meta["owner_zone"]
        zones_json.append(zj)
    total = sum(t.stats["bytes"] for t in c.tiles.values())
    total_gz = sum(t.stats["bytes_gzip"] for t in c.tiles.values())
    l0 = c.tiles["SHELL@L0"]
    body: Json = {
        "manifest_version": MANIFEST_VERSION, "compiler": COMPILER_VERSION, "tile_format": TILE_FORMAT,
        "facility_id": c.fac["id"], "layout_version": c.fac.get("layout_version"), "layout_hash": c.fac["topology_hash"],
        "topology_version": c.fac.get("topology_version"), "topology_revision": c.fac["topology_hash"], "topology_digest": digest,
        "cache_key": f"{c.fac['topology_hash']}/{digest[:16]}/{MANIFEST_VERSION}",
        "frame": {"name": "facility_world", "units": "m", "axes": "x east, y up, z south (right-handed)", "floor_y_m": 0.0},
        "bounds_min_m": c.fac["bounds_min"], "bounds_max_m": c.fac["bounds_max"],
        "asset_url_template": "/assets/sha256/{sha256}",
        "features": {"sha256": fmap_sha, "url": f"/assets/sha256/{fmap_sha}", "content_type": "application/json", "bytes": len(fmap_bytes),
                     "bytes_gzip": len(blobs[fmap_sha][1]), "count": len(fmap["features"])},
        "levels": levels,
        "omitted": [] if 3 in lods_present else [{"lod": 3, "reason": "no data-derived contact geometry"}],
        "refinement": {"0": "base, always resident; one node group per zone", "1": "replace_group: hide SHELL@L0 node group `zone.l0_group` when the zone's L1 is resident",
                       "2": "add (never duplicates L0/L1 surfaces)", "3": "add (inward bore surface)"},
        "limits": {"lod0_bytes": l0.stats["bytes"], "lod0_bytes_gzip": l0.stats["bytes_gzip"], "lod0_budget_bytes_gzip": 3_000_000,
                   "total_bytes": total, "total_bytes_gzip": total_gz, "tiles": len(tiles_json), "zones": len(zones_json)},
        "compression": {"identity_sha256": True, "gzip": True, "brotli": False, "meshopt": False,
                        "note": "hash = sha256 of the identity GLB bytes; gzip served via Content-Encoding when accepted (deterministic mtime=0)"},
        "dynamic_layers": {"robots": {"stream_event": "robot.pose", "note": "robots are not baked into tiles; place from stream/world.robots"}},
        "zones": zones_json, "tiles": tiles_json,
    }
    manifest_id = sha256_hex(canonical_json(body))
    manifest = {**body, "manifest_id": manifest_id}
    return CompiledFacility(manifest, canonical_json(manifest), manifest_id, blobs, c.part, c.tiles, digest)


def validate_tile(data: bytes) -> Json:
    """Structural self-check used by tests: indices in range, normals unit length, bounds contain positions."""
    doc, binary = parse_glb(data)
    from .glb import read_accessor
    problems = []
    for mi, m in enumerate(doc["meshes"]):
        for p in m["primitives"]:
            pos = read_accessor(doc, binary, p["attributes"]["POSITION"])
            idx = read_accessor(doc, binary, p["indices"])
            if len(idx) and int(idx.max()) >= len(pos):
                problems.append(f"mesh {mi}: index out of range")
            if p.get("mode", 4) == 4 and len(idx) % 3:
                problems.append(f"mesh {mi}: index count not multiple of 3")
            if "NORMAL" in p["attributes"]:
                n = read_accessor(doc, binary, p["attributes"]["NORMAL"])
                ln = np.linalg.norm(n, axis=1)
                if len(n) and (np.abs(ln - 1) > 1e-3).any():
                    problems.append(f"mesh {mi}: non-unit normals")
            acc = doc["accessors"][p["attributes"]["POSITION"]]
            if len(pos) and (pos.min(axis=0) < np.array(acc["min"]) - 1e-4).any():
                problems.append(f"mesh {mi}: min bounds wrong")
    return {"problems": problems, "doc": doc}
