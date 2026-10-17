import { clamp, createRng, type Rng } from '../geometry';
import { AUX_SLOTS, SLOT_BY_KEY } from './layout';

/**
 * Plant physics for the *mock* simulator.
 *
 * This is deliberately small but causal: pipe resistance → flow → coolant ΔT →
 * rack temperature, with the CDU as the only coupling between the two loops
 * (heat crosses, mass does not). Nothing here is CFD, and nothing is random per
 * frame — all stochastic input comes from a seeded RNG.
 *
 * The real backend (CompOpt + pandapipes, see backend.md §5) replaces this file;
 * the UI only ever sees the contract types.
 */

export const RACK_IDS = ['a1', 'a2', 'b1', 'b2'] as const;
export type RackKey = (typeof RACK_IDS)[number];
export const ZONE_OF: Record<RackKey, 'a' | 'b'> = { a1: 'a', a2: 'a', b1: 'b', b2: 'b' };

/**
 * Auxiliary racks (network / storage / CPU): same headers, same coolant, lighter load. They are simulated
 * (branch hydraulics, rack thermals, rack meters) but are not fault targets and not diagnosed by the agents.
 */
export const AUX_IDS: string[] = AUX_SLOTS.map((s) => s.key);
export const ZONE_OF_ANY = (k: string): 'a' | 'b' => (k.startsWith('b') ? 'b' : 'a');
/** coolant temperature rise the aux branches are sized for, K */
const AUX_DT = 12;

export const CP_TCS = 3.9; // kJ/kg·K (PG25)
export const CP_FWS = 4.18; // kJ/kg·K (water)
export const T_FWS_SET = 27;
export const R_TH = 0.267; // K/kW chip-to-coolant
export const CHIP_LIMIT = 90;
export const NOMINAL_KW = 120;

/** Design hydraulic resistances, kPa / (kg/s)². */
export const K = {
  tcsTrunkS: 0.15,
  tcsStrainer: 0.2,
  tcsHx: 0.5,
  tcsTrunkR: 0.15,
  headerS: 0.6,
  headerR: 0.6,
  drops: 0.5,
  coldPlate: 16,
  valve: 3.0, // at the balanced 0.85 opening
  fwsStrainer: 0.08,
  fwsPipes: 0.07,
  fwsHx: 0.45,
  fwsChiller: 0.2,
};
const VALVE_BALANCED = 0.85;
const FOUL_EXTENT = 0.25; // fouling occupies ~25 % of a header's length
export const PUMP_T = { h0: 290, a: 1.6 };
const PUMP_F = { h0: 300, a: 0.8 };
const UA0 = 58; // kW/K at design flows (TCS 8 kg/s, FWS 13 kg/s)

export const foulFactor = (o: number, exponent = 5, extent = FOUL_EXTENT) =>
  1 + extent * (Math.pow(1 / (1 - clamp(o, 0, 0.97)), exponent) - 1);

export interface PlantFaults {
  /** occlusion by pipe edge id or strainer id (0..1) */
  occl: Record<string, number>;
  /** where along the edge the deposit sits (m) */
  occlS: Record<string, number>;
  /** valves stuck at an effective opening regardless of command */
  valveStuck: Partial<Record<RackKey, number>>;
  pumpHealth: Record<string, number>;
  /** extra rack load (fraction of nominal) with expiry in sim seconds */
  spike: Partial<Record<RackKey, { extra: number; until: number }>>;
  sensorOffset: Record<string, number>;
  sensorDriftRate: Record<string, number>;
}

export interface PlantControls {
  tcsDuty: 'pump_t1' | 'pump_t2';
  fwsDuty: 'pump_f1' | 'pump_f2';
  tcsSpeed: number;
  fwsSpeed: number;
  valveCmd: Record<RackKey, number>;
  /** fraction of normal load a rack carries (cordon / workload migration) */
  loadFactor: Record<RackKey, number>;
  /** isolation valves closed by OUTRIG during a service window */
  isolated: Record<string, boolean>;
}

export interface Hydraulics {
  tcsQ: number;
  fwsQ: number;
  zoneQ: Record<'a' | 'b', number>;
  rackQ: Record<RackKey, number>;
  /** branch flow of the auxiliary racks, kg/s */
  auxQ: Record<string, number>;
  /** pressure drop per edge id, kPa (true) */
  dp: Record<string, number>;
  /** pressure drop across S-01 / S-02, kPa */
  strainerDp: { strainer_01: number; strainer_02: number };
  pumpHead: { tcs: number; fws: number };
  residual: number;
}

export interface Temps {
  fwsIn: number;
  fwsOut: number;
  tcsSupply: number;
  tcsReturn: number;
  rackOut: Record<RackKey, number>;
  chip: Record<RackKey, number>;
  auxOut: Record<string, number>;
  auxChip: Record<string, number>;
  hxDuty: number;
}

export interface PlantState {
  time: number;
  faults: PlantFaults;
  controls: PlantControls;
  temps: Temps;
  hyd: Hydraulics;
  load: Record<RackKey, number>; // kW actually dissipated now
  loadPhase: Record<RackKey, [number, number, number]>;
  vib: Record<string, number>;
  auxLoad: Record<string, number>;
}

export function initialFaults(): PlantFaults {
  return { occl: {}, occlS: {}, valveStuck: {}, pumpHealth: { pump_t1: 1, pump_t2: 1, pump_f1: 1, pump_f2: 1 }, spike: {}, sensorOffset: {}, sensorDriftRate: {} };
}

export function initialControls(): PlantControls {
  return {
    tcsDuty: 'pump_t1',
    fwsDuty: 'pump_f1',
    tcsSpeed: 0.9,
    fwsSpeed: 0.95,
    valveCmd: { a1: VALVE_BALANCED, a2: VALVE_BALANCED, b1: VALVE_BALANCED, b2: VALVE_BALANCED },
    loadFactor: { a1: 1, a2: 1, b1: 1, b2: 1 },
    isolated: {},
  };
}

/* ───────────────────────────── hydraulic solve ───────────────────────────── */

const parK = (ks: number[]) => {
  const s = ks.reduce((acc, k) => acc + 1 / Math.sqrt(k), 0);
  return s > 0 ? 1 / (s * s) : Infinity;
};

/** branch resistance of an auxiliary rack: fixed balancing valve + drops + a cold plate sized for its design load */
const auxBranchK = (key: string) => {
  const m = SLOT_BY_KEY[key].kw / (CP_TCS * AUX_DT);
  return K.valve + K.drops + (K.coldPlate * 1.5 ** 2) / (m * m);
};
const AUX_K: Record<string, number> = Object.fromEntries(AUX_IDS.map((k) => [k, auxBranchK(k)]));

export interface SolveInput {
  faults: PlantFaults;
  controls: PlantControls;
  /** when true ignore all faults — this is the "healthy twin" used by the monitor */
  healthy?: boolean;
}

export function solveHydraulics({ faults, controls, healthy }: SolveInput): Hydraulics {
  const f = healthy ? initialFaults() : faults;
  const o = (id: string) => f.occl[id] ?? 0;

  /* ── TCS ── */
  const kTrunkS = K.tcsTrunkS * foulFactor(o('p_10'));
  const kStrainer = K.tcsStrainer * Math.pow(1 / (1 - clamp(o('strainer_02'), 0, 0.97)), 2.5);
  const kTrunkR = K.tcsTrunkR * foulFactor(o('p_20'));

  const rackK: Record<RackKey, number> = { a1: 0, a2: 0, b1: 0, b2: 0 };
  for (const r of RACK_IDS) {
    const stuck = f.valveStuck[r];
    const theta = clamp(stuck ?? controls.valveCmd[r], 0.02, 1);
    const kValve = K.valve * Math.pow(VALVE_BALANCED / theta, 2);
    rackK[r] = kValve + K.drops + K.coldPlate;
  }
  const zoneIsolated = { a: !!controls.isolated['valve_za'], b: !!controls.isolated['valve_zb'] };
  const rackActive = (r: RackKey) => !controls.isolated[`valve_${r}`] && !zoneIsolated[ZONE_OF[r]];

  const auxActive = (k: string) => !zoneIsolated[ZONE_OF_ANY(k)];
  const zoneK: Record<'a' | 'b', number> = { a: Infinity, b: Infinity };
  for (const z of ['a', 'b'] as const) {
    const active = RACK_IDS.filter((r) => ZONE_OF[r] === z && rackActive(r));
    const auxIn = AUX_IDS.filter((k) => ZONE_OF_ANY(k) === z && auxActive(k));
    if (!active.length && !auxIn.length) continue;
    const hs = K.headerS * foulFactor(o(z === 'a' ? 'p_12' : 'p_17'));
    const hr = K.headerR * foulFactor(o(z === 'a' ? 'p_22' : 'p_27'));
    zoneK[z] = hs + hr + parK([...active.map((r) => rackK[r]), ...auxIn.map((k) => AUX_K[k])]);
  }
  const kZones = parK([zoneK.a, zoneK.b].filter((k) => Number.isFinite(k)));
  const kSys = kTrunkS + kStrainer + K.tcsHx + kTrunkR + (Number.isFinite(kZones) ? kZones : 1e6);

  const tcsHealth = f.pumpHealth[controls.tcsDuty] ?? 1;
  const headFactor = 0.5 + 0.5 * clamp(tcsHealth, 0, 1);
  const h0 = PUMP_T.h0 * controls.tcsSpeed * controls.tcsSpeed * headFactor;
  const tcsQ = Number.isFinite(kZones) ? Math.sqrt(Math.max(h0, 0) / (PUMP_T.a + kSys)) : 0;

  const zoneQ: Record<'a' | 'b', number> = { a: 0, b: 0 };
  const share = ['a', 'b'].map((z) => (Number.isFinite(zoneK[z as 'a' | 'b']) ? 1 / Math.sqrt(zoneK[z as 'a' | 'b']) : 0));
  const shareSum = share[0] + share[1];
  zoneQ.a = shareSum > 0 ? (tcsQ * share[0]) / shareSum : 0;
  zoneQ.b = shareSum > 0 ? (tcsQ * share[1]) / shareSum : 0;

  const rackQ: Record<RackKey, number> = { a1: 0, a2: 0, b1: 0, b2: 0 };
  const auxQ: Record<string, number> = Object.fromEntries(AUX_IDS.map((k) => [k, 0]));
  for (const z of ['a', 'b'] as const) {
    const act = RACK_IDS.filter((r) => ZONE_OF[r] === z && rackActive(r));
    const auxIn = AUX_IDS.filter((k) => ZONE_OF_ANY(k) === z && auxActive(k));
    const s = act.reduce((a, r) => a + 1 / Math.sqrt(rackK[r]), 0) + auxIn.reduce((a, k) => a + 1 / Math.sqrt(AUX_K[k]), 0);
    for (const r of act) rackQ[r] = s > 0 ? (zoneQ[z] * (1 / Math.sqrt(rackK[r]))) / s : 0;
    for (const k of auxIn) auxQ[k] = s > 0 ? (zoneQ[z] * (1 / Math.sqrt(AUX_K[k]))) / s : 0;
  }

  /* ── FWS ── */
  const kFwsStr = K.fwsStrainer * Math.pow(1 / (1 - clamp(o('strainer_01'), 0, 0.97)), 2.5);
  const kFws = kFwsStr + K.fwsPipes * foulFactor(o('p_02'), 5, 0.2) + K.fwsHx + K.fwsChiller;
  const fwsHealth = f.pumpHealth[controls.fwsDuty] ?? 1;
  const fh0 = PUMP_F.h0 * controls.fwsSpeed * controls.fwsSpeed * (0.5 + 0.5 * clamp(fwsHealth, 0, 1));
  const fwsQ = Math.sqrt(Math.max(fh0, 0) / (PUMP_F.a + kFws));

  /* ── per-edge dp (kPa) ── */
  const dp: Record<string, number> = {};
  dp.p_10 = kTrunkS * tcsQ ** 2;
  dp.p_20 = kTrunkR * tcsQ ** 2;
  dp.p_12 = K.headerS * foulFactor(o('p_12')) * zoneQ.a ** 2;
  dp.p_22 = K.headerR * foulFactor(o('p_22')) * zoneQ.a ** 2;
  dp.p_17 = K.headerS * foulFactor(o('p_17')) * zoneQ.b ** 2;
  dp.p_27 = K.headerR * foulFactor(o('p_27')) * zoneQ.b ** 2;
  for (const r of RACK_IDS) {
    dp[SLOT_BY_KEY[r].supEdge] = (K.drops / 2) * rackQ[r] ** 2;
    dp[SLOT_BY_KEY[r].retEdge] = (K.drops / 2) * rackQ[r] ** 2;
  }
  for (const k of AUX_IDS) {
    dp[SLOT_BY_KEY[k].supEdge] = (K.drops / 2) * auxQ[k] ** 2;
    dp[SLOT_BY_KEY[k].retEdge] = (K.drops / 2) * auxQ[k] ** 2;
  }
  dp.p_01 = (K.fwsPipes * 0.3) * fwsQ ** 2;
  dp.p_02 = K.fwsPipes * 0.4 * foulFactor(o('p_02'), 5, 0.2) * fwsQ ** 2;
  dp.p_03 = (K.fwsPipes * 0.3) * fwsQ ** 2;

  const strainerDp = { strainer_01: kFwsStr * fwsQ ** 2, strainer_02: kStrainer * tcsQ ** 2 };
  const pumpHead = {
    tcs: Math.max(h0 - PUMP_T.a * tcsQ ** 2, 0),
    fws: Math.max(fh0 - PUMP_F.a * fwsQ ** 2, 0),
  };
  // closure check: pump head must equal total system dp (series/parallel algebra)
  const sysDp = kSys * tcsQ ** 2;
  const residual = Math.abs(pumpHead.tcs - sysDp) / Math.max(pumpHead.tcs, 1);

  return { tcsQ, fwsQ, zoneQ, rackQ, auxQ, dp, strainerDp, pumpHead, residual };
}

/* ─────────────────────────────── thermal step ─────────────────────────────── */

function hxEffectiveness(ntu: number, cr: number) {
  if (Math.abs(1 - cr) < 1e-4) return ntu / (1 + ntu);
  const e = Math.exp(-ntu * (1 - cr));
  return (1 - e) / (1 - cr * e);
}

export function createPlant(seed: number): { state: PlantState; rng: Rng } {
  const rng = createRng(seed ^ 0x9e3779b9);
  const phase = (): [number, number, number] => [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
  const state: PlantState = {
    time: 0,
    faults: initialFaults(),
    controls: initialControls(),
    temps: {
      fwsIn: T_FWS_SET,
      fwsOut: 34,
      tcsSupply: 33,
      tcsReturn: 48,
      rackOut: { a1: 48, a2: 48, b1: 48, b2: 48 },
      chip: { a1: 72, a2: 72, b1: 72, b2: 72 },
      auxOut: Object.fromEntries(AUX_IDS.map((k) => [k, 46])),
      auxChip: Object.fromEntries(AUX_IDS.map((k) => [k, 55])),
      hxDuty: 450,
    },
    hyd: undefined as unknown as Hydraulics,
    load: { a1: NOMINAL_KW, a2: NOMINAL_KW, b1: NOMINAL_KW, b2: NOMINAL_KW },
    loadPhase: { a1: phase(), a2: phase(), b1: phase(), b2: phase() },
    vib: { pump_t1: 1.6, pump_t2: 0.2, pump_f1: 1.9, pump_f2: 0.2 },
    auxLoad: Object.fromEntries(AUX_SLOTS.map((a) => [a.key, a.kw])),
  };
  state.hyd = solveHydraulics(state);
  // relax to steady state before the world "starts"
  for (let i = 0; i < 1200; i++) stepPlant(state, 0.5, false);
  state.time = 0;
  return { state, rng };
}

/** Smoothly varying AI workload per rack: sum of a few slow sinusoids. */
function workloadKw(st: PlantState, r: RackKey, t: number) {
  const [p1, p2, p3] = st.loadPhase[r];
  const wave = 0.5 * Math.sin(t / 310 + p1) + 0.3 * Math.sin(t / 97 + p2) + 0.2 * Math.sin(t / 41 + p3);
  let kw = NOMINAL_KW * (0.95 + 0.04 * wave);
  const sp = st.faults.spike[r];
  if (sp && sp.until > t) kw *= 1 + sp.extra;
  return kw * st.controls.loadFactor[r];
}

/** deterministic, rng-free slow variation for the aux racks (does not disturb the seeded fault stream) */
function auxLoadKw(st: PlantState, key: string, t: number) {
  const slot = SLOT_BY_KEY[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  const ph = (h / 997) * 6.28;
  const wave = 0.6 * Math.sin(t / 420 + ph) + 0.4 * Math.sin(t / 130 + 2 * ph);
  const off = st.controls.isolated[`valve_z${ZONE_OF_ANY(key)}`];
  return off ? 0 : slot.kw * (0.93 + 0.07 * wave);
}

export function stepPlant(st: PlantState, dt: number, withDynamics = true) {
  st.time += dt;
  const t = st.time;
  const { faults, controls } = st;

  // fault dynamics that live in the plant (pump vibration signature, sensor drift)
  for (const id of Object.keys(faults.sensorDriftRate)) {
    faults.sensorOffset[id] = (faults.sensorOffset[id] ?? 0) + faults.sensorDriftRate[id] * dt;
  }
  for (const id of ['pump_t1', 'pump_t2', 'pump_f1', 'pump_f2']) {
    const duty = controls.tcsDuty === id || controls.fwsDuty === id;
    const health = faults.pumpHealth[id] ?? 1;
    const target = duty ? 1.6 + (1 - health) * 7.5 : 0.2;
    st.vib[id] += (target - st.vib[id]) * Math.min(1, dt / 12);
  }

  st.hyd = solveHydraulics(st);
  const h = st.hyd;

  // chiller supply wobble
  const fwsIn = T_FWS_SET + 0.6 * Math.sin((2 * Math.PI * t) / 1800);
  st.temps.fwsIn = fwsIn;

  // loads
  for (const r of RACK_IDS) st.load[r] = workloadKw(st, r, t);
  for (const k of AUX_IDS) st.auxLoad[k] = auxLoadKw(st, k, t);

  const T = st.temps;
  const k = (tau: number) => (withDynamics ? Math.min(1, dt / tau) : 1);
  const k_ = k;

  // racks
  let mixNum = 0;
  let mixDen = 0;
  for (const r of RACK_IDS) {
    const m = h.rackQ[r];
    const q = st.load[r];
    const outTarget = m > 0.05 ? T.tcsSupply + q / (m * CP_TCS) : T.tcsSupply + 60;
    T.rackOut[r] += (Math.min(outTarget, T.tcsSupply + 80) - T.rackOut[r]) * k(6);
    const mean = (T.tcsSupply + T.rackOut[r]) / 2;
    const chipTarget = mean + R_TH * q;
    T.chip[r] += (chipTarget - T.chip[r]) * k(20);
    if (m > 0.05) {
      mixNum += m * T.rackOut[r];
      mixDen += m;
    }
  }
  for (const k of AUX_IDS) {
    const m = h.auxQ[k];
    const q = st.auxLoad[k];
    const outTarget = m > 0.02 ? T.tcsSupply + q / (m * CP_TCS) : T.tcsSupply + q * 0.5;
    T.auxOut[k] += (Math.min(outTarget, T.tcsSupply + 80) - T.auxOut[k]) * k_(6);
    T.auxChip[k] += ((T.tcsSupply + T.auxOut[k]) / 2 + R_TH * q - T.auxChip[k]) * k_(20);
    if (m > 0.02) {
      mixNum += m * T.auxOut[k];
      mixDen += m;
    }
  }
  const tMix = mixDen > 0 ? mixNum / mixDen : T.tcsReturn;
  T.tcsReturn += (tMix - T.tcsReturn) * k(8);

  // CDU heat exchanger (ε-NTU, counterflow). Heat crosses; mass does not.
  const ct = Math.max(h.tcsQ, 0.01) * CP_TCS;
  const cf = Math.max(h.fwsQ, 0.01) * CP_FWS;
  const cmin = Math.min(ct, cf);
  const cr = cmin / Math.max(ct, cf);
  const ua = UA0 * Math.pow(Math.max(h.tcsQ, 0.01) / 8, 0.3) * Math.pow(Math.max(h.fwsQ, 0.01) / 13, 0.3);
  const eps = hxEffectiveness(ua / cmin, cr);
  const q = Math.max(eps * cmin * (T.tcsReturn - fwsIn), 0);
  T.hxDuty = q;
  const supplyTarget = T.tcsReturn - q / ct;
  T.tcsSupply += (supplyTarget - T.tcsSupply) * k(20);
  T.fwsOut += (fwsIn + q / cf - T.fwsOut) * k(15);
}

/* ─────────────────────────── ideal (healthy) reference ─────────────────────────── */

/** Steady-state healthy flows with the same setpoints — used for residuals. */
export function healthyReference(st: PlantState): Hydraulics {
  return solveHydraulics({ faults: st.faults, controls: st.controls, healthy: true });
}

/** Steady chip temperature a rack would reach with healthy flow right now. */
export function expectedChip(st: PlantState, r: RackKey, healthyHyd: Hydraulics) {
  const m = Math.max(healthyHyd.rackQ[r], 0.05);
  const q = st.load[r];
  const supply = st.temps.tcsSupply;
  return supply + q / (2 * m * CP_TCS) + R_TH * q;
}

/* ─────────────────────────────── measurement ─────────────────────────────── */

export interface Noise {
  flow: number;
  temp: number;
  dp: number;
  power: number;
}
export const NOISE: Noise = { flow: 0.02, temp: 0.06, dp: 0.04, power: 0.6 };

export function noisy(rng: Rng, v: number, sigma: number) {
  return v + rng.normal() * sigma;
}
