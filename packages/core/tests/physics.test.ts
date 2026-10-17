import { describe, expect, it } from 'vitest';
import { AUX_IDS, RACK_IDS, createPlant, initialControls, initialFaults, solveHydraulics, stepPlant } from '../src/engine/plant';

describe('hydraulics', () => {
  it('closes head and conserves mass in nominal operation', () => {
    const h = solveHydraulics({ faults: initialFaults(), controls: initialControls() });
    expect(h.residual).toBeLessThan(1e-9);
    expect(h.zoneQ.a + h.zoneQ.b).toBeCloseTo(h.tcsQ, 9);
    expect(RACK_IDS.reduce((a, r) => a + h.rackQ[r], 0) + AUX_IDS.reduce((a, k) => a + h.auxQ[k], 0)).toBeCloseTo(h.tcsQ, 9);
  });

  it('fouling a zone header shifts flow to the other zone and raises that header ΔP', () => {
    const base = solveHydraulics({ faults: initialFaults(), controls: initialControls() });
    const f = initialFaults();
    f.occl.p_17 = 0.55;
    const h = solveHydraulics({ faults: f, controls: initialControls() });
    expect(h.zoneQ.b).toBeLessThan(base.zoneQ.b * 0.9);
    expect(h.zoneQ.a).toBeGreaterThan(base.zoneQ.a);
    expect(h.dp.p_17).toBeGreaterThan(base.dp.p_17 * 3);
    expect(h.residual).toBeLessThan(1e-9);
  });

  it('isolating a zone removes its flow', () => {
    const c = initialControls();
    c.isolated.valve_zb = true;
    const h = solveHydraulics({ faults: initialFaults(), controls: c });
    expect(h.zoneQ.b).toBe(0);
    expect(h.rackQ.b1 + h.rackQ.b2).toBe(0);
  });

  it('a heavier restriction never makes a rack run cooler (thermal causality)', () => {
    const run = (o: number) => {
      const { state } = createPlant(3);
      state.faults.occl.p_17 = o;
      for (let t = 0; t < 400; t += 0.5) stepPlant(state, 0.5);
      return state.temps.chip.b1;
    };
    expect(run(0.7)).toBeGreaterThan(run(0.3));
    expect(run(0.3)).toBeGreaterThanOrEqual(run(0) - 0.3);
  });

  it('sensor drift changes measurements only, never true flow', () => {
    const { state } = createPlant(3);
    const before = state.hyd.zoneQ.b;
    state.faults.sensorDriftRate.sn_flow_zb = 0.01;
    for (let t = 0; t < 200; t += 0.5) stepPlant(state, 0.5);
    expect(state.faults.sensorOffset.sn_flow_zb).toBeGreaterThan(1);
    expect(state.hyd.zoneQ.b).toBeCloseTo(before, 6);
  });
});
