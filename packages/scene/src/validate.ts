import type { Topology } from '@loopkeeper/core/contracts';

/**
 * Client-side sanity check of the backend manifest. The backend validator is the authority; this only decides whether the
 * scene may draw the cooling network as "valid" (cooling cutaway) and finds the exact edge ids that would look like a stub.
 * Nothing here repairs or invents geometry.
 */
export interface TopologyIssue {
  edge_id: string;
  kind: 'dangling_end' | 'unknown_node' | 'zero_length' | 'length_mismatch' | 'no_bore';
  detail: string;
}

const cache = new WeakMap<object, TopologyIssue[]>();
const TOL_M = 0.005; // backend guarantees 2 mm; allow 5 mm for float formatting

export function topologyIssues(topo: Topology): TopologyIssue[] {
  const hit = cache.get(topo);
  if (hit) return hit;
  const out: TopologyIssue[] = [];
  const nodes = new Map(((topo as unknown as { nodes?: Array<{ id: string; position_xyz_m: number[] }> }).nodes ?? []).map((n) => [n.id, n.position_xyz_m]));
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const e of topo.edges) {
    const c = e.centerline_xyz_m;
    if (c.length < 2) {
      out.push({ edge_id: e.id, kind: 'zero_length', detail: 'fewer than 2 centerline points' });
      continue;
    }
    let len = 0;
    for (let i = 1; i < c.length; i++) len += d(c[i - 1], c[i]);
    if (len < 1e-3) out.push({ edge_id: e.id, kind: 'zero_length', detail: `${len.toFixed(4)} m` });
    // length_m is the filleted run (shorter than the polyline through the corner points); a longer length_m than the polyline is wrong
    if (e.length_m > len + 0.02 + 0.002 * len) out.push({ edge_id: e.id, kind: 'length_mismatch', detail: `centerline ${len.toFixed(3)} m vs length_m ${e.length_m}` });
    if (!(e.diameter_mm > 0)) out.push({ edge_id: e.id, kind: 'no_bore', detail: `diameter_mm=${e.diameter_mm}` });
    for (const [end, nid] of [[c[0], e.from], [c[c.length - 1], e.to]] as const) {
      const p = nodes.get(nid);
      if (!p) out.push({ edge_id: e.id, kind: 'unknown_node', detail: nid });
      else if (d(end, p) > TOL_M) out.push({ edge_id: e.id, kind: 'dangling_end', detail: `end ${d(end, p).toFixed(3)} m from node ${nid}` });
    }
  }
  cache.set(topo, out);
  return out;
}
