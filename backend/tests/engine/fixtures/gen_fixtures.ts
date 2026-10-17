// Regenerates topology.json + golden.json from the TypeScript reference (run from repo root: node_modules/.bin/tsx backend/tests/engine/fixtures/gen_fixtures.ts)
import { writeFileSync } from 'node:fs';
import { buildTopology, HALL } from '../../../../packages/core/src/engine/facility';
import { PipeGraph, NavGrid } from '../../../../packages/core/src/engine/robots';
import { buildPath, samplePath } from '../../../../packages/core/src/geometry';

const here = new URL('.', import.meta.url).pathname;
const topo = buildTopology();
writeFileSync(here + 'topology.json', JSON.stringify(topo));
const g = new PipeGraph(topo);
const nav = new NavGrid(topo, HALL);
const golden: any = { paths: {}, routes: [], nav: [] };
for (const e of topo.edges) {
  const p = buildPath(e.centerline_xyz_m, e.fillet_radius_m);
  const L = p.length;
  golden.paths[e.id] = { length: L, samples: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ s: L * f, p: samplePath(p, L * f).p, t: samplePath(p, L * f).t })) };
}
const q: Array<[any, any]> = [
  [{ edge_id: 'p_10', s: 0.5 }, { edge_id: 'p_17', s: 3.2 }],
  [{ edge_id: 'p_10', s: 0.5 }, { edge_id: 'p_22', s: 2.0 }],
  [{ edge_id: 'p_17', s: 7.9 }, { edge_id: 'p_20', s: 1.0 }],
  [{ edge_id: 'p_01', s: 0.6 }, { edge_id: 'p_17', s: 1 }],
];
for (const [a, b] of q) {
  const r = g.route(a, b);
  golden.routes.push({ from: a, to: b, length: r ? r.length : null, legs: r ? r.legs : null });
}
const nq: Array<[any, any]> = [
  [[8.3, 0, 0], [-5.3, 0, -1.5]],
  [[8.3, 0, 0], [-3.1, 0, 1.55]],
  [[8.3, 0, 0], [-7.0, 0, -3.0]],
];
for (const [a, b] of nq) golden.nav.push({ from: a, to: b, path: nav.route(a, b) });
writeFileSync(here + 'golden.json', JSON.stringify(golden));
console.log('ok');
