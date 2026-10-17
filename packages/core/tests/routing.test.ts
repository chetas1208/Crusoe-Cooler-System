import { describe, expect, it } from 'vitest';
import { buildTopology, HALL } from '../src/engine/facility';
import { NavGrid, PipeGraph } from '../src/engine/robots';
import { buildPath, samplePath } from '../src/geometry';

const topo = buildTopology();
const graph = new PipeGraph(topo);

describe('crawler routing (pipe graph)', () => {
  it('finds a legal route from PORT-A2 to the middle of P-17', () => {
    const a2 = topo.assets.find((a) => a.id === 'port_a2')!;
    const r = graph.route({ edge_id: a2.edge_id!, s: a2.s_m! }, { edge_id: 'p_17', s: 4.5 });
    expect(r).not.toBeNull();
    expect(r!.legs.map((l) => l.edge_id)).toEqual(['p_10', 'p_17']);
    expect(r!.length).toBeGreaterThan(8);
    expect(r!.length).toBeLessThan(20);
  });

  it('refuses non-passable branches (rack drops) — no crawler access', () => {
    expect(graph.route({ edge_id: 'p_10', s: 1 }, { edge_id: 'p_18', s: 0.2 })).toBeNull();
    expect(topo.edges.find((e) => e.id === 'p_18')!.not_passable_reason).toBeTruthy();
  });

  it('keeps loops separate: supply side cannot reach the facility-water ring', () => {
    expect(graph.route({ edge_id: 'p_10', s: 1 }, { edge_id: 'p_02', s: 1 })).toBeNull();
  });
});

describe('OUTRIG routing (nav grid)', () => {
  const nav = new NavGrid(topo, HALL);
  it('plans around racks and the CDU without entering an obstacle', () => {
    const route = nav.route([8.3, 0, 0], nav.snap([-5.3, 0, -1.5]));
    expect(route).not.toBeNull();
    const r = 0.5;
    for (const [x, , z] of route!) {
      for (const o of topo.nav.obstacles) {
        const [x0, z0, x1, z1] = o.rect;
        expect(x > x0 - r + 0.2 && x < x1 + r - 0.2 && z > z0 - r + 0.2 && z < z1 + r - 0.2).toBe(false);
      }
    }
  });
});

describe('geometry', () => {
  it('filleted paths are continuous and slightly shorter than sharp ones', () => {
    const sharp = buildPath([[0, 0, 0], [4, 0, 0], [4, 0, 4]], 0);
    const round = buildPath([[0, 0, 0], [4, 0, 0], [4, 0, 4]], 0.4);
    expect(round.length).toBeLessThan(sharp.length);
    expect(samplePath(round, 0).p).toEqual([0, 0, 0]);
    const end = samplePath(round, round.length).p;
    expect(end[0]).toBeCloseTo(4);
    expect(end[2]).toBeCloseTo(4);
  });
});
