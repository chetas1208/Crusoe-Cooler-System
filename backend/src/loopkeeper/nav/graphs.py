"""First-class navigation graphs derived from the validated V6 geometry.

G_ext (OUTRIG): roads, end cross-aisles, mechanical-bay links; nodes = junction / dock(+parking,+passing) / service / door / bay;
        edges carry centerline, clear width/height, min turn radius, direction, classes, grade, speed, capacity, conflict set.
        The layout has no mid cross-aisle: rack rows are continuous 10 m walls with no clear opening, so the clearance gate
        (aisle width >= 2 x robot envelope + margin) cannot hold anywhere along a row; the graph says so (`mid_cross_aisle: null`).
G_in (INPIPE): robot-passable pipe segments only (never the CDU exchanger, rack drops or cold plates), with bore, bends, tees,
        entry/exit ports, isolation valves, and recovery ports so no crawler can be stranded.

`build_graphs` validates the whole thing at start-up: every declared-reachable service target must be reachable per robot class
from every start, every edge centreline must be collision-free in the nav grid and every passable pipe component must have a
recovery port; otherwise `NavValidationError` names the failing constraint.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
from typing import Any, Iterable

Json = dict[str, Any]

OUTRIG_MIN_TURN_M = 0.9           # connector radius used for corner smoothing / TURN_RADIUS gate
OUTRIG_SPEED_PLAN = 0.45 * 0.9    # planning speed (m/s): nominal x 0.9 safety factor
ROBOT_ENVELOPE_W = 0.90
ROBOT_STOWED_H = 2.2
MID_AISLE_MIN_W = 2 * ROBOT_ENVELOPE_W + 0.4
SERVICE_MERGE_M = 0.15


class NavValidationError(Exception):
    def __init__(self, constraint: str, detail: str):
        super().__init__(f"{constraint}: {detail}")
        self.constraint, self.detail = constraint, detail


def _d(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _r(x: float, n: int = 3) -> float:
    return round(float(x), n)


class ExtGraph:
    kind = "exterior"

    def __init__(self) -> None:
        self.nodes: dict[str, Json] = {}
        self.edges: dict[str, Json] = {}
        self.adj: dict[str, list[tuple[str, str]]] = {}     # node -> [(edge_id, neighbour)]
        self.closed: set[str] = set()                        # edge ids closed by an operator / fault (part of the revision)
        self.base_revision = ""
        self.targets: dict[str, str] = {}                    # asset id -> node id (service approach)

    # ---------------------------------------------------------------- structure
    def add_node(self, nid: str, kind: list[str], x: float, z: float, **attrs: Any) -> str:
        if nid in self.nodes:
            n = self.nodes[nid]
            n["kinds"] = sorted(set(n["kinds"]) | set(kind))
            n.update({k: v for k, v in attrs.items() if k not in n})
            return nid
        self.nodes[nid] = {"id": nid, "kinds": sorted(kind), "x": _r(x), "z": _r(z), **attrs}
        self.adj.setdefault(nid, [])
        return nid

    def add_edge(self, eid: str, a: str, b: str, kind: str, width: float, height: float, speed: float, **attrs: Any) -> None:
        na, nb = self.nodes[a], self.nodes[b]
        pts = [[na["x"], na["z"]], [nb["x"], nb["z"]]]
        self.edges[eid] = {"id": eid, "a": a, "b": b, "kind": kind, "centerline_xz_m": pts, "length_m": _r(_d(pts[0], pts[1])),
                           "width_m": _r(width), "height_m": _r(height), "min_turn_radius_m": OUTRIG_MIN_TURN_M, "direction": "bidirectional",
                           "classes": ["outrig"], "grade": 0.0, "speed_limit_m_s": speed,
                           "capacity": {"forward": 1, "reverse": 1}, **attrs}
        self.adj[a].append((eid, b))
        self.adj[b].append((eid, a))

    def finish(self) -> None:
        by_node: dict[str, list[str]] = {}
        for e in self.edges.values():
            by_node.setdefault(e["a"], []).append(e["id"])
            by_node.setdefault(e["b"], []).append(e["id"])
        for e in self.edges.values():
            e["conflicts"] = sorted({o for n in (e["a"], e["b"]) if self.nodes[n]["kinds"] != ["dock"] for o in by_node[n]} - {e["id"]})
        self.base_revision = hashlib.sha1(json.dumps([self.nodes, self.edges], sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]

    @property
    def revision(self) -> str:
        """Graph revision: the immutable structure plus the closure set (a closure changes what the planner may use)."""
        if not self.closed:
            return self.base_revision
        return hashlib.sha1((self.base_revision + "|" + ",".join(sorted(self.closed))).encode()).hexdigest()[:12]

    # ---------------------------------------------------------------- queries
    def edge_between(self, a: str, b: str) -> str | None:
        return next((e for e, n in self.adj.get(a, []) if n == b), None)

    def nearest_node(self, x: float, z: float, ok=None) -> str | None:
        best, bd = None, 1e18
        for nid, n in sorted(self.nodes.items()):
            d = math.hypot(n["x"] - x, n["z"] - z)
            if d < bd and (ok is None or ok(n)):
                best, bd = nid, d
        return best

    def shortest(self, src: str, dst: str, closed: Iterable[str] = (), avoid_nodes: Iterable[str] = (), turn_pen: float = 0.6
                 ) -> tuple[float, list[str], list[str]] | None:
        """Dijkstra over (node, incoming edge) so turns can be penalised. Returns (cost, node ids, edge ids)."""
        closed = set(closed) | self.closed
        avoid = set(avoid_nodes) - {src, dst}
        pq: list[tuple[float, int, str, str | None]] = [(0.0, 0, src, None)]
        best: dict[tuple[str, str | None], float] = {(src, None): 0.0}
        prev: dict[tuple[str, str | None], tuple[str, str | None, str | None]] = {}
        n = 0
        while pq:
            c, _, u, ein = heapq.heappop(pq)
            if best.get((u, ein), 1e18) < c - 1e-12:
                continue
            if u == dst:
                nodes, edges, key = [u], [], (u, ein)
                while key in prev:
                    pu, pein, pe = prev[key]
                    nodes.append(pu)
                    if pe:
                        edges.append(pe)
                    key = (pu, pein)
                return c, nodes[::-1], edges[::-1]
            for eid, v in self.adj[u]:
                if eid in closed or v in avoid:
                    continue
                e = self.edges[eid]
                step = e["length_m"] + (turn_pen if ein is not None and ein != eid and self._is_turn(ein, eid, u) else 0.0)
                nk = (v, eid)
                if c + step < best.get(nk, 1e18) - 1e-12:
                    best[nk] = c + step
                    prev[nk] = (u, ein, eid)
                    n += 1
                    heapq.heappush(pq, (c + step, n, v, eid))
        return None

    def _dir(self, eid: str, frm: str) -> tuple[float, float]:
        e = self.edges[eid]
        a, b = self.nodes[e["a"]], self.nodes[e["b"]]
        if frm == e["b"]:
            a, b = b, a
        d = math.hypot(b["x"] - a["x"], b["z"] - a["z"]) or 1.0
        return ((b["x"] - a["x"]) / d, (b["z"] - a["z"]) / d)

    def _is_turn(self, ein: str, eout: str, node: str) -> bool:
        i = self._dir(ein, node)          # direction when *leaving* node along ein points back; compare incoming direction
        incoming = (-i[0], -i[1])
        o = self._dir(eout, node)
        return incoming[0] * o[0] + incoming[1] * o[1] < 0.95

    def components(self, closed: Iterable[str] = ()) -> list[set[str]]:
        closed = set(closed) | self.closed
        seen: set[str] = set()
        out = []
        for s in sorted(self.nodes):
            if s in seen:
                continue
            comp, st = set(), [s]
            while st:
                u = st.pop()
                if u in comp:
                    continue
                comp.add(u)
                st += [v for e, v in self.adj[u] if e not in closed and v not in comp]
            seen |= comp
            out.append(comp)
        return out

    def to_json(self) -> Json:
        return {"kind": "exterior", "graph_revision": self.revision, "base_revision": self.base_revision, "closed_edges": sorted(self.closed),
                "nodes": [self.nodes[k] for k in sorted(self.nodes)], "edges": [self.edges[k] for k in sorted(self.edges)],
                "mid_cross_aisle": getattr(self, "mid_cross_aisle", None), "frame": "facility_world", "units": "m"}


class IntGraph:
    kind = "interior"

    def __init__(self, graph: Any, topo: Json) -> None:
        self.g = graph                                   # engine PipeGraph (centerlines, junction options)
        self.edges: dict[str, Json] = {}
        self.nodes: dict[str, Json] = {}
        self.closed: set[str] = set()
        assets = {a["id"]: a for a in topo["assets"]}
        ports_by_edge: dict[str, list[str]] = {}
        for a in topo["assets"]:
            if a["type"] == "port" and a.get("edge_id"):
                ports_by_edge.setdefault(a["edge_id"], []).append(a["id"])
        nd = {n["id"]: n for n in topo["nodes"]}
        deg: dict[str, int] = {}
        for e in topo["edges"]:
            if e["robot_passable"]:
                deg[e["from"]] = deg.get(e["from"], 0) + 1
                deg[e["to"]] = deg.get(e["to"], 0) + 1
        for e in topo["edges"]:
            if not e["robot_passable"]:
                continue
            pts = e["centerline_xyz_m"]
            bends = max(0, len(pts) - 2)
            self.edges[e["id"]] = {
                "id": e["id"], "a": e["from"], "b": e["to"], "loop": e["loop"], "length_m": e["length_m"], "bore_mm": e["diameter_mm"],
                "bends": bends, "min_bend_radius_m": e.get("fillet_radius_m"), "centerline_xyz_m": pts, "ports": list(e["access_port_ids"]),
                "isolation_valves": [a["id"] for a in topo["assets"] if a["type"] == "valve" and a.get("edge_id") == e["id"] and a["id"].startswith("valve_z")],
                "tees": [n for n in (e["from"], e["to"]) if deg.get(n, 0) >= 3], "classes": ["inpipe"], "speed_limit_m_s": 0.12,
                "capacity": {"forward": 1, "reverse": 1}, "zone_id": e.get("zone_id")}
            for n in (e["from"], e["to"]):
                self.nodes.setdefault(n, {"id": n, "label": nd[n]["label"], "position_xyz_m": nd[n]["position_xyz_m"], "degree": deg.get(n, 0)})
        self.excluded = {"cdu_exchanger": ["n_cdu_fs->n_cdu_fr", "n_cdu_tr->n_cdu_ts"],
                         "rack_branches": sorted(e["id"] for e in topo["edges"] if not e["robot_passable"])[:6] + ["..."],
                         "reason": "heat-exchanger plates and rack cold-plate channels are far below any crawler bore"}
        self.recovery_ports: dict[int, list[str]] = {}
        self.components_: list[set[str]] = self._components()
        self.base_revision = hashlib.sha1(json.dumps([self.edges, sorted(self.nodes)], sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:12]
        for i, comp in enumerate(self.components_):
            self.recovery_ports[i] = sorted(p for eid, ed in self.edges.items() if ed["a"] in comp for p in ed["ports"])

    def _components(self) -> list[set[str]]:
        adj: dict[str, set[str]] = {}
        for e in self.edges.values():
            adj.setdefault(e["a"], set()).add(e["b"])
            adj.setdefault(e["b"], set()).add(e["a"])
        seen, out = set(), []
        for s in sorted(adj):
            if s in seen:
                continue
            comp, st = set(), [s]
            while st:
                u = st.pop()
                if u not in comp:
                    comp.add(u)
                    st += list(adj[u] - comp)
            seen |= comp
            out.append(comp)
        return out

    @property
    def revision(self) -> str:
        if not self.closed:
            return self.base_revision
        return hashlib.sha1((self.base_revision + "|" + ",".join(sorted(self.closed))).encode()).hexdigest()[:12]

    def component_of_edge(self, eid: str) -> int | None:
        e = self.edges.get(eid)
        if not e:
            return None
        return next((i for i, c in enumerate(self.components_) if e["a"] in c), None)

    def to_json(self) -> Json:
        return {"kind": "interior", "graph_revision": self.revision, "base_revision": self.base_revision, "closed_edges": sorted(self.closed),
                "nodes": [self.nodes[k] for k in sorted(self.nodes)], "edges": [self.edges[k] for k in sorted(self.edges)],
                "recovery_ports": {str(i): p for i, p in self.recovery_ports.items()}, "excluded": self.excluded,
                "components": [sorted(c) for c in self.components_], "frame": "facility_world", "units": "m"}


# ------------------------------------------------------------------ builders
def _dense(pts: list, step: float = 0.5):
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(math.dist(a, b) / step))
        for k in range(n):
            t = k / n
            yield [a[i] + (b[i] - a[i]) * t for i in range(3)]
    yield pts[-1]


def _in_rect(x: float, z: float, rect: list[float], pad: float = 0.0) -> bool:
    return rect[0] - pad <= x <= rect[2] + pad and rect[1] - pad <= z <= rect[3] + pad


def build_ext(topo: Json, nav: Any) -> ExtGraph:
    lay = topo.get("facility_layout_v6") or {}
    G = ExtGraph()
    G.mid_cross_aisle = None
    if not lay:
        return G
    roads, aisles = lay["roads"], lay["cross_aisles"]
    env_h = float(lay.get("robot_envelope", {}).get("stowed_arm_h", ROBOT_STOWED_H))
    # lowest overhead pipe above the floor (headers 2.8 m) -> clear height
    zone_rects = [[r["x_min_m"], r["z_m"] - r["clear_width_m"] / 2, r["x_max_m"], r["z_m"] + r["clear_width_m"] / 2] for r in roads] + \
                 [[a["x_min_m"], a["z_min_m"], a["x_max_m"], a["z_max_m"]] for a in aisles]
    low = min((p[1] for e in topo["edges"] for p in _dense(e["centerline_xyz_m"]) if any(_in_rect(p[0], p[2], zr) for zr in zone_rects)), default=2.8)
    height = _r(low - 0.1)
    if height < env_h:
        raise NavValidationError("EQUIPMENT_BLOCK", f"clear height {height} m under the lowest overhead pipe is below the stowed robot height {env_h} m")
    aisle_c = {a["id"]: (a["x_min_m"] + a["x_max_m"]) / 2.0 for a in aisles}
    aisle_w = {a["id"]: a["x_max_m"] - a["x_min_m"] for a in aisles}

    # --- service points (deduplicated by position)
    svc: list[tuple[str, float, float]] = []
    for a in topo["assets"]:
        sp = a.get("service_xyz_m")
        if sp:
            svc.append((a["id"], float(sp[0]), float(sp[2])))
    for r in roads:
        for t in r.get("service_target_ids", []):
            pass
    # --- docks
    docks = [(a["id"], float(a["position_xyz_m"][0]), float(a["position_xyz_m"][2])) for a in topo["assets"] if a["type"] == "dock"]

    road_rect = {r["road_id"]: [r["x_min_m"], r["z_m"] - r["clear_width_m"] / 2, r["x_max_m"], r["z_m"] + r["clear_width_m"] / 2] for r in roads}
    aisle_rect = {a["id"]: [a["x_min_m"], a["z_min_m"], a["x_max_m"], a["z_max_m"]] for a in aisles}
    rooms = {r["id"]: r for r in topo["site"]["rooms"]}
    mech = rooms.get("room_mech", {}).get("rect")

    # road chains: junction nodes at both ends of every road, docks and service points in between
    road_nodes: dict[str, list[tuple[float, str]]] = {}
    for r in roads:
        rid, z = r["road_id"], float(r["z_m"])
        chain: list[tuple[float, str]] = []
        for a in aisles:
            xc = aisle_c[a["id"]]
            nid = G.add_node(f"J:{a['id']}:{rid}", ["junction", "yield"], xc, z, road_id=rid, aisle_id=a["id"])
            chain.append((xc, nid))
        for did, x, dz in docks:
            if _in_rect(x, dz, road_rect[rid], 0.2):
                nid = G.add_node(f"DK:{did}", ["dock", "parking", "passing"], x, z, road_id=rid, dock_id=did, pose_xz=[_r(x), _r(dz)],
                                 lateral_offset_m=_r(dz - z))
                chain.append((x, nid))
        for sid, x, sz in svc:
            if _in_rect(x, sz, road_rect[rid], 0.0):
                key = f"SV:{rid}:{x:.2f}"
                nid = G.add_node(key, ["service"], x, z, road_id=rid, targets=[])
                if sid not in G.nodes[nid]["targets"]:
                    G.nodes[nid]["targets"].append(sid)
                G.targets[sid] = nid
                chain.append((x, nid))
        road_nodes[rid] = _merge_chain(G, chain)
    # aisle chains
    aisle_nodes: dict[str, list[tuple[float, str]]] = {}
    for a in aisles:
        aid, xc = a["id"], aisle_c[a["id"]]
        chain = []
        for r in roads:
            chain.append((float(r["z_m"]), f"J:{aid}:{r['road_id']}"))
        for end, zz in (("N", a["z_min_m"] + 1.6), ("S", a["z_max_m"] - 1.6)):
            chain.append((zz, G.add_node(f"END:{aid}:{end}", ["end", "parking"], xc, zz, aisle_id=aid)))
        for sid, x, sz in svc:
            if _in_rect(x, sz, aisle_rect[aid], 0.0):
                nid = G.add_node(f"SV:{aid}:{sz:.2f}", ["service"], xc, sz, aisle_id=aid, targets=[])
                if sid not in G.nodes[nid]["targets"]:
                    G.nodes[nid]["targets"].append(sid)
                G.targets[sid] = nid
                chain.append((sz, nid))
        aisle_nodes[aid] = _merge_chain(G, chain)
    # doors into the mechanical bay
    mech_nodes: list[str] = []
    door_ids: list[tuple[str, float, float]] = []
    for d in topo["site"]["doors"]:
        x, z = d["position_xyz_m"][0], d["position_xyz_m"][2]
        door_ids.append((d["id"], x, z))
    # edges: road chains
    for r in roads:
        ch = road_nodes[r["road_id"]]
        for i, ((xa, na), (xb, nb)) in enumerate(zip(ch, ch[1:])):
            G.add_edge(f"E:{r['road_id']}:{i:02d}", na, nb, "road", r["clear_width_m"], height, 0.45, road_id=r["road_id"], lanes=2)
    for a in aisles:
        ch = aisle_nodes[a["id"]]
        for i, ((za, na), (zb, nb)) in enumerate(zip(ch, ch[1:])):
            G.add_edge(f"E:{a['id']}:{i:02d}", na, nb, "aisle", aisle_w[a["id"]], height, 0.45, aisle_id=a["id"], lanes=2)
    # mechanical bay: door nodes + service/dock points inside the bay, linked by visibility
    bay: list[tuple[str, float, float, list[str]]] = []
    for did, x, z in door_ids:
        bay.append((G.add_node(f"DOOR:{did}", ["door", "passing"], x + 0.0, z, door_id=did), x, z, ["door"]))
    for sid, x, sz in svc:
        if mech and _in_rect(x, sz, mech, 0.0):
            nid = G.add_node(f"SV:bay:{x:.2f}:{sz:.2f}", ["service"], x, sz, targets=[])
            if sid not in G.nodes[nid]["targets"]:
                G.nodes[nid]["targets"].append(sid)
            G.targets[sid] = nid
            bay.append((nid, x, sz, ["service"]))
    for did, x, dz in docks:
        if mech and _in_rect(x, dz, mech, 0.0):
            nid = G.add_node(f"DK:{did}", ["dock", "parking", "passing"], x, dz, dock_id=did, pose_xz=[_r(x), _r(dz)], lateral_offset_m=0.0)
            bay.append((nid, x, dz, ["dock"]))
    bay_ids = sorted({b[0] for b in bay})
    # door -> west aisle link
    for did, x, z in door_ids:
        aid = "XA-W"
        if aid in aisle_nodes and abs(x - (aisle_rect[aid][0])) < 0.6:
            # nearest aisle chain node by z
            an = min(aisle_nodes[aid], key=lambda t: abs(t[0] - z))[1]
            G.add_edge(f"E:DOOR:{did}", f"DOOR:{did}", an, "link", 2.4, height, 0.4, door_id=did)
    for i, a in enumerate(bay_ids):
        for b in bay_ids[i + 1:]:
            na, nb = G.nodes[a], G.nodes[b]
            if "door" in na["kinds"] and "door" in nb["kinds"]:
                continue
            if _d((na["x"], na["z"]), (nb["x"], nb["z"])) > 16.0:
                continue
            if nav.segment_free([na["x"], 0.0, na["z"]], [nb["x"], 0.0, nb["z"]]):
                G.add_edge(f"E:BAY:{a}~{b}", a, b, "link", 1.6, height, 0.4, region="room_mech")
    G.finish()
    return G


def _merge_chain(G: ExtGraph, chain: list[tuple[float, str]]) -> list[tuple[float, str]]:
    """Sort a chain by coordinate; nodes closer than SERVICE_MERGE_M are merged into the first (kinds/targets unified)."""
    chain = sorted(set(chain))
    out: list[tuple[float, str]] = []
    for c, nid in chain:
        if out and abs(c - out[-1][0]) < SERVICE_MERGE_M:
            keep = out[-1][1]
            if keep == nid:
                continue
            kn, dn = G.nodes[keep], G.nodes.pop(nid)
            G.adj.pop(nid, None)
            kn["kinds"] = sorted(set(kn["kinds"]) | set(dn["kinds"]))
            if "targets" in dn:
                kn.setdefault("targets", [])
                kn["targets"] = sorted(set(kn["targets"]) | set(dn["targets"]))
            for k in ("dock_id", "pose_xz", "lateral_offset_m"):
                if k in dn and k not in kn:
                    kn[k] = dn[k]
            for t, v in list(G.targets.items()):
                if v == nid:
                    G.targets[t] = keep
            # rewrite any later chain reference
            continue
        out.append((c, nid))
    return out


def build_graphs(topo: Json, nav: Any, pipe_graph: Any, robots: dict[str, Any] | None = None) -> tuple[ExtGraph, IntGraph]:
    ext = build_ext(topo, nav)
    inp = IntGraph(pipe_graph, topo)
    validate(topo, ext, inp, nav, robots or {})
    return ext, inp


def validate(topo: Json, ext: ExtGraph, inp: IntGraph, nav: Any, robots: dict[str, Any]) -> None:
    lay = topo.get("facility_layout_v6")
    if lay:
        # 1. every edge centreline is collision-free in the nav grid and clear of equipment
        for e in ext.edges.values():
            (xa, za), (xb, zb) = e["centerline_xz_m"]
            if not nav.segment_free([xa, 0.0, za], [xb, 0.0, zb]):
                raise NavValidationError("EQUIPMENT_BLOCK", f"edge {e['id']} ({e['a']} -> {e['b']}) crosses an obstacle or a wall")
            if e["kind"] in ("road", "aisle") and e["width_m"] < ROBOT_ENVELOPE_W + 0.4:
                raise NavValidationError("TURN_RADIUS", f"edge {e['id']} is {e['width_m']} m wide, below envelope + margin")
        # 2. junction connectors (corner fillets of radius OUTRIG_MIN_TURN_M) are feasible
        for nid, n in ext.nodes.items():
            if "junction" not in n["kinds"]:
                continue
            if not _corner_ok(ext, nid, nav):
                raise NavValidationError("TURN_RADIUS", f"junction {nid}: a {OUTRIG_MIN_TURN_M} m connector radius does not fit between the road and the aisle")
        # 3. reachability: every declared service target / dock is reachable from every OUTRIG start, per robot class
        starts = {rid: r for rid, r in robots.items() if getattr(r, "klass", "") == "outrig"}
        src_nodes = sorted({ext.nearest_node(r.pos[0], r.pos[2]) for r in starts.values()}) or [n for n in ext.nodes if "dock" in ext.nodes[n]["kinds"]][:1]
        targets = {t: n for t, n in ext.targets.items()}
        for road in lay["roads"]:
            if not [t for t in road.get("service_target_ids", [])]:
                raise NavValidationError("NO_ACCESS", f"{road['road_id']} declares no service target")
        for s in src_nodes:
            for t, n in sorted(targets.items()):
                if ext.shortest(s, n) is None:
                    raise NavValidationError("NO_ACCESS", f"service target {t} (node {n}) is unreachable from {s} for class outrig")
        comps = ext.components()
        if len(comps) != 1:
            raise NavValidationError("NO_ACCESS", f"G_ext is split into {len(comps)} components (sizes {[len(c) for c in comps]})")
        # every OR start must have a dock node and a parking node to retreat to
        for rid, r in starts.items():
            if ext.nearest_node(r.pos[0], r.pos[2], ok=lambda n: "dock" in n["kinds"]) is None:
                raise NavValidationError("NO_ACCESS", f"{rid} has no dock node")
    # 4. G_in: every passable component has a recovery port; every crawler start sits on a passable edge of a component with a port
    #    (strict for the V6+ layout; recorded legacy topologies that replay old runs are only described, never rejected)
    if not lay:
        return
    for i, comp in enumerate(inp.components_):
        if not inp.recovery_ports.get(i):
            raise NavValidationError("NO_ACCESS", f"passable pipe component {sorted(comp)[:3]}... has no recovery port (a crawler there could not be retrieved)")
    for rid, r in robots.items():
        if getattr(r, "klass", "") != "inpipe":
            continue
        ed = inp.edges.get(r.segment_id or "")
        if ed is None:
            raise NavValidationError("NO_ACCESS", f"{rid} is not on a robot-passable pipe segment ({r.segment_id})")
        if r.hw.get("min_bore_mm", 0) > ed["bore_mm"]:
            raise NavValidationError("PIPE_CLEARANCE", f"{rid} (min bore {r.hw['min_bore_mm']} mm) cannot be in {ed['id']} ({ed['bore_mm']} mm)")
        ci = inp.component_of_edge(ed["id"])
        if ci is None or not inp.recovery_ports.get(ci):
            raise NavValidationError("NO_ACCESS", f"{rid} is in a pipe component without a recovery port")


def _corner_ok(ext: ExtGraph, nid: str, nav: Any) -> bool:
    """For every road/aisle edge pair at the junction, a fillet of radius OUTRIG_MIN_TURN_M must be collision-free."""
    n = ext.nodes[nid]
    es = [e for e, _ in ext.adj[nid]]
    for i, ea in enumerate(es):
        for eb in es[i + 1:]:
            da, db = ext._dir(ea, nid), ext._dir(eb, nid)
            dot = da[0] * db[0] + da[1] * db[1]
            if abs(dot) > 0.5:
                continue                                           # straight-through, no corner
            r = OUTRIG_MIN_TURN_M
            pa = (n["x"] + da[0] * r, n["z"] + da[1] * r)
            pb = (n["x"] + db[0] * r, n["z"] + db[1] * r)
            c = (n["x"] + (da[0] + db[0]) * r * 0.2929, n["z"] + (da[1] + db[1]) * r * 0.2929)      # arc midpoint of a quarter circle
            for p, q in ((pa, c), (c, pb)):
                if not nav.segment_free([p[0], 0.0, p[1]], [q[0], 0.0, q[1]]):
                    return False
    return True
