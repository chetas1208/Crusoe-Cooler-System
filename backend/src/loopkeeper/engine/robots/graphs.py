"""Routing: INPIPE Dijkstra over the pipe graph (robot_passable edges only), OUTRIG A* over a nav grid
with obstacle avoidance. Ported from packages/core/src/engine/robots.ts, extended with robot-specific
filters (min bore), blocked edges (isolation / work locks) and an edge penalty hook."""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Callable, Iterable

from ..geometry import (Path, build_path, clamp, join_paths, reverse_path, sample_path, slice_path,
                        v_dist, v_lerp)


@dataclass
class InpipeRoute:
    legs: list  # [{edge_id, s0, s1}]
    path: Path
    leg_start: list
    length: float

    def legs_json(self):
        return [dict(l) for l in self.legs]


class PipeGraph:
    def __init__(self, topo: dict):
        self.edges = {e["id"]: e for e in topo["edges"]}
        self.paths = {e["id"]: build_path(e["centerline_xyz_m"], e.get("fillet_radius_m", 0.0)) for e in topo["edges"]}
        self._adj: dict[str, list] = {}
        for e in topo["edges"]:
            self._adj.setdefault(e["from"], []).append((e["id"], e["to"], True))
            self._adj.setdefault(e["to"], []).append((e["id"], e["from"], False))

    # ---- queries -------------------------------------------------------
    def edge(self, eid): return self.edges[eid]
    def path(self, eid): return self.paths[eid]
    def length(self, eid): return self.paths[eid].length
    def position(self, eid, s): return sample_path(self.paths[eid], s)[0]
    def tangent(self, eid, s): return sample_path(self.paths[eid], s)[1]

    def passable(self, eid, min_bore_mm: float = 0.0, blocked: Iterable[str] = ()) -> bool:
        e = self.edges.get(eid)
        if not e or not e.get("robot_passable"):
            return False
        if min_bore_mm and e.get("diameter_mm", 0) < min_bore_mm:
            return False
        return eid not in blocked

    def why_not(self, eid, min_bore_mm: float = 0.0, blocked: Iterable[str] = ()) -> str | None:
        e = self.edges.get(eid)
        if not e:
            return "unknown_segment"
        if not e.get("robot_passable"):
            return e.get("not_passable_reason") or "not_robot_passable"
        if min_bore_mm and e.get("diameter_mm", 0) < min_bore_mm:
            return f"bore {e['diameter_mm']} mm < robot minimum {min_bore_mm:g} mm"
        if eid in blocked:
            return "segment_locked"
        return None

    def junction_options(self, edge_id: str, at_end: bool, min_bore_mm=0.0, blocked=()) -> list[str]:
        """Passable edges that continue from the end node of `edge_id` (at_end: s=length, else s=0)."""
        e = self.edges[edge_id]
        node = e["to"] if at_end else e["from"]
        return [eid for eid, _, _ in self._adj.get(node, []) if eid != edge_id and self.passable(eid, min_bore_mm, blocked)]

    def node_at(self, edge_id: str, at_end: bool) -> str:
        e = self.edges[edge_id]
        return e["to"] if at_end else e["from"]

    # ---- routing -------------------------------------------------------
    def route(self, frm: dict, to: dict, *, min_bore_mm: float = 0.0, blocked: Iterable[str] = (),
              penalty: Callable[[str], float] | None = None) -> InpipeRoute | None:
        blocked = frozenset(blocked)
        fe, te = frm["edge_id"], to["edge_id"]
        # the start edge is allowed even if the robot sits in a (now) locked edge: it must be able to leave
        if not self.passable(fe, min_bore_mm) or not self.passable(te, min_bore_mm, blocked):
            return None
        if fe == te:
            legs = [{"edge_id": fe, "s0": frm["s"], "s1": to["s"]}]
            return self.assemble(legs)
        eF, eT = self.edges[fe], self.edges[te]
        best = None
        for exit_node in (eF["from"], eF["to"]):
            exit_s = 0.0 if exit_node == eF["from"] else self.length(fe)
            for entry_node in (eT["from"], eT["to"]):
                entry_s = 0.0 if entry_node == eT["from"] else self.length(te)
                mid = self._dijkstra(exit_node, entry_node, {fe, te}, min_bore_mm, blocked, penalty)
                if mid is None:
                    continue
                cost = abs(frm["s"] - exit_s) + mid[0] + abs(entry_s - to["s"])
                if best is None or cost < best[0]:
                    best = (cost, [{"edge_id": fe, "s0": frm["s"], "s1": exit_s}, *mid[1],
                                   {"edge_id": te, "s0": entry_s, "s1": to["s"]}])
        if best is None:
            return None
        return self.assemble(best[1])

    def _dijkstra(self, a, b, exclude, min_bore_mm, blocked, penalty):
        if a == b:
            return 0.0, []
        dist = {a: 0.0}
        prev: dict = {}
        heap = [(0.0, 0, a)]
        n = 0
        done = set()
        while heap:
            d, _, u = heapq.heappop(heap)
            if u in done:
                continue
            done.add(u)
            if u == b:
                break
            for eid, v, forward in self._adj.get(u, []):
                if eid in exclude or not self.passable(eid, min_bore_mm, blocked):
                    continue
                nd = d + self.length(eid) + (penalty(eid) if penalty else 0.0)
                if nd < dist.get(v, math.inf) - 1e-12:
                    dist[v] = nd
                    prev[v] = (u, eid, forward)
                    n += 1
                    heapq.heappush(heap, (nd, n, v))
        if b not in dist:
            return None
        legs, cur = [], b
        while cur != a:
            u, eid, fwd = prev[cur]
            L = self.length(eid)
            legs.insert(0, {"edge_id": eid, "s0": 0.0 if fwd else L, "s1": L if fwd else 0.0})
            cur = u
        return dist[b], legs

    def assemble(self, legs: list) -> InpipeRoute:
        cleaned = [l for l in legs if abs(l["s1"] - l["s0"]) > 1e-3]
        if not cleaned:
            l = legs[0]
            p = self.position(l["edge_id"], l["s0"])
            return InpipeRoute([dict(l)], Path([p, p], [0.0, 0.0], 0.0), [0.0], 0.0)
        subs, starts, acc = [], [], 0.0
        for l in cleaned:
            full = self.paths[l["edge_id"]]
            lo, hi = min(l["s0"], l["s1"]), max(l["s0"], l["s1"])
            sub = slice_path(full, lo, hi)
            if l["s1"] < l["s0"]:
                sub = reverse_path(sub)
            subs.append(sub)
            starts.append(acc)
            acc += sub.length
        path = join_paths(subs)
        return InpipeRoute([dict(l) for l in cleaned], path, starts, path.length)


class NavGrid:
    """2.5D ground navigation: axis-aligned obstacles inflated by the robot radius."""

    def __init__(self, topo: dict, radius: float = 0.72):   # = half-diagonal of the OUTRIG envelope (0.95 x 0.90 m) + 3 cm: any yaw is safe
        fac = topo["facility"]
        self.cell = topo["nav"]["cell_m"]
        self.min_x, self.min_z = fac["interior_min"][0], fac["interior_min"][2]
        max_x, max_z = fac["interior_max"][0], fac["interior_max"][2]
        self.bounds = (self.min_x, self.min_z, max_x, max_z)
        self.w = math.ceil((max_x - self.min_x) / self.cell)
        self.h = math.ceil((max_z - self.min_z) / self.cell)
        self.radius = radius
        self._extra: set = set()
        self.obstacles = topo["nav"]["obstacles"]
        self.blocked = bytearray(self.w * self.h)
        c = self.cell
        rb = self.blocked
        w, h = self.w, self.h
        # rasterise only the cells each rectangle (inflated by the robot radius) can touch, plus the boundary band
        for j in range(h):
            z = self.min_z + (j + 0.5) * c
            edge_z = z < self.min_z + radius or z > max_z - radius
            row = j * w
            if edge_z:
                for i in range(w):
                    rb[row + i] = 1
            else:
                for i in range(w):
                    x = self.min_x + (i + 0.5) * c
                    if x < self.min_x + radius or x > max_x - radius:
                        rb[row + i] = 1
        for o in self.obstacles:
            x0, z0, x1, z1 = o["rect"]
            i0 = max(int(math.floor((x0 - radius - self.min_x) / c)) - 1, 0)
            i1 = min(int(math.ceil((x1 + radius - self.min_x) / c)) + 1, w - 1)
            j0 = max(int(math.floor((z0 - radius - self.min_z) / c)) - 1, 0)
            j1 = min(int(math.ceil((z1 + radius - self.min_z) / c)) + 1, h - 1)
            for j in range(j0, j1 + 1):
                z = self.min_z + (j + 0.5) * c
                if not (z0 - radius < z < z1 + radius):
                    continue
                for i in range(i0, i1 + 1):
                    x = self.min_x + (i + 0.5) * c
                    if x0 - radius < x < x1 + radius:
                        rb[j * w + i] = 1

    def _idx(self, x, z):
        return (int(clamp(math.floor((x - self.min_x) / self.cell), 0, self.w - 1)),
                int(clamp(math.floor((z - self.min_z) / self.cell), 0, self.h - 1)))

    def _world(self, i, j):
        return [self.min_x + (i + 0.5) * self.cell, 0.0, self.min_z + (j + 0.5) * self.cell]

    def is_free(self, x, z):
        i, j = self._idx(x, z)
        return not self.blocked[j * self.w + i]

    def in_obstacle(self, x, z) -> str | None:
        """Raw (non-inflated) obstacle containing the point, for collision assertions."""
        for o in self.obstacles:
            x0, z0, x1, z1 = o["rect"]
            if x0 < x < x1 and z0 < z < z1:
                return o["id"]
        return None

    def snap(self, p):
        ci, cj = self._idx(p[0], p[2])
        if not self.blocked[cj * self.w + ci]:
            return self._world(ci, cj)
        for r in range(1, 30):
            best, bd = None, math.inf
            for j in range(cj - r, cj + r + 1):
                for i in range(ci - r, ci + r + 1):
                    if i < 0 or j < 0 or i >= self.w or j >= self.h:
                        continue
                    if max(abs(i - ci), abs(j - cj)) != r or self.blocked[j * self.w + i]:
                        continue
                    d = (i - ci) ** 2 + (j - cj) ** 2
                    if d < bd:
                        bd, best = d, (i, j)
            if best:
                return self._world(*best)
        return [p[0], 0.0, p[2]]

    def _line_free(self, a, b):
        n = math.ceil(v_dist(a, b) / (self.cell * 0.5))
        for k in range(n + 1):
            p = v_lerp(a, b, k / max(n, 1))
            if not self.is_free(p[0], p[2]) or (self._extra and self._idx_flat(p[0], p[2]) in self._extra):
                return False
        return True

    def _idx_flat(self, x, z):
        i, j = self._idx(x, z)
        return j * self.w + i

    def extra_cells(self, rects, keep_clear=None) -> set:
        """Flat cell indices blocked by extra (dynamic) rectangles [x0, z0, x1, z1], inflated by the robot radius.
        Cells within 1.0 m of `keep_clear` (the planning robot itself) are never blocked so it can always leave its spot."""
        out: set = set()
        c, r = self.cell, self.radius
        for x0, z0, x1, z1 in rects:
            i0 = max(int(math.floor((x0 - r - self.min_x) / c)), 0)
            i1 = min(int(math.ceil((x1 + r - self.min_x) / c)), self.w - 1)
            j0 = max(int(math.floor((z0 - r - self.min_z) / c)), 0)
            j1 = min(int(math.ceil((z1 + r - self.min_z) / c)), self.h - 1)
            for j in range(j0, j1 + 1):
                z = self.min_z + (j + 0.5) * c
                if not (z0 - r < z < z1 + r):
                    continue
                for i in range(i0, i1 + 1):
                    x = self.min_x + (i + 0.5) * c
                    if not (x0 - r < x < x1 + r):
                        continue
                    if keep_clear is not None and math.hypot(x - keep_clear[0], z - keep_clear[2]) < 1.0:
                        continue
                    out.add(j * self.w + i)
        return out

    def segment_free(self, a, b, extras=()) -> bool:
        """Collision test of a straight leg against the static grid and the given dynamic rectangles."""
        prev = self._extra
        self._extra = self.extra_cells(extras) if extras else set()
        try:
            return self._line_free(a, b)
        finally:
            self._extra = prev

    def route(self, frm, to, extra=()):
        """A* over the free grid. `extra` = dynamic rectangles (parked robots) treated as obstacles for this query only."""
        self._extra = self.extra_cells(extra, keep_clear=frm) if extra else set()
        try:
            return self._route(frm, to)
        finally:
            self._extra = set()

    def _route(self, frm, to):
        s, g = self.snap(frm), self.snap(to)
        si, sj = self._idx(s[0], s[2])
        gi, gj = self._idx(g[0], g[2])
        w = self.w
        key = lambda i, j: j * w + i  # noqa: E731
        heap = [(0.0, 0, si, sj)]
        gscore = {key(si, sj): 0.0}
        came: dict = {}
        closed = set()
        n = 0
        while heap:
            _, _, ci, cj = heapq.heappop(heap)
            ck = key(ci, cj)
            if ck in closed:
                continue
            closed.add(ck)
            if ci == gi and cj == gj:
                cells, k = [], ck
                while k is not None:
                    cells.insert(0, self._world(k % w, k // w))
                    k = came.get(k)
                first = [frm[0], 0.0, frm[2]] if not (frm[0] == s[0] and frm[2] == s[2]) else list(frm)
                return self._smooth([first, *cells[1:-1], g])
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if not di and not dj:
                        continue
                    ni, nj = ci + di, cj + dj
                    if ni < 0 or nj < 0 or ni >= w or nj >= self.h or self.blocked[key(ni, nj)] or key(ni, nj) in self._extra:
                        continue
                    if di and dj and (self.blocked[key(ci + di, cj)] or self.blocked[key(ci, cj + dj)] or key(ci + di, cj) in self._extra or key(ci, cj + dj) in self._extra):
                        continue
                    tg = gscore.get(ck, 0.0) + (math.sqrt(2) if di and dj else 1.0)
                    nk = key(ni, nj)
                    if tg < gscore.get(nk, math.inf):
                        gscore[nk] = tg
                        came[nk] = ck
                        n += 1
                        heapq.heappush(heap, (tg + math.hypot(ni - gi, nj - gj), n, ni, nj))
        return None

    def _smooth(self, pts):
        out = [pts[0]]
        anchor = 0
        while anchor < len(pts) - 1:
            far = len(pts) - 1
            while far > anchor + 1 and not self._line_free(pts[anchor], pts[far]):
                far -= 1
            out.append(pts[far])
            anchor = far
        return out
