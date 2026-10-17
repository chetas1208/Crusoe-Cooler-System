"""Pipe-centerline geometry. Port of packages/core/src/geometry.ts (filleted polylines)
so edge lengths and on-pipe positions match what the frontend renders."""
from __future__ import annotations

import math
from dataclasses import dataclass

Vec3 = tuple[float, float, float]


def js_round(x: float, d: int = 2) -> float:
    """Math.round(x*10^d)/10^d (half-up), as used by the TS reference."""
    f = 10 ** d
    return math.floor(x * f + 0.5) / f


def _sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def _add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def _scale(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def _dist(a, b): return math.dist(a, b)


def _norm(a):
    l = math.hypot(a[0], a[1], a[2]) or 1.0
    return (a[0] / l, a[1] / l, a[2] / l)


def fillet_polyline(ctrl: list[Vec3], radius: float, arc_steps: int = 8) -> list[Vec3]:
    if len(ctrl) < 3 or radius <= 0:
        return [tuple(p) for p in ctrl]
    out: list[Vec3] = [tuple(ctrl[0])]
    for i in range(1, len(ctrl) - 1):
        a, b, c = ctrl[i - 1], ctrl[i], ctrl[i + 1]
        u1 = _norm(_sub(a, b))
        u2 = _norm(_sub(c, b))
        cos = max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]))
        theta = math.acos(cos)
        if theta > math.pi - 1e-3 or theta < 1e-3:
            out.append(tuple(b))
            continue
        max_t = min(_dist(a, b), _dist(b, c)) * 0.48
        t = min(radius / math.tan(theta / 2), max_t)
        p1 = _add(b, _scale(u1, t))
        p2 = _add(b, _scale(u2, t))
        for k in range(arc_steps + 1):
            s = k / arc_steps
            w0, w1, w2 = (1 - s) * (1 - s), 2 * (1 - s) * s, s * s
            out.append(tuple(p1[j] * w0 + b[j] * w1 + p2[j] * w2 for j in range(3)))
    out.append(tuple(ctrl[-1]))
    return out


@dataclass
class Path:
    points: list[Vec3]
    cum: list[float]

    @property
    def length(self) -> float:
        return self.cum[-1]


def build_path(ctrl: list[Vec3], fillet_radius: float = 0.0) -> Path:
    pts = fillet_polyline(ctrl, fillet_radius)
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + _dist(pts[i - 1], pts[i]))
    return Path(pts, cum)


def sample_path(path: Path, s: float) -> Vec3:
    ss = max(0.0, min(path.length, s))
    lo, hi = 0, len(path.cum) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if path.cum[mid] <= ss:
            lo = mid
        else:
            hi = mid
    seg = (path.cum[hi] - path.cum[lo]) or 1e-9
    f = (ss - path.cum[lo]) / seg
    a, b = path.points[lo], path.points[hi]
    return tuple(a[j] + (b[j] - a[j]) * f for j in range(3))  # type: ignore[return-value]


def project_to_path(path: Path, p: Vec3) -> tuple[float, float]:
    """Nearest point of the (filleted) polyline to p -> (arc length s, distance)."""
    best_s, best_d = 0.0, float("inf")
    for i in range(1, len(path.points)):
        a, b = path.points[i - 1], path.points[i]
        ab = _sub(b, a)
        l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
        t = 0.0 if l2 < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2))
        q = (a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t)
        d = _dist(q, p)
        if d < best_d:
            best_d, best_s = d, path.cum[i - 1] + (path.cum[i] - path.cum[i - 1]) * t
    return best_s, best_d


def fnv1a_hex(s: str) -> str:
    """32-bit FNV-1a over UTF-16 code units (matches hashStr in facility.ts)."""
    h = 2166136261
    for ch in _utf16_units(s):
        h ^= ch
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h, "08x")


def _utf16_units(s: str):
    b = s.encode("utf-16-le")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]
