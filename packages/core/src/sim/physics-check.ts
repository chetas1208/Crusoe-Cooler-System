import { createPlant, stepPlant, healthyReference, RACK_IDS, CHIP_LIMIT } from '../engine/plant';

function run(label: string, mut: (s: ReturnType<typeof createPlant>['state']) => void, secs = 400) {
  const { state } = createPlant(7);
  mut(state);
  for (let t = 0; t < secs; t += 0.5) stepPlant(state, 0.5);
  const h = state.hyd;
  const ref = healthyReference(state);
  const chips = RACK_IDS.map((r) => `${r}:${state.temps.chip[r].toFixed(1)}`).join(' ');
  console.log(
    `${label.padEnd(26)} tcsQ=${h.tcsQ.toFixed(2)} zA=${h.zoneQ.a.toFixed(2)} zB=${h.zoneQ.b.toFixed(2)} fwsQ=${h.fwsQ.toFixed(2)} ` +
      `Tsup=${state.temps.tcsSupply.toFixed(1)} Tret=${state.temps.tcsReturn.toFixed(1)} hx=${state.temps.hxDuty.toFixed(0)} | chip ${chips} margin=${(CHIP_LIMIT - Math.max(...RACK_IDS.map((r) => state.temps.chip[r]))).toFixed(1)} | dp17=${h.dp.p_17.toFixed(2)} (ref ${ref.dp.p_17.toFixed(2)}) resid=${h.residual.toExponential(1)}`,
  );
}
run('nominal', () => {});
for (const o of [0.2, 0.35, 0.5, 0.6, 0.7]) run(`p_17 fouling o=${o}`, (s) => (s.faults.occl.p_17 = o));
for (const o of [0.4, 0.6, 0.8]) run(`strainer_01 o=${o}`, (s) => (s.faults.occl.strainer_01 = o));
for (const o of [0.4, 0.6, 0.8]) run(`strainer_02 o=${o}`, (s) => (s.faults.occl.strainer_02 = o));
run('valve_b1 stuck 0.3', (s) => (s.faults.valveStuck.b1 = 0.3));
run('valve_b1 stuck 0.15', (s) => (s.faults.valveStuck.b1 = 0.15));
run('pump_t1 health 0.5', (s) => (s.faults.pumpHealth.pump_t1 = 0.5));
run('pump_t1 health 0.2', (s) => (s.faults.pumpHealth.pump_t1 = 0.2));
run('rack b1 spike +35%', (s) => (s.faults.spike.b1 = { extra: 0.35, until: 1e9 }));
run('zone B isolated (no cordon)', (s) => (s.controls.isolated.valve_zb = true));
