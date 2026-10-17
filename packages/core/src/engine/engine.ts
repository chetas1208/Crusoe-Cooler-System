import type {
  AssetState,
  CommandAck,
  CommandRequest,
  EngineHealth,
  EventType,
  FaultKind,
  Incident,
  Kpis,
  Mission,
  ReplayPage,
  SimStatus,
  StreamEvent,
  TelemetrySeries,
  Topology,
  WorldSnapshot,
} from '../contracts';
import { READING_META } from '../contracts';
import { createRng } from '../geometry';
import { FaultManager } from './faults';
import { buildTopology, HALL } from './facility';
import { Monitor } from './monitor';
import { Orchestrator } from './orchestrator';
import { createPlant, stepPlant } from './plant';
import { NavGrid, PipeGraph, buildRobots, type RobotActor } from './robots';
import { ControlService } from './control';

export interface EngineOptions {
  seed?: number;
  /** sim seconds per wall second */
  speed?: number;
  approvalMode?: 'autonomous' | 'supervised';
  /** sim seconds the operator has to veto a high-impact action */
  approvalWindowS?: number;
  faultsEnabled?: boolean;
  firstFaultS?: [number, number];
  meanGapS?: number;
  /** wall-clock ms source for the manual-control deadman (tests inject a fake clock) */
  clock?: () => number;
  /** manual-control timing overrides (tests) */
  control?: { deadmanMs?: number; leaseTtlMs?: number; safeHoldResumeMs?: number };
}

export const DT = 0.5; // sim seconds per tick
const MONITOR_EVERY = 4; // ticks (2 sim-s)
const HISTORY_LEN = 450;
const LOG_CAP = 40000;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class Engine {
  readonly topology: Topology;
  readonly seed: number;
  readonly plant;
  readonly monitor: Monitor;
  readonly faults: FaultManager;
  readonly orch: Orchestrator;
  readonly robots: Record<string, RobotActor>;
  readonly graph: PipeGraph;
  /** server-owned manual-control leases (backend.md §10) */
  readonly control: ControlService;

  tick = 0;
  speed: number;
  paused = false;
  private seq = 0;
  private acc = 0;
  private listeners = new Set<(e: StreamEvent) => void>();
  private log: StreamEvent[] = [];
  private hist = new Map<string, number[]>();
  private histT: number[] = [];
  private config: { approvalMode: 'autonomous' | 'supervised'; approvalWindowS: number };
  private lastPose = new Map<string, string>();
  private startedWall = Date.now();

  constructor(opts: EngineOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.speed = opts.speed ?? 6;
    this.config = { approvalMode: opts.approvalMode ?? 'autonomous', approvalWindowS: opts.approvalWindowS ?? 24 };
    this.topology = buildTopology();
    const { state, rng } = createPlant(this.seed);
    this.plant = state;
    this.graph = new PipeGraph(this.topology);
    const nav = new NavGrid(this.topology, HALL);
    const robotList = buildRobots(this.topology, this.graph);
    this.robots = Object.fromEntries(robotList.map((r) => [r.id, r]));
    const lengths = Object.fromEntries(this.topology.edges.map((e) => [e.id, this.graph.length(e.id)]));
    this.monitor = new Monitor(this.topology, this.plant, rng);
    this.faults = new FaultManager(
      this.plant,
      createRng(this.seed * 7919 + 13),
      { firstFaultS: opts.firstFaultS ?? [45, 75], meanGapS: opts.meanGapS ?? 520, enabled: opts.faultsEnabled ?? true },
      lengths,
    );
    this.orch = new Orchestrator({
      topo: this.topology,
      plant: this.plant,
      monitor: this.monitor,
      faults: this.faults,
      graph: this.graph,
      nav,
      robots: this.robots,
      rng: createRng(this.seed * 104729 + 7),
      emit: (type, entity, payload) => this.emit(type, entity, payload),
      tick: () => this.tick,
      config: this.config,
    });
    this.control = new ControlService({
      topo: this.topology,
      graph: this.graph,
      plant: this.plant,
      robots: this.robots,
      emit: (type, entity, payload) => this.emit(type, entity, payload),
      tick: () => this.tick,
      now: opts.clock ?? (() => Date.now()),
      ...opts.control,
    });
    this.sample();
  }

  /* ───────────────────────────── events ───────────────────────────── */

  subscribe(cb: (e: StreamEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get lastSeq() {
    return this.seq;
  }

  private emit(type: EventType, entityId: string, payload: unknown) {
    const seq = ++this.seq;
    const ev = {
      event_id: `ev_${String(seq).padStart(6, '0')}`,
      seq,
      sim_tick: this.tick,
      sim_time_s: this.plant.time,
      world_version: this.tick,
      type,
      entity_id: entityId,
      facility_id: this.topology.facility.id,
      ts: new Date().toISOString(),
      payload: clone(payload),
    } as StreamEvent;
    this.log.push(ev);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    for (const l of this.listeners) l(ev);
  }

  replay(fromSeq: number, limit = 500): ReplayPage {
    const idx = this.log.findIndex((e) => e.seq >= fromSeq);
    if (idx < 0) return { events: [], next_seq: null };
    const events = this.log.slice(idx, idx + limit);
    const last = events[events.length - 1];
    return { events, next_seq: last && last.seq < this.seq ? last.seq + 1 : null };
  }

  /* ───────────────────────────── stepping ───────────────────────────── */

  advance(wallMs: number) {
    if (this.paused) return;
    // operator-driven motion runs at wall-clock cadence, independent of the sim-speed multiplier
    this.control.integrate(wallMs / 1000);
    this.acc += (wallMs / 1000) * this.speed;
    let n = 0;
    while (this.acc >= DT && n < 600) {
      this.step();
      this.acc -= DT;
      n++;
    }
    if (n >= 600) this.acc = 0;
  }

  /** advance simulated time without wall pacing (used for restore / headless runs) */
  fastForward(simSeconds: number) {
    const n = Math.round(simSeconds / DT);
    for (let i = 0; i < n; i++) this.step();
  }

  step() {
    this.faults.step(DT, this.orch.openCount());
    stepPlant(this.plant, DT);
    this.tick++;
    if (this.tick % MONITOR_EVERY === 0) {
      const meas = this.monitor.measure();
      this.orch.recordMeas(meas);
      const out = this.monitor.evaluate(this.orch.suppressedSet());
      this.orch.ingest(out.detections);
      this.sample();
    }
    for (const r of Object.values(this.robots)) r.step(DT);
    this.orch.step(DT);
  }

  private sample() {
    this.histT.push(this.plant.time);
    if (this.histT.length > HISTORY_LEN) this.histT.shift();
    const assets = this.monitor.last.assets;
    const seen = new Set<string>();
    for (const [id, a] of Object.entries(assets)) {
      for (const [metric, v] of Object.entries(a.readings)) {
        const k = `${id}.${metric}`;
        seen.add(k);
        let arr = this.hist.get(k);
        if (!arr) {
          arr = new Array(this.histT.length - 1).fill(v);
          this.hist.set(k, arr);
        }
        arr.push(v);
        if (arr.length > HISTORY_LEN) arr.shift();
      }
    }
  }

  telemetry(assetId: string, metric: string, windowS = 600): TelemetrySeries | null {
    const arr = this.hist.get(`${assetId}.${metric}`);
    if (!arr) return null;
    const tmin = this.plant.time - windowS;
    const points: Array<[number, number]> = [];
    for (let i = 0; i < arr.length; i++) {
      const t = this.histT[this.histT.length - arr.length + i];
      if (t >= tmin) points.push([Math.round(t * 10) / 10, Math.round(arr[i] * 1000) / 1000]);
    }
    return { asset_id: assetId, metric, unit: READING_META[metric]?.unit ?? '', points };
  }

  /* ───────────────────────────── frames (wall cadence) ───────────────────────────── */

  /** Called by the runner at ~10 Hz. Emits robot poses that changed. */
  publishPoses() {
    for (const r of Object.values(this.robots)) {
      const c = r.toContract();
      const key = `${c.pose.position_xyz_m.map((x) => x.toFixed(3)).join(',')}|${c.mode}|${c.battery_pct}|${c.pose.yaw_rad.toFixed(2)}|${c.control ? `${c.control.controller_state}|${c.control.lamp}|${c.control.velocity_m_s}|${c.control.junction?.selected ?? ''}|${c.control.junction ? 1 : 0}|${c.control.last_scan?.tick ?? 0}` : ''}`;
      if (this.lastPose.get(r.id) === key) continue;
      this.lastPose.set(r.id, key);
      this.emit('robot.pose', r.id, { robot_id: r.id, pose: c.pose, battery_pct: c.battery_pct, mode: c.mode, route_xyz_m: c.route_xyz_m, control: c.control });
    }
  }

  /** ~2 Hz: telemetry diff for every asset. */
  publishWorldDiff() {
    const assets: Record<string, Partial<AssetState>> = clone(this.monitor.last.assets);
    this.emit('world.diff', this.topology.facility.id, { assets, kpis: this.kpis(), sim_speed: this.speed, sim_status: this.simStatus() });
  }

  publishHealth() {
    this.emit('engine.health', this.topology.facility.id, { health: this.health() });
  }

  publishHeartbeat() {
    this.emit('heartbeat', this.topology.facility.id, { server_ts: new Date().toISOString() });
  }

  /* ───────────────────────────── snapshot ───────────────────────────── */

  simStatus(): SimStatus {
    if (this.paused) return 'paused';
    const busy = [...this.orch.incidents.values()].some((i) => !i.closed_tick && ['mitigating', 'verifying'].includes(i.status));
    return busy ? 'recovering' : 'running';
  }

  health(): EngineHealth {
    return {
      status: this.simStatus(),
      tick_rate_hz: 1 / DT,
      solver: { status: this.plant.hyd.residual < 1e-3 ? 'converged' : 'degraded', residual: this.plant.hyd.residual },
      database: 'n/a',
      intelligence: { provider: 'mock', model_id: 'mock-policy-v0', status: 'mock', last_latency_ms: undefined },
      safe_automation_mode: this.config.approvalMode,
      approval_window_s: this.config.approvalWindowS,
      backend: 'mock',
      uptime_s: this.plant.time,
      seed: this.seed,
    };
  }

  kpis(): Kpis {
    const incs = [...this.orch.incidents.values()];
    return {
      ...this.monitor.last.kpis,
      open_incidents: incs.filter((i) => !i.closed_tick).length,
      resolved_incidents: incs.filter((i) => i.status === 'resolved' || i.status === 'dismissed').length,
    };
  }

  incidents(status?: 'open'): Incident[] {
    const all = [...this.orch.incidents.values()].sort((a, b) => b.opened_tick - a.opened_tick);
    return status === 'open' ? all.filter((i) => !i.closed_tick) : all;
  }

  snapshot(): WorldSnapshot {
    const missions: Record<string, Mission> = {};
    for (const m of this.orch.missions.values()) missions[m.id] = m;
    return clone({
      facility_id: this.topology.facility.id,
      version: this.tick,
      sim_tick: this.tick,
      sim_time_s: this.plant.time,
      sim_speed: this.speed,
      sim_status: this.simStatus(),
      assets: this.monitor.last.assets,
      robots: Object.fromEntries(Object.values(this.robots).map((r) => [r.id, r.toContract()])),
      missions,
      incidents: this.incidents(),
      health: this.health(),
      kpis: this.kpis(),
      last_seq: this.seq,
    });
  }

  /* ───────────────────────────── commands ───────────────────────────── */

  command(req: CommandRequest): CommandAck {
    const ok = (accepted: boolean, reason?: string): CommandAck => ({ command_id: req.command_id, accepted, reason });
    switch (req.kind) {
      case 'approve_action':
        return ok(this.orch.approve(req.target_id ?? '', true), 'no pending approval with that id');
      case 'hold_action':
        return ok(this.orch.approve(req.target_id ?? '', false), 'no pending approval with that id');
      case 'set_sim_speed': {
        const s = Number(req.args?.speed);
        if (!(s >= 0.5 && s <= 60)) return ok(false, 'speed must be between 0.5 and 60');
        this.speed = s;
        this.publishHealth();
        return ok(true);
      }
      case 'pause':
        this.paused = true;
        this.publishHealth();
        return ok(true);
      case 'resume':
        this.paused = false;
        this.publishHealth();
        return ok(true);
      case 'test.inject_fault': {
        const kind = req.args?.kind as FaultKind | undefined;
        if (!kind) return ok(false, 'missing fault kind');
        const target = this.faults.begin(kind, (req.args?.target as string | undefined) ?? undefined);
        return ok(!!target, target ? undefined : 'unsupported fault');
      }
      default:
        return ok(false, 'unknown command');
    }
  }

  wallUptimeS() {
    return (Date.now() - this.startedWall) / 1000;
  }
}

/* ───────────────────────────── runner ───────────────────────────── */

/** Drives an Engine from wall-clock time: physics at 20 Hz, poses 10 Hz, telemetry 2 Hz. */
export class EngineRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private n = 0;

  constructor(readonly engine: Engine) {}

  start() {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(now - this.last, 250);
      this.last = now;
      this.engine.advance(dt);
      this.n++;
      if (this.n % 2 === 0) this.engine.publishPoses();
      if (this.n % 10 === 0) this.engine.publishWorldDiff();
      if (this.n % 100 === 0) this.engine.publishHealth();
      if (this.n % 200 === 0) this.engine.publishHeartbeat();
    }, 50);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
