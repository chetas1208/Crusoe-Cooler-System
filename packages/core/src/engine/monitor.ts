import type { AssetState, AssetStatus, FaultKind, Kpis, Severity, Topology } from '../contracts';
import { clamp, createRng, type Rng } from '../geometry';
import { SLOT_BY_KEY } from './layout';
import {
  CHIP_LIMIT,
  CP_FWS,
  CP_TCS,
  K,
  NOISE,
  PUMP_T,
  AUX_IDS,
  RACK_IDS,
  ZONE_OF,
  ZONE_OF_ANY,
  foulFactor,
  healthyReference,
  noisy,
  solveHydraulics,
  type Hydraulics,
  type PlantState,
  type RackKey,
} from './plant';

/**
 * Deterministic anomaly monitor (backend.md §5 step 8: "never LLM on each tick").
 *
 * It sees only *measurements* (truth + bounded noise + sensor drift) and compares
 * them against a healthy digital twin that shares the current setpoints. Residuals
 * that persist become detections; detections become incidents.
 */

const EDGE_FLOW: Record<string, (h: Hydraulics) => number> = {
  ...Object.fromEntries(
    [...RACK_IDS, ...AUX_IDS].flatMap((k) => {
      const f = (h: Hydraulics) => (h.rackQ as Record<string, number>)[k] ?? h.auxQ[k] ?? 0;
      return [[SLOT_BY_KEY[k].supEdge, f], [SLOT_BY_KEY[k].retEdge, f]];
    }),
  ),
  p_01: (h) => h.fwsQ,
  p_02: (h) => h.fwsQ,
  p_03: (h) => h.fwsQ,
  p_10: (h) => h.tcsQ,
  p_20: (h) => h.tcsQ,
  p_12: (h) => h.zoneQ.a,
  p_22: (h) => h.zoneQ.a,
  p_17: (h) => h.zoneQ.b,
  p_27: (h) => h.zoneQ.b,
};
export const edgeFlow = (h: Hydraulics, id: string) => EDGE_FLOW[id]?.(h) ?? 0;

const FOUL_WATCH = ['p_10', 'p_12', 'p_17', 'p_22', 'p_27', 'p_20', 'p_02'];

export interface Meas {
  t: number;
  rackFlow: Record<RackKey, number>;
  rackChip: Record<RackKey, number>;
  rackOut: Record<RackKey, number>;
  rackPower: Record<RackKey, number>;
  /** auxiliary (network / storage / CPU) racks, keyed by slot key */
  auxFlow: Record<string, number>;
  auxChip: Record<string, number>;
  auxOut: Record<string, number>;
  auxPower: Record<string, number>;
  edgeFlow: Record<string, number>;
  edgeDp: Record<string, number>;
  strainerDp: { strainer_01: number; strainer_02: number };
  tcsSupply: number;
  tcsReturn: number;
  fwsIn: number;
  fwsOut: number;
  tcsQ: number;
  fwsQ: number;
  pumpHead: { tcs: number; fws: number };
  hxDuty: number;
}

export interface Detection {
  key: string;
  cause: FaultKind;
  target_id: string;
  severity: Severity;
  title: string;
  summary: string;
  affected: string[];
  anchor_id: string;
  evidence: string[];
}

export interface MonitorOutput {
  assets: Record<string, AssetState>;
  kpis: Omit<Kpis, 'open_incidents' | 'resolved_incidents'>;
  detections: Detection[];
  /** healthy-twin reference flows (for evidence & verification) */
  ref: Hydraulics;
  minMargin: number;
}

const PERSIST = 8; // monitor ticks (2 sim-s each) an anomaly must persist before it can open an incident

export class Monitor {
  /** design resistance per edge (kPa/(kg/s)²) from the healthy twin */
  readonly kDesign: Record<string, number> = {};
  private streak: Record<string, number> = {};
  private loadEma: Record<RackKey, number>;
  /** independent noise stream for aux racks so adding them never perturbs the seeded fault/measurement sequence */
  private auxRng = createRng(0xa11c5);
  last!: MonitorOutput;
  meas!: Meas;

  constructor(
    private topo: Topology,
    private plant: PlantState,
    private rng: Rng,
  ) {
    const ref = solveHydraulics({ faults: plant.faults, controls: plant.controls, healthy: true });
    for (const e of topo.edges) {
      const q = edgeFlow(ref, e.id);
      if (q > 0.01) this.kDesign[e.id] = (ref.dp[e.id] ?? 0) / (q * q);
    }
    this.loadEma = { ...plant.load };
    this.meas = this.measure();
    this.last = this.evaluate(new Set());
  }

  /* ── measurement: truth + noise + drift ── */
  measure(): Meas {
    const p = this.plant;
    const h = p.hyd;
    const r = this.rng;
    const off = p.faults.sensorOffset;
    const m: Meas = {
      t: p.time,
      rackFlow: {} as Record<RackKey, number>,
      rackChip: {} as Record<RackKey, number>,
      rackOut: {} as Record<RackKey, number>,
      rackPower: {} as Record<RackKey, number>,
      auxFlow: {},
      auxChip: {},
      auxOut: {},
      auxPower: {},
      edgeFlow: {},
      edgeDp: {},
      strainerDp: { strainer_01: 0, strainer_02: 0 },
      tcsSupply: noisy(r, p.temps.tcsSupply, NOISE.temp),
      tcsReturn: noisy(r, p.temps.tcsReturn, NOISE.temp),
      fwsIn: noisy(r, p.temps.fwsIn, NOISE.temp),
      fwsOut: noisy(r, p.temps.fwsOut, NOISE.temp),
      tcsQ: noisy(r, h.tcsQ, NOISE.flow) + (off['sn_flow_trunk'] ?? 0),
      fwsQ: noisy(r, h.fwsQ, NOISE.flow * 2),
      pumpHead: { tcs: noisy(r, h.pumpHead.tcs, 0.6), fws: noisy(r, h.pumpHead.fws, 0.6) },
      hxDuty: noisy(r, p.temps.hxDuty, 2),
    };
    for (const k of RACK_IDS) {
      m.rackFlow[k] = Math.max(noisy(r, h.rackQ[k], NOISE.flow), 0);
      m.rackChip[k] = noisy(r, p.temps.chip[k], NOISE.temp);
      m.rackOut[k] = noisy(r, p.temps.rackOut[k], NOISE.temp);
      m.rackPower[k] = noisy(r, p.load[k], NOISE.power);
    }
    const ar = this.auxRng;
    for (const k of AUX_IDS) {
      m.auxFlow[k] = Math.max(noisy(ar, h.auxQ[k], NOISE.flow * 0.5), 0);
      m.auxChip[k] = noisy(ar, p.temps.auxChip[k], NOISE.temp);
      m.auxOut[k] = noisy(ar, p.temps.auxOut[k], NOISE.temp);
      m.auxPower[k] = Math.max(noisy(ar, p.auxLoad[k], NOISE.power * 0.3), 0);
    }
    for (const e of this.topo.edges) {
      let q = edgeFlow(h, e.id);
      if (e.id === 'p_12') q += off['sn_flow_za'] ?? 0;
      if (e.id === 'p_17') q += off['sn_flow_zb'] ?? 0;
      if (e.id === 'p_10') q += off['sn_flow_trunk'] ?? 0;
      m.edgeFlow[e.id] = Math.max(noisy(r, q, NOISE.flow), 0);
      m.edgeDp[e.id] = Math.max(noisy(r, h.dp[e.id] ?? 0, NOISE.dp), 0);
    }
    m.strainerDp.strainer_01 = Math.max(noisy(r, h.strainerDp.strainer_01, NOISE.dp), 0);
    m.strainerDp.strainer_02 = Math.max(noisy(r, h.strainerDp.strainer_02, NOISE.dp), 0);
    this.meas = m;
    return m;
  }

  /** Flow used for hydraulic residuals: redundant rack meters beat a (possibly drifting) header meter. */
  flowEst(edgeId: string, m: Meas = this.meas) {
    const sum = (zone: 'a' | 'b' | null) => zoneFlow(m, zone);
    if (edgeId === 'p_12' || edgeId === 'p_22') return sum('a');
    if (edgeId === 'p_17' || edgeId === 'p_27') return sum('b');
    if (edgeId === 'p_10' || edgeId === 'p_20') return sum(null);
    return m.edgeFlow[edgeId];
  }

  dpRatio(edgeId: string, m: Meas = this.meas) {
    const k = this.kDesign[edgeId];
    const q = Math.max(this.flowEst(edgeId, m), 0.25);
    if (!k) return 1;
    return Math.max(m.edgeDp[edgeId], 0.01) / (k * q * q);
  }

  strainerRatio(id: 'strainer_01' | 'strainer_02', m: Meas = this.meas) {
    const k = id === 'strainer_01' ? K.fwsStrainer : K.tcsStrainer;
    const q = id === 'strainer_01' ? Math.max(m.fwsQ, 0.5) : Math.max(this.flowEst('p_10', m), 0.5);
    return Math.max(m.strainerDp[id], 0.01) / (k * q * q);
  }

  /** measured thermal margin, K */
  margin(k: RackKey, m: Meas = this.meas) {
    return CHIP_LIMIT - m.rackChip[k];
  }

  /* ── evaluate: statuses, kpis, detections ── */
  evaluate(suppressed: Set<string>): MonitorOutput {
    const p = this.plant;
    const m = this.meas;
    const topo = this.topo;
    const ref = healthyReference(p);
    const { margin_warn_k: warnK, margin_crit_k: critK } = topo.limits;
    const assets: Record<string, AssetState> = {};
    const detections: Detection[] = [];
    const hit = (key: string, cond: boolean) => {
      this.streak[key] = cond ? (this.streak[key] ?? 0) + 1 : 0;
      return (this.streak[key] ?? 0) >= PERSIST;
    };
    const isolated = p.controls.isolated;
    const zoneOff = (z: 'a' | 'b') => !!isolated[`valve_z${z}`];

    // load baseline (slow EMA) for workload-spike detection
    for (const k of RACK_IDS) if (p.controls.loadFactor[k] >= 0.98) this.loadEma[k] += (m.rackPower[k] - this.loadEma[k]) * 0.004;

    /* racks */
    const deficit: Record<RackKey, number> = { a1: 0, a2: 0, b1: 0, b2: 0 };
    let minMargin = 99;
    for (const k of RACK_IDS) {
      const refQ = ref.rackQ[k];
      deficit[k] = refQ > 0.2 ? (refQ - m.rackFlow[k]) / refQ : 0;
      const margin = this.margin(k, m);
      minMargin = Math.min(minMargin, margin);
      const offline = p.load[k] < 30 || zoneOff(ZONE_OF[k]) || !!isolated[`valve_${k}`];
      let status: AssetStatus = margin < critK ? 'critical' : margin < warnK ? 'warning' : deficit[k] > 0.1 ? 'watch' : 'nominal';
      if (offline && margin > warnK) status = 'isolated';
      assets[`rack_${k}`] = {
        status,
        readings: {
          power_kw: m.rackPower[k],
          flow_kg_s: m.rackFlow[k],
          t_in_c: m.tcsSupply,
          t_out_c: m.rackOut[k],
          t_chip_c: m.rackChip[k],
          margin_k: margin,
        },
      };
    }

    /* auxiliary racks: telemetry and status only (no detectors) */
    for (const k of AUX_IDS) {
      const margin = CHIP_LIMIT - m.auxChip[k];
      const zOff = zoneOff(ZONE_OF_ANY(k));
      const status: AssetStatus = zOff ? 'isolated' : margin < critK ? 'critical' : margin < warnK ? 'warning' : 'nominal';
      assets[`rack_${k}`] = {
        status,
        readings: { power_kw: m.auxPower[k], flow_kg_s: m.auxFlow[k], t_in_c: m.tcsSupply, t_out_c: m.auxOut[k], t_chip_c: m.auxChip[k], margin_k: margin },
      };
      assets[`valve_${k}`] = { status: zOff ? 'isolated' : 'nominal', readings: { opening_pct: zOff ? 0 : 85, flow_kg_s: m.auxFlow[k] } };
    }
    for (const k of [...RACK_IDS, ...AUX_IDS]) {
      const q = (RACK_IDS as readonly string[]).includes(k) ? m.rackFlow[k as RackKey] : m.auxFlow[k];
      assets[`sn_rack_${k}`] = { status: 'nominal', readings: { flow_kg_s: q } };
    }

    /* pipes */
    for (const e of topo.edges) {
      const q = m.edgeFlow[e.id];
      const area = Math.PI * (e.diameter_mm / 2000) ** 2;
      const rho = e.loop === 'fws' ? 997 : 1025;
      const ratio = FOUL_WATCH.includes(e.id) ? this.dpRatio(e.id, m) : 1;
      const lockedOff = (e.zone_id === 'zone_a' && zoneOff('a')) || (e.zone_id === 'zone_b' && zoneOff('b'));
      const status: AssetStatus = lockedOff ? 'isolated' : ratio > 5 ? 'critical' : ratio > 2.5 ? 'warning' : ratio > 1.6 ? 'watch' : 'nominal';
      assets[e.id] = {
        status,
        readings: { flow_kg_s: q, dp_kpa: m.edgeDp[e.id], velocity_m_s: q / (rho * area) },
        fault: p.faults.occl[e.id] ? { occlusion: p.faults.occl[e.id], location_s_m: p.faults.occlS[e.id] } : undefined,
      };
    }

    /* strainers */
    for (const id of ['strainer_01', 'strainer_02'] as const) {
      const ratio = this.strainerRatio(id, m);
      assets[id] = {
        status: ratio > 4 ? 'critical' : ratio > 2.6 ? 'warning' : ratio > 1.9 ? 'watch' : 'nominal',
        readings: { strainer_dp_kpa: m.strainerDp[id], flow_kg_s: id === 'strainer_01' ? m.fwsQ : m.tcsQ },
        fault: p.faults.occl[id] ? { occlusion: p.faults.occl[id] } : undefined,
      };
    }

    /* pumps */
    for (const id of ['pump_t1', 'pump_t2', 'pump_f1', 'pump_f2']) {
      const tcs = id.startsWith('pump_t');
      const duty = tcs ? p.controls.tcsDuty === id : p.controls.fwsDuty === id;
      const q = tcs ? m.tcsQ : m.fwsQ;
      const speed = tcs ? p.controls.tcsSpeed : p.controls.fwsSpeed;
      const health = p.faults.pumpHealth[id] ?? 1;
      const vib = p.vib[id] + this.rng.normal() * 0.04;
      const serviced = !!isolated[id];
      assets[id] = {
        status: serviced ? 'service' : !duty ? 'nominal' : vib > 6 ? 'warning' : vib > 3.2 ? 'watch' : 'nominal',
        readings: {
          speed_pct: duty ? speed * 100 : 0,
          head_kpa: duty ? (tcs ? m.pumpHead.tcs : m.pumpHead.fws) : 0,
          flow_kg_s: duty ? q : 0,
          vibration_mm_s: Math.max(vib, 0),
        },
        fault: health < 0.995 ? { health } : undefined,
      };
    }

    /* valves */
    for (const k of RACK_IDS) {
      const cmd = p.controls.valveCmd[k];
      const eff = p.faults.valveStuck[k] ?? cmd;
      assets[`valve_${k}`] = {
        status: isolated[`valve_${k}`] ? 'service' : deficit[k] > 0.12 && this.dpRatio(`p_${k === 'a1' ? 12 : k === 'a2' ? 12 : 17}`, m) < 1.3 ? 'watch' : 'nominal',
        readings: { opening_pct: cmd * 100, flow_kg_s: m.rackFlow[k] },
        fault: eff !== cmd ? { opening: eff, commanded_opening: cmd } : undefined,
      };
    }
    for (const z of ['a', 'b'] as const) {
      assets[`valve_z${z}`] = {
        status: isolated[`valve_z${z}`] ? 'isolated' : 'nominal',
        readings: { opening_pct: isolated[`valve_z${z}`] ? 0 : 100, flow_kg_s: m.edgeFlow[z === 'a' ? 'p_12' : 'p_17'] },
      };
    }

    /* sensors */
    const racksSum = (z: 'a' | 'b') => zoneFlow(m, z);
    const trunkRacks = zoneFlow(m, null);
    const sensorDev: Record<string, number> = {
      sn_flow_za: m.edgeFlow.p_12 - racksSum('a'),
      sn_flow_zb: m.edgeFlow.p_17 - racksSum('b'),
      sn_flow_trunk: m.edgeFlow.p_10 - trunkRacks,
    };
    for (const id of Object.keys(sensorDev)) {
      const rel = Math.abs(sensorDev[id]) / Math.max(id === 'sn_flow_trunk' ? trunkRacks : racksSum(id.endsWith('za') ? 'a' : 'b'), 0.5);
      const suspect = rel > 0.05;
      const edge = id === 'sn_flow_za' ? 'p_12' : id === 'sn_flow_zb' ? 'p_17' : 'p_10';
      assets[id] = {
        status: suspect ? (rel > 0.12 ? 'warning' : 'watch') : 'nominal',
        readings: { flow_kg_s: m.edgeFlow[edge] },
        suspect: suspect ? ['flow_kg_s'] : undefined,
      };
      if (suspect && assets[edge]) assets[edge].suspect = ['flow_kg_s'];
    }

    /* CDU */
    const approach = m.tcsSupply - m.fwsIn;
    assets.cdu_01 = {
      status: approach > 9 ? 'warning' : approach > 7.5 ? 'watch' : 'nominal',
      readings: {
        heat_duty_kw: m.hxDuty,
        tcs_supply_c: m.tcsSupply,
        tcs_return_c: m.tcsReturn,
        fws_in_c: m.fwsIn,
        fws_out_c: m.fwsOut,
        approach_k: approach,
        tcs_flow_kg_s: m.tcsQ,
        fws_flow_kg_s: m.fwsQ,
      },
    };
    assets.chiller_01 = { status: 'nominal', readings: { fws_in_c: m.fwsIn, fws_out_c: m.fwsOut } };

    /* ── detectors ── */
    const sup = (id: string) => suppressed.has(id);

    // fouling (passable pipes)
    for (const e of FOUL_WATCH) {
      const ratio = this.dpRatio(e, m);
      const live = this.flowEst(e, m) > 0.4 && !sup(e);
      if (hit(`fouling:${e}`, live && ratio > 1.6)) {
        const edge = topo.edges.find((x) => x.id === e)!;
        const zone = edge.zone_id;
        const affected = [e, ...(zone ? topo.zones.find((z) => z.id === zone)!.rack_ids : RACK_IDS.map((r) => `rack_${r}`))];
        const zoneKey = zone === 'zone_a' ? 'a' : zone === 'zone_b' ? 'b' : null;
        const margins = (zoneKey ? RACK_IDS.filter((r) => ZONE_OF[r] === zoneKey) : [...RACK_IDS]).map((r) => this.margin(r, m));
        const worst = Math.min(...margins);
        detections.push({
          key: `fouling:${e}`,
          cause: 'fouling',
          target_id: e,
          severity: worst < critK ? 'critical' : worst < warnK ? 'warning' : 'watch',
          title: `${edge.label} pressure drop rising`,
          summary: `ΔP across ${edge.label} is ${ratio.toFixed(1)}× design at ${this.flowEst(e, m).toFixed(2)} kg/s — progressive restriction suspected.`,
          affected,
          anchor_id: e,
          evidence: [`ΔP ${m.edgeDp[e].toFixed(1)} kPa vs ${(this.kDesign[e] * this.flowEst(e, m) ** 2).toFixed(1)} kPa expected`],
        });
      }
    }

    // strainer blockage
    for (const id of ['strainer_01', 'strainer_02'] as const) {
      const ratio = this.strainerRatio(id, m);
      if (hit(`strainer:${id}`, ratio > 2.1 && !sup(id))) {
        const fws = id === 'strainer_01';
        const worst = Math.min(...RACK_IDS.map((r) => this.margin(r, m)));
        detections.push({
          key: `strainer:${id}`,
          cause: 'strainer_blockage',
          target_id: id,
          severity: worst < critK ? 'critical' : worst < warnK ? 'warning' : 'watch',
          title: `${id === 'strainer_01' ? 'S-01' : 'S-02'} strainer ΔP rising`,
          summary: `Strainer ΔP is ${ratio.toFixed(1)}× design; ${fws ? 'facility-water' : 'technology-cooling'} flow is down ${Math.round(100 * (1 - (fws ? m.fwsQ / ref.fwsQ : m.tcsQ / ref.tcsQ)))}%.`,
          affected: [id, 'cdu_01', ...RACK_IDS.map((r) => `rack_${r}`)],
          anchor_id: id,
          evidence: [`Strainer ΔP ${m.strainerDp[id].toFixed(1)} kPa`],
        });
      }
    }

    // stuck valve: one rack starved while its zone header is healthy and its sibling is fine
    for (const k of RACK_IDS) {
      const zone = ZONE_OF[k];
      const sibling = RACK_IDS.find((r) => r !== k && ZONE_OF[r] === zone)!;
      const header = zone === 'a' ? 'p_12' : 'p_17';
      const cond = deficit[k] > 0.11 && deficit[sibling] < 0.07 && this.dpRatio(header, m) < 1.35 && !sup(`valve_${k}`) && !zoneOff(zone) && !isolated[`valve_${k}`];
      if (hit(`valve:${k}`, cond)) {
        const margin = this.margin(k, m);
        detections.push({
          key: `valve:${k}`,
          cause: 'valve_stuck',
          target_id: `valve_${k}`,
          severity: margin < critK ? 'critical' : margin < warnK ? 'warning' : 'watch',
          title: `Rack ${k.toUpperCase()} branch flow low`,
          summary: `Rack ${k.toUpperCase()} receives ${(m.rackFlow[k]).toFixed(2)} kg/s (${Math.round(deficit[k] * 100)}% below expected) while ${sibling.toUpperCase()} on the same header is normal.`,
          affected: [`valve_${k}`, `rack_${k}`],
          anchor_id: `valve_${k}`,
          evidence: [`Branch flow ${m.rackFlow[k].toFixed(2)} vs ${ref.rackQ[k].toFixed(2)} kg/s expected`],
        });
      }
    }

    // pump degradation: head below pump curve + vibration
    {
      const duty = p.controls.tcsDuty;
      const expected = healthyPumpHead(p, m.tcsQ);
      const ratio = m.pumpHead.tcs / Math.max(expected, 1);
      const vib = p.vib[duty];
      if (hit(`pump:${duty}`, ratio < 0.89 && vib > 3.2 && !sup(duty) && !isolated[duty])) {
        const worst = Math.min(...RACK_IDS.map((r) => this.margin(r, m)));
        detections.push({
          key: `pump:${duty}`,
          cause: 'pump_degradation',
          target_id: duty,
          severity: worst < critK ? 'critical' : worst < warnK ? 'warning' : 'watch',
          title: `${duty === 'pump_t1' ? 'TCS-PMP-1' : 'TCS-PMP-2'} head below curve`,
          summary: `Delivering ${Math.round(ratio * 100)}% of expected head at ${Math.round(p.controls.tcsSpeed * 100)}% speed, vibration ${vib.toFixed(1)} mm/s.`,
          affected: [duty, 'cdu_01', ...RACK_IDS.map((r) => `rack_${r}`)],
          anchor_id: duty,
          evidence: [`Head ${m.pumpHead.tcs.toFixed(0)} kPa vs ${expected.toFixed(0)} kPa on curve`],
        });
      }
    }

    // workload spike: load up, hydraulics normal
    for (const k of RACK_IDS) {
      const up = m.rackPower[k] / Math.max(this.loadEma[k], 1);
      const cond = up > 1.13 && Math.abs(deficit[k]) < 0.06 && !sup(`rack_${k}`) && p.controls.loadFactor[k] >= 0.98;
      if (hit(`workload:${k}`, cond)) {
        const margin = this.margin(k, m);
        detections.push({
          key: `workload:${k}`,
          cause: 'workload_spike',
          target_id: `rack_${k}`,
          severity: margin < critK ? 'warning' : margin < warnK + 2 ? 'warning' : 'watch',
          title: `Rack ${k.toUpperCase()} load surge`,
          summary: `Rack ${k.toUpperCase()} is drawing ${m.rackPower[k].toFixed(0)} kW (+${Math.round((up - 1) * 100)}% vs baseline); coolant flow is nominal.`,
          affected: [`rack_${k}`],
          anchor_id: `rack_${k}`,
          evidence: [`Power ${m.rackPower[k].toFixed(0)} kW vs ${this.loadEma[k].toFixed(0)} kW baseline`],
        });
      }
    }

    // sensor drift: a flow meter disagrees with the rack meters beneath it
    for (const id of Object.keys(sensorDev)) {
      const rel = Math.abs(sensorDev[id]) / Math.max(id === 'sn_flow_trunk' ? trunkRacks : racksSum(id.endsWith('za') ? 'a' : 'b'), 0.5);
      if (hit(`sensor:${id}`, rel > 0.06 && !sup(id) && !zoneOff(id.endsWith('zb') ? 'b' : 'a'))) {
        const label = id === 'sn_flow_zb' ? 'FM-17' : id === 'sn_flow_za' ? 'FM-12' : 'FM-10';
        detections.push({
          key: `sensor:${id}`,
          cause: 'sensor_drift',
          target_id: id,
          severity: 'watch',
          title: `${label} readings inconsistent`,
          summary: `${label} reads ${(sensorDev[id] >= 0 ? '+' : '') + sensorDev[id].toFixed(2)} kg/s against the rack meters beneath it — mass balance does not close.`,
          affected: [id],
          anchor_id: id,
          evidence: [`Mass-balance residual ${(rel * 100).toFixed(1)}%`],
        });
      }
    }

    const kpis = {
      min_margin_k: minMargin,
      total_heat_kw: RACK_IDS.reduce((a, r) => a + m.rackPower[r], 0) + AUX_IDS.reduce((a, k) => a + m.auxPower[k], 0),
      tcs_flow_kg_s: m.tcsQ,
      fws_flow_kg_s: m.fwsQ,
      tcs_supply_c: m.tcsSupply,
      tcs_return_c: m.tcsReturn,
    };
    this.last = { assets, kpis, detections, ref, minMargin };
    return this.last;
  }
}

/** measured branch flow of every rack (instrumented + auxiliary) in a zone, or in the whole loop */
export function zoneFlow(m: Meas, zone: 'a' | 'b' | null) {
  let s = 0;
  for (const r of RACK_IDS) if (zone === null || ZONE_OF[r] === zone) s += m.rackFlow[r];
  for (const k of AUX_IDS) if (zone === null || ZONE_OF_ANY(k) === zone) s += m.auxFlow[k];
  return s;
}

export function healthyPumpHead(p: PlantState, q: number) {
  // same curve as the plant but with a healthy pump (health = 1)
  const h0 = PUMP_T.h0 * p.controls.tcsSpeed ** 2;
  return Math.max(h0 - PUMP_T.a * q * q, 0);
}

export { CP_FWS, CP_TCS, foulFactor, clamp };
