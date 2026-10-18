import type { NavGraph } from '@loopkeeper/core/control';

/**
 * The exterior graph edge (road / cross-aisle / bay link) whose centreline passes closest to (x, z), with the distance to it.
 * Pure geometry on the authoritative pose and the server-published graph: nothing is estimated beyond "nearest centreline".
 */
export function nearestEdge(graph: NavGraph | undefined, x: number, z: number): { id: string; road?: string; dist: number } | null {
  if (!graph) return null;
  let best: { id: string; road?: string; dist: number } | null = null;
  for (const e of graph.edges) {
    const c = e.centerline_xz_m;
    if (!c || c.length < 2) continue;
    for (let i = 0; i + 1 < c.length; i++) {
      const [ax, az] = c[i];
      const [bx, bz] = c[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
      if (!best || d < best.dist) best = { id: e.id, road: e.road_id ?? (/^E:(ROAD-\d+|XA-[WE])/.exec(e.id)?.[1]), dist: d };
    }
  }
  return best;
}
