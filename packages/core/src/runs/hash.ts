import type { Incident, Kpis, Mission, Robot, AssetState } from '../contracts';

/** Deterministic JSON: object keys sorted, numbers via JSON. Used only for hashing/evidence manifests. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * FNV-1a, two 32-bit lanes with different offsets -> 64-bit hex. NOT cryptographic: it detects
 * accidental divergence in this mock; the real backend must use SHA-256 (algorithm is named in every manifest).
 */
export const HASH_ALGO = 'fnv1a-64x2' as const;
export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The physical state that must be bit-identical for two worlds to count as "the same". Excludes wall-clock and transport counters. */
export interface PhysicalState {
  sim_tick: number;
  sim_time_s: number;
  assets: Record<string, AssetState>;
  robots: Record<string, Robot>;
  missions: Record<string, Mission> | Mission[];
  incidents: Incident[];
  kpis: Kpis | null;
}

export function physicalHash(s: PhysicalState): string {
  const missions = Array.isArray(s.missions) ? [...s.missions].sort((a, b) => (a.id < b.id ? -1 : 1)) : Object.values(s.missions).sort((a, b) => (a.id < b.id ? -1 : 1));
  const incidents = [...s.incidents].sort((a, b) => (a.id < b.id ? -1 : 1));
  return hashString(canonical({ t: s.sim_tick, s: s.sim_time_s, a: s.assets, r: s.robots, m: missions, i: incidents, k: s.kpis }));
}
