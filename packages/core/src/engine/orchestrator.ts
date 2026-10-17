import type {
  AgentRole,
  AgentTask,
  AgentTaskStatus,
  ApprovalRequest,
  Evidence,
  EventType,
  FaultKind,
  Hypothesis,
  Incident,
  IncidentStage,
  IncidentStatus,
  Mission,
  MissionStep,
  ModelMeta,
  RobotMode,
  Severity,
  Topology,
  ToolCall,
  VerificationCheck,
  VerificationResult,
  Vec3,
} from '../contracts';
import { clamp, type Rng } from '../geometry';
import { zoneFlow, type Detection, type Meas, type Monitor } from './monitor';
import type { FaultManager } from './faults';
import {
  PUMP_T,
  RACK_IDS,
  ZONE_OF,
  foulFactor,
  initialFaults,
  solveHydraulics,
  type PlantFaults,
  type PlantState,
  type RackKey,
} from './plant';
import type { NavGrid, PipeGraph, RobotActor, RobotCommand } from './robots';

/* ─────────────────────── tiny cooperative scheduler ─────────────────────── */

type Wait = { dur?: number; until?: number; cond?: () => boolean };
type G<T = void> = Generator<Wait, T, void>;

interface Proc {
  name: string;
  gen: G;
  wait: Wait | null;
  done: boolean;
}

interface Op {
  id: string;
  command: string;
  label: string;
  make: () => RobotCommand;
  done?: () => string | void;
  tool?: { name: string; input: Record<string, unknown>; output: () => Record<string, unknown> };
}

export interface OrchDeps {
  topo: Topology;
  plant: PlantState;
  monitor: Monitor;
  faults: FaultManager;
  graph: PipeGraph;
  nav: NavGrid;
  robots: Record<string, RobotActor>;
  rng: Rng;
  emit: (type: EventType, entityId: string, payload: unknown) => void;
  tick: () => number;
  config: { approvalMode: 'autonomous' | 'supervised'; approvalWindowS: number };
}

const fmt = (x: number, d = 1) => x.toFixed(d);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const RACK_LABEL = (k: string) => k.toUpperCase();

/** invert foulFactor(o) = ratio by bisection (twin what-if) */
function estOcclusion(ratio: number, extent = 0.25) {
  let lo = 0;
  let hi = 0.96;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (foulFactor(mid, 5, extent) < ratio) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export class Orchestrator {
  readonly incidents = new Map<string, Incident>();
  readonly tasks = new Map<string, AgentTask>();
  readonly missions = new Map<string, Mission>();
  private procs: Proc[] = [];
  private incSeq = 8;
  private taskSeq = 0;
  private evSeq = 0;
  private missionSeq = 8;
  private toolSeq = 0;
  private approvalSeq = 0;
  private robotOwner: Record<string, string | null> = {};
  private isolationOwner: string | null = null;
  private suppress = new Map<string, number>();
  private openKeys = new Map<string, string>();
  private hist: Meas[] = [];
  private baselines = new Map<string, Record<string, number>>();
  private lastSev = 0;

  constructor(private d: OrchDeps) {
    for (const id of Object.keys(d.robots)) this.robotOwner[id] = null;
  }

  private get now() {
    return this.d.plant.time;
  }

  /* ───────────────────────────── public API ───────────────────────────── */

  step(_dt: number) {
    const now = this.now;
    for (const p of this.procs) {
      if (p.done) continue;
      let guard = 0;
      while (!p.done && guard++ < 16) {
        const w = p.wait;
        if (w) {
          if (w.cond ? !w.cond() : now < (w.until ?? 0)) break;
        }
        const r = p.gen.next();
        if (r.done) {
          p.done = true;
          break;
        }
        const nw = r.value;
        p.wait = nw.dur !== undefined ? { until: now + nw.dur } : nw;
      }
    }
    this.procs = this.procs.filter((p) => !p.done);
    if (now - this.lastSev >= 4) {
      this.lastSev = now;
      for (const inc of this.incidents.values()) if (!inc.closed_tick) this.refreshSeverity(inc);
    }
  }

  recordMeas(m: Meas) {
    this.hist.push(m);
    if (this.hist.length > 60) this.hist.shift();
  }

  suppressedSet(): Set<string> {
    const s = new Set<string>();
    for (const [k, until] of this.suppress) {
      if (until > this.now) s.add(k);
      else this.suppress.delete(k);
    }
    return s;
  }

  openCount() {
    let n = 0;
    for (const i of this.incidents.values()) if (!i.closed_tick) n++;
    return n;
  }

  ingest(dets: Detection[]) {
    for (const det of dets) {
      if (this.openKeys.has(det.key)) continue;
      if (this.openCount() >= 3) break;
      this.open(det);
    }
  }

  approve(id: string, approve: boolean) {
    for (const inc of this.incidents.values()) {
      const a = inc.approval;
      if (!a || (a.id !== id && inc.id !== id)) continue;
      if (a.status === 'pending' || a.status === 'held') {
        a.status = approve ? 'approved' : 'held';
        if (!approve) a.auto_approve_at_s = null;
        this.touch(inc);
        return true;
      }
    }
    return false;
  }

  traceFor(incidentId: string): AgentTask[] {
    const inc = this.incidents.get(incidentId);
    return inc ? inc.task_ids.map((id) => this.tasks.get(id)!).filter(Boolean) : [];
  }

  /* ───────────────────────────── incident open ───────────────────────────── */

  private positionOf(id: string): Vec3 {
    const a = this.d.topo.assets.find((x) => x.id === id);
    if (a) return [a.position_xyz_m[0], a.position_xyz_m[1] + (a.type === 'rack' || a.type === 'cdu' ? (a.size_m?.[1] ?? 0) / 2 : 0), a.position_xyz_m[2]];
    if (this.d.graph.edge(id)) {
      const s = this.d.plant.faults.occlS[id] ?? this.d.graph.length(id) * 0.5;
      return this.d.graph.position(id, s);
    }
    return [0, 1, 0];
  }

  private open(det: Detection) {
    const id = `INC-${String(++this.incSeq).padStart(3, '0')}`;
    const tick = this.d.tick();
    const inc: Incident = {
      id,
      opened_tick: tick,
      opened_at_s: this.now,
      updated_tick: tick,
      severity: det.severity,
      status: 'open',
      stage: 'observed',
      stage_log: [{ stage: 'observed', tick }],
      title: det.title,
      summary: det.summary,
      cause: 'unknown',
      anchor: { entity_id: det.anchor_id, position_xyz_m: this.positionOf(det.anchor_id) },
      affected_asset_ids: det.affected,
      hypotheses: [],
      evidence: [],
      mission_ids: [],
      task_ids: [],
      attempts: 0,
    };
    this.incidents.set(id, inc);
    this.openKeys.set(det.key, id);
    for (const e of det.evidence) this.ev(inc, 'telemetry', e, { asset_id: det.anchor_id });
    this.baselines.set(id, this.metrics(det, id));
    this.d.emit('incident.opened', id, { incident: inc });
    this.spawn(`playbook:${id}`, this.playbook(inc, det));
  }

  /* ───────────────────────────── scheduler utils ───────────────────────────── */

  private spawn(name: string, gen: G) {
    const proc: Proc = { name, gen, wait: null, done: false };
    this.procs.push(proc);
    return proc;
  }

  private touch(inc: Incident) {
    inc.updated_tick = this.d.tick();
    this.d.emit('incident.updated', inc.id, { incident: inc });
  }

  private setStatus(inc: Incident, status: IncidentStatus, summary?: string) {
    inc.status = status;
    if (summary) inc.summary = summary;
    this.touch(inc);
  }

  private stage(inc: Incident, stage: IncidentStage, outcome?: 'ok' | 'rejected') {
    inc.stage = stage;
    inc.stage_log.push({ stage, tick: this.d.tick(), outcome });
    this.touch(inc);
  }

  private ev(inc: Incident, kind: Evidence['kind'], summary: string, extra: Partial<Evidence> = {}): string {
    const e: Evidence = { id: `ev_${++this.evSeq}`, kind, summary, tick: this.d.tick(), ...extra };
    inc.evidence.push(e);
    return e.id;
  }

  private refreshSeverity(inc: Incident) {
    const { margin_warn_k: w, margin_crit_k: c } = this.d.topo.limits;
    const racks = inc.affected_asset_ids.filter((a) => a.startsWith('rack_')).map((a) => a.replace('rack_', '') as RackKey).filter((k) => (RACK_IDS as readonly string[]).includes(k));
    const scope = racks.length ? racks : [...RACK_IDS];
    const worst = Math.min(...scope.map((r) => this.d.monitor.margin(r)));
    const next: Severity = worst < c ? 'critical' : worst < w ? 'warning' : inc.status === 'resolved' ? 'nominal' : 'watch';
    if (next !== inc.severity && inc.cause !== 'workload_spike') {
      inc.severity = next;
      this.touch(inc);
    }
  }

  /* ───────────────────────────── agent tasks / tools ───────────────────────────── */

  private model(kind: 'llm' | 'det'): ModelMeta {
    const r = this.d.rng;
    if (kind === 'det') {
      return { provider: 'deterministic', model_id: 'policy-engine-v1', latency_ms: Math.round(r.range(4, 40)), schema_version: 'agent.v1', fallback: false };
    }
    return {
      provider: 'mock',
      model_id: 'mock-policy-v0',
      latency_ms: Math.round(r.range(380, 1350)),
      tokens_in: Math.round(r.range(700, 2600)),
      tokens_out: Math.round(r.range(90, 420)),
      schema_version: 'agent.v1',
      fallback: false,
    };
  }

  private task(
    inc: Incident,
    spec: {
      role: AgentRole;
      kind: string;
      title: string;
      question: string;
      parent?: AgentTask;
      caused_by?: AgentTask[];
      robot_id?: string;
      asset_ids?: string[];
      det?: boolean;
    },
  ): AgentTask {
    const t: AgentTask = {
      id: `t_${String(++this.taskSeq).padStart(3, '0')}`,
      incident_id: inc.id,
      parent_id: spec.parent?.id,
      role: spec.role,
      kind: spec.kind,
      title: spec.title,
      question: spec.question,
      status: 'working',
      depth: spec.parent ? spec.parent.depth + 1 : 0,
      started_tick: this.d.tick(),
      evidence_ids: [],
      tool_calls: [],
      model: this.model(spec.det ? 'det' : 'llm'),
      caused_by: (spec.caused_by ?? (spec.parent ? [spec.parent] : [])).map((x) => x.id),
      robot_id: spec.robot_id,
      asset_ids: spec.asset_ids ?? [],
    };
    this.tasks.set(t.id, t);
    inc.task_ids.push(t.id);
    this.d.emit('agent.task', t.id, { task: t });
    return t;
  }

  private finish(t: AgentTask, status: AgentTaskStatus, summary: string, outcome?: { label: string; ok: boolean }, evidence: string[] = []) {
    t.status = status;
    t.summary = summary;
    t.outcome = outcome;
    t.ended_tick = this.d.tick();
    t.evidence_ids.push(...evidence);
    this.d.emit('agent.task', t.id, { task: t });
  }

  private *tool(t: AgentTask, name: string, input: Record<string, unknown>, compute: () => Record<string, unknown>, latencyS = 1.4): G<Record<string, unknown>> {
    const call: ToolCall = { id: `tc_${++this.toolSeq}`, task_id: t.id, name, input, status: 'running', tick: this.d.tick() };
    t.tool_calls.push(call);
    this.d.emit('agent.tool', t.id, { task_id: t.id, tool_call: call });
    yield { dur: latencyS };
    call.output = compute();
    call.status = 'ok';
    call.latency_ms = Math.round(this.d.rng.range(40, 880));
    this.d.emit('agent.tool', t.id, { task_id: t.id, tool_call: call });
    return call.output;
  }

  /* ───────────────────────────── metrics & verification ───────────────────────────── */

  private avg(fn: (m: Meas) => number, n = 6) {
    const h = this.hist.slice(-n);
    if (!h.length) return fn(this.d.monitor.meas);
    return h.reduce((a, m) => a + fn(m), 0) / h.length;
  }

  private scopeRacks(det: Detection): RackKey[] {
    if (det.cause === 'valve_stuck') return [det.target_id.replace('valve_', '') as RackKey];
    const e = this.d.topo.edges.find((x) => x.id === det.target_id);
    if (e?.zone_id) return RACK_IDS.filter((r) => `zone_${ZONE_OF[r]}` === e.zone_id);
    if (det.cause === 'workload_spike') return [det.target_id.replace('rack_', '') as RackKey];
    return [...RACK_IDS];
  }

  /** racks currently attributed to *other* open incidents (excluded from this incident's checks) */
  private otherAffected(incId: string): Set<RackKey> {
    const out = new Set<RackKey>();
    for (const i of this.incidents.values()) {
      if (i.id === incId || i.closed_tick) continue;
      for (const a of i.affected_asset_ids) if (a.startsWith('rack_') && (RACK_IDS as readonly string[]).includes(a.slice(5))) out.add(a.replace('rack_', '') as RackKey);
    }
    return out;
  }

  /** The twin with only *this* incident's fault removed — "what should flow be if this were fixed?" */
  private counterfactual(det: Detection) {
    const f: PlantFaults = JSON.parse(JSON.stringify(this.d.plant.faults));
    if (det.cause === 'fouling' || det.cause === 'strainer_blockage') delete f.occl[det.target_id];
    else if (det.cause === 'valve_stuck') delete f.valveStuck[det.target_id.replace('valve_', '') as RackKey];
    else if (det.cause === 'pump_degradation') f.pumpHealth[det.target_id] = 1;
    return solveHydraulics({ faults: f, controls: this.d.plant.controls });
  }

  private metrics(det: Detection, incId: string): Record<string, number> {
    const mon = this.d.monitor;
    const cf = this.counterfactual(det);
    const excluded = this.otherAffected(incId);
    const racks = this.scopeRacks(det);
    const marginRacks = racks.filter((r) => !excluded.has(r));
    const m: Record<string, number> = {};
    // margin is judged at nominal load: an unrelated workload surge must not fail a hydraulic repair
    const normMargin = (r: RackKey) => this.avg((x) => mon.margin(r, x)) + 0.4 * Math.max(0, this.avg((x) => x.rackPower[r]) - 0.95 * 120);
    // when another incident owns every rack in scope we still *report* a real margin, but skip judging it
    m.margin = Math.min(...(marginRacks.length ? marginRacks : racks).map(normMargin));
    m.margin_excl = marginRacks.length ? 0 : 1;
    const dev = (r: RackKey) => Math.abs(this.avg((x) => x.rackFlow[r]) - cf.rackQ[r]) / Math.max(cf.rackQ[r], 0.1);
    switch (det.cause) {
      case 'fouling':
      case 'strainer_blockage': {
        if (det.cause === 'fouling') {
          const whole = racks.length === 4;
          m.flow = whole ? this.avg((x) => x.tcsQ) : racks.reduce((a, r) => a + this.avg((x) => x.rackFlow[r]), 0);
          m.flow_ref = whole ? cf.tcsQ : racks.reduce((a, r) => a + cf.rackQ[r], 0);
          m.dp_ratio = this.avg((x) => mon.dpRatio(det.target_id, x));
          const other = RACK_IDS.filter((r) => !racks.includes(r) && !excluded.has(r));
          m.collateral = other.length ? Math.max(...other.map(dev)) : 0;
        } else {
          const fws = det.target_id === 'strainer_01';
          m.flow = this.avg((x) => (fws ? x.fwsQ : x.tcsQ));
          m.flow_ref = fws ? cf.fwsQ : cf.tcsQ;
          m.dp_ratio = this.avg((x) => mon.strainerRatio(det.target_id as 'strainer_01' | 'strainer_02', x));
          m.collateral = 0;
        }
        break;
      }
      case 'valve_stuck': {
        const r = racks[0];
        const sib = RACK_IDS.find((x) => x !== r && ZONE_OF[x] === ZONE_OF[r])!;
        m.flow = this.avg((x) => x.rackFlow[r]);
        m.flow_ref = cf.rackQ[r];
        m.collateral = excluded.has(sib) ? 0 : dev(sib);
        break;
      }
      case 'pump_degradation': {
        const duty = this.d.plant.controls.tcsDuty;
        const exp = PUMP_T.h0 * this.d.plant.controls.tcsSpeed ** 2 - PUMP_T.a * this.avg((x) => x.tcsQ) ** 2;
        m.head_ratio = this.avg((x) => x.pumpHead.tcs) / Math.max(exp, 1);
        m.vibration = this.d.plant.vib[duty];
        m.flow = this.avg((x) => x.tcsQ);
        m.flow_ref = cf.tcsQ;
        break;
      }
      case 'sensor_drift': {
        const z = det.target_id.endsWith('za') ? 'a' : det.target_id.endsWith('zb') ? 'b' : null;
        const edge = det.target_id === 'sn_flow_za' ? 'p_12' : det.target_id === 'sn_flow_zb' ? 'p_17' : 'p_10';
        const sum = this.avg((x) => zoneFlow(x, z));
        m.residual_kg_s = Math.abs(this.avg((x) => x.edgeFlow[edge]) - sum);
        m.tol_kg_s = z === null ? 0.14 : 0.08;
        const all = RACK_IDS.filter((r) => !excluded.has(r));
        m.collateral = all.length ? Math.max(...all.map(dev)) : 0;
        break;
      }
      default:
        break;
    }
    return m;
  }

  private checksFor(det: Detection, before: Record<string, number>, after: Record<string, number>): VerificationCheck[] {
    const warn = this.d.topo.limits.margin_warn_k;
    const checks: VerificationCheck[] = [];
    const add = (id: string, label: string, unit: string, b: number, a: number, target: number, direction: 'min' | 'max') =>
      checks.push({ id, label, unit, before: b, after: a, target, direction, pass: direction === 'min' ? a >= target : a <= target });
    const scopeLabel = this.scopeRacks(det).length === 1 ? `Rack ${RACK_LABEL(this.scopeRacks(det)[0])}` : this.scopeRacks(det).length === 2 ? `Zone ${ZONE_OF[this.scopeRacks(det)[0]].toUpperCase()}` : 'Loop';
    switch (det.cause) {
      case 'fouling':
      case 'strainer_blockage':
      case 'valve_stuck': {
        add('flow', `${scopeLabel} flow`, 'kg/s', before.flow, after.flow, 0.95 * after.flow_ref, 'min');
        if (det.cause !== 'valve_stuck') add('dp', `${det.target_id.startsWith('strainer') ? 'Strainer' : 'Segment'} ΔP vs design`, '×', before.dp_ratio, after.dp_ratio, 1.4, 'max');
        if (!after.margin_excl) add('margin', `Thermal margin at nominal load · ${scopeLabel}`, 'K', before.margin, after.margin, warn, 'min');
        // no *new* downstream problems: other racks must not be worse off than before the repair
        add('collateral', 'Collateral flow deviation', '%', before.collateral * 100, after.collateral * 100, Math.max(6, before.collateral * 100 + 4), 'max');
        break;
      }
      case 'pump_degradation':
        add('head', 'Head vs pump curve', '%', before.head_ratio * 100, after.head_ratio * 100, 96, 'min');
        add('vib', 'Bearing vibration', 'mm/s', before.vibration, after.vibration, 2.8, 'max');
        if (!after.margin_excl) add('margin', 'Thermal margin at nominal load', 'K', before.margin, after.margin, warn, 'min');
        break;
      case 'sensor_drift':
        add('residual', 'Meter vs rack-meter residual', 'kg/s', before.residual_kg_s, after.residual_kg_s, after.tol_kg_s, 'max');
        add('collateral', 'True flows unchanged', '%', before.collateral * 100, after.collateral * 100, Math.max(4, before.collateral * 100 + 3), 'max');
        break;
      default:
        break;
    }
    return checks;
  }

  /** Independent verifier: a stabilisation window, then a before/after physics comparison. */
  private *verify(inc: Incident, det: Detection, parent: AgentTask, windowS = 55): G<boolean> {
    const task = this.task(inc, { role: 'sentinel', kind: 'verify', title: 'Independent verification', question: 'Did measured hydraulics and thermal margin genuinely recover — without new problems downstream?', parent, det: true });
    const v: VerificationResult = {
      id: `ver_${inc.id}_${inc.attempts + 1}`,
      incident_id: inc.id,
      attempt: inc.attempts + 1,
      status: 'pending',
      window_s: windowS,
      elapsed_s: 0,
      progress: 0,
      checks: [],
      confidence: 0,
      started_tick: this.d.tick(),
    };
    inc.verification = v;
    this.setStatus(inc, 'verifying', 'Stabilisation window running — verifier is watching flow, ΔP and thermal margin.');
    this.d.emit('verification.result', inc.id, { verification: v });
    const t0 = this.now;
    let nextEmit = 0;
    const before = this.baselines.get(inc.id)!;
    let after: Record<string, number> = {};
    let extended = false;
    for (;;) {
      yield {
        cond: () => {
          v.elapsed_s = this.now - t0;
          v.progress = clamp(v.elapsed_s / v.window_s, 0, 1);
          if (v.elapsed_s >= nextEmit) {
            nextEmit += 4;
            this.d.emit('verification.result', inc.id, { verification: { ...v } });
          }
          return v.elapsed_s >= v.window_s;
        },
      };
      yield* this.tool(task, 'compare_windows', { pre: 'incident open', post: `last ${Math.round(v.window_s)}s`, metrics: Object.keys(before) }, () => {
        after = this.metrics(det, inc.id);
        return { before, after };
      });
      const failing = this.checksFor(det, before, after).filter((c) => !c.pass);
      // thermal mass: if the only miss is margin and it is still recovering, keep watching
      const rising = this.scopeRacks(det).some((r) => this.marginSlope(r) > 0.002);
      if (!extended && failing.length > 0 && failing.every((c) => c.id === 'margin') && rising) {
        extended = true;
        v.window_s += 60;
        this.ev(inc, 'verification', 'Hydraulics recovered; thermal margin still rising — extending the stabilisation window', { asset_id: det.target_id });
        continue;
      }
      break;
    }
    v.checks = this.checksFor(det, before, after);
    const ok = v.checks.every((c) => c.pass);
    v.status = ok ? 'verified' : 'rejected';
    v.progress = 1;
    v.elapsed_s = windowS;
    v.confidence = ok ? clamp(0.82 + 0.02 * v.checks.length, 0, 0.97) : 0.3;
    v.completed_tick = this.d.tick();
    if (!ok) v.failed_reason = v.checks.filter((c) => !c.pass).map((c) => `${c.label} ${fmt(c.after, 2)}${c.unit} (needs ${c.direction === 'min' ? '≥' : '≤'} ${fmt(c.target, 2)})`).join('; ');
    this.d.emit('verification.result', inc.id, { verification: { ...v } });
    this.ev(inc, 'verification', ok ? `Verified after ${windowS}s window: ${v.checks.map((c) => `${c.label} ${fmt(c.after, 2)}${c.unit}`).join(' · ')}` : `Rejected: ${v.failed_reason}`, { asset_id: det.target_id });
    this.finish(
      task,
      ok ? 'verified' : 'rejected',
      ok ? `All ${v.checks.length} checks passed over a ${windowS}s stabilisation window. No new anomalies downstream.` : `Repair did not restore the plant: ${v.failed_reason}.`,
      { label: ok ? 'Verified' : 'Rejected', ok },
    );
    return ok;
  }

  /* ───────────────────────────── approvals ───────────────────────────── */

  private *approval(inc: Incident, task: AgentTask, action: string, steps: string[]): G {
    const supervised = this.d.config.approvalMode === 'supervised';
    const a: ApprovalRequest = {
      id: `ap_${++this.approvalSeq}`,
      incident_id: inc.id,
      task_id: task.id,
      action,
      steps,
      requested_tick: this.d.tick(),
      auto_approve_at_s: supervised ? null : this.now + this.d.config.approvalWindowS,
      status: 'pending',
    };
    inc.approval = a;
    this.setStatus(inc, 'awaiting_approval', `Awaiting operator approval: ${action}`);
    yield* this.tool(task, 'request_approval', { action, mode: supervised ? 'explicit' : 'veto-window', window_s: supervised ? null : this.d.config.approvalWindowS }, () => ({ approval_id: a.id, status: 'pending' }), 0.6);
    yield {
      cond: () => {
        if (a.status === 'pending' && a.auto_approve_at_s !== null && this.now >= a.auto_approve_at_s) a.status = 'approved';
        return a.status === 'approved';
      },
    };
    this.touch(inc);
  }

  /* ───────────────────────────── missions ───────────────────────────── */

  private newMission(inc: Incident, robot: RobotActor, kind: Mission['kind'], title: string, targetId: string, ops: Op[]): Mission {
    const m: Mission = {
      id: `m_${String(++this.missionSeq).padStart(2, '0')}`,
      incident_id: inc.id,
      robot_id: robot.id,
      kind,
      title,
      target_id: targetId,
      status: 'ASSIGNED',
      progress: 0,
      steps: ops.map<MissionStep>((o) => ({ id: o.id, command: o.command, label: o.label, status: 'pending' })),
      opened_tick: this.d.tick(),
    };
    this.missions.set(m.id, m);
    inc.mission_ids.push(m.id);
    this.touch(inc);
    return m;
  }

  private emitMission(m: Mission, robot: RobotActor) {
    this.d.emit('mission.transition', m.id, { mission: m, robot_mode: robot.mode, tool: robot.tool });
  }

  private *runOps(m: Mission, robot: RobotActor, task: AgentTask, ops: Op[]): G {
    robot.missionId = m.id;
    robot.taskId = task.id;
    this.emitMission(m, robot);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const step = m.steps[i];
      step.status = 'active';
      step.started_tick = this.d.tick();
      const cmd = op.make();
      robot.start(cmd);
      m.status = robot.mode;
      if (cmd.kind === 'move_inpipe') m.route_xyz_m = decimate(cmd.route.path.points, 0.35);
      if (cmd.kind === 'move_outrig') m.route_xyz_m = cmd.waypoints;
      m.route_segment_ids = cmd.kind === 'move_inpipe' ? cmd.route.legs.map((l) => l.edge_id) : m.route_segment_ids;
      let call: ToolCall | undefined;
      if (op.tool) {
        call = { id: `tc_${++this.toolSeq}`, task_id: task.id, name: op.tool.name, input: op.tool.input, status: 'running', tick: this.d.tick() };
        task.tool_calls.push(call);
        this.d.emit('agent.tool', task.id, { task_id: task.id, tool_call: call });
      }
      this.emitMission(m, robot);
      yield { cond: () => !robot.busy };
      const result = op.done?.();
      step.status = 'done';
      step.ended_tick = this.d.tick();
      if (typeof result === 'string') step.result = result;
      m.progress = (i + 1) / ops.length;
      if (call && op.tool) {
        call.output = op.tool.output();
        call.status = 'ok';
        call.latency_ms = Math.round(this.d.rng.range(900, 4200));
        this.d.emit('agent.tool', task.id, { task_id: task.id, tool_call: call });
      }
      this.emitMission(m, robot);
    }
    m.status = robot.mode;
    m.closed_tick = this.d.tick();
    this.emitMission(m, robot);
  }

  private finishRobot(robot: RobotActor, mode: RobotMode = 'DOCKED') {
    robot.mode = mode;
    robot.missionId = undefined;
    robot.taskId = undefined;
    robot.route = undefined;
    if (mode === 'DOCKED') robot.tool = null;
  }

  private crawlerOps(robot: RobotActor, target: { edge: string; s: number }, label: string): Op[] {
    const { graph } = this.d;
    const portLabel = this.d.topo.assets.find((a) => a.id === robot.homeId)?.label ?? robot.homeId;
    return [
      { id: 's1', command: 'launch', label: `Pre-flight check · launch from ${portLabel}`, make: () => ({ kind: 'action', label: 'launch', duration_s: 6, mode: 'ASSIGNED' }) },
      {
        id: 's2',
        command: 'move_to',
        label,
        make: () => {
          const route = graph.route({ edge_id: robot.segment_id!, s: robot.s_m! }, { edge_id: target.edge, s: target.s });
          return { kind: 'move_inpipe', route: route!, label };
        },
      },
    ];
  }

  private reachCrawler(edge: string, s: number): { robot: RobotActor; length: number; eta: number } | null {
    let best: { robot: RobotActor; length: number; eta: number } | null = null;
    for (const r of Object.values(this.d.robots)) {
      if (r.klass !== 'inpipe') continue;
      const route = this.d.graph.route({ edge_id: r.segment_id!, s: r.s_m! }, { edge_id: edge, s });
      if (!route) continue;
      if (!best || route.length < best.length) best = { robot: r, length: route.length, eta: route.length / 0.12 };
    }
    return best;
  }

  private *acquire(robot: RobotActor, inc: Incident): G {
    yield { cond: () => this.robotOwner[robot.id] === null && !robot.busy && !robot.controlled && (robot.mode === 'DOCKED' || robot.mode === 'IDLE') };
    this.robotOwner[robot.id] = inc.id;
  }

  private release(robot: RobotActor) {
    this.robotOwner[robot.id] = null;
  }

  private lockSuppress(ids: string[], until = Infinity) {
    for (const i of ids) this.suppress.set(i, until);
  }

  private zoneKeys(zone: 'a' | 'b'): string[] {
    const racks = RACK_IDS.filter((r) => ZONE_OF[r] === zone);
    return [`p_1${zone === 'a' ? 2 : 7}`, `p_2${zone === 'a' ? 2 : 7}`, `valve_z${zone}`, ...racks.flatMap((r) => [`rack_${r}`, `valve_${r}`]), `sn_flow_z${zone}`];
  }

  private *rampLoad(racks: RackKey[], to: number, seconds = 20): G {
    const steps = Math.max(1, Math.round(seconds));
    const from = racks.map((r) => this.d.plant.controls.loadFactor[r]);
    for (let i = 1; i <= steps; i++) {
      yield { dur: 1 };
      racks.forEach((r, k) => (this.d.plant.controls.loadFactor[r] = from[k] + (to - from[k]) * (i / steps)));
    }
  }

  /* ───────────────────────────── the incident playbook ───────────────────────────── */

  private *playbook(inc: Incident, det: Detection): G {
    const { plant, monitor, topo, graph } = this.d;
    const warnK = topo.limits.margin_warn_k;
    const m = monitor.meas;
    const ref = monitor.last.ref;
    const racks = this.scopeRacks(det);
    const edge = topo.edges.find((e) => e.id === det.target_id);

    /* 1 ─ classify */
    this.setStatus(inc, 'investigating', 'SENTINEL is classifying the anomaly.');
    const root = this.task(inc, { role: 'sentinel', kind: 'classify', title: 'Observe & classify', question: `What changed in the plant, and which mechanism fits "${det.title}"?`, asset_ids: det.affected.slice(0, 3) });
    yield* this.tool(root, 'read_telemetry', { assets: det.affected.slice(0, 4), window_s: 120 }, () => ({
      samples: 60,
      worst_margin_k: round(Math.min(...racks.map((r) => monitor.margin(r))), 1),
      tcs_flow_kg_s: round(m.tcsQ, 2),
      fws_flow_kg_s: round(m.fwsQ, 2),
    }));
    yield* this.tool(root, 'query_twin_residual', { healthy_twin: true, setpoints: 'current' }, () => ({
      tcs_flow_residual_pct: round(((m.tcsQ - ref.tcsQ) / ref.tcsQ) * 100, 1),
      zone_a_residual_pct: round(((zoneFlow(m, 'a') - ref.zoneQ.a) / ref.zoneQ.a) * 100, 1),
      zone_b_residual_pct: round(((zoneFlow(m, 'b') - ref.zoneQ.b) / ref.zoneQ.b) * 100, 1),
    }));
    this.finish(root, 'completed', `${det.summary} Opening an incident and delegating hydraulic, thermal and accessibility review.`, { label: 'Incident opened', ok: true });

    /* 2 ─ three reviewers in parallel (bounded fan-out) */
    const reviewers: Proc[] = [];
    const rTasks: AgentTask[] = [];
    for (const kind of ['hydraulics', 'thermal', 'accessibility'] as const) {
      const t = this.task(inc, { role: 'sentinel', kind: `review.${kind}`, title: `${kind[0].toUpperCase()}${kind.slice(1)} reviewer`, question: reviewQuestion(kind), parent: root, asset_ids: det.affected.slice(0, 3) });
      rTasks.push(t);
      reviewers.push(this.spawn(`rev:${inc.id}:${kind}`, this.reviewer(inc, det, t, kind)));
    }
    yield { cond: () => reviewers.every((p) => p.done) };

    /* 3 ─ reconcile */
    const rec = this.task(inc, { role: 'sentinel', kind: 'reconcile', title: 'Reconcile hypotheses', question: 'Which hypothesis is best supported by the evidence and counter-evidence?', parent: root, caused_by: rTasks });
    yield* this.tool(rec, 'rank_hypotheses', { candidates: 'auto', evidence: inc.evidence.length }, () => ({ ranked: true }), 1.0);
    inc.hypotheses = this.hypothesesFor(inc, det);
    inc.cause = inc.hypotheses[0]?.cause ?? 'unknown';
    this.stage(inc, 'hypothesized');
    const top = inc.hypotheses[0];
    this.finish(rec, 'completed', `Leading hypothesis: ${top.label} (${pct(top.confidence)}). ${inc.hypotheses.slice(1).map((h) => `${h.label} ${pct(h.confidence)}`).join(' · ')}.`, { label: top.label, ok: true });
    this.setStatus(inc, 'investigating', `Leading hypothesis: ${top.label} (${pct(top.confidence)}).`);

    /* 4 ─ per-cause plan */
    switch (det.cause) {
      case 'fouling':
        yield* this.runFouling(inc, det, rec, edge!.id);
        break;
      case 'strainer_blockage':
        yield* this.runStrainer(inc, det, rec);
        break;
      case 'valve_stuck':
        yield* this.runValve(inc, det, rec);
        break;
      case 'pump_degradation':
        yield* this.runPump(inc, det, rec);
        break;
      case 'sensor_drift':
        yield* this.runSensor(inc, det, rec);
        break;
      case 'workload_spike':
        yield* this.runWorkload(inc, det, rec);
        break;
      default:
        break;
    }
    void warnK;
    void graph;
  }

  /* ── reviewers ── */

  private *reviewer(inc: Incident, det: Detection, t: AgentTask, kind: 'hydraulics' | 'thermal' | 'accessibility'): G {
    const { monitor, topo, graph, plant } = this.d;
    const m = monitor.meas;
    const ref = monitor.last.ref;
    const racks = this.scopeRacks(det);
    const eId = det.target_id;
    if (kind === 'hydraulics') {
      let summary = '';
      const ids: string[] = [];
      if (det.cause === 'fouling') {
        const ratio = monitor.dpRatio(eId);
        const occ = estOcclusion(ratio);
        const zone = topo.edges.find((e) => e.id === eId)?.zone_id;
        yield* this.tool(t, 'query_topology', { edge: eId, neighbors: true }, () => {
          const e = topo.edges.find((x) => x.id === eId)!;
          return { edge: e.label, loop: e.loop, diameter_mm: e.diameter_mm, length_m: e.length_m, passable: e.robot_passable };
        });
        const res = yield* this.tool(t, 'solve_twin_whatif', { hypothesis: `bore occlusion on ${eId}`, occlusion: round(occ, 2) }, () => {
          const f = initialFaults();
          f.occl[eId] = occ;
          const h = solveHydraulics({ faults: f, controls: plant.controls });
          return { predicted_dp_ratio: round(foulFactor(occ), 2), observed_dp_ratio: round(ratio, 2), predicted_zone_flow: round(zone === 'zone_b' ? h.zoneQ.b : zone === 'zone_a' ? h.zoneQ.a : h.tcsQ, 2) };
        });
        ids.push(this.ev(inc, 'telemetry', `Twin what-if: ~${pct(occ)} bore restriction on ${eId.toUpperCase().replace('_', '-')} reproduces ΔP ${fmt(ratio, 1)}× design`, { asset_id: eId, tags: ['hydraulics', 'what-if'] }));
        summary = `A localized restriction near ${eId.toUpperCase().replace('_', '-')} (~${pct(occ)} of bore) reproduces the measured ΔP (${fmt(ratio, 1)}× design) and the flow redistribution to the neighbouring zone. Twin predicts ${fmt(Number(res.predicted_zone_flow), 2)} kg/s through the zone.`;
      } else if (det.cause === 'strainer_blockage') {
        const ratio = monitor.strainerRatio(eId as 'strainer_01' | 'strainer_02');
        const occ = 1 - Math.pow(ratio, -0.4);
        yield* this.tool(t, 'query_topology', { asset: eId }, () => ({ asset: eId, loop: eId === 'strainer_01' ? 'fws' : 'tcs', inline: true }));
        yield* this.tool(t, 'solve_twin_whatif', { hypothesis: `basket clogging at ${eId}`, occlusion: round(occ, 2) }, () => ({ predicted_dp_ratio: round(ratio, 2), flow_loss_pct: round((1 - (eId === 'strainer_01' ? m.fwsQ / ref.fwsQ : m.tcsQ / ref.tcsQ)) * 100, 1) }));
        ids.push(this.ev(inc, 'telemetry', `Basket ~${pct(occ)} blocked explains ΔP ${fmt(ratio, 1)}× and loop flow loss`, { asset_id: eId, tags: ['hydraulics'] }));
        summary = `Strainer ΔP is ${fmt(ratio, 1)}× design while the whole loop's flow fell uniformly — a series restriction, not a branch problem. Basket blockage of roughly ${pct(occ)} fits.`;
      } else if (det.cause === 'valve_stuck') {
        const r = racks[0];
        const est = estimateValve(this.d.plant, r, m.rackFlow[r]);
        yield* this.tool(t, 'query_topology', { asset: det.target_id, branch: `rack_${r}` }, () => ({ commanded_opening_pct: Math.round(plant.controls.valveCmd[r] * 100), header: ZONE_OF[r] === 'a' ? 'P-12' : 'P-17' }));
        yield* this.tool(t, 'solve_twin_whatif', { hypothesis: `valve_${r} effective opening`, opening: round(est, 2) }, () => ({ predicted_branch_flow: round(m.rackFlow[r], 2), expected_flow: round(ref.rackQ[r], 2) }));
        ids.push(this.ev(inc, 'telemetry', `Branch flow implies valve effective opening ≈ ${pct(est)} vs ${pct(plant.controls.valveCmd[r])} commanded`, { asset_id: det.target_id, tags: ['hydraulics'] }));
        summary = `Only rack ${RACK_LABEL(r)} is starved; its header ΔP and sibling rack are normal. The branch behaves like a valve at ~${pct(est)} effective opening against ${pct(plant.controls.valveCmd[r])} commanded.`;
      } else if (det.cause === 'pump_degradation') {
        yield* this.tool(t, 'query_pump_curve', { pump: eId, speed_pct: Math.round(plant.controls.tcsSpeed * 100) }, () => ({ head_measured_kpa: round(m.pumpHead.tcs, 0), head_on_curve_kpa: round(PUMP_T.h0 * plant.controls.tcsSpeed ** 2 - PUMP_T.a * m.tcsQ ** 2, 0) }));
        ids.push(this.ev(inc, 'telemetry', `Pump head ${fmt(m.pumpHead.tcs, 0)} kPa below curve with vibration ${fmt(plant.vib[eId], 1)} mm/s`, { asset_id: eId, tags: ['pump'] }));
        summary = `Every branch lost flow in proportion and no ΔP anomaly exists in any segment: the shortfall originates at the pump. Head is below the curve and vibration is elevated.`;
      } else if (det.cause === 'sensor_drift') {
        yield* this.tool(t, 'check_mass_balance', { meters: [eId], reference: 'rack meters' }, () => ({ residual_kg_s: round(m.edgeFlow[eId === 'sn_flow_zb' ? 'p_17' : eId === 'sn_flow_za' ? 'p_12' : 'p_10'] - zoneFlow(m, eId.endsWith('trunk') ? null : eId.endsWith('zb') ? 'b' : 'a'), 2) }));
        ids.push(this.ev(inc, 'telemetry', 'Mass balance does not close at the suspect meter while rack meters agree with the pump curve', { asset_id: eId, tags: ['sensor'] }));
        summary = `Rack-level meters agree with the pump curve and thermal response; only ${eId === 'sn_flow_zb' ? 'FM-17' : eId === 'sn_flow_za' ? 'FM-12' : 'FM-10'} disagrees. The plant is behaving normally — the instrument is the likelier culprit.`;
      } else {
        yield* this.tool(t, 'check_flow_normality', { rack: eId }, () => ({ flow_residual_pct: round(((m.rackFlow[racks[0]] - ref.rackQ[racks[0]]) / ref.rackQ[racks[0]]) * 100, 1) }));
        ids.push(this.ev(inc, 'telemetry', 'Hydraulics nominal on every branch', { tags: ['hydraulics'] }));
        summary = 'Flow, ΔP and pump behaviour are all nominal. No hydraulic cause is indicated.';
      }
      this.finish(t, 'completed', summary, { label: 'Hydraulic picture', ok: true }, ids);
      return;
    }

    if (kind === 'thermal') {
      const worstRack = racks.reduce((a, r) => (monitor.margin(r) < monitor.margin(a) ? r : a), racks[0]);
      const slope = this.marginSlope(worstRack);
      yield* this.tool(t, 'read_telemetry', { assets: racks.map((r) => `rack_${r}`), metric: 'margin_k' }, () => ({ worst_rack: RACK_LABEL(worstRack), margin_k: round(monitor.margin(worstRack), 1), t_chip_c: round(m.rackChip[worstRack], 1) }));
      const fc = yield* this.tool(t, 'forecast_margin', { rack: `rack_${worstRack}`, horizon_s: 600 }, () => {
        const m0 = monitor.margin(worstRack);
        const toWarn = slope < -0.002 && m0 > warnOf(topo) ? (m0 - warnOf(topo)) / -slope : null;
        return { slope_k_per_min: round(slope * 60, 2), seconds_to_warning: toWarn === null ? null : Math.round(toWarn) };
      });
      const id = this.ev(inc, 'telemetry', `Rack ${RACK_LABEL(worstRack)} margin ${fmt(monitor.margin(worstRack), 1)} K (${fc.slope_k_per_min} K/min)`, { asset_id: `rack_${worstRack}`, tags: ['thermal'] });
      const eta = fc.seconds_to_warning as number | null;
      this.finish(
        t,
        'completed',
        `Rack ${RACK_LABEL(worstRack)} is the thermal limiter at ${fmt(monitor.margin(worstRack), 1)} K margin${eta ? `, eroding ${Math.abs(Number(fc.slope_k_per_min))} K/min — warning threshold in ~${Math.max(1, Math.round(eta / 60))} min if nothing changes` : ' and stable for now'}.`,
        { label: 'Thermal risk', ok: true },
        [id],
      );
      return;
    }

    // accessibility
    const target = det.cause === 'fouling' ? { edge: eId, s: plant.faults.occlS[eId] ?? graph.length(eId) / 2 } : null;
    const out = yield* this.tool(t, 'check_reachability', { targets: [eId], robot_classes: ['inpipe', 'outrig'] }, () => {
      const res: Record<string, unknown> = {};
      for (const r of Object.values(this.d.robots)) {
        if (r.klass === 'inpipe') {
          const edgeId = det.cause === 'valve_stuck' ? (ZONE_OF[racks[0]] === 'a' ? 'p_12' : 'p_17') : det.cause === 'sensor_drift' ? topo.assets.find((a) => a.id === eId)?.edge_id ?? 'p_10' : target?.edge ?? null;
          if (!edgeId) {
            res[r.id] = { reachable: false, reason: 'target is not a serviceable pipe' };
            continue;
          }
          const route = graph.route({ edge_id: r.segment_id!, s: r.s_m! }, { edge_id: edgeId, s: graph.length(edgeId) / 2 });
          res[r.id] = route ? { reachable: true, route_m: round(route.length, 1), eta_s: Math.round(route.length / 0.12), via: route.legs.map((l) => l.edge_id).join(' → ') } : { reachable: false };
        }
      }
      const svc = topo.assets.find((a) => a.id === eId)?.service_xyz_m;
      res.o_01 = svc ? { reachable: true, service_pose: svc.map((x) => round(x, 1)) } : { reachable: false, reason: 'no direct service access' };
      return res;
    });
    const reach = Object.entries(out).filter(([k, v]) => k.startsWith('c_') && (v as { reachable: boolean }).reachable) as Array<[string, { route_m: number; eta_s: number; via: string }]>;
    const id = this.ev(inc, 'topology', reach.length ? `${reach.map(([k, v]) => `${k.toUpperCase().replace('_', '-')} can reach the segment (${v.route_m} m)`).join('; ')}` : 'No crawler route to the target — exterior access only', { asset_id: eId, tags: ['access'] });
    this.finish(
      t,
      'completed',
      reach.length
        ? `${reach[0][0].toUpperCase().replace('_', '-')} can reach ${eId.toUpperCase().replace('_', '-')} via ${reach[0][1].via} (${reach[0][1].route_m} m, ETA ${Math.round(reach[0][1].eta_s / 60 * 10) / 10} min). OUTRIG has a legal service pose for exterior work.`
        : `No crawler can enter this component (bore or topology). OUTRIG has a legal service pose for exterior work.`,
      { label: reach.length ? 'Crawler route found' : 'Exterior only', ok: true },
      [id],
    );
  }

  private marginSlope(r: RackKey) {
    const h = this.hist.slice(-20);
    if (h.length < 6) return 0;
    const first = h[0];
    const last = h[h.length - 1];
    const dt = Math.max(last.t - first.t, 1);
    return (this.d.monitor.margin(r, last) - this.d.monitor.margin(r, first)) / dt;
  }

  private hypothesesFor(inc: Incident, det: Detection): Hypothesis[] {
    const mk = (cause: FaultKind, target: string, label: string, w: number, f: string[], a: string[], status: Hypothesis['status'] = 'candidate'): Hypothesis => ({ id: `h_${inc.id}_${cause}_${target}`, cause, label, target_id: target, confidence: w, status, evidence_for: f, evidence_against: a });
    const ev = inc.evidence.map((e) => e.id);
    const z = (id: string) => id.replace('_', '-').toUpperCase();
    let hs: Hypothesis[] = [];
    switch (det.cause) {
      case 'fouling': {
        const zv = this.d.topo.edges.find((e) => e.id === det.target_id)?.zone_id === 'zone_a' ? 'valve_za' : 'valve_zb';
        hs = [
          mk('fouling', det.target_id, `Fouling in ${z(det.target_id)}`, 0.64, ev.slice(0, 3), []),
          mk('valve_stuck', zv, `Isolation valve ${zv === 'valve_za' ? 'V-ZA' : 'V-ZB'} partly closed`, 0.17, [ev[0]], ['Would not raise ΔP at the recorded flow signature']),
          mk('sensor_drift', 'sn_flow_zb', 'Flow-meter drift', 0.1, [], ['ΔP and rack temperatures corroborate the flow loss']),
          mk('strainer_blockage', 'strainer_02', 'Strainer S-02 blockage', 0.09, [], ['Neighbouring zone flow rose — a series blockage would lower both']),
        ];
        break;
      }
      case 'strainer_blockage':
        hs = [
          mk('strainer_blockage', det.target_id, `${det.target_id === 'strainer_01' ? 'S-01' : 'S-02'} basket blockage`, 0.7, ev.slice(0, 3), []),
          mk('pump_degradation', this.d.plant.controls.tcsDuty, 'Pump degradation', 0.14, [ev[0]], ['Vibration within normal band']),
          mk('fouling', 'p_10', 'Trunk fouling', 0.16, [], ['ΔP localised at the strainer, not along the pipe']),
        ];
        break;
      case 'valve_stuck':
        hs = [
          mk('valve_stuck', det.target_id, `${z(det.target_id.replace('valve_', 'V-'))} actuator stuck partially closed`, 0.58, ev.slice(0, 3), []),
          mk('fouling', ZONE_OF[det.target_id.replace('valve_', '') as RackKey] === 'a' ? 'p_12' : 'p_17', 'Header fouling upstream', 0.26, [ev[0]], ['Header ΔP is nominal']),
          mk('sensor_drift', 'sn_flow_zb', 'Rack flow-meter drift', 0.16, [], ['Rack inlet/outlet ΔT corroborates reduced flow']),
        ];
        break;
      case 'pump_degradation':
        hs = [
          mk('pump_degradation', det.target_id, `${det.target_id === 'pump_t1' ? 'TCS-PMP-1' : 'TCS-PMP-2'} bearing / impeller wear`, 0.76, ev.slice(0, 3), []),
          mk('strainer_blockage', 'strainer_02', 'Strainer S-02 blockage', 0.14, [], ['Strainer ΔP is nominal']),
          mk('sensor_drift', 'sn_flow_trunk', 'Trunk flow-meter drift', 0.1, [], ['Pump head is independently low']),
        ];
        break;
      case 'sensor_drift':
        hs = [
          mk('sensor_drift', det.target_id, `${det.target_id === 'sn_flow_zb' ? 'FM-17' : det.target_id === 'sn_flow_za' ? 'FM-12' : 'FM-10'} measurement drift`, 0.62, ev.slice(0, 3), []),
          mk('fouling', det.target_id === 'sn_flow_za' ? 'p_12' : 'p_17', 'Real flow reduction in the header', 0.3, [ev[0]], ['Rack meters and temperatures show no flow loss']),
          mk('valve_stuck', 'valve_zb', 'Valve movement', 0.08, [], ['No ΔP change']),
        ];
        break;
      case 'workload_spike':
        hs = [
          mk('workload_spike', det.target_id, 'Workload surge (no hydraulic fault)', 0.9, ev.slice(0, 2), []),
          mk('valve_stuck', det.target_id.replace('rack_', 'valve_'), 'Branch valve stuck', 0.06, [], ['Branch flow is nominal']),
          mk('fouling', 'p_17', 'Header fouling', 0.04, [], ['ΔP across headers is nominal']),
        ];
        break;
      default:
        break;
    }
    const total = hs.reduce((a, h) => a + h.confidence, 0);
    hs.forEach((h) => (h.confidence = round(h.confidence / total, 2)));
    hs.forEach((h, i) => (h.status = i === 0 ? 'supported' : 'candidate'));
    return hs;
  }

  private updateHypotheses(inc: Incident, confirmed: FaultKind, note: string, refuted: FaultKind[] = []) {
    for (const h of inc.hypotheses) {
      if (h.cause === confirmed) {
        h.confidence = 0.96;
        h.status = 'confirmed';
        h.evidence_for.push(note);
      } else if (refuted.includes(h.cause) || inc.hypotheses[0]?.cause === confirmed) {
        h.confidence = Math.min(h.confidence, 0.03);
        h.status = 'refuted';
      }
    }
    inc.hypotheses.sort((a, b) => b.confidence - a.confidence);
    inc.cause = confirmed;
    this.touch(inc);
  }

  /* ───────────────────────────── crawler inspection ───────────────────────────── */

  /** Dispatch a crawler to an edge position, inspect, and return the observation. Returns the crawler. */
  private *inspect(
    inc: Incident,
    parent: AgentTask,
    edgeId: string,
    s: number,
    spec: { title: string; question: string; gauge: 'deposit' | 'bore' | 'flow'; sensorId?: string },
    out: { robot?: RobotActor; obs?: Record<string, number | string> },
  ): G<boolean> {
    const { graph, plant, rng } = this.d;
    const reach = this.reachCrawler(edgeId, s);
    if (!reach) return false;
    const robot = reach.robot;
    const req = this.task(inc, { role: 'sentinel', kind: 'mission.request', title: `Request ${robot.id.toUpperCase().replace('_', '-')} inspection`, question: 'Which robot can legally reach the target, and does the mission fit within battery and route constraints?', parent, det: true });
    yield* this.tool(req, 'propose_mission', { robot: robot.id, target: edgeId, s_m: round(s, 2), tool: spec.gauge }, () => ({ route_m: round(reach.length, 1), eta_s: Math.round(reach.eta), battery_reserve_ok: robot.battery > 40 }), 1.0);
    this.finish(req, 'completed', `${robot.name} is the closest legal option (${fmt(reach.length)} m). Mission approved within policy.`, { label: 'Dispatched', ok: true });

    yield* this.acquire(robot, inc);
    out.robot = robot;
    const task = this.task(inc, { role: 'inpipe', kind: 'inspect', title: spec.title, question: spec.question, parent: req, robot_id: robot.id, asset_ids: [edgeId], det: false });
    const label = spec.gauge === 'flow' ? `Travel to ${edgeId.toUpperCase().replace('_', '-')} meter position` : `Scan ${edgeId.toUpperCase().replace('_', '-')} for restrictions`;
    const ops: Op[] = [
      ...this.crawlerOps(robot, { edge: edgeId, s }, label),
      {
        id: 's3',
        command: 'inspect',
        label: spec.gauge === 'flow' ? 'Local flow & ΔP probe' : 'Camera + ultrasonic wall gauge',
        make: () => ({ kind: 'action', label: 'inspect', duration_s: 14, mode: 'INSPECTING', tool: null }),
        tool: { name: spec.gauge === 'flow' ? 'local_flow_probe' : 'ultrasonic_gauge', input: { edge: edgeId, s_m: round(s, 2) }, output: () => ({ ...(out.obs ?? {}) }) },
        done: () => {
          const o = plant.faults.occl[edgeId] ?? 0;
          if (spec.gauge === 'flow') {
            const sensorEdge = edgeId;
            const trueQ = this.d.plant.hyd.zoneQ ? (sensorEdge === 'p_12' ? this.d.plant.hyd.zoneQ.a : sensorEdge === 'p_17' ? this.d.plant.hyd.zoneQ.b : this.d.plant.hyd.tcsQ) : 0;
            const probe = trueQ + rng.normal() * 0.012;
            const meter = this.d.monitor.meas.edgeFlow[sensorEdge];
            out.obs = { probe_kg_s: round(probe, 2), meter_kg_s: round(meter, 2), offset_kg_s: round(meter - probe, 2) };
            return `Probe ${fmt(probe, 2)} kg/s vs meter ${fmt(meter, 2)} kg/s`;
          }
          const oEst = clamp(o + rng.normal() * 0.02, 0, 0.97);
          const dn = graph.edge(edgeId).diameter_mm;
          out.obs = { occlusion: round(oEst, 2), effective_bore_mm: Math.round(dn * (1 - oEst)), deposit_thickness_mm: round((dn / 2) * oEst, 1), location_s_m: round(s, 1), wall_thickness: 'nominal', through_wall_defect: 'none' };
          return `${pct(oEst)} of bore blocked at s = ${fmt(s, 1)} m`;
        },
      },
    ];
    const m = this.newMission(inc, robot, 'inspect', `${spec.title}`, edgeId, ops);
    this.setStatus(inc, 'investigating', `${robot.name} is travelling to ${edgeId.toUpperCase().replace('_', '-')} (${fmt(reach.length)} m).`);
    yield* this.runOps(m, robot, task, ops);
    const obs = out.obs!;
    const evId = this.ev(inc, 'observation', spec.gauge === 'flow' ? `Crawler probe ${obs.probe_kg_s} kg/s vs meter ${obs.meter_kg_s} kg/s` : `Ultrasonic scan: ${pct(Number(obs.occlusion))} of bore blocked, effective bore ${obs.effective_bore_mm} mm, wall intact`, { asset_id: edgeId, tags: ['inpipe', 'observation'], data: obs as Record<string, number | string> });
    this.finish(
      task,
      'completed',
      spec.gauge === 'flow'
        ? `Local probe reads ${obs.probe_kg_s} kg/s; the fixed meter reads ${obs.meter_kg_s} kg/s. Offset ${obs.offset_kg_s} kg/s.`
        : spec.gauge === 'bore'
          ? `Bore is ${Number(obs.occlusion) < 0.1 ? 'clean' : 'mildly fouled'} (${pct(Number(obs.occlusion))}); no internal obstruction explains the symptom.`
          : `Deposit of ${obs.deposit_thickness_mm} mm narrows the bore to ${obs.effective_bore_mm} mm at s = ${obs.location_s_m} m; wall thickness nominal, no through-wall defect.`,
      { label: spec.gauge === 'flow' ? 'Meter offset confirmed' : spec.gauge === 'bore' ? 'Bore clear' : 'Restriction located', ok: true },
      [evId],
    );
    robot.mode = 'ASSIGNED'; // holding position, awaiting SENTINEL's decision
    this.setStatus(inc, 'investigating', spec.gauge === 'flow' ? `${robot.name} corroborated the meter offset in-pipe.` : spec.gauge === 'bore' ? `${robot.name} found the bore clear — narrowing the cause.` : `${robot.name} located the restriction (${pct(Number(obs.occlusion))} of bore blocked).`);
    return true;
  }

  private *returnCrawler(inc: Incident, robot: RobotActor, parent: AgentTask) {
    const { graph, topo } = this.d;
    const home = topo.assets.find((a) => a.id === robot.homeId)!;
    const task = this.task(inc, { role: 'inpipe', kind: 'return', title: `${robot.id.toUpperCase().replace('_', '-')} return to port`, question: 'Return safely to the launch port with battery reserve intact.', parent, robot_id: robot.id, det: true });
    const ops: Op[] = [
      {
        id: 'r1',
        command: 'return_to_port',
        label: `Return to ${home.label}`,
        make: () => ({ kind: 'move_inpipe', mode: 'RETURNING', label: 'return', route: graph.route({ edge_id: robot.segment_id!, s: robot.s_m! }, { edge_id: home.edge_id!, s: home.s_m! })! }),
      },
      { id: 'r2', command: 'dock', label: 'Dock & recharge', make: () => ({ kind: 'action', label: 'dock', duration_s: 5, mode: 'RETURNING' }) },
    ];
    const m = this.newMission(inc, robot, 'return', `Return ${robot.id.toUpperCase().replace('_', '-')} to ${home.label}`, home.id, ops);
    yield* this.runOps(m, robot, task, ops);
    this.finishRobot(robot, 'DOCKED');
    this.release(robot);
    this.finish(task, 'completed', `${robot.name} docked at ${home.label}; battery ${Math.round(robot.battery)}%.`, { label: 'Docked', ok: true });
    this.emitMission(m, robot);
  }

  /* ───────────────────────────── OUTRIG job ───────────────────────────── */

  private *outrigJob(
    inc: Incident,
    det: Detection,
    parent: AgentTask,
    job: {
      title: string;
      tool: string;
      targetId: string;
      isolate?: { valve: string; zone: 'a' | 'b' };
      actions: Array<{ id: string; command: string; label: string; dur: number; mode?: RobotMode; done?: () => string | void; tool?: Op['tool'] }>;
      swapAfter?: boolean;
    },
  ): G<boolean> {
    const { topo, nav, plant, robots } = this.d;
    const robot = robots.o_01;
    const asset = topo.assets.find((a) => a.id === job.targetId)!;
    const zoneRacks = job.isolate ? RACK_IDS.filter((r) => ZONE_OF[r] === job.isolate!.zone) : [];

    /* plan */
    const plan = this.task(inc, { role: 'sentinel', kind: 'plan', title: 'Plan work order', question: 'What is the minimum safe sequence that fixes the cause, and what does it cost the plant?', parent, det: false, asset_ids: [job.targetId] });
    const steps = [
      ...(job.isolate ? [`Cordon racks ${zoneRacks.map(RACK_LABEL).join(' & ')} (migrate workload)`, `Isolate via ${topo.assets.find((a) => a.id === job.isolate!.valve)!.label}`] : []),
      ...job.actions.map((a) => a.label),
      ...(job.isolate ? ['Pressure test', `Re-open ${topo.assets.find((a) => a.id === job.isolate!.valve)!.label}`, 'Restore workload'] : []),
    ];
    yield* this.tool(plan, 'compose_work_order', { target: job.targetId, tool: job.tool }, () => ({ steps, est_duration_s: job.actions.reduce((a, x) => a + x.dur, 0) + 90 }));
    this.finish(plan, 'completed', `${steps.length}-step work order: ${steps.join(' → ')}.`, { label: 'Work order ready', ok: true });

    /* safety */
    const safety = this.task(inc, { role: 'sentinel', kind: 'safety', title: 'Safety & policy review', question: 'Is every step whitelisted, physically safe and covered by an approval policy?', parent: plan, det: true, asset_ids: [job.targetId] });
    const impact = yield* this.tool(safety, 'check_safety_policy', { steps: steps.length, isolation: !!job.isolate }, () => ({
      whitelisted: true,
      isolation_required: !!job.isolate,
      cordon: zoneRacks.map(RACK_LABEL),
      crawler_inside_segment: false,
      pressure_below_service_threshold: true,
      thermal_impact: job.isolate ? `${zoneRacks.length} racks leave service; remaining racks absorb no extra heat` : 'none',
      approval: job.isolate ? (this.d.config.approvalMode === 'supervised' ? 'operator approval' : 'operator veto window') : 'policy auto-approved',
    }));
    this.finish(safety, 'completed', job.isolate ? `Isolation is required: racks ${zoneRacks.map(RACK_LABEL).join(' & ')} must be cordoned first so no workload loses cooling. Crawler must be out of the segment. High-impact → ${String(impact.approval)}.` : `Work stays within the whitelist and needs no isolation. Policy auto-approves.`, { label: job.isolate ? 'Approval needed' : 'Within policy', ok: true });

    if (job.isolate) {
      yield* this.approval(inc, safety, `Isolate ${topo.assets.find((a) => a.id === job.isolate!.valve)!.label} and service ${asset.label}`, steps);
    }

    /* resources */
    yield* this.acquire(robot, inc);
    if (job.isolate) {
      yield { cond: () => this.isolationOwner === null || this.isolationOwner === inc.id };
      this.isolationOwner = inc.id;
      this.lockSuppress(this.zoneKeys(job.isolate.zone));
      // wait for every crawler to be out of the zone's pipes
      const zoneEdges = new Set([`p_${job.isolate.zone === 'a' ? 12 : 17}`, `p_${job.isolate.zone === 'a' ? 22 : 27}`]);
      yield { cond: () => !Object.values(robots).some((r) => r.klass === 'inpipe' && r.mode !== 'DOCKED' && r.segment_id && zoneEdges.has(r.segment_id) && r.busy) && !Object.values(robots).some((r) => r.klass === 'inpipe' && r.segment_id && zoneEdges.has(r.segment_id) && r.mode !== 'DOCKED') };
      this.setStatus(inc, 'mitigating', `Cordoning racks ${zoneRacks.map(RACK_LABEL).join(' & ')} before isolation.`);
      const cord = this.task(inc, { role: 'sentinel', kind: 'cordon', title: 'Cordon racks', question: 'Migrate workload off the affected racks so isolation costs no compute.', parent: safety, det: true });
      yield* this.tool(cord, 'migrate_workload', { racks: zoneRacks.map((r) => `rack_${r}`), target_load_pct: 10 }, () => ({ status: 'draining' }), 0.8);
      yield* this.rampLoad(zoneRacks, 0.1, 20);
      this.ev(inc, 'action', `Workload migrated off racks ${zoneRacks.map(RACK_LABEL).join(' & ')} (load → 10%)`, { asset_id: `rack_${zoneRacks[0]}` });
      this.finish(cord, 'completed', `Racks ${zoneRacks.map(RACK_LABEL).join(' & ')} drained to idle; heat load removed before isolation.`, { label: 'Racks cordoned', ok: true });
    } else {
      this.lockSuppress([job.targetId]);
      this.setStatus(inc, 'mitigating', 'OUTRIG is preparing the work.');
    }

    /* physical work */
    const task = this.task(inc, { role: 'outrig', kind: 'service', title: job.title, question: 'Execute the approved work order with accessible, interlocked service actions only.', parent: safety, robot_id: robot.id, asset_ids: [job.targetId], det: false });
    const svc = nav.snap(asset.service_xyz_m ?? asset.position_xyz_m);
    const dock = topo.assets.find((a) => a.id === 'dock_o1')!;
    const ops: Op[] = [];
    ops.push({
      id: 'o1',
      command: 'fetch_tool',
      label: `Fetch ${job.tool}`,
      make: () => ({ kind: 'action', label: 'fetch', duration_s: 10, mode: 'WORKING', tool: job.tool }),
      tool: { name: 'fetch_tool', input: { tool: job.tool }, output: () => ({ attached: job.tool }) },
    });
    ops.push({
      id: 'o2',
      command: 'navigate',
      label: `Navigate to ${asset.label} service pose`,
      make: () => {
        const wp = nav.route([robot.pos[0], 0, robot.pos[2]], svc);
        return { kind: 'move_outrig', waypoints: wp ?? [robot.pos, svc], label: 'navigate' };
      },
      tool: { name: 'plan_route', input: { to: asset.label, planner: 'A* 0.25 m grid · 0.55 m clearance' }, output: () => ({ waypoints: robot.route?.length ?? 0, reached: true }) },
    });
    ops.push({ id: 'o3', command: 'scan', label: `Scan ${asset.label} (visual + thermal)`, make: () => ({ kind: 'action', label: 'scan', duration_s: 8, mode: 'INSPECTING' }) });
    if (job.isolate) {
      const vlabel = topo.assets.find((a) => a.id === job.isolate!.valve)!.label;
      const vSvc = nav.snap(topo.assets.find((a) => a.id === job.isolate!.valve)!.service_xyz_m ?? svc);
      ops.push({
        id: 'o4',
        command: 'isolate_valve',
        label: `Isolate ${vlabel}`,
        make: () => {
          // reposition to the isolation valve if it differs from the service pose
          return { kind: 'action', label: 'isolate', duration_s: 15, mode: 'WORKING' };
        },
        done: () => {
          plant.controls.isolated[job.isolate!.valve] = true;
          this.ev(inc, 'action', `${vlabel} closed — zone ${job.isolate!.zone.toUpperCase()} isolated`, { asset_id: job.isolate!.valve });
          return `${vlabel} closed`;
        },
        tool: { name: 'isolate_valve', input: { valve: job.isolate.valve, interlocks: ['crawler_out', 'cordoned', 'pressure_ok'] }, output: () => ({ closed: true }) },
      });
      void vSvc;
    }
    for (const a of job.actions) {
      ops.push({ id: a.id, command: a.command, label: a.label, make: () => ({ kind: 'action', label: a.command, duration_s: a.dur, mode: a.mode ?? 'WORKING' }), done: a.done, tool: a.tool });
    }
    if (job.isolate) {
      const vlabel = topo.assets.find((a) => a.id === job.isolate!.valve)!.label;
      ops.push({ id: 'o8', command: 'pressure_test', label: 'Pressure test at 1.5× operating', make: () => ({ kind: 'action', label: 'test', duration_s: 20, mode: 'INSPECTING' }), tool: { name: 'pressure_test', input: { hold_s: 15, kpa: 280 }, output: () => ({ result: 'hold ok', leak_kg_s: 0 }) } });
      ops.push({
        id: 'o9',
        command: 'reopen_valve',
        label: `Re-open ${vlabel}`,
        make: () => ({ kind: 'action', label: 'reopen', duration_s: 10, mode: 'WORKING' }),
        done: () => {
          plant.controls.isolated[job.isolate!.valve] = false;
          return `${vlabel} open`;
        },
      });
    }
    ops.push({
      id: 'o10',
      command: 'return_to_dock',
      label: 'Return to charging bay',
      make: () => {
        const wp = nav.route([robot.pos[0], 0, robot.pos[2]], [dock.position_xyz_m[0], 0, dock.position_xyz_m[2]]);
        return { kind: 'move_outrig', waypoints: wp ?? [robot.pos, dock.position_xyz_m], label: 'return', mode: 'RETURNING' };
      },
    });
    const mission = this.newMission(inc, robot, 'service', job.title, job.targetId, ops);
    this.setStatus(inc, 'mitigating', `OUTRIG is executing: ${job.title}.`);
    // dispatch the exterior robot; verification can start as soon as the repair itself is done
    const jobDone = this.spawn(`outrig:${inc.id}`, this.runOps(mission, robot, task, ops));
    const repairedIdx = ops.findIndex((o) => o.id === job.actions[job.actions.length - 1].id);
    yield { cond: () => mission.steps[repairedIdx].status === 'done' };
    this.stage(inc, 'repaired');
    if (job.isolate) {
      // wait until the isolation is fully released (test + re-open done), then restore the load
      yield { cond: () => !plant.controls.isolated[job.isolate!.valve] && mission.steps[ops.findIndex((o) => o.id === 'o9')].status === 'done' };
      this.ev(inc, 'action', `Zone ${job.isolate.zone.toUpperCase()} re-opened; restoring workload`, { asset_id: job.isolate.valve });
      this.spawn(`restore:${inc.id}`, this.rampLoad(zoneRacks, 1, 20));
    }
    yield { cond: () => jobDone.done };
    this.finishRobot(robot, 'DOCKED');
    this.release(robot);
    this.finish(task, 'completed', `Work order complete: ${job.title}.`, { label: 'Work complete', ok: true });
    if (job.isolate) this.isolationOwner = null;
    // release the detection lock after a settling grace period
    this.lockSuppress(job.isolate ? this.zoneKeys(job.isolate.zone) : [job.targetId], this.now + 90);
    return true;
  }

  /* ───────────────────────────── playbooks per cause ───────────────────────────── */

  private *closeOrReplan(inc: Incident, det: Detection, verifier: AgentTask | null, ok: boolean, replan: () => G): G {
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, 'Verified: physics recovered within the stabilisation window.');
      return;
    }
    inc.attempts++;
    inc.stage_log.push({ stage: 'verified', tick: this.d.tick(), outcome: 'rejected' });
    inc.stage = 'investigated';
    this.setStatus(inc, 'replanning', `Verification rejected the repair — replanning (attempt ${inc.attempts + 1}).`);
    void verifier;
    yield* replan();
  }

  /** Hand the incident to a human: the autonomous policy has run out of whitelisted options. */
  private escalate(inc: Incident, reason: string) {
    const t = this.task(inc, { role: 'sentinel', kind: 'escalate', title: 'Escalate to operator', question: 'What cannot be resolved within the autonomous whitelist?', det: true });
    this.finish(t, 'blocked', `${reason} Operator decision required; monitoring continues.`, { label: 'Escalated', ok: false });
    this.setStatus(inc, 'escalated', `${reason} Operator decision required.`);
  }

  private resolve(inc: Incident, det: Detection, reason: string) {
    inc.status = 'resolved';
    inc.severity = 'nominal';
    inc.closed_tick = this.d.tick();
    inc.close_reason = reason;
    inc.summary = reason;
    this.d.emit('incident.closed', inc.id, { incident: inc });
    this.openKeys.delete(det.key);
    this.lockSuppress([det.target_id, ...det.affected], this.now + 70);
  }

  /* fouling */
  private *runFouling(inc: Incident, det: Detection, parent: AgentTask, edgeId: string): G {
    const { plant, rng, faults } = this.d;
    const label = edgeId.toUpperCase().replace('_', '-');
    const s = plant.faults.occlS[edgeId] ?? this.d.graph.length(edgeId) / 2;
    const out: { robot?: RobotActor; obs?: Record<string, number | string> } = {};
    const found = yield* this.inspect(inc, parent, edgeId, s, { title: `Inspect ${label}`, question: `Is ${label} actually restricted, where, and by how much?`, gauge: 'deposit' }, out);
    let crawlerInside = !!found;
    let oEst = found ? Number(out.obs!.occlusion) : 0.6;
    if (found) {
      this.updateHypotheses(inc, 'fouling', `Crawler scan: ${pct(oEst)} of bore blocked`, ['valve_stuck', 'sensor_drift', 'strainer_blockage']);
      this.stage(inc, 'investigated');
    }

    /* decide */
    const dec = this.task(inc, { role: 'sentinel', kind: 'decide', title: 'Choose intervention', question: 'Can the crawler clear this deposit, or does the segment need a physical repair?', parent, det: false });
    const brush = found && oEst <= 0.68 && inc.attempts === 0 && out.robot;
    yield* this.tool(dec, 'evaluate_options', { options: ['brush_clear', 'replace_section'], deposit_pct: round(oEst * 100, 0) }, () => ({ chosen: brush ? 'brush_clear' : 'replace_section', rationale: brush ? 'Soft deposit within crawler tooling scope' : 'Deposit exceeds crawler scope or a prior clearing failed' }));
    this.finish(dec, 'completed', brush ? `Deposit (${pct(oEst)}) is within the crawler's limited brush scope — try clearing first, verify, then escalate if it does not recover.` : `Deposit is too heavy for limited in-pipe clearing — replacing the section needs isolation.`, { label: brush ? 'Brush clear' : 'Replace section', ok: true });

    let ok = false;
    let returning = false;
    if (brush) {
      const robot = out.robot!;
      const appr = this.task(inc, { role: 'sentinel', kind: 'safety', title: 'Authorize in-pipe clearing', question: 'Is limited brush clearing authorised for this segment under current policy?', parent: dec, det: true });
      yield* this.tool(appr, 'check_safety_policy', { action: 'brush_clear', segment: edgeId, live_line: true }, () => ({ whitelisted: true, flow_velocity_ok: true, approval: 'operator veto window' }));
      this.finish(appr, 'completed', 'Brush clearing is whitelisted for this bore; operator veto window applies.', { label: 'Approval needed', ok: true });
      yield* this.approval(inc, appr, `${robot.name} brush-clears ${label}`, [`Brush clear ${label} at s = ${fmt(s, 1)} m`, 'Verify over stabilisation window', 'Return to port']);
      this.setStatus(inc, 'mitigating', `${robot.name} is clearing the deposit in ${label}.`);
      const task = this.task(inc, { role: 'inpipe', kind: 'clear', title: `Brush-clear ${label}`, question: 'Remove as much deposit as the brush can reach without damaging the wall.', parent: appr, robot_id: robot.id, asset_ids: [edgeId], det: false });
      const phi = clamp(0.9 - 0.85 * oEst + rng.normal() * 0.07, 0.2, 0.95);
      const ops: Op[] = [{
        id: 'c1',
        command: 'brush_clear',
        label: 'Extend brush · clear deposit',
        make: () => ({ kind: 'action', label: 'brush', duration_s: 55, mode: 'WORKING', tool: 'brush' }),
        tool: { name: 'brush_clear', input: { scope: `${label} @ ${fmt(s, 1)} m`, max_torque_pct: 60 }, output: () => ({ removed_pct: Math.round(phi * 100), residual_pct: Math.round(Math.max(plant.faults.occl[edgeId] ?? 0, 0) * 100) }) },
        done: () => {
          plant.faults.occl[edgeId] = Math.max((plant.faults.occl[edgeId] ?? 0) * (1 - phi), 0);
          faults.halt(edgeId);
          robot.tool = null;
          this.ev(inc, 'action', `Brush clear removed ~${pct(phi)} of the deposit`, { asset_id: edgeId });
          return `Removed ~${pct(phi)} of deposit`;
        },
      }];
      const m = this.newMission(inc, robot, 'clear', `Brush-clear ${label}`, edgeId, ops);
      yield* this.runOps(m, robot, task, ops);
      this.finish(task, 'completed', `Brush pass complete; removed ~${pct(phi)} of the deposit. Handing to the independent verifier.`, { label: 'Cleared (partial?)', ok: true });
      this.stage(inc, 'repaired');
      // the crawler heads home while the plant settles
      this.spawn(`return:${inc.id}`, this.returnCrawler(inc, robot, task));
      returning = true;
      crawlerInside = false;
      ok = yield* this.verify(inc, det, dec);
    }

    if (!ok) {
      if (brush) {
        inc.attempts++;
        inc.stage_log.push({ stage: 'verified', tick: this.d.tick(), outcome: 'rejected' });
        inc.stage = 'investigated';
        this.setStatus(inc, 'replanning', 'Verification rejected the clearing — escalating to a physical repair.');
        const rp = this.task(inc, { role: 'sentinel', kind: 'replan', title: 'Replan after rejected repair', question: 'Why did the intervention fail and what must change?', parent: dec, det: false });
        yield* this.tool(rp, 'diagnose_failure', { failed: 'brush_clear', checks: inc.verification?.checks.filter((c) => !c.pass).map((c) => c.id) }, () => ({ residual_deposit_pct: Math.round((plant.faults.occl[edgeId] ?? 0) * 100), conclusion: 'hard scale beyond brush reach' }));
        this.finish(rp, 'completed', `Residual deposit (~${pct(plant.faults.occl[edgeId] ?? 0)}) is hard scale the brush cannot remove. Escalating to OUTRIG: isolate the zone and replace the section.`, { label: 'Escalate to OUTRIG', ok: true });
        parent = rp;
      }
      // the crawler must be out of the pipe before the segment can be isolated
      if (out.robot && !returning) {
        this.spawn(`return:${inc.id}`, this.returnCrawler(inc, out.robot, parent));
        returning = true;
      }
      yield* this.waitDocked(out.robot);
      crawlerInside = false;
      void crawlerInside;
      const zone = this.d.topo.edges.find((e) => e.id === edgeId)?.zone_id;
      const isolate = zone ? { valve: zone === 'zone_a' ? 'valve_za' : 'valve_zb', zone: (zone === 'zone_a' ? 'a' : 'b') as 'a' | 'b' } : undefined;
      if (!isolate) {
        // trunk / FWS segments: a pipe repair would need a plant shutdown — out of MVP; leave for human decision
        this.escalate(inc, `${label} needs a planned shutdown — outside the autonomous whitelist.`);
        return;
      }
      const okJob = yield* this.outrigJob(inc, det, parent, {
        title: `Replace fouled section of ${label}`,
        tool: 'pipe clamp & spool kit',
        targetId: isolate.valve,
        isolate,
        actions: [{
          id: 'o5',
          command: 'replace_section',
          label: `Replace ${label} spool section`,
          dur: 90,
          tool: { name: 'replace_section', input: { segment: edgeId, interlocks: ['isolated', 'depressurised'] }, output: () => ({ replaced: true }) },
          done: () => {
            plant.faults.occl[edgeId] = 0;
            delete plant.faults.occlS[edgeId];
            faults.halt(edgeId);
            this.ev(inc, 'action', `${label} spool section replaced`, { asset_id: edgeId });
            return `${label} section replaced`;
          },
        }],
      });
      void okJob;
      ok = yield* this.verify(inc, det, parent);
    }
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, `Verified: ${label} restriction removed, flow and thermal margin recovered.`);
    } else {
      this.escalate(inc, 'Second verification failed — the plant did not recover after a physical repair.');
    }
  }

  /** Wait until *this incident's* crawler is back in its port (other incidents' crawlers are none of our business). */
  private *waitDocked(robot?: RobotActor) {
    if (!robot) return;
    yield { cond: () => robot.mode === 'DOCKED' && !robot.busy };
  }

  /* strainer */
  private *runStrainer(inc: Incident, det: Detection, parent: AgentTask): G {
    const { plant, faults, topo } = this.d;
    const s = topo.assets.find((a) => a.id === det.target_id)!;
    this.updateHypotheses(inc, 'strainer_blockage', `ΔP across ${s.label} ${fmt(this.d.monitor.strainerRatio(det.target_id as 'strainer_01' | 'strainer_02'), 1)}× design`, ['pump_degradation', 'fouling']);
    this.stage(inc, 'investigated');
    const okJob = yield* this.outrigJob(inc, det, parent, {
      title: `Replace ${s.label} basket`,
      tool: 'strainer basket',
      targetId: det.target_id,
      actions: [{
        id: 'o5',
        command: 'replace_strainer',
        label: `Duplex changeover · replace ${s.label} basket`,
        dur: 45,
        tool: { name: 'replace_strainer', input: { strainer: det.target_id, method: 'duplex changeover — no flow interruption' }, output: () => ({ replaced: true }) },
        done: () => {
          plant.faults.occl[det.target_id] = 0;
          faults.halt(det.target_id);
          this.ev(inc, 'action', `${s.label} basket replaced`, { asset_id: det.target_id });
          return `${s.label} basket replaced`;
        },
      }],
    });
    void okJob;
    const ok = yield* this.verify(inc, det, parent);
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, `Verified: ${s.label} flow restored, ΔP back to design.`);
    } else this.escalate(inc, 'Verification failed — the plant did not recover.');
  }

  /* stuck valve */
  private *runValve(inc: Incident, det: Detection, parent: AgentTask): G {
    const { plant, faults, topo } = this.d;
    const r = det.target_id.replace('valve_', '') as RackKey;
    const header = ZONE_OF[r] === 'a' ? 'p_12' : 'p_17';
    const v = topo.assets.find((a) => a.id === det.target_id)!;
    const out: { robot?: RobotActor; obs?: Record<string, number | string> } = {};
    const hLabel = header.toUpperCase().replace('_', '-');
    const L = this.d.graph.length(header);
    const found = yield* this.inspect(inc, parent, header, L * 0.5, { title: `Rule out obstruction in ${hLabel}`, question: `Is the header ahead of rack ${RACK_LABEL(r)} clean? (rule out internal obstruction)`, gauge: 'bore' }, out);
    if (found) {
      this.updateHypotheses(inc, 'valve_stuck', `Header ${hLabel} bore ${pct(Number(out.obs!.occlusion))} blocked — clean`, ['fouling', 'sensor_drift']);
      this.stage(inc, 'investigated');
      this.spawn(`return:${inc.id}`, this.returnCrawler(inc, out.robot!, parent));
      yield* this.waitDocked(out.robot);
    } else {
      this.updateHypotheses(inc, 'valve_stuck', 'Header ΔP nominal', ['fouling']);
      this.stage(inc, 'investigated');
    }
    const zone = ZONE_OF[r];
    yield* this.outrigJob(inc, det, parent, {
      title: `Service ${v.label} actuator`,
      tool: 'valve actuator kit',
      targetId: det.target_id,
      isolate: { valve: zone === 'a' ? 'valve_za' : 'valve_zb', zone },
      actions: [{
        id: 'o5',
        command: 'service_valve',
        label: `Replace ${v.label} actuator · re-stroke`,
        dur: 60,
        tool: { name: 'service_valve', input: { valve: det.target_id, action: 'replace actuator, stroke test' }, output: () => ({ stroke_ok: true, commanded_pct: Math.round(plant.controls.valveCmd[r] * 100) }) },
        done: () => {
          delete plant.faults.valveStuck[r];
          faults.halt(det.target_id);
          this.ev(inc, 'action', `${v.label} actuator replaced; valve follows its command`, { asset_id: det.target_id });
          return `${v.label} free`;
        },
      }],
    });
    const ok = yield* this.verify(inc, det, parent);
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, `Verified: rack ${RACK_LABEL(r)} branch flow restored.`);
    } else this.escalate(inc, 'Verification failed — the plant did not recover.');
  }

  /* pump degradation */
  private *runPump(inc: Incident, det: Detection, parent: AgentTask): G {
    const { plant, faults, topo } = this.d;
    const pump = det.target_id as 'pump_t1' | 'pump_t2';
    const standby = pump === 'pump_t1' ? 'pump_t2' : 'pump_t1';
    const pl = topo.assets.find((a) => a.id === pump)!.label;
    const sl = topo.assets.find((a) => a.id === standby)!.label;
    this.updateHypotheses(inc, 'pump_degradation', `Head ${pct(inc.verification ? 0 : 0.75)} of curve`, ['strainer_blockage', 'sensor_drift']);
    this.stage(inc, 'investigated');

    const mit = this.task(inc, { role: 'sentinel', kind: 'mitigate', title: 'Swap to standby pump', question: 'Can we restore flow immediately without a physical repair?', parent, det: true, asset_ids: [pump, standby] });
    yield* this.tool(mit, 'command_bus.swap_duty', { from: pump, to: standby, preconditions: ['standby_healthy', 'speed_match'] }, () => {
      plant.controls.tcsDuty = standby;
      return { duty: standby, speed_pct: Math.round(plant.controls.tcsSpeed * 100) };
    }, 1.5);
    this.ev(inc, 'action', `Duty swapped from ${pl} to ${sl}`, { asset_id: standby });
    this.finish(mit, 'completed', `${sl} is now duty. Flow is recovering while ${pl} is serviced offline — no isolation needed.`, { label: 'Standby on duty', ok: true });
    yield { dur: 20 };

    yield* this.outrigJob(inc, det, mit, {
      title: `Service ${pl}`,
      tool: 'pump service kit',
      targetId: pump,
      actions: [{
        id: 'o5',
        command: 'service_pump',
        label: `Replace bearing set · re-balance impeller on ${pl}`,
        dur: 90,
        tool: { name: 'service_pump', input: { pump, action: 'bearing set + impeller balance' }, output: () => ({ vibration_mm_s: 1.5 }) },
        done: () => {
          plant.faults.pumpHealth[pump] = 1;
          faults.halt(pump);
          this.ev(inc, 'action', `${pl} serviced — bearing set replaced`, { asset_id: pump });
          return `${pl} serviced`;
        },
      }],
    });
    const back = this.task(inc, { role: 'sentinel', kind: 'trial', title: `Trial run ${pl}`, question: 'Does the serviced pump deliver its curve under load?', parent: mit, det: true, asset_ids: [pump] });
    yield* this.tool(back, 'command_bus.swap_duty', { from: standby, to: pump }, () => {
      plant.controls.tcsDuty = pump;
      return { duty: pump };
    }, 1.2);
    this.finish(back, 'completed', `${pl} returned to duty for the verification trial.`, { label: 'Trial started', ok: true });
    yield { dur: 12 };
    const ok = yield* this.verify(inc, det, back, 45);
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, `Verified: ${pl} head back on curve, vibration normal.`);
    } else this.escalate(inc, 'Verification failed — the plant did not recover.');
  }

  /* sensor drift */
  private *runSensor(inc: Incident, det: Detection, parent: AgentTask): G {
    const { plant, faults, topo } = this.d;
    const a = topo.assets.find((x) => x.id === det.target_id)!;
    const edge = a.edge_id!;
    const out: { robot?: RobotActor; obs?: Record<string, number | string> } = {};
    const found = yield* this.inspect(inc, parent, edge, a.s_m ?? this.d.graph.length(edge) / 2, { title: `Corroborate ${a.label}`, question: `What is the true flow at ${a.label}? (independent in-pipe probe)`, gauge: 'flow', sensorId: a.id }, out);
    if (found) {
      this.updateHypotheses(inc, 'sensor_drift', `Crawler probe disagrees with ${a.label} by ${out.obs!.offset_kg_s} kg/s`, ['fouling', 'valve_stuck']);
      this.stage(inc, 'investigated');
      this.spawn(`return:${inc.id}`, this.returnCrawler(inc, out.robot!, parent));
    } else {
      this.updateHypotheses(inc, 'sensor_drift', 'Rack-level meters corroborate nominal flow', ['fouling', 'valve_stuck']);
      this.stage(inc, 'investigated');
    }
    yield* this.outrigJob(inc, det, parent, {
      title: `Recalibrate ${a.label}`,
      tool: 'calibration kit',
      targetId: a.id,
      actions: [{
        id: 'o5',
        command: 'recalibrate_sensor',
        label: `Zero & span recalibration of ${a.label}`,
        dur: 40,
        tool: { name: 'recalibrate_sensor', input: { sensor: a.id, reference: 'rack meters' }, output: () => ({ offset_after: 0 }) },
        done: () => {
          plant.faults.sensorOffset[a.id] = 0;
          plant.faults.sensorDriftRate[a.id] = 0;
          faults.halt(a.id);
          this.ev(inc, 'action', `${a.label} recalibrated`, { asset_id: a.id });
          return `${a.label} recalibrated`;
        },
      }],
    });
    yield* this.waitDocked(out.robot);
    const ok = yield* this.verify(inc, det, parent, 35);
    if (ok) {
      this.stage(inc, 'verified', 'ok');
      this.resolve(inc, det, `Verified: ${a.label} agrees with the rack meters; plant was never at fault.`);
    } else this.escalate(inc, 'Verification failed — the plant did not recover.');
  }

  /* workload spike: SENTINEL decides NOT to dispatch */
  private *runWorkload(inc: Incident, det: Detection, parent: AgentTask): G {
    const { plant, monitor, topo } = this.d;
    const r = det.target_id.replace('rack_', '') as RackKey;
    this.updateHypotheses(inc, 'workload_spike', 'Flow and ΔP nominal; power up', ['valve_stuck', 'fouling']);
    this.stage(inc, 'investigated');
    const dec = this.task(inc, { role: 'sentinel', kind: 'decide', title: 'Decide: no dispatch', question: 'Is a robot dispatch justified, or is this a load-driven thermal event?', parent, det: false, asset_ids: [det.target_id] });
    yield* this.tool(dec, 'evaluate_options', { options: ['dispatch_inpipe', 'dispatch_outrig', 'monitor'], rack: det.target_id }, () => ({ chosen: 'monitor', margin_k: round(monitor.margin(r), 1), min_allowed_k: topo.limits.margin_warn_k }));
    this.finish(dec, 'completed', `Hydraulics are healthy; rack ${RACK_LABEL(r)} simply draws more power. Dispatching a robot would be a false positive — monitoring instead.`, { label: 'No dispatch', ok: true });
    this.setStatus(inc, 'investigating', `Monitoring rack ${RACK_LABEL(r)}: workload-driven, no repair required.`);
    const t0 = this.now;
    yield { cond: () => !(plant.faults.spike[r] && plant.faults.spike[r]!.until > this.now) || this.now - t0 > 400 };
    const v = this.task(inc, { role: 'sentinel', kind: 'verify', title: 'Confirm load has subsided', question: 'Did the rack return to baseline with margin intact?', parent: dec, det: true });
    yield* this.tool(v, 'read_telemetry', { rack: det.target_id, window_s: 60 }, () => ({ margin_k: round(monitor.margin(r), 1), power_kw: round(monitor.meas.rackPower[r], 0) }));
    inc.attempts = 0;
    this.finish(v, 'verified', `Rack ${RACK_LABEL(r)} settled at ${fmt(monitor.margin(r), 1)} K margin. No robot work was needed.`, { label: 'Dismissed', ok: true });
    inc.status = 'dismissed';
    inc.severity = 'nominal';
    inc.closed_tick = this.d.tick();
    inc.close_reason = 'Workload surge subsided; thermal margin remained safe. No dispatch.';
    inc.summary = inc.close_reason;
    inc.stage_log.push({ stage: 'verified', tick: this.d.tick(), outcome: 'ok' });
    inc.stage = 'verified';
    this.d.emit('incident.closed', inc.id, { incident: inc });
    this.openKeys.delete(det.key);
    this.lockSuppress([det.target_id], this.now + 60);
  }
}

/* ───────────────────────────── helpers ───────────────────────────── */

function round(x: number, d = 2) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

const warnOf = (t: Topology) => t.limits.margin_warn_k;

function reviewQuestion(kind: 'hydraulics' | 'thermal' | 'accessibility') {
  return kind === 'hydraulics'
    ? 'Which hydraulic element explains the pressure and flow pattern?'
    : kind === 'thermal'
      ? 'How much thermal margin remains, and how fast is it eroding?'
      : 'Can a robot physically reach and safely service the suspected component?';
}

function estimateValve(plant: PlantState, rack: RackKey, qMeas: number) {
  let lo = 0.03;
  let hi = 0.85;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const f = initialFaults();
    f.valveStuck[rack] = mid;
    const q = solveHydraulics({ faults: f, controls: plant.controls }).rackQ[rack];
    if (q < qMeas) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function decimate(points: Vec3[], minStep: number): Vec3[] {
  const out: Vec3[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1], points[i][2] - last[2]) >= minStep) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}
