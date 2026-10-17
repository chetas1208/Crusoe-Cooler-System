import type { Asset, Topology } from '@loopkeeper/core/contracts';

/**
 * Everything the architectural layers need, derived from /topology only (site.rooms, context_cabinets, racks, docks).
 * Nothing here knows a coordinate: a different facility config produces a different hall.
 */
export interface SiteRoom {
  id: string;
  name: string;
  kind: string;
  rect: [number, number, number, number]; // x0 z0 x1 z1
  exterior?: boolean;
}

export interface CabRow {
  id: string;
  /** manifest id when the topology carries one (ROW-01) */
  rowId?: string;
  rackIds?: string[];
  z: number;
  yaw: number;
  x0: number;
  x1: number;
  n: number;
}

/** The free band between two adjacent cabinet rows: a robot road, a cold aisle or a service aisle. */
export interface Road {
  id: string;
  /** manifest id when the topology carries one (ROAD-01) */
  roadId?: string;
  meta?: { clear_width_m?: number; between_rows?: string[]; dock_ids?: string[]; service_target_ids?: string[] };
  hallId: string;
  /** 0-based order across the pod, by z */
  index: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  width: number;
  /** rows facing each other (cold aisle) | rows turned away (hot aisle) | rows facing the same way */
  kind: 'cold' | 'hot' | 'service';
}

export interface Pod {
  hallId: string;
  name: string;
  rect: [number, number, number, number];
  x0: number;
  x1: number;
  rows: CabRow[];
  /** cold aisle: front faces of two facing rows */
  cold: { z0: number; z1: number; rowLo: number; rowHi: number } | null;
  roads: Road[];
  dims: { w: number; h: number; d: number };
  /** solver-backed racks in this pod (everything else is architectural context) */
  racks: Asset[];
}

export interface SiteModel {
  rooms: SiteRoom[];
  /** every road of every pod, in plan order (z, then x) */
  roads: Road[];
  pods: Pod[];
  rackDims: { w: number; h: number; d: number };
  docks: Asset[];
}

const cache = new WeakMap<object, SiteModel>();
const near = (a: number, b: number, e = 0.4) => Math.abs(a - b) < e;

export function siteModel(topo: Topology): SiteModel {
  const hit = cache.get(topo);
  if (hit) return hit;
  const site = (topo as unknown as { site?: { rooms?: SiteRoom[] } }).site;
  const rooms: SiteRoom[] = site?.rooms ?? [];
  const ctx = ((topo as unknown as { context_cabinets?: Array<{ hall_id: string; row_id: string; position_xyz_m: number[]; size_m: number[]; yaw_rad: number }> }).context_cabinets ?? []);
  const L = (topo as unknown as { facility_layout_v6?: { rows?: Array<{ row_id: string; z_m: number; x_min_m?: number; x_max_m?: number; rack_ids: string[] }>; roads?: Array<{ road_id: string; z_m: number; x_min_m?: number; x_max_m?: number; clear_width_m?: number; between_rows?: string[]; dock_ids?: string[]; service_target_ids?: string[] }> } }).facility_layout_v6;
  const racks = topo.assets.filter((a) => a.type === 'rack');
  const d0 = racks[0]?.size_m ?? ctx[0]?.size_m ?? [1, 2.3, 1.3];
  const dims = { w: d0[0], h: d0[1], d: d0[2] };
  let halls = rooms.filter((r) => r.kind === 'hall');
  if (!halls.length) {
    // no room list (older / mock topologies): treat the interior as one hall
    const mn = topo.facility.interior_min;
    const mx = topo.facility.interior_max;
    halls = [{ id: 'hall', name: 'Hall', kind: 'hall', rect: [mn[0], mn[2], mx[0], mx[2]] }];
  }
  const pods: Pod[] = [];
  for (const h of halls) {
    const [rx0, rz0, rx1, rz1] = h.rect;
    const inHall = (p: number[]) => p[0] >= rx0 && p[0] <= rx1 && p[2] >= rz0 && p[2] <= rz1;
    const items = [
      ...racks.filter((r) => inHall(r.position_xyz_m)).map((r) => ({ p: r.position_xyz_m, yaw: r.yaw_rad ?? 0 })),
      ...ctx.filter((c) => c.hall_id === h.id || inHall(c.position_xyz_m)).map((c) => ({ p: c.position_xyz_m, yaw: c.yaw_rad })),
    ];
    if (!items.length) continue;
    const rowsM = new Map<number, CabRow>();
    for (const it of items) {
      const key = Math.round(it.p[2] * 10);
      const r = rowsM.get(key) ?? { id: `${h.id}:${key}`, z: it.p[2], yaw: it.yaw, x0: Infinity, x1: -Infinity, n: 0 };
      r.x0 = Math.min(r.x0, it.p[0] - dims.w / 2);
      r.x1 = Math.max(r.x1, it.p[0] + dims.w / 2);
      r.n++;
      rowsM.set(key, r);
    }
    const rows = [...rowsM.values()].sort((a, b) => a.z - b.z);
    for (const row of rows) {
      const m = L?.rows?.find((r) => Math.abs(r.z_m - row.z) < 0.3);
      if (m) {
        row.rowId = m.row_id;
        row.rackIds = m.rack_ids;
        // the manifest's own row extent (rack pitch / row length come from the backend, never from a constant)
        if (m.x_min_m !== undefined && m.x_max_m !== undefined) {
          row.x0 = m.x_min_m;
          row.x1 = m.x_max_m;
        }
      }
    }
    let cold: Pod['cold'] = null;
    for (let i = 0; i + 1 < rows.length; i++) {
      const lo = rows[i];
      const hi = rows[i + 1];
      // yaw 0 = front towards +z (see HallDetail legacy convention): a cold aisle lies between two fronts that face each other
      if (near(Math.cos(lo.yaw), 1, 0.3) && near(Math.cos(hi.yaw), -1, 0.3)) {
        cold = { z0: lo.z + dims.d / 2, z1: hi.z - dims.d / 2, rowLo: i, rowHi: i + 1 };
        break;
      }
    }
    const x0 = Math.min(...rows.map((r) => r.x0));
    const x1 = Math.max(...rows.map((r) => r.x1));
    const roads: Road[] = [];
    for (let i = 0; i + 1 < rows.length; i++) {
      const lo = rows[i];
      const hi = rows[i + 1];
      const z0 = lo.z + dims.d / 2;
      const z1 = hi.z - dims.d / 2;
      if (z1 - z0 < 0.8) continue; // rows touching: no road
      const loFront = Math.cos(lo.yaw) >= 0; // front towards +z
      const hiFront = Math.cos(hi.yaw) < 0; // front towards -z
      const mr = L?.roads?.find((r) => Math.abs(r.z_m - (z0 + z1) / 2) < 0.4);
      roads.push({ roadId: mr?.road_id, meta: mr, id: `${h.id}:road${roads.length + 1}`, hallId: h.id, index: roads.length, x0: mr?.x_min_m ?? Math.min(lo.x0, hi.x0), x1: mr?.x_max_m ?? Math.max(lo.x1, hi.x1), z0, z1, width: z1 - z0, kind: loFront && hiFront ? 'cold' : !loFront && !hiFront ? 'hot' : 'service' });
    }
    pods.push({ hallId: h.id, name: h.name, rect: h.rect, x0, x1, rows, cold, roads, dims, racks: racks.filter((r) => inHall(r.position_xyz_m)) });
  }
  const out: SiteModel = { rooms, roads: pods.flatMap((p) => p.roads).sort((a, b) => a.z0 - b.z0 || a.x0 - b.x0), pods, rackDims: dims, docks: topo.assets.filter((a) => a.type === 'dock') };
  cache.set(topo, out);
  return out;
}
