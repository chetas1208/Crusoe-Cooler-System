import type { Vec3 } from '../contracts';
import type { ReplayFrame, ReplayWindow, RunSummary } from './types';

export interface CompareSeries {
  metric: string;
  label: string;
  unit: string;
  a: Array<[number, number]>; // [sim_time_s, value]
  b: Array<[number, number]>;
  /** first sim time at which |a-b| exceeded the tolerance */
  firstDiffS: number | null;
}

export interface RobotPath {
  robot_id: string;
  a: Vec3[];
  b: Vec3[];
}

export interface CompareResult {
  a: RunSummary;
  b: RunSummary;
  fromTick: number;
  toTick: number;
  samples: number;
  series: CompareSeries[];
  paths: RobotPath[];
  /** incident id -> tick the incident closed in each run, null if not closed inside the common window */
  completion: Array<{ incident_id: string; title: string; a: number | null; b: number | null }>;
  divergence: { tick: number; metric: string } | null;
}

const METRICS: Array<{ metric: string; label: string; unit: string; tol: number; pick: (f: ReplayFrame) => number | undefined }> = [
  { metric: 'min_margin_k', label: 'Worst thermal margin', unit: 'K', tol: 0.15, pick: (f) => f.kpis.min_margin_k },
  { metric: 'max_chip_c', label: 'Hottest GPU junction', unit: '°C', tol: 0.2, pick: (f) => Math.max(...Object.entries(f.assets).filter(([id]) => id.startsWith('rack_')).map(([, a]) => a.readings.t_chip_c ?? -Infinity)) },
  { metric: 'tcs_flow_kg_s', label: 'TCS flow', unit: 'kg/s', tol: 0.02, pick: (f) => f.kpis.tcs_flow_kg_s },
  { metric: 'fws_flow_kg_s', label: 'FWS flow', unit: 'kg/s', tol: 0.02, pick: (f) => f.kpis.fws_flow_kg_s },
  { metric: 'tcs_return_c', label: 'TCS return temperature', unit: '°C', tol: 0.15, pick: (f) => f.kpis.tcs_return_c },
];

/**
 * Two runs on a common sim-time axis. Describes what was observed in the recordings; it does not claim what
 * "would have" happened (these are two independent runs from one fork point, not a counterfactual).
 */
export function compareRuns(a: RunSummary, wa: ReplayWindow, b: RunSummary, wb: ReplayWindow): CompareResult | null {
  const mb = new Map(wb.frames.map((f) => [f.tick, f]));
  const common = wa.frames.filter((f) => mb.has(f.tick));
  if (!common.length) return null;
  const series: CompareSeries[] = METRICS.map((m) => ({ metric: m.metric, label: m.label, unit: m.unit, a: [], b: [], firstDiffS: null }));
  let divergence: CompareResult['divergence'] = null;
  const robotIds = Object.keys(common[0].robots);
  const paths: RobotPath[] = robotIds.map((robot_id) => ({ robot_id, a: [], b: [] }));
  for (const fa of common) {
    const fb = mb.get(fa.tick)!;
    METRICS.forEach((m, i) => {
      const va = m.pick(fa);
      const vb = m.pick(fb);
      if (va === undefined || vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb)) return;
      series[i].a.push([fa.sim_time_s, va]);
      series[i].b.push([fa.sim_time_s, vb]);
      if (Math.abs(va - vb) > m.tol && series[i].firstDiffS === null) {
        series[i].firstDiffS = fa.sim_time_s;
        if (!divergence || fa.tick < divergence.tick) divergence = { tick: fa.tick, metric: m.label };
      }
    });
    paths.forEach((p) => {
      const ra = fa.robots[p.robot_id]?.pose.position_xyz_m;
      const rb = fb.robots[p.robot_id]?.pose.position_xyz_m;
      if (ra) p.a.push(ra);
      if (rb) p.b.push(rb);
    });
  }
  const last = common[common.length - 1];
  const lastB = mb.get(last.tick)!;
  const titles = new Map<string, string>();
  const closedA = new Map<string, number>();
  const closedB = new Map<string, number>();
  for (const f of [...common, ...[]]) for (const i of f.incidents) titles.set(i.id, i.title);
  for (const [map, f] of [[closedA, last], [closedB, lastB]] as const) for (const i of f.incidents) if (i.closed_tick !== undefined) map.set(i.id, i.closed_tick);
  const completion = [...titles.entries()].map(([incident_id, title]) => ({ incident_id, title, a: closedA.get(incident_id) ?? null, b: closedB.get(incident_id) ?? null }));
  return { a, b, fromTick: common[0].tick, toTick: last.tick, samples: common.length, series, paths, completion, divergence };
}
