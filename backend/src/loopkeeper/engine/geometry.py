"""Port of packages/core/src/geometry.ts. Robot positions MUST match what the client draws, so the
algorithms (fillet, arc-length sampling) are kept identical. Tuples/lists of 3 floats (x, y up, z)."""
from __future__ import annotations

import math
from dataclasses import dataclass

Vec3 = list  # [x, y, z]


def v_add(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def v_sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def v_scale(a, k): return [a[0] * k, a[1] * k, a[2] * k]
def v_dist(a, b): return math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
def v_lerp(a, b, t): return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]


def v_norm(a):
    l = math.hypot(a[0], a[1], a[2]) or 1.0
    return [a[0] / l, a[1] / l, a[2] / l]


def clamp(x, lo, hi):
    return min(hi, max(lo, x))


def angle_delta(a: float, b: float) -> float:
    d = math.fmod(b - a, math.pi * 2)  # JS % keeps dividend sign, like fmod
    if d > math.pi:
        d -= math.pi * 2
    if d < -math.pi:
        d += math.pi * 2
    return d


def yaw_of(d) -> float:
    return math.atan2(d[0], d[2])


@dataclass
class Path:
    points: list
    cum: list
    length: float

    def to_json(self):
        return {"points": self.points, "cum": self.cum, "length": self.length}


def fillet_polyline(ctrl, radius: float, arc_steps: int = 8):
    if len(ctrl) < 3 or radius <= 0:
        return [list(map(float, p)) for p in ctrl]
    out = [list(map(float, ctrl[0]))]
    for i in range(1, len(ctrl) - 1):
        a, b, c = ctrl[i - 1], ctrl[i], ctrl[i + 1]
        u1 = v_norm(v_sub(a, b))
        u2 = v_norm(v_sub(c, b))
        cos = clamp(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2], -1, 1)
        theta = math.acos(cos)
        if theta > math.pi - 1e-3 or theta < 1e-3:
            out.append(list(map(float, b)))
            continue
        max_t = min(v_dist(a, b), v_dist(b, c)) * 0.48
        t = min(radius / math.tan(theta / 2), max_t)
        p1 = v_add(b, v_scale(u1, t))
        p2 = v_add(b, v_scale(u2, t))
        for k in range(arc_steps + 1):
            s = k / arc_steps
            w0, w1, w2 = (1 - s) * (1 - s), 2 * (1 - s) * s, s * s
            out.append([p1[j] * w0 + b[j] * w1 + p2[j] * w2 for j in range(3)])
    out.append(list(map(float, ctrl[-1])))
    return out


def _cum(points):
    cum = [0.0]
    for i in range(1, len(points)):
        cum.append(cum[i - 1] + v_dist(points[i - 1], points[i]))
    return cum


def build_path(ctrl, fillet_radius: float = 0.0) -> Path:
    pts = fillet_polyline(ctrl, fillet_radius)
    cum = _cum(pts)
    return Path(pts, cum, cum[-1])


def sample_path(path: Path, s: float):
    """-> (position, unit tangent) at arc length s (clamped)."""
    pts, cum = path.points, path.cum
    ss = clamp(s, 0.0, path.length)
    lo, hi = 0, len(cum) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if cum[mid] <= ss:
            lo = mid
        else:
            hi = mid
    seg = (cum[hi] - cum[lo]) or 1e-9
    f = (ss - cum[lo]) / seg
    return v_lerp(pts[lo], pts[hi], f), v_norm(v_sub(pts[hi], pts[lo]))


def reverse_path(path: Path) -> Path:
    pts = list(reversed(path.points))
    cum = _cum(pts)
    return Path(pts, cum, cum[-1])


def join_paths(paths) -> Path:
    pts: list = []
    for p in paths:
        for i, pt in enumerate(p.points):
            if pts and i == 0 and v_dist(pts[-1], pt) < 1e-6:
                continue
            pts.append(pt)
    cum = _cum(pts)
    return Path(pts, cum, cum[-1])


def slice_path(path: Path, s0: float, s1: float) -> Path:
    pts = [sample_path(path, s0)[0]]
    for i, p in enumerate(path.points):
        if path.cum[i] > s0 + 1e-6 and path.cum[i] < s1 - 1e-6:
            pts.append(p)
    pts.append(sample_path(path, s1)[0])
    cum = _cum(pts)
    return Path(pts, cum, cum[-1])
