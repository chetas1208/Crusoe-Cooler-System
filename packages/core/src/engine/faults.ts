import type { FaultKind } from '../contracts';
import type { Rng } from '../geometry';
import { RACK_IDS, type PlantState, type RackKey } from './plant';

/**
 * Seeded stochastic fault arrival + progression. Faults are wear/process driven
 * ("not AI deciding to cause damage"); the seed is logged in engine health so a
 * run can be reproduced. Engineering test controls can force a specific fault but
 * go through the same progression code.
 */

interface Proc {
  id: string;
  kind: FaultKind;
  target: string;
  t0: number;
  active: boolean;
  /** kind-specific parameters */
  p: Record<string, number>;
}

export interface FaultOnset {
  kind: FaultKind;
  target: string;
  at: number;
}

const WEIGHTS: Array<[FaultKind, number]> = [
  ['fouling', 0.3],
  ['strainer_blockage', 0.14],
  ['valve_stuck', 0.17],
  ['pump_degradation', 0.11],
  ['sensor_drift', 0.14],
  ['workload_spike', 0.14],
];

export class FaultManager {
  private procs: Proc[] = [];
  private nextAt: number;
  private seq = 0;
  private cool = new Map<string, number>();
  readonly onsets: FaultOnset[] = [];

  constructor(
    private plant: PlantState,
    private rng: Rng,
    private opts: { firstFaultS: [number, number]; meanGapS: number; enabled: boolean },
    private lengths: Record<string, number> = {},
  ) {
    this.nextAt = rng.range(opts.firstFaultS[0], opts.firstFaultS[1]);
  }

  /** targets currently carrying an un-repaired fault (so we never stack on the same thing) */
  busyTargets(): Set<string> {
    const busy = new Set(this.procs.filter((p) => p.active).map((p) => p.target));
    for (const [t, until] of this.cool) if (until > this.plant.time) busy.add(t);
    return busy;
  }

  /** Stop a fault process (repair done). The target cools down so it cannot instantly re-fault. */
  halt(target: string) {
    for (const p of this.procs) if (p.target === target) p.active = false;
    this.cool.set(target, this.plant.time + 900);
  }

  step(dt: number, openIncidents: number) {
    const t = this.plant.time;
    const f = this.plant.faults;

    if (this.opts.enabled && t >= this.nextAt && openIncidents < 2) {
      const kind = this.drawKind();
      const began = this.begin(kind);
      // exponential gap with a floor so incidents never pile up unrealistically
      this.nextAt = began ? t + Math.max(180, -Math.log(1 - this.rng.next()) * this.opts.meanGapS) : t + 60;
    }

    for (const p of this.procs) {
      if (!p.active) continue;
      switch (p.kind) {
        case 'fouling':
        case 'strainer_blockage': {
          const cur = f.occl[p.target] ?? 0;
          const rate = (p.p.omax / p.p.tau) * (1 - cur / p.p.omax);
          f.occl[p.target] = Math.min(cur + Math.max(rate, 0) * dt, p.p.omax);
          break;
        }
        case 'pump_degradation': {
          const cur = f.pumpHealth[p.target] ?? 1;
          f.pumpHealth[p.target] = Math.max(p.p.hend, cur - ((1 - p.p.hend) / p.p.duration) * dt);
          break;
        }
        case 'sensor_drift': {
          const cur = f.sensorOffset[p.target] ?? 0;
          if (Math.abs(cur) >= p.p.cap) {
            f.sensorDriftRate[p.target] = 0;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private drawKind(): FaultKind {
    const total = WEIGHTS.reduce((a, [, w]) => a + w, 0);
    let r = this.rng.next() * total;
    for (const [k, w] of WEIGHTS) {
      r -= w;
      if (r <= 0) return k;
    }
    return 'fouling';
  }

  /** Begin a fault of a given kind. target optional (drawn when omitted). */
  begin(kind: FaultKind, target?: string) {
    const f = this.plant.faults;
    const t = this.plant.time;
    const busy = this.busyTargets();
    const id = `f_${++this.seq}`;
    const rng = this.rng;
    const pickFree = <T extends string>(xs: readonly T[]): T | null => {
      const free = xs.filter((x) => !busy.has(x));
      return free.length ? rng.pick(free) : null;
    };
    const weighted = (xs: Array<[string, number]>): string | null => {
      const arr = xs.filter(([x]) => !busy.has(x));
      if (!arr.length) return null;
      const total = arr.reduce((a, [, w]) => a + w, 0);
      let r = rng.next() * total;
      for (const [x, w] of arr) {
        r -= w;
        if (r <= 0) return x;
      }
      return arr[0][0];
    };

    switch (kind) {
      case 'fouling': {
        const e = target ?? weighted([['p_17', 0.6], ['p_12', 0.4]]);
        if (!e) return '';
        this.procs.push({ id, kind, target: e, t0: t, active: true, p: { omax: rng.range(0.6, 0.78), tau: rng.range(70, 115) } });
        f.occl[e] = f.occl[e] ?? 0.01;
        f.occlS[e] = (this.lengths[e] ?? 6) * rng.range(0.38, 0.68);
        this.onsets.push({ kind, target: e, at: t });
        return e;
      }
      case 'strainer_blockage': {
        const s = target ?? weighted([['strainer_02', 0.55], ['strainer_01', 0.45]]);
        if (!s) return '';
        this.procs.push({ id, kind, target: s, t0: t, active: true, p: { omax: rng.range(0.65, 0.82), tau: rng.range(170, 240) } });
        f.occl[s] = f.occl[s] ?? 0.01;
        this.onsets.push({ kind, target: s, at: t });
        return s;
      }
      case 'valve_stuck': {
        const r = (target?.replace('valve_', '') as RackKey | undefined) ?? pickFree(RACK_IDS.filter((k) => !busy.has(`valve_${k}`)) as RackKey[]);
        if (!r) return '';
        f.valveStuck[r] = rng.range(0.12, 0.3);
        this.procs.push({ id, kind, target: `valve_${r}`, t0: t, active: true, p: {} });
        this.onsets.push({ kind, target: `valve_${r}`, at: t });
        return `valve_${r}`;
      }
      case 'pump_degradation': {
        const pump = target ?? this.plant.controls.tcsDuty;
        this.procs.push({ id, kind, target: pump, t0: t, active: true, p: { hend: rng.range(0.2, 0.4), duration: rng.range(110, 160) } });
        this.onsets.push({ kind, target: pump, at: t });
        return pump;
      }
      case 'sensor_drift': {
        const s = target ?? pickFree(['sn_flow_za', 'sn_flow_zb', 'sn_flow_trunk'] as const);
        if (!s) return '';
        const sign = rng.next() < 0.5 ? -1 : 1;
        f.sensorDriftRate[s] = sign * rng.range(0.0045, 0.0075);
        this.procs.push({ id, kind, target: s, t0: t, active: true, p: { cap: rng.range(0.5, 0.75) } });
        this.onsets.push({ kind, target: s, at: t });
        return s;
      }
      case 'workload_spike': {
        const r = (target?.replace('rack_', '') as RackKey | undefined) ?? pickFree(RACK_IDS.filter((k) => !busy.has(`rack_${k}`)) as RackKey[]);
        if (!r) return '';
        f.spike[r] = { extra: rng.range(0.17, 0.24), until: t + rng.range(200, 280) };
        this.procs.push({ id, kind, target: `rack_${r}`, t0: t, active: false, p: {} });
        this.onsets.push({ kind, target: `rack_${r}`, at: t });
        return `rack_${r}`;
      }
      default:
        return '';
    }
  }
}
