export interface Dist {
  n: number;
  mean: number;
  /** fastest sample and 10th percentile: the noise-robust end of a distribution on a shared (contended) machine */
  min: number;
  p10: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function dist(xs: number[]): Dist {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, min: 0, p10: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  // nearest-rank percentile (no interpolation: a reported p99 is a frame that really happened)
  const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  let sum = 0;
  for (const x of s) sum += x;
  return { n, mean: sum / n, min: s[0], p10: q(10), p50: q(50), p95: q(95), p99: q(99), max: s[n - 1] };
}

export const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
export const roundDist = (d: Dist): Dist => ({ n: d.n, mean: round(d.mean), min: round(d.min), p10: round(d.p10), p50: round(d.p50), p95: round(d.p95), p99: round(d.p99), max: round(d.max) });
