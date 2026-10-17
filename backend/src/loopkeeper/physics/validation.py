"""Facility topology validation: graph connectivity, cooling-loop closure, FWS/TCS separation, geometry sanity,
robot passability and honest rack capacity. Produces a machine-readable report plus a readable text rendering.

    python -m loopkeeper.physics.validation [--config backend/configs/facility-large.yaml] [--json out.json] [--solve]

The report is also the failing-test contract (tests/physics/test_topology_v2.py): every check must pass, and each
check has a negative test that proves it can fail (missing endpoint, orphan pipe, cross-loop link, ...).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import deque
from typing import Any

from .geometry import build_path, project_to_path, sample_path

Json = dict[str, Any]
TOL_NODE_M = 0.002         # a pipe end must sit on its node within 2 mm
TOL_TAP_M = 0.002          # a rack tap must lie on its header centerline within 2 mm
TOL_ASSET_ON_EDGE_M = 0.005
MIN_CRAWLER_BORE_MM = 80.0
ROBOT_RADIUS_M = 0.55
CLEARANCE_M = 0.05


def _check(cid: str, title: str, problems: list[str], note: str = "", **extra: Any) -> Json:
    return {"id": cid, "title": title, "passed": not problems, "problems": problems[:40], "n_problems": len(problems),
            "note": note, **extra}


def _paths(topo: Json) -> dict[str, Any]:
    return {e["id"]: build_path([tuple(p) for p in e["centerline_xyz_m"]], e["fillet_radius_m"]) for e in topo["edges"]}


def _near_bbox(p: list[float], a: Json, tol: float) -> bool:
    cx, _, cz = a["position_xyz_m"]
    sx, _, sz = a.get("size_m", [0, 0, 0])
    return abs(p[0] - cx) <= sx / 2 + tol and abs(p[2] - cz) <= sz / 2 + tol and -tol <= p[1] <= (a["size_m"][1] if a.get("size_m") else 0) + tol


# ─────────────────────────── graph construction ───────────────────────────
def flow_graph(topo: Json) -> tuple[dict[str, set[str]], dict[str, str]]:
    """Directed node graph per flow direction (edge from->to), with header edges split at their rack taps and the
    declared device links (rack cold plate, CDU secondary/primary, chiller) added. Returns (adjacency, node->loop)."""
    adj: dict[str, set[str]] = {}
    loop_of: dict[str, str] = {n["id"]: n["loop"] for n in topo["nodes"]}

    def add(a: str, b: str) -> None:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set())

    for e in topo["edges"]:
        chain = [e["from"], *[t["node_id"] for t in sorted(e.get("taps", []), key=lambda t: t["s_m"])], e["to"]]
        for a, b in zip(chain, chain[1:]):
            add(a, b)
    for a in topo["assets"]:
        if a["type"] == "rack":
            rid = a["id"][5:]
            add(f"n_{rid}_in", f"n_{rid}_out")                       # cold-plate path inside the rack
    cdu = next((a for a in topo["assets"] if a["type"] == "cdu"), None)
    if cdu:
        add("n_cdu_tr", "n_cdu_ts")                                   # secondary side through pump + HX
        add("n_cdu_fs", "n_cdu_fr")                                   # primary side through the HX
    ch = next((a for a in topo["assets"] if a["type"] == "chiller"), None)
    if ch:
        add("n_fws_chiller_r", "n_fws_chiller_s")                     # plant boundary closes the facility-water circuit
    return adj, loop_of


def _sccs(adj: dict[str, set[str]]) -> list[set[str]]:
    index, low, on, stack, out = {}, {}, set(), [], []
    counter = [0]

    def strong(v: str) -> None:           # iterative Tarjan to stay safe on deep chains
        work = [(v, iter(adj[v]))]
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        while work:
            node, it = work[-1]
            adv = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(adj[w])))
                    adv = True
                    break
                if w in on:
                    low[node] = min(low[node], index[w])
            if adv:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                comp = set()
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.add(w)
                    if w == node:
                        break
                out.append(comp)

    for v in list(adj):
        if v not in index:
            strong(v)
    return out


def _reach(adj: dict[str, set[str]], start: str) -> set[str]:
    seen, q = {start}, deque([start])
    while q:
        for w in adj.get(q.popleft(), ()):
            if w not in seen:
                seen.add(w)
                q.append(w)
    return seen


# ───────────────────────────────── checks ─────────────────────────────────
def check_endpoints(topo: Json) -> Json:
    nodes = {n["id"]: n for n in topo["nodes"]}
    bad: list[str] = []
    for e in topo["edges"]:
        for end, idx in (("from", 0), ("to", -1)):
            n = nodes.get(e[end])
            if n is None:
                bad.append(f"{e['id']}: {end} node '{e[end]}' does not exist")
                continue
            d = math.dist(e["centerline_xyz_m"][idx], n["position_xyz_m"])
            if d > TOL_NODE_M:
                bad.append(f"{e['id']}: centerline {end}-end is {d * 1000:.1f} mm from node {n['id']}")
    return _check("endpoints", "Every pipe end exists as a node and sits on it (<= 2 mm)", bad)


def check_unique_ids(topo: Json) -> Json:
    bad: list[str] = []
    seen: dict[str, str] = {}
    for kind, items in (("node", topo["nodes"]), ("edge", topo["edges"]), ("asset", topo["assets"]),
                        ("context_cabinet", topo.get("context_cabinets", [])), ("door", topo.get("site", {}).get("doors", []))):
        for it in items:
            if it["id"] in seen and seen[it["id"]] != kind:
                bad.append(f"id '{it['id']}' used by {seen[it['id']]} and {kind}")
            elif it["id"] in seen:
                bad.append(f"duplicate {kind} id '{it['id']}'")
            seen[it["id"]] = kind
    return _check("unique_ids", "Entity ids are unique", bad)


def check_loop_separation(topo: Json) -> Json:
    """FWS and TCS never mix: edges connect nodes of their own loop, devices never bridge loops except the CDU/chiller
    links that transfer heat only, and no tap sits on a header of the other loop."""
    nodes = {n["id"]: n for n in topo["nodes"]}
    edges = {e["id"]: e for e in topo["edges"]}
    bad: list[str] = []
    for e in topo["edges"]:
        for end in ("from", "to"):
            n = nodes.get(e[end])
            if n and n["loop"] != e["loop"]:
                bad.append(f"{e['id']} ({e['loop']}) connects to {n['id']} ({n['loop']})")
        for t in e.get("taps", []):
            n = nodes.get(t["node_id"])
            d = edges.get(t["drop_edge_id"])
            if n and (n["loop"] != e["loop"] or (d and d["loop"] != e["loop"])):
                bad.append(f"tap {t['node_id']} bridges loops on {e['id']}")
    for a in topo["assets"]:
        if a.get("edge_id") and a.get("loop") and a["edge_id"] in edges and a["loop"] != edges[a["edge_id"]]["loop"]:
            bad.append(f"asset {a['id']} ({a['loop']}) is mounted on {a['edge_id']} ({edges[a['edge_id']]['loop']})")
    adj, loop_of = flow_graph(topo)
    # pipe-only undirected components must be single-loop
    und: dict[str, set[str]] = {}
    for e in topo["edges"]:
        und.setdefault(e["from"], set()).add(e["to"])
        und.setdefault(e["to"], set()).add(e["from"])
    seen: set[str] = set()
    for s in und:
        if s in seen:
            continue
        comp = _reach(und, s)
        seen |= comp
        loops = {loop_of[n] for n in comp if n in loop_of}
        if len(loops) > 1:
            bad.append(f"pipe component {sorted(comp)[:4]}... mixes loops {sorted(loops)}")
    return _check("loop_separation", "FWS and TCS are separate mass circuits (heat crosses only inside the CDU)", bad)


def check_no_orphans(topo: Json) -> Json:
    """A pipe end must meet another pipe, a rack tap, or a declared boundary (rack coolant in/out, CDU port, plant boundary)."""
    deg: dict[str, int] = {}
    for e in topo["edges"]:
        for end in ("from", "to"):
            deg[e[end]] = deg.get(e[end], 0) + 1
        for t in e.get("taps", []):
            deg[t["node_id"]] = deg.get(t["node_id"], 0) + 1
    bad: list[str] = []
    nodes = {n["id"]: n for n in topo["nodes"]}
    boundary_assets = [a for a in topo["assets"] if a["type"] in ("rack", "cdu", "chiller")]
    for nid, d in deg.items():
        if d >= 2:
            continue
        n = nodes.get(nid)
        if n is None:
            bad.append(f"dangling end at unknown node {nid}")
            continue
        if n.get("terminal") == "capped_header_end":
            # a capped header end is only valid if it sits right at the last rack tap of that header
            e = next(e for e in topo["edges"] if nid in (e["from"], e["to"]))
            ts = e.get("taps", [])
            paths = _paths(topo)
            L = paths[e["id"]].length
            end_s = L if e["to"] == nid else 0.0
            if not ts or min(abs(t["s_m"] - end_s) for t in ts) > 1.0:
                bad.append(f"capped end {nid} is more than 1 m beyond the last rack tap")
            continue
        host = next((a for a in boundary_assets if _near_bbox(n["position_xyz_m"], a, 0.35)), None)
        if host is None:
            bad.append(f"orphan pipe end at {nid} {n['position_xyz_m']}: not at a rack, CDU or plant boundary")
    for n in topo["nodes"]:
        if n["id"] not in deg:
            bad.append(f"node {n['id']} has no pipe")
    return _check("no_orphans", "No orphaned pipe ends: every end is a junction, rack tap or declared boundary", bad)


def check_loops_closed(topo: Json) -> Json:
    adj, loop_of = flow_graph(topo)
    comps = _sccs(adj)
    bad: list[str] = []
    for loop in ("fws", "tcs"):
        terminals = {n["id"] for n in topo["nodes"] if n.get("terminal")}
        want = {n for n, l in loop_of.items() if l == loop} - terminals     # capped header ends are valid dead ends
        main = max((c for c in comps if c & want), key=len, default=set())
        missing = want - main
        if missing:
            bad.append(f"{loop}: nodes outside the closed circuit: {sorted(missing)[:8]}")
    return _check("loops_closed", "FWS and TCS each form one closed circulation loop (CDU/plant links included)", bad)


def check_rack_branches(topo: Json) -> Json:
    adj, _ = flow_graph(topo)
    edges = {e["id"]: e for e in topo["edges"]}
    fwd = _reach(adj, "n_cdu_ts")
    rev: dict[str, set[str]] = {}
    for a, bs in adj.items():
        for b in bs:
            rev.setdefault(b, set()).add(a)
    back = _reach(rev, "n_cdu_tr")
    bad: list[str] = []
    tap_by_node = {t["node_id"]: (e["id"], t) for e in topo["edges"] for t in e.get("taps", [])}
    for a in topo["assets"]:
        if a["type"] != "rack":
            continue
        rid = a["id"][5:]
        sdrop = next((e for e in topo["edges"] if e["to"] == f"n_{rid}_in"), None)
        rdrop = next((e for e in topo["edges"] if e["from"] == f"n_{rid}_out"), None)
        if sdrop is None or rdrop is None:
            bad.append(f"{a['id']}: missing {'supply' if sdrop is None else 'return'} drop")
            continue
        if sdrop["from"] not in tap_by_node:
            bad.append(f"{a['id']}: supply drop {sdrop['id']} is not tapped into a header")
        if rdrop["to"] not in tap_by_node:
            bad.append(f"{a['id']}: return drop {rdrop['id']} is not tapped into a header")
        if f"n_{rid}_in" not in fwd:
            bad.append(f"{a['id']}: not reachable from CDU secondary out")
        if f"n_{rid}_out" not in back:
            bad.append(f"{a['id']}: cannot return to CDU secondary in")
        if sdrop["loop"] != "tcs" or rdrop["loop"] != "tcs":
            bad.append(f"{a['id']}: branch not on the TCS loop")
        if a.get("zone_id") and edges[tap_by_node[sdrop["from"]][0]].get("zone_id") != a["zone_id"]:
            bad.append(f"{a['id']}: tapped into another zone's supply header")
    return _check("rack_branches", "Every solver-backed rack has supply and return via the CDU secondary loop", bad)


def check_taps(topo: Json) -> Json:
    paths = _paths(topo)
    nodes = {n["id"]: n for n in topo["nodes"]}
    bad: list[str] = []
    for e in topo["edges"]:
        for t in e.get("taps", []):
            n = nodes.get(t["node_id"])
            if n is None:
                bad.append(f"{e['id']}: tap node {t['node_id']} missing")
                continue
            s, d = project_to_path(paths[e["id"]], tuple(n["position_xyz_m"]))
            if d > TOL_TAP_M:
                bad.append(f"{t['node_id']} is {d * 1000:.1f} mm off header {e['id']} (visually connected, graph-disconnected)")
            if not 0.0 < s < paths[e["id"]].length:
                bad.append(f"{t['node_id']} projects outside header {e['id']}")
    return _check("taps_on_headers", "Rack taps lie on their header centerline", bad)


def check_assets_on_edges(topo: Json) -> Json:
    paths = _paths(topo)
    edges = {e["id"]: e for e in topo["edges"]}
    bad: list[str] = []
    for a in topo["assets"]:
        eid = a.get("edge_id")
        if not eid:
            continue
        e = edges.get(eid)
        if e is None:
            bad.append(f"{a['id']}: edge {eid} does not exist")
            continue
        if a["type"] == "pump":
            # floor-mounted: must stand within 3 m (plan view) of the pipe it feeds
            _, d = project_to_path(paths[eid], (a["position_xyz_m"][0], 0.9, a["position_xyz_m"][2]))
            if d > 3.0:
                bad.append(f"{a['id']}: {d:.1f} m from its pipe {eid}")
            continue
        if a.get("s_m") is not None and not 0.0 <= a["s_m"] <= paths[eid].length:
            bad.append(f"{a['id']}: s={a['s_m']} outside {eid} (0..{paths[eid].length:.2f})")
        _, d = project_to_path(paths[eid], tuple(a["position_xyz_m"]))
        if d > TOL_ASSET_ON_EDGE_M:
            bad.append(f"{a['id']}: {d * 1000:.1f} mm off its pipe {eid}")
    return _check("assets_on_edges", "Edge-mounted assets (valves, strainers, meters, ports) lie on their pipe", bad)


def check_ports(topo: Json) -> Json:
    edges = {e["id"]: e for e in topo["edges"]}
    bad: list[str] = []
    ports = [a for a in topo["assets"] if a["type"] == "port"]
    for p in ports:
        e = edges.get(p.get("edge_id", ""))
        if e is None or not e["robot_passable"]:
            bad.append(f"{p['id']}: not on a robot-passable edge")
        elif e["diameter_mm"] < MIN_CRAWLER_BORE_MM:
            bad.append(f"{p['id']}: bore {e['diameter_mm']} mm below crawler minimum")
        elif p["id"] not in e["access_port_ids"]:
            bad.append(f"{p['id']}: edge {e['id']} does not list it in access_port_ids")
    for e in topo["edges"]:
        for pid in e["access_port_ids"]:
            if not any(p["id"] == pid for p in ports):
                bad.append(f"{e['id']}: lists unknown port {pid}")
    return _check("ports", "Crawler ports sit on passable pipes of sufficient bore", bad, n_ports=len(ports))


def check_passable_components(topo: Json) -> Json:
    """Every robot-passable connected run needs a launch port (otherwise no crawler can ever reach it)."""
    pe = [e for e in topo["edges"] if e["robot_passable"]]
    und: dict[str, set[str]] = {}
    for e in pe:
        und.setdefault(e["from"], set()).add(e["to"])
        und.setdefault(e["to"], set()).add(e["from"])
    comps, seen = [], set()
    for n in und:
        if n in seen:
            continue
        c = _reach(und, n)
        seen |= c
        comps.append(c)
    bad: list[str] = []
    info = []
    for c in comps:
        es = sorted(e["id"] for e in pe if e["from"] in c)
        ports = sorted(p for e in pe if e["from"] in c for p in e["access_port_ids"])
        info.append({"edges": es, "ports": ports})
        if not ports:
            bad.append(f"passable run {es} has no launch port")
    for e in topo["edges"]:
        if e["robot_passable"] and e["diameter_mm"] < MIN_CRAWLER_BORE_MM:
            bad.append(f"{e['id']} marked passable at {e['diameter_mm']} mm")
        if not e["robot_passable"] and e["diameter_mm"] >= 100:
            bad.append(f"{e['id']} large bore but not passable")
    return _check("passable_components", "Every robot-passable run is launchable; small bores are never passable", bad, components=info)


def _rect_overlap(a: list[float], b: list[float], tol: float = 0.0) -> bool:
    return a[0] < b[2] - tol and b[0] < a[2] - tol and a[1] < b[3] - tol and b[1] < a[3] - tol


def check_geometry(topo: Json) -> Json:
    """Containment, cabinet/equipment collisions, pipes vs racks/walls/doors, pipe-pipe clearance."""
    bad: list[str] = []
    fac = topo["facility"]
    x0, z0, x1, z1 = fac["interior_min"][0], fac["interior_min"][2], fac["interior_max"][0], fac["interior_max"][2]
    site = topo.get("site", {})
    rack_h = next((a["size_m"][1] for a in topo["assets"] if a["type"] == "rack"), 2.3)

    def foot(it: Json) -> list[float]:
        p, s = it["position_xyz_m"], it["size_m"]
        return [p[0] - s[0] / 2, p[2] - s[2] / 2, p[0] + s[0] / 2, p[2] + s[2] / 2]

    bodies = [(a["id"], foot(a)) for a in topo["assets"] if a["type"] in ("rack", "cdu") or a["id"].startswith("dock")]
    bodies += [(c["id"], foot(c)) for c in topo.get("context_cabinets", [])]
    bodies += [(c["id"], foot(c)) for c in topo.get("context_equipment", [])]
    for bid, r in bodies:
        if r[0] < x0 or r[1] < z0 or r[2] > x1 or r[3] > z1:
            if not bid.startswith("chiller"):
                bad.append(f"{bid} outside the interior")
    # cabinets/racks must not collide with each other, equipment, walls
    solid = [(i, r) for i, r in bodies if not i.startswith("dock")]
    for i in range(len(solid)):
        for j in range(i + 1, len(solid)):
            if _rect_overlap(solid[i][1], solid[j][1], 0.001):
                bad.append(f"{solid[i][0]} overlaps {solid[j][0]}")
    wall_rects = [(w["id"], r) for w in site.get("walls", []) if not w["exterior"] for r in w["rect_segments"]]
    for bid, r in bodies:
        for wid, wr in wall_rects:
            if _rect_overlap(r, wr, 0.001):
                bad.append(f"{bid} intersects wall {wid}")
    for it in topo["nav"]["obstacles"]:
        if it["id"].startswith("obs_wall"):
            continue
        for d in (a for a in topo["assets"] if a["id"].startswith("dock")):
            if _rect_overlap(foot(d), it["rect"], 0.001):
                bad.append(f"dock {d['id']} sits inside obstacle {it['id']}")
    # rooms: every cabinet/rack/equipment/dock/port lies inside a room (hall, mech, cdu, corridor)
    rooms = site.get("rooms", [])
    if rooms:
        for it in [*topo["assets"], *topo.get("context_cabinets", []), *topo.get("context_equipment", [])]:
            if it["type"] in ("rack", "cabinet", "equipment", "dock", "cdu", "pump", "chiller") and not it.get("room_id") and \
                    not (it["type"] == "chiller"):
                from .topology import _room_of
                p = it["position_xyz_m"]
                if _room_of(rooms, p[0], p[2]) is None:
                    bad.append(f"{it['id']} is not inside any room")
    # pipes vs racks / cabinets / equipment (plan overlap AND below the body height) and vs walls/doors
    paths = _paths(topo)
    doors = site.get("doors", [])
    door_h = doors[0]["height_m"] if doors else 2.4
    bodies3 = [(i, r, rack_h) for i, r in bodies if not i.startswith("dock")]
    heights = {c["id"]: c["size_m"][1] for c in topo.get("context_equipment", [])}
    for e in topo["edges"]:
        if e["id"].startswith("p_") and e["role"] in ("supply", "return") and not e["robot_passable"]:
            continue      # rack drops terminate on the rack top by construction
        pts = []
        p = paths[e["id"]]
        n = max(int(p.length / 0.1), 2)
        for k in range(n + 1):
            pts.append(sample_path(p, p.length * k / n))
        rad = e["diameter_mm"] / 2000.0 * 1.1
        for bid, r, h in bodies3:
            h = heights.get(bid, h)
            for q in pts:
                if r[0] + 0.01 < q[0] < r[2] - 0.01 and r[1] + 0.01 < q[2] < r[3] - 0.01 and q[1] - rad < h - 0.01:
                    bad.append(f"{e['id']} passes through {bid} at {[round(c, 2) for c in q]}")
                    break
        for w in site.get("doors", []):
            for q in pts:
                along = q[0] if w["axis"] == "x" else q[2]
                cross = q[2] if w["axis"] == "x" else q[0]
                if w["from"] <= along <= w["to"] and abs(cross - w["at"]) < 0.2 and q[1] - rad < door_h:
                    bad.append(f"{e['id']} blocks door {w['id']} (pipe below door height)")
                    break
    # pipe-pipe clearance between non-neighbouring edges
    samples: dict[str, list[tuple[float, float, float]]] = {}
    for e in topo["edges"]:
        p = paths[e["id"]]
        n = max(int(p.length / 0.25), 2)
        samples[e["id"]] = [sample_path(p, p.length * k / n) for k in range(n + 1)]
    ids = [e["id"] for e in topo["edges"] if e["robot_passable"]]
    radius = {e["id"]: e["diameter_mm"] / 2000.0 for e in topo["edges"]}
    nbrs = {e["id"]: set(e.get("schematic_neighbors", [])) for e in topo["edges"]}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            if b in nbrs[a]:
                continue
            need = radius[a] + radius[b] + CLEARANCE_M
            m = min(math.dist(p, q) for p in samples[a][::2] for q in samples[b][::2])
            if m < need:
                bad.append(f"{a} and {b} are only {m * 1000:.0f} mm apart (need {need * 1000:.0f} mm)")
    # wall penetrations declared + only at sleeves
    pens = site.get("penetrations", [])
    for pn in pens:
        if not pn.get("sleeve"):
            bad.append(f"{pn['id']}: wall crossing without a sleeve")
    return _check("geometry", "Structure and pipe geometry is collision-free, contained and penetrations are sleeved", bad,
                  n_penetrations=len(pens))


def _free_grid(topo: Json, cell: float = 0.25):
    import numpy as np
    fac = topo["facility"]
    x0, z0 = fac["interior_min"][0], fac["interior_min"][2]
    x1, z1 = fac["interior_max"][0], fac["interior_max"][2]
    w, h = math.ceil((x1 - x0) / cell), math.ceil((z1 - z0) / cell)
    xs = x0 + (np.arange(w) + 0.5) * cell
    zs = z0 + (np.arange(h) + 0.5) * cell
    blocked = np.zeros((h, w), dtype=bool)
    blocked |= (xs[None, :] < x0 + ROBOT_RADIUS_M) | (xs[None, :] > x1 - ROBOT_RADIUS_M)
    blocked |= (zs[:, None] < z0 + ROBOT_RADIUS_M) | (zs[:, None] > z1 - ROBOT_RADIUS_M)
    for o in topo["nav"]["obstacles"]:
        a, b, c, d = o["rect"]
        blocked |= ((xs[None, :] > a - ROBOT_RADIUS_M) & (xs[None, :] < c + ROBOT_RADIUS_M)
                    & (zs[:, None] > b - ROBOT_RADIUS_M) & (zs[:, None] < d + ROBOT_RADIUS_M))
    return blocked, x0, z0, cell


def check_nav_reachability(topo: Json) -> Json:
    """Every dock, OUTRIG service pose and port-adjacent floor point is in free space and connected to dock 1."""
    blocked, x0, z0, cell = _free_grid(topo)
    h, w = blocked.shape

    def idx(p: list[float]) -> tuple[int, int]:
        return (min(max(int((p[2] - z0) // cell), 0), h - 1), min(max(int((p[0] - x0) // cell), 0), w - 1))

    docks = [a for a in topo["assets"] if a["type"] == "dock"]
    bad: list[str] = []
    if not docks:
        return _check("nav_reachability", "OUTRIG floor navigation", ["no docks"])
    start = idx(docks[0]["position_xyz_m"])
    if blocked[start]:
        bad.append(f"{docks[0]['id']} is in blocked space")
    seen = {start}
    q = deque([start])
    while q:
        r, c = q.popleft()
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if not dr and not dc:
                    continue
                rr, cc = r + dr, c + dc
                if 0 <= rr < h and 0 <= cc < w and (rr, cc) not in seen and not blocked[rr, cc]:
                    if dr and dc and (blocked[r + dr, c] or blocked[r, c + dc]):
                        continue
                    seen.add((rr, cc))
                    q.append((rr, cc))
    targets = [(d["id"], d["position_xyz_m"]) for d in docks]
    targets += [(a["id"], a["service_xyz_m"]) for a in topo["assets"] if a.get("service_xyz_m")]
    for name, p in targets:
        i = idx(p)
        if blocked[i]:
            bad.append(f"{name}: floor pose {p} is blocked (inside a robot-inflated obstacle)")
        elif i not in seen:
            bad.append(f"{name}: floor pose {p} unreachable from {docks[0]['id']}")
    return _check("nav_reachability", "Every OUTRIG dock and service pose is free floor and reachable", bad, n_targets=len(targets),
                  free_cells=int((~blocked).sum()), reachable_cells=len(seen))


def check_capacity(topo: Json) -> Json:
    bad: list[str] = []
    racks = [a for a in topo["assets"] if a["type"] == "rack"]
    ctx = topo.get("context_cabinets", [])
    ids = {a["id"] for a in topo["assets"]}
    for c in ctx:
        if c.get("fidelity") != "architectural_context" or c.get("solver_backed") is not False:
            bad.append(f"{c['id']}: not flagged architectural_context")
        if c.get("edge_id") or c["id"] in ids or c.get("telemetry") != "none":
            bad.append(f"{c['id']}: context cabinet must have no telemetry/pipe/asset identity")
    for r in racks:
        if not r.get("solver_backed"):
            bad.append(f"{r['id']}: solver rack not flagged solver_backed")
    cap = topo.get("capacity", {})
    if cap and (cap.get("solver_backed_racks") != len(racks) or cap.get("architectural_context_cabinets") != len(ctx)):
        bad.append("capacity summary disagrees with entities")
    # no two cabinets/racks on the same slot
    seen: dict[tuple[float, float], str] = {}
    for it in [*racks, *ctx]:
        key = (round(it["position_xyz_m"][0], 2), round(it["position_xyz_m"][2], 2))
        if key in seen:
            bad.append(f"{it['id']} duplicates the slot of {seen[key]}")
        seen[key] = it["id"]
    return _check("capacity_honesty", "Solver-backed racks vs architectural-context cabinets are explicit and disjoint", bad,
                  solver_backed=len(racks), context=len(ctx))


def check_cdu_boundary(topo: Json) -> Json:
    cdu = next((a for a in topo["assets"] if a["type"] == "cdu"), None)
    nodes = {n["id"]: n for n in topo["nodes"]}
    bad: list[str] = []
    if cdu is None:
        return _check("cdu_boundary", "CDU heat-exchanger boundary", ["no CDU asset"])
    for nid, loop in (("n_cdu_fs", "fws"), ("n_cdu_fr", "fws"), ("n_cdu_ts", "tcs"), ("n_cdu_tr", "tcs")):
        n = nodes.get(nid)
        if n is None:
            bad.append(f"missing CDU port node {nid}")
            continue
        if n["loop"] != loop:
            bad.append(f"{nid} on wrong loop")
        if not _near_bbox(n["position_xyz_m"], cdu, 0.05):
            bad.append(f"{nid} is not on the CDU body")
    return _check("cdu_boundary", "CDU primary (FWS) and secondary (TCS) ports are four distinct nodes on the CDU body", bad)


ALL_CHECKS = (check_unique_ids, check_endpoints, check_loop_separation, check_no_orphans, check_loops_closed, check_rack_branches,
              check_taps, check_assets_on_edges, check_ports, check_passable_components, check_cdu_boundary, check_capacity,
              check_geometry, check_nav_reachability)


def solver_conservation(plant: Any) -> Json:
    """Run the plant's pandapipes solve and verify convergence and mass conservation on both loops."""
    h = plant.hyd
    bad: list[str] = []
    if h is None or not h.converged:
        bad.append(f"hydraulic solve did not converge: {getattr(plant, 'fail', None)}")
        return _check("solver_conservation", "pandapipes solves FWS+TCS with mass conserved", bad)
    if h.residual > 1e-6:
        bad.append(f"residual {h.residual:.2e}")
    for loop in ("tcs", "fws"):
        if h.mass_balance[loop] > 1e-4:
            bad.append(f"{loop}: mass imbalance {h.mass_balance[loop]:.2e}")
        if h.q[loop] <= 0:
            bad.append(f"{loop}: no flow")
    rack_sum = sum(h.rack_q.values())
    if abs(rack_sum - h.q["tcs"]) / max(h.q["tcs"], 1e-9) > 1e-3:
        bad.append(f"rack flows sum {rack_sum:.5f} != pump flow {h.q['tcs']:.5f} m3/s")
    return _check("solver_conservation", "pandapipes solves FWS+TCS with mass conserved", bad, residual=h.residual,
                  tcs_mass_balance=h.mass_balance["tcs"], fws_mass_balance=h.mass_balance["fws"],
                  tcs_kg_s=round(h.q["tcs"] * plant.rho_loc("tcs"), 3), fws_kg_s=round(h.q["fws"] * plant.rho_loc("fws"), 3))


def validate_topology(topo: Json, plant: Any | None = None) -> Json:
    checks = [fn(topo) for fn in ALL_CHECKS]
    if plant is not None:
        checks.append(solver_conservation(plant))
    fac = topo["facility"]
    return {
        "facility_id": fac["id"], "config_version": fac["config_version"], "topology_hash": fac["topology_hash"],
        "ok": all(c["passed"] for c in checks),
        "summary": {"nodes": len(topo["nodes"]), "edges": len(topo["edges"]), "assets": len(topo["assets"]),
                    "passable_edges": sum(1 for e in topo["edges"] if e["robot_passable"]),
                    "fittings": len(topo.get("fittings", [])), "supports": len(topo.get("supports", [])),
                    "penetrations": len(topo.get("site", {}).get("penetrations", [])),
                    "capacity": topo.get("capacity")},
        "checks": checks,
    }


def render_text(rep: Json) -> str:
    out = [f"Topology validation: {rep['facility_id']} ({rep['config_version']}) hash {rep['topology_hash']}",
           "  " + ", ".join(f"{k}={v}" for k, v in rep["summary"].items() if k != "capacity")]
    if rep["summary"].get("capacity"):
        c = rep["summary"]["capacity"]
        out.append(f"  racks: {c['solver_backed_racks']} solver-backed ({c['instrumented_racks']} instrumented) + "
                   f"{c['architectural_context_cabinets']} architectural-context cabinets")
    for c in rep["checks"]:
        out.append(f"  [{'PASS' if c['passed'] else 'FAIL'}] {c['id']}: {c['title']}")
        for p in c["problems"]:
            out.append(f"         - {p}")
    out.append("RESULT: " + ("OK" if rep["ok"] else "FAILED"))
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=None)
    ap.add_argument("--json", default=None, help="write the machine-readable report here")
    ap.add_argument("--solve", action="store_true", help="also run the pandapipes solve and check conservation")
    a = ap.parse_args(argv)
    from .config import load_config
    from .topology import build_topology
    cfg = load_config(a.config)
    topo = build_topology(cfg)
    plant = None
    if a.solve:
        from .plant import FacilityPlant
        plant = FacilityPlant(1, config=cfg)
    rep = validate_topology(topo, plant)
    print(render_text(rep))
    if a.json:
        import os
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, indent=2)
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
