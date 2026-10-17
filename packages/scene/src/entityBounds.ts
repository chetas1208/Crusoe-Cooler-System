import type { Robot, Topology, Vec3 } from '@loopkeeper/core/contracts';
import { siteModel } from './siteModel';

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/**
 * Selection ids for things that are neither assets, edges nor robots. They carry the REAL manifest id
 * (`road:ROAD-02`, `row:ROW-03`), so the same string works in every tab, the palette and deep links.
 */
export const roadSel = (roadId: string) => `road:${roadId}`;
export const rowSel = (rowId: string) => `row:${rowId}`;
export const isRoadSel = (id: string | null | undefined): id is string => !!id && id.startsWith('road:');
export const isRowSel = (id: string | null | undefined): id is string => !!id && id.startsWith('row:');
export const selKey = (id: string) => id.replace(/^(road|row):/, '');

/** World-space bounds to fly to for any selectable id (null = no position: the caller says so). Pure, topology-driven. */
export function entityBounds(topo: Topology, id: string, robots?: Record<string, Robot>): Bounds | null {
  const m = siteModel(topo);
  if (isRoadSel(id)) {
    const k = selKey(id);
    const r = m.roads.find((x) => (x.roadId ?? x.id) === k || x.id === k);
    return r ? { min: [r.x0 - 1, 0, r.z0 - 2.2], max: [r.x1 + 1, 3.3, r.z1 + 2.2] } : null;
  }
  if (isRowSel(id)) {
    const key = selKey(id);
    for (const p of m.pods) for (const r of p.rows) if ((r.rowId ?? r.id) === key) return { min: [r.x0 - 1.5, 0, r.z - m.rackDims.d / 2 - 1.5], max: [r.x1 + 1.5, 3.4, r.z + m.rackDims.d / 2 + 1.5] };
    return null;
  }
  const robot = robots?.[id];
  if (robot) {
    const [x, y, z] = robot.pose.position_xyz_m;
    const pad = robot.class === 'inpipe' ? 3 : 4;
    return { min: [x - pad, Math.max(0, y - 1), z - pad], max: [x + pad, y + 2, z + pad] };
  }
  const e = topo.edges.find((x) => x.id === id);
  if (e) {
    const min: Vec3 = [Infinity, 0, Infinity];
    const max: Vec3 = [-Infinity, 0, -Infinity];
    for (const p of e.centerline_xyz_m) {
      min[0] = Math.min(min[0], p[0]);
      min[2] = Math.min(min[2], p[2]);
      max[0] = Math.max(max[0], p[0]);
      max[2] = Math.max(max[2], p[2]);
      max[1] = Math.max(max[1], p[1] + 0.8);
    }
    const pad = Math.max(2.2, Math.min(7, e.length_m * 0.25));
    return { min: [min[0] - pad, 0, min[2] - pad], max: [max[0] + pad, max[1], max[2] + pad] };
  }
  const a = topo.assets.find((x) => x.id === id);
  if (a) {
    const [x, y, z] = a.position_xyz_m;
    const [w, h, d] = a.size_m ?? [1, 1, 1];
    // pipe-mounted hardware has no footprint: use its position
    const pad = a.type === 'rack' ? 2.4 : a.type === 'cdu' ? 3.4 : a.type === 'chiller' ? 4 : 2;
    const top = a.edge_id ? y + 1 : Math.max(h, y) + 0.6;
    return { min: [x - w / 2 - pad, 0, z - d / 2 - pad], max: [x + w / 2 + pad, top, z + d / 2 + pad] };
  }
  return null;
}

/** all bounding points of a bounds box, used by tests/measurements */
export const boundsCenter = (b: Bounds): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
