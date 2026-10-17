import * as THREE from 'three';
import { buildPath, type Path } from '@loopkeeper/core';
import type { Topology } from '@loopkeeper/core/contracts';
import { buildTubeGeometry } from './tube';

/**
 * Pipe geometry is expensive to build and only depends on the topology, never on telemetry. Cache it by
 *   (topology_hash, edge_id, kind, radial_segments)
 * so a topology refetch with identical geometry (reconnect, backend restart, v2 hot swap with the same pipes)
 * rebuilds nothing, and quality changes only build the tessellation levels actually used.
 * The hash covers every centerline vertex, diameter and fillet radius — i.e. the "segment geometry version".
 */
const hashOf = new WeakMap<object, string>();

export function topologyHash(topo: Topology): string {
  const hit = hashOf.get(topo);
  if (hit) return hit;
  let h = 0x811c9dc5;
  // the manifest's own version stamp (facility_layout_v6@1#hash) leads the key: a new topology_version never reuses old geometry
  const ver = (topo.facility as { topology_version?: string }).topology_version ?? '';
  const mix = (x: number) => {
    h ^= x | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
  };
  mixStr(ver);
  for (const e of topo.edges) {
    mixStr(e.id);
    mix(Math.round(e.diameter_mm * 10));
    mix(Math.round((e.fillet_radius_m ?? 0) * 1e4));
    for (const p of e.centerline_xyz_m) {
      mix(Math.round(p[0] * 1e4));
      mix(Math.round(p[1] * 1e4));
      mix(Math.round(p[2] * 1e4));
    }
  }
  const out = `${ver}:${topo.edges.length}:${h.toString(16)}`;
  hashOf.set(topo, out);
  return out;
}

let curHash = '';
const paths = new Map<string, Record<string, Path>>();
const tubes = new Map<string, THREE.BufferGeometry>();
export const geomCacheStats = { pathBuilds: 0, tubeBuilds: 0, tubeHits: 0 };

function evictOthers(hash: string) {
  if (curHash === hash) return;
  curHash = hash;
  for (const k of [...paths.keys()]) if (k !== hash) paths.delete(k);
  for (const [k, g] of [...tubes]) {
    if (!k.startsWith(hash + '|')) {
      g.dispose();
      tubes.delete(k);
    }
  }
}

export function cachedPaths(topo: Topology | null | undefined): Record<string, Path> {
  if (!topo) return {};
  const hash = topologyHash(topo);
  evictOthers(hash);
  let m = paths.get(hash);
  if (!m) {
    m = {};
    for (const e of topo.edges) m[e.id] = buildPath(e.centerline_xyz_m, e.fillet_radius_m);
    geomCacheStats.pathBuilds++;
    paths.set(hash, m);
  }
  return m;
}

/** Shared, never disposed by consumers (the cache owns it). `kind` separates shell/core radii. */
export function cachedTube(topo: Topology, edgeId: string, kind: 'shell' | 'core', radius: number, radial: number, stepM: number): THREE.BufferGeometry {
  const hash = topologyHash(topo);
  const key = `${hash}|${edgeId}|${kind}|${radial}`;
  const hit = tubes.get(key);
  if (hit) {
    geomCacheStats.tubeHits++;
    return hit;
  }
  const g = buildTubeGeometry(cachedPaths(topo)[edgeId], radius, radial, stepM, false, undefined, undefined, true);
  geomCacheStats.tubeBuilds++;
  tubes.set(key, g);
  return g;
}
