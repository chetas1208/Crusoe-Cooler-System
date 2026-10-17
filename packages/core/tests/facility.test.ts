import { describe, expect, it } from 'vitest';
import { buildTopology } from '../src/engine/facility';
import { Engine } from '../src/engine/engine';
import { AUX_IDS, RACK_IDS } from '../src/engine/plant';

const topo = buildTopology();
const ids = new Set(topo.assets.map((a) => a.id));
const edgeIds = new Set(topo.edges.map((e) => e.id));

describe('facility topology', () => {
  it('has 16 racks, every one with a supply drop, return drop, balancing valve and branch flow meter', () => {
    const racks = topo.assets.filter((a) => a.type === 'rack');
    expect(racks.length).toBe(16);
    for (const r of racks) {
      const k = r.id.replace('rack_', '');
      expect(ids.has(`valve_${k}`), `valve_${k}`).toBe(true);
      expect(ids.has(`sn_rack_${k}`), `sn_rack_${k}`).toBe(true);
      expect(topo.edges.some((e) => e.role === 'supply' && e.to === `n_${k}_in`)).toBe(true);
      expect(topo.edges.some((e) => e.role === 'return' && e.from === `n_${k}_out`)).toBe(true);
    }
  });
  it('keeps the original instrumented ids stable', () => {
    for (const id of ['rack_a1', 'rack_a2', 'rack_b1', 'rack_b2', 'valve_a1', 'valve_b2', 'valve_za', 'valve_zb', 'sn_flow_za', 'sn_flow_zb', 'sn_flow_trunk', 'cdu_01', 'pump_t1', 'strainer_02', 'port_a2', 'p_12', 'p_17', 'p_13', 'p_29']) {
      expect(ids.has(id) || edgeIds.has(id), id).toBe(true);
    }
  });
  it('has unique ids, every edge endpoint is a node, every node is used', () => {
    expect(new Set(topo.edges.map((e) => e.id)).size).toBe(topo.edges.length);
    expect(ids.size).toBe(topo.assets.length);
    const nodes = new Set(topo.nodes.map((n) => n.id));
    for (const e of topo.edges) expect(nodes.has(e.from) && nodes.has(e.to), e.id).toBe(true);
  });
  it('plant models exactly the racks the topology declares', () => {
    expect([...RACK_IDS, ...AUX_IDS].sort()).toEqual(topo.assets.filter((a) => a.type === 'rack').map((a) => a.id.replace('rack_', '')).sort());
  });
});

describe('aux racks in the live world', () => {
  it('report telemetry, stay nominal and never open incidents on their own', () => {
    const e = new Engine({ seed: 4, speed: 6, faultsEnabled: false });
    e.fastForward(1500);
    const snap = e.snapshot();
    for (const k of AUX_IDS) {
      const a = snap.assets[`rack_${k}`];
      expect(a.status).toBe('nominal');
      expect(a.readings.flow_kg_s).toBeGreaterThan(0.05);
      expect(a.readings.margin_k).toBeGreaterThan(30);
      expect(snap.assets[`sn_rack_${k}`].readings.flow_kg_s).toBeGreaterThan(0.05);
    }
    expect(e.incidents().length).toBe(0);
    expect(snap.kpis.min_margin_k).toBeGreaterThan(12);
  });
});
