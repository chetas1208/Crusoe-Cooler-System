"""Procedural mesh primitives (numpy). Y up, right-handed, metres, counter-clockwise front faces."""
from __future__ import annotations

import math

import numpy as np

V3 = np.ndarray


class Mesh:
    """Accumulates triangles (or line segments) for ONE material."""

    def __init__(self) -> None:
        self.pos: list[np.ndarray] = []
        self.nrm: list[np.ndarray] = []
        self.feat: list[np.ndarray] = []
        self.s: list[np.ndarray] = []
        self.idx: list[np.ndarray] = []
        self.n = 0

    def add(self, pos: np.ndarray, nrm: np.ndarray | None, idx: np.ndarray, feat: int, s: np.ndarray | None = None) -> None:
        pos = np.asarray(pos, dtype=np.float64)
        self.pos.append(pos)
        self.nrm.append(np.zeros_like(pos) if nrm is None else np.asarray(nrm, dtype=np.float64))
        self.feat.append(np.full(len(pos), feat, dtype=np.uint16))
        self.s.append(np.zeros(len(pos)) if s is None else np.asarray(s, dtype=np.float64))
        self.idx.append(np.asarray(idx, dtype=np.int64).reshape(-1) + self.n)
        self.n += len(pos)

    def empty(self) -> bool:
        return self.n == 0

    def arrays(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        return (np.concatenate(self.pos).astype(np.float32), np.concatenate(self.nrm).astype(np.float32),
                np.concatenate(self.feat), np.concatenate(self.s).astype(np.float32), np.concatenate(self.idx))

    @property
    def tri_count(self) -> int:
        return sum(len(i) for i in self.idx) // 3

    # ---- primitives ---------------------------------------------------
    def box(self, center, size, feat: int, yaw: float = 0.0, y_base: bool = False) -> None:
        """Axis box (rotated about +y by ``yaw``). ``y_base`` -> ``center`` is the bottom-centre."""
        cx, cy, cz = center
        sx, sy, sz = (float(v) / 2 for v in size)
        if y_base:
            cy += sy
        faces = [  # normal, 4 corners CCW seen from outside
            ((1, 0, 0), [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)]),
            ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
            ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)]),
            ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
            ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
            ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)]),
        ]
        c, s = math.cos(yaw), math.sin(yaw)
        rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        pos, nrm = [], []
        for n, corners in faces:
            for k in corners:
                pos.append(rot @ np.array([k[0] * sx, k[1] * sy, k[2] * sz]) + (cx, cy, cz))
                nrm.append(rot @ np.array(n, dtype=float))
        idx = np.array([[4 * f, 4 * f + 1, 4 * f + 2, 4 * f, 4 * f + 2, 4 * f + 3] for f in range(6)])
        self.add(np.array(pos), np.array(nrm), idx, feat)

    def quad(self, center, size_xz, feat: int, y: float | None = None) -> None:
        """Horizontal up-facing rectangle (x extent, z extent)."""
        cx, cy, cz = center
        hx, hz = size_xz[0] / 2, size_xz[1] / 2
        pos = np.array([(cx - hx, cy, cz + hz), (cx + hx, cy, cz + hz), (cx + hx, cy, cz - hz), (cx - hx, cy, cz - hz)])
        self.add(pos, np.tile((0, 1, 0), (4, 1)), np.array([0, 1, 2, 0, 2, 3]), feat)

    def tube(self, pts: V3, radius: float, radial: int, feat: int, *, inward: bool = False, caps: bool = False,
             s_start: float = 0.0, s_scale: float = 1.0) -> None:
        """Swept circle along a polyline (parallel-transport frames, smooth normals). ``_S_M`` = arclength along it."""
        pts = np.asarray(pts, dtype=np.float64)
        if len(pts) < 2:
            return
        seg = np.diff(pts, axis=0)
        ln = np.linalg.norm(seg, axis=1)
        keep = np.concatenate([[True], ln > 1e-9])
        pts = pts[keep]
        seg = np.diff(pts, axis=0)
        ln = np.linalg.norm(seg, axis=1)
        if len(pts) < 2:
            return
        dirs = seg / ln[:, None]
        tang = np.empty_like(pts)
        tang[0], tang[-1] = dirs[0], dirs[-1]
        if len(pts) > 2:
            t = dirs[:-1] + dirs[1:]
            nt = np.linalg.norm(t, axis=1)
            t = np.where(nt[:, None] > 1e-9, t / np.maximum(nt, 1e-9)[:, None], dirs[1:])
            tang[1:-1] = t
        up = np.array([0.0, 1.0, 0.0]) if abs(tang[0][1]) < 0.9 else np.array([1.0, 0.0, 0.0])
        nrm0 = np.cross(tang[0], up)
        nrm0 /= np.linalg.norm(nrm0)
        frames = []
        n = nrm0
        for i in range(len(pts)):
            if i:  # parallel transport: project previous normal onto the new tangent's normal plane
                n = n - tang[i] * np.dot(n, tang[i])
                nn = np.linalg.norm(n)
                n = n / nn if nn > 1e-9 else np.cross(tang[i], up)
            b = np.cross(tang[i], n)
            frames.append((n.copy(), b))
        th = np.linspace(0, 2 * math.pi, radial, endpoint=False)
        ct, st = np.cos(th), np.sin(th)
        rings_p, rings_n = [], []
        for p, (nn_, bb) in zip(pts, frames):
            dirv = ct[:, None] * nn_[None, :] + st[:, None] * bb[None, :]
            rings_p.append(p + radius * dirv)
            rings_n.append(-dirv if inward else dirv)
        cum = np.concatenate([[0.0], np.cumsum(ln)]) * s_scale + s_start
        pos = np.concatenate(rings_p)
        nrm = np.concatenate(rings_n)
        s = np.repeat(cum, radial)
        idx = []
        for i in range(len(pts) - 1):
            for j in range(radial):
                a, b2 = i * radial + j, i * radial + (j + 1) % radial
                c2, d = a + radial, b2 + radial
                idx += [a, b2, c2, b2, d, c2] if not inward else [a, c2, b2, b2, c2, d]
        self.add(pos, nrm, np.array(idx), feat, s)
        if caps and not inward:
            for end, sign in ((0, -1.0), (len(pts) - 1, 1.0)):
                base = len(pos)
                centre = pts[end]
                cp = np.vstack([centre, rings_p[end]])
                cn = np.tile(tang[end] * sign, (radial + 1, 1))
                ci = []
                for j in range(radial):
                    a, b2 = 1 + j, 1 + (j + 1) % radial
                    ci += [0, a, b2] if sign > 0 else [0, b2, a]
                self.add(cp, cn, np.array(ci), feat, np.full(len(cp), cum[end]))

    def cylinder(self, base, radius: float, height: float, radial: int, feat: int, axis: str = "y", caps: bool = True) -> None:
        base = np.asarray(base, dtype=np.float64)
        d = {"x": np.array([1.0, 0, 0]), "y": np.array([0, 1.0, 0]), "z": np.array([0, 0, 1.0])}[axis]
        self.tube(np.array([base, base + d * height]), radius, radial, feat, caps=caps)


def fillet_polyline(pts: V3, radius: float, seg: int = 4) -> V3:
    """Round interior corners with quadratic Bezier arcs (cut-back <= radius, <= 45% of each adjacent leg)."""
    pts = np.asarray(pts, dtype=np.float64)
    if len(pts) < 3 or radius <= 0:
        return pts
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        l1, l2 = np.linalg.norm(b - a), np.linalg.norm(c - b)
        if l1 < 1e-9 or l2 < 1e-9:
            continue
        d1, d2 = (a - b) / l1, (c - b) / l2
        if abs(float(np.dot(d1, d2)) + 1.0) < 1e-6 or abs(float(np.dot(d1, d2)) - 1.0) < 1e-6:  # straight / reversal
            out.append(b)
            continue
        cut = min(radius, 0.45 * l1, 0.45 * l2)
        p0, p1 = b + d1 * cut, b + d2 * cut
        for k in range(seg + 1):
            t = k / seg
            out.append((1 - t) ** 2 * p0 + 2 * t * (1 - t) * b + t * t * p1)
    out.append(pts[-1])
    return np.array(out)


def polyline_length(pts: V3) -> float:
    return float(np.linalg.norm(np.diff(np.asarray(pts, dtype=np.float64), axis=0), axis=1).sum())


def split_polyline(pts: V3, n_chunks: int) -> list[tuple[V3, float, float]]:
    """Split into ``n_chunks`` equal arclength pieces -> [(points, s_lo, s_hi)] in metres of polyline arclength."""
    pts = np.asarray(pts, dtype=np.float64)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    out = []
    for k in range(n_chunks):
        lo, hi = total * k / n_chunks, total * (k + 1) / n_chunks
        inner = [p for p, c in zip(pts, cum) if lo + 1e-9 < c < hi - 1e-9]
        def at(s: float) -> np.ndarray:
            j = int(np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(seg) - 1))
            t = (s - cum[j]) / seg[j] if seg[j] > 0 else 0.0
            return pts[j] + (pts[j + 1] - pts[j]) * t
        out.append((np.array([at(lo), *inner, at(hi)]), float(lo), float(hi)))
    return out
