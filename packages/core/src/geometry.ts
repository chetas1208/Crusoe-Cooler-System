import type { Vec3 } from './contracts';

/* ───────────────────────────── vector helpers ───────────────────────────── */

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Shortest signed angular difference b - a, wrapped to [-π, π]. */
export function angleDelta(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ─────────────────────────────── seeded rng ─────────────────────────────── */

export interface Rng {
  next(): number;
  range(lo: number, hi: number): number;
  normal(): number;
  pick<T>(arr: readonly T[]): T;
  state(): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    normal: () => {
      // Box–Muller
      const u = Math.max(next(), 1e-9);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    state: () => a,
  };
}

/* ───────────────────────────── filleted paths ───────────────────────────── */

export interface Path {
  points: Vec3[];
  /** cumulative arc length at each point */
  cum: number[];
  length: number;
}

/** Round the interior corners of a polyline with circular-ish (quadratic) arcs. */
export function filletPolyline(ctrl: Vec3[], radius: number, arcSteps = 8): Vec3[] {
  if (ctrl.length < 3 || radius <= 0) return ctrl.map((p) => [...p] as Vec3);
  const out: Vec3[] = [[...ctrl[0]] as Vec3];
  for (let i = 1; i < ctrl.length - 1; i++) {
    const a = ctrl[i - 1];
    const b = ctrl[i];
    const c = ctrl[i + 1];
    const u1 = v3.norm(v3.sub(a, b));
    const u2 = v3.norm(v3.sub(c, b));
    const cos = clamp(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2], -1, 1);
    const theta = Math.acos(cos);
    if (theta > Math.PI - 1e-3 || theta < 1e-3) {
      out.push([...b] as Vec3);
      continue;
    }
    const maxT = Math.min(v3.dist(a, b), v3.dist(b, c)) * 0.48;
    const t = Math.min(radius / Math.tan(theta / 2), maxT);
    const p1 = v3.add(b, v3.scale(u1, t));
    const p2 = v3.add(b, v3.scale(u2, t));
    for (let k = 0; k <= arcSteps; k++) {
      const s = k / arcSteps;
      // quadratic bezier p1 → b → p2
      const w0 = (1 - s) * (1 - s);
      const w1 = 2 * (1 - s) * s;
      const w2 = s * s;
      out.push([
        p1[0] * w0 + b[0] * w1 + p2[0] * w2,
        p1[1] * w0 + b[1] * w1 + p2[1] * w2,
        p1[2] * w0 + b[2] * w1 + p2[2] * w2,
      ]);
    }
  }
  out.push([...ctrl[ctrl.length - 1]] as Vec3);
  return out;
}

export function buildPath(ctrl: Vec3[], filletRadius = 0): Path {
  const points = filletPolyline(ctrl, filletRadius);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + v3.dist(points[i - 1], points[i]));
  return { points, cum, length: cum[cum.length - 1] };
}

export function polylineLength(ctrl: Vec3[]) {
  let l = 0;
  for (let i = 1; i < ctrl.length; i++) l += v3.dist(ctrl[i - 1], ctrl[i]);
  return l;
}

/** Position + unit tangent at arc length s (clamped). */
export function samplePath(path: Path, s: number): { p: Vec3; t: Vec3 } {
  const { points, cum, length } = path;
  const ss = clamp(s, 0, length);
  // binary search
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= ss) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo] || 1e-9;
  const f = (ss - cum[lo]) / segLen;
  const p = v3.lerp(points[lo], points[hi], f);
  const t = v3.norm(v3.sub(points[hi], points[lo]));
  return { p, t };
}

export function reversePath(path: Path): Path {
  const points = [...path.points].reverse();
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + v3.dist(points[i - 1], points[i]));
  return { points, cum, length: cum[cum.length - 1] };
}

/** Concatenate paths that share endpoints (dedupes the joint). */
export function joinPaths(paths: Path[]): Path {
  const points: Vec3[] = [];
  for (const p of paths) {
    for (let i = 0; i < p.points.length; i++) {
      if (points.length && i === 0 && v3.dist(points[points.length - 1], p.points[0]) < 1e-6) continue;
      points.push(p.points[i]);
    }
  }
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + v3.dist(points[i - 1], points[i]));
  return { points, cum, length: cum[cum.length - 1] };
}

/** Yaw (about +y) pointing along direction d on the ground plane. */
export const yawOf = (d: Vec3) => Math.atan2(d[0], d[2]);
