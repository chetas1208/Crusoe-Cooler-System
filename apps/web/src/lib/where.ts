import type { Topology, Vec3 } from '@loopkeeper/core/contracts';

type L = {
  roads?: Array<{ road_id: string; z_m: number; x_min_m: number; x_max_m: number; clear_width_m?: number }>;
  cross_aisles?: Array<{ id: string; x_min_m: number; x_max_m: number }>;
  hall?: { x_min_m: number; x_max_m: number; z_min_m: number; z_max_m: number };
  mechanical_bay?: { room_id: string };
};

/** Where on the manifest does a floor position lie: a ROAD, a cross-aisle (XA-W / XA-E), the mechanical/CDU bay, or the yard. Pure, from /topology. */
export function whereOnFloor(topo: Topology | null | undefined, p: Vec3): string {
  const L = (topo as unknown as { facility_layout_v6?: L } | null | undefined)?.facility_layout_v6;
  if (!L) return `x ${p[0].toFixed(1)} · z ${p[2].toFixed(1)} m`;
  for (const r of L.roads ?? []) if (p[0] >= r.x_min_m - 0.3 && p[0] <= r.x_max_m + 0.3 && Math.abs(p[2] - r.z_m) <= (r.clear_width_m ?? 2.7) / 2 + 0.15) return `${r.road_id} · x ${p[0].toFixed(1)} m`;
  for (const a of L.cross_aisles ?? []) if (p[0] >= a.x_min_m && p[0] <= a.x_max_m) return `${a.id} cross-aisle`;
  const h = L.hall;
  if (h && p[0] < h.x_min_m) return 'yard (outside the hall)';
  if (p[0] < (L.cross_aisles?.[0]?.x_min_m ?? 3.5)) return 'mechanical / CDU bay';
  return `rack hall · z ${p[2].toFixed(1)} m`;
}
