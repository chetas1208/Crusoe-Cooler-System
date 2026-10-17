import { ApiError } from './errors';
import type { CommandAck, CommandRequest, StreamEvent, Topology, WorldSnapshot } from '../contracts';
import { Engine, DT } from '../engine/engine';
import type { EngineOptions } from '../engine/engine';
import { createRng } from '../geometry';
import { HASH_ALGO } from './hash';
import { buildEngine, captureFrame, configFromOptions, frameHash, FRAME_EVERY, NON_PHYSICAL, RunRecorder, type RunConfig, type ScheduledCommand } from './recorder';
import { MOCK_SUPPORT, mockModelStatus, validateScenario, validateScenarioText } from './scenario';
import {
  RUNS_SCHEMA_VERSION,
  type CheckpointList,
  type ForkRequest,
  type ForkResult,
  type ModelStatus,
  type RecordedCommand,
  type ReplayFrame,
  type ReplayGap,
  type ReplayWindow,
  type RunKind,
  type RunState,
  type RunSummary,
  type ScenarioSpec,
  type ScenarioValidateRequest,
  type ScenarioValidation,
} from './types';

interface Runtime {
  id: string;
  label: string;
  kind: RunKind;
  state: RunState;
  parent: string | null;
  forkTick: number | null;
  forkSnapshot: string | null;
  scenario: ScenarioSpec | null;
  config: RunConfig;
  engine: Engine | null;
  rec: RunRecorder;
  /** scenario faults still to be injected (carried into forks) */
  schedule: ScheduledCommand[];
  createdAt: string;
  children: string[];
  externalDriver: boolean;
  frozenTick: number;
  frozenTime: number;
  /** seed material for the branch's own random streams (forks only) */
  salt: string | null;
}

export interface RegistryOptions {
  baseline: { engine: Engine; options: EngineOptions; label?: string };
  backend?: 'mock' | 'live';
  /** max concurrently running non-baseline engines (backend.md §11: resource and count limits apply) */
  maxLive?: number;
  /** drive child runs from wall time (true everywhere except tests) */
  autoDrive?: boolean;
}

const BUILD = 'ts-sim 0.1 (deterministic mock engine)';
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Run ledger + recorder + fork for the TS simulator. This is the reference implementation of backend.md §11 for the mock;
 * `apps/mock-api/src/runs.ts` serves it over HTTP and `EmbeddedTransport` exposes it in-page.
 */
export class RunRegistry {
  readonly topology: Topology;
  private runs = new Map<string, Runtime>();
  private n = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall = 0;
  readonly maxLive: number;
  readonly backend: 'mock' | 'live';

  constructor(private o: RegistryOptions) {
    this.topology = o.baseline.engine.topology;
    this.maxLive = o.maxLive ?? 3;
    this.backend = o.backend ?? 'mock';
    const cfg = configFromOptions(o.baseline.options);
    const rec = new RunRecorder('run_baseline', o.baseline.engine);
    this.runs.set('run_baseline', {
      id: 'run_baseline',
      label: o.baseline.label ?? 'Continuous baseline',
      kind: 'baseline',
      state: 'running',
      parent: null,
      forkTick: null,
      forkSnapshot: null,
      scenario: null,
      config: cfg,
      engine: o.baseline.engine,
      rec,
      schedule: [],
      createdAt: new Date().toISOString(),
      children: [],
      externalDriver: true,
      frozenTick: 0,
      frozenTime: 0,
      salt: null,
    });
  }

  /* ───────────────────────── driving child runs ───────────────────────── */

  private ensureTimer() {
    if (this.timer || this.o.autoDrive === false) return;
    this.lastWall = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(now - this.lastWall, 250);
      this.lastWall = now;
      this.driveAll(dt);
    }, 50);
  }

  /** advance every running non-baseline engine by `wallMs` (exposed for deterministic tests) */
  driveAll(wallMs: number) {
    let live = 0;
    for (const r of this.runs.values()) {
      if (r.externalDriver || r.state !== 'running' || !r.engine) continue;
      live++;
      r.engine.advance(wallMs);
    }
    if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ───────────────────────── queries ───────────────────────── */

  private rt(id: string): Runtime {
    const r = this.runs.get(id);
    if (!r) throw new ApiError('not_found', `No run "${id}".`, 404);
    return r;
  }

  private summary(r: Runtime): RunSummary {
    const last = r.rec.lastFrame;
    const live = r.engine && r.state !== 'stopped';
    const tick = live ? r.engine!.tick : r.frozenTick || last?.tick || 0;
    const time = live ? r.engine!.plant.time : r.frozenTime || last?.sim_time_s || 0;
    const cps = r.rec.checkpoints;
    const incs = last?.incidents ?? [];
    return {
      run_id: r.id,
      label: r.label,
      kind: r.kind,
      mode: r.kind === 'fork' ? 'FORK' : 'LIVE',
      state: r.state === 'running' && r.engine?.paused ? 'paused' : r.state,
      parent_run_id: r.parent,
      fork_tick: r.forkTick,
      fork_snapshot_id: r.forkSnapshot,
      scenario_id: r.scenario?.scenario_id ?? null,
      facility_id: this.topology.facility.id,
      seed: r.config.seed,
      topology_hash: this.topology.facility.topology_hash,
      schema_version: RUNS_SCHEMA_VERSION,
      engine: { backend: this.backend, build: BUILD },
      created_at: r.createdAt,
      current_tick: tick,
      current_time_s: time,
      first_tick: r.rec.firstTick,
      recording: {
        frames: r.rec.frames.length,
        checkpoints: cps.length,
        events: r.rec.events.length,
        commands: r.rec.commands.length,
        approx_bytes: r.rec.frames.length * r.rec.frameBytes + r.rec.events.length * 600,
      },
      incidents: { opened: incs.length, resolved: incs.filter((i) => i.status === 'resolved' || i.status === 'dismissed').length },
      children: [...r.children],
      head_hash: cps[cps.length - 1]?.hash ?? null,
    };
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => this.summary(r));
  }

  get(id: string): RunSummary {
    return this.summary(this.rt(id));
  }

  world(id: string): WorldSnapshot {
    const r = this.rt(id);
    if (r.engine && r.state !== 'stopped') return r.engine.snapshot();
    const f = r.rec.lastFrame;
    const base = this.o.baseline.engine.snapshot();
    return { ...base, version: f.tick, sim_tick: f.tick, sim_time_s: f.sim_time_s, sim_status: 'paused', assets: f.assets, robots: f.robots, missions: f.missions, incidents: f.incidents, kpis: f.kpis };
  }

  /* ───────────────────────── scenarios ───────────────────────── */

  modelStatus(): ModelStatus {
    return { ...mockModelStatus(), last_checked_at: new Date().toISOString() };
  }

  /** Never touches a live world. */
  validate(req: ScenarioValidateRequest): ScenarioValidation {
    if (typeof req.text === 'string') return validateScenarioText(req.text, this.topology);
    return validateScenario(req.spec, this.topology, this.backend);
  }

  private nextId() {
    return `run_${String(++this.n).padStart(3, '0')}`;
  }

  private liveCount() {
    return [...this.runs.values()].filter((r) => !r.externalDriver && r.state !== 'stopped').length;
  }

  private quota() {
    if (this.liveCount() >= this.maxLive) throw new ApiError('quota', `At most ${this.maxLive} scenario or fork runs can be live at once. Stop one to start another.`, 429);
  }

  createScenarioRun(input: unknown): RunSummary {
    const v = validateScenario(input, this.topology, this.backend);
    if (!v.valid || !v.spec) throw new ApiError('invalid', 'Scenario failed validation.', 422, v.issues);
    this.quota();
    const spec = v.spec;
    const cfg: RunConfig = {
      seed: spec.seed,
      speed: spec.sim_speed,
      approvalMode: spec.agent_policy,
      approvalWindowS: spec.approval_window_s,
      faultsEnabled: spec.background_faults,
      workloadFactor: spec.workload_factor,
    };
    const engine = buildEngine(cfg);
    const schedule: ScheduledCommand[] = spec.faults.map((f, i) => ({ tick: f.onset_tick, req: { command_id: `scn_${spec.scenario_id}_${i}`, kind: 'test.inject_fault', args: { kind: f.kind, target: f.target_id } } }));
    const id = this.nextId();
    const rec = new RunRecorder(id, engine, schedule);
    this.runs.set(id, { id, label: spec.title, kind: 'scenario', state: 'running', parent: null, forkTick: null, forkSnapshot: null, scenario: spec, config: cfg, engine, rec, schedule, createdAt: new Date().toISOString(), children: [], externalDriver: false, frozenTick: 0, frozenTime: 0, salt: null });
    this.ensureTimer();
    return this.get(id);
  }

  /* ───────────────────────── control ───────────────────────── */

  /** Commands for a non-baseline live run (the baseline takes commands through the normal /commands path). */
  command(id: string, req: CommandRequest): CommandAck {
    const r = this.rt(id);
    if (!r.engine || r.state === 'stopped') throw new ApiError('read_only', 'This run is stopped. Fork it to interact.', 409);
    return r.engine.command(req);
  }

  setState(id: string, state: 'running' | 'paused' | 'stopped'): RunSummary {
    const r = this.rt(id);
    if (r.kind === 'baseline' && state === 'stopped') throw new ApiError('invalid', 'The continuous baseline cannot be stopped.', 409);
    if (state === 'stopped') {
      if (r.engine) {
        r.frozenTick = r.engine.tick;
        r.frozenTime = r.engine.plant.time;
      }
      r.rec.detach();
      r.engine = null;
      r.state = 'stopped';
    } else if (r.engine) {
      r.engine.paused = state === 'paused';
      r.state = 'running';
    }
    return this.get(id);
  }

  /* ───────────────────────── recording access ───────────────────────── */

  /** frames/events/commands/checkpoints of a run including inherited pre-fork history */
  private lineage(r: Runtime): { frames: ReplayFrame[]; events: StreamEvent[]; commands: RecordedCommand[]; checkpoints: CheckpointList['checkpoints'] } {
    if (!r.parent || r.forkTick === null) return { frames: r.rec.frames, events: r.rec.events, commands: r.rec.commands, checkpoints: r.rec.checkpoints };
    const p = this.lineage(this.rt(r.parent));
    const T = r.forkTick;
    return {
      frames: [...p.frames.filter((f) => f.tick < T).map((f) => ({ ...f, inherited: true })), ...r.rec.frames],
      events: [...p.events.filter((e) => e.sim_tick <= T), ...r.rec.events],
      commands: [...p.commands.filter((c) => c.tick < T), ...r.rec.commands],
      checkpoints: [...p.checkpoints.filter((c) => c.tick < T), ...r.rec.checkpoints],
    };
  }

  checkpoints(id: string, toTick?: number): CheckpointList {
    const r = this.rt(id);
    const all = this.lineage(r).checkpoints;
    return { run_id: id, schema_version: RUNS_SCHEMA_VERSION, checkpoints: toTick === undefined ? [...all] : all.filter((c) => c.tick <= toTick) };
  }

  replay(id: string, q: { start_tick?: number; end_tick?: number; stride?: number; events?: boolean } = {}): ReplayWindow {
    const r = this.rt(id);
    const L = this.lineage(r);
    const first = L.frames[0]?.tick ?? 0;
    const last = L.frames[L.frames.length - 1]?.tick ?? 0;
    const start = Math.max(0, Math.floor(q.start_tick ?? first));
    const end = Math.min(Math.floor(q.end_tick ?? last), last);
    const stride = Math.max(1, Math.floor(q.stride ?? 1));
    const inRange = L.frames.filter((f) => f.tick >= start && f.tick <= end);
    const frames = stride === 1 ? inRange : inRange.filter((f, i) => i % stride === 0 || f.hash !== undefined || i === inRange.length - 1);
    const gaps: ReplayGap[] = [];
    if (first > 0) gaps.push({ from_tick: 0, to_tick: first, kind: 'not_recorded', reason: r.parent ? 'Before the fork there is no inherited recording.' : 'Recording began at this tick; earlier history was not captured.' });
    for (let i = 1; i < L.frames.length; i++) {
      const a = L.frames[i - 1];
      const b = L.frames[i];
      if (b.tick - a.tick > FRAME_EVERY) {
        const prev = gaps[gaps.length - 1];
        if (prev && prev.kind === 'reduced_resolution' && prev.to_tick === a.tick) prev.to_tick = b.tick;
        else gaps.push({ from_tick: a.tick, to_tick: b.tick, kind: 'reduced_resolution', reason: `Older samples were thinned to every ${b.tick - a.tick} ticks to bound memory.` });
      }
    }
    return {
      run_id: id,
      schema_version: RUNS_SCHEMA_VERSION,
      start_tick: start,
      end_tick: end,
      stride,
      recorded_from_tick: first,
      recorded_to_tick: last,
      frames,
      events: q.events === false ? [] : L.events.filter((e) => e.sim_tick >= start && e.sim_tick <= end),
      commands: L.commands.filter((c) => c.tick >= start && c.tick <= end),
      checkpoints: L.checkpoints.filter((c) => c.tick >= start && c.tick <= end),
      gaps,
      frozen_agent_decisions: true,
    };
  }

  /* ───────────────────────── fork ───────────────────────── */

  /**
   * Restore = deterministic re-simulation from tick 0 with the run's command ledger, verified against the recorded
   * checkpoint hashes (the mock has no serialised engine state). Yields to the event loop so the UI never stalls.
   */
  private async reconstruct(r: Runtime, toTick: number, verify: Map<number, string>): Promise<{ engine: Engine; hash: string }> {
    const L = this.lineage(r);
    const first = L.frames[0]?.tick ?? 0;
    if (first > 0) throw new ApiError('cannot_reconstruct', `History before tick ${first} was not recorded, so this run cannot be rebuilt from its start.`, 422);
    const cmds = L.commands.filter((c) => !NON_PHYSICAL.has(c.kind) && c.tick < toTick);
    const e = buildEngine(this.rootConfig(r));
    const bounds: Array<{ tick: number; salt: string }> = [];
    for (let cur: Runtime | null = r; cur; cur = cur.parent ? this.rt(cur.parent) : null) if (cur.forkTick !== null && cur.salt) bounds.unshift({ tick: cur.forkTick, salt: cur.salt });
    let bi = 0;
    let ci = 0;
    let t0 = Date.now();
    const apply = () => {
      while (ci < cmds.length && cmds[ci].tick <= e.tick) {
        const c = cmds[ci++];
        e.command({ command_id: c.command_id, kind: c.kind as CommandRequest['kind'], target_id: c.target_id, args: c.args });
      }
    };
    const check = () => {
      const want = verify.get(e.tick);
      if (want === undefined) return;
      const got = frameHash(captureFrame(e).frame);
      if (got !== want) throw new ApiError('cannot_reconstruct', `Restored state at tick ${e.tick} does not match the recorded checkpoint (${got} ≠ ${want}). Refusing to fork from an unverified state.`, 422, { tick: e.tick, got, want });
      verify.delete(e.tick);
    };
    check();
    while (e.tick < toTick) {
      while (bi < bounds.length && bounds[bi].tick <= e.tick) reseed(e, bounds[bi++].salt);
      apply();
      e.step();
      check();
      if (Date.now() - t0 > 40) {
        await yieldNow();
        t0 = Date.now();
      }
    }
    return { engine: e, hash: frameHash(captureFrame(e).frame) };
  }

  /** config of the lineage root (forks rebuild from the root's tick 0, replaying the full inherited ledger) */
  private rootConfig(r: Runtime): RunConfig {
    let cur = r;
    while (cur.parent) cur = this.rt(cur.parent);
    return cur.config;
  }

  async fork(parentId: string, req: ForkRequest): Promise<ForkResult> {
    const parent = this.rt(parentId);
    if (!req || !Number.isInteger(req.fork_tick) || typeof req.expected_parent_hash !== 'string' || typeof req.chosen_snapshot_id !== 'string') throw new ApiError('invalid', 'fork needs {fork_tick, expected_parent_hash, chosen_snapshot_id}.', 422);
    const L = this.lineage(parent);
    const cp = L.checkpoints.find((c) => c.snapshot_id === req.chosen_snapshot_id);
    if (!cp) throw new ApiError('checkpoint_missing', `Checkpoint ${req.chosen_snapshot_id.slice(0, 60)} is not in this run's recording.`, 404);
    if (!cp.compatible || cp.schema_version !== RUNS_SCHEMA_VERSION) throw new ApiError('checkpoint_incompatible', `Checkpoint was written with schema ${cp.schema_version}${cp.reason ? ` (${cp.reason})` : ''}; this engine reads ${RUNS_SCHEMA_VERSION}.`, 409);
    if (req.fork_tick < cp.tick) throw new ApiError('invalid', 'fork_tick is before the chosen checkpoint.', 422);
    const frameAt = L.frames.find((f) => f.tick === req.fork_tick);
    if (!frameAt) throw new ApiError('checkpoint_missing', `No recorded sample at tick ${req.fork_tick}. Pick a sampled tick (multiples of ${FRAME_EVERY}).`, 404);
    const recorded = frameAt.hash ?? frameHash(frameAt);
    if (recorded !== req.expected_parent_hash) throw new ApiError('hash_mismatch', `The parent at tick ${req.fork_tick} is ${recorded}, not ${req.expected_parent_hash}. Reload the run and choose the tick again.`, 409, { actual: recorded });
    this.quota();

    const parentHashBefore = this.parentHash(parent, req.fork_tick);
    const verify = new Map<number, string>([[cp.tick, cp.hash]]);
    verify.set(req.fork_tick, recorded);
    const { engine, hash } = await this.reconstruct(parent, req.fork_tick, verify);
    if (hash !== recorded) throw new ApiError('cannot_reconstruct', 'Restored state differs from the recorded parent state.', 422);

    const id = this.nextId();
    engine.speed = parent.engine?.speed ?? parent.config.speed;
    const salt = `${id}:${req.fork_tick}:${parent.config.seed}`;
    const rng = reseed(engine, salt);
    const schedule = parent.schedule.filter((s) => s.tick >= req.fork_tick);
    const rec = new RunRecorder(id, engine, schedule);
    const label = req.label?.trim().slice(0, 80) || `Fork of ${parent.label} @ tick ${req.fork_tick}`;
    const config = { ...parent.config, speed: engine.speed };
    this.runs.set(id, { id, label, kind: 'fork', state: 'running', parent: parentId, forkTick: req.fork_tick, forkSnapshot: cp.snapshot_id, scenario: parent.scenario, config, engine, rec, schedule, createdAt: new Date().toISOString(), children: [], externalDriver: false, frozenTick: 0, frozenTime: 0, salt });
    parent.children.push(id);
    this.ensureTimer();
    return {
      run: this.get(id),
      parent_run_id: parentId,
      fork_tick: req.fork_tick,
      parent_hash_before: parentHashBefore,
      parent_hash_after: this.parentHash(parent, req.fork_tick),
      restored_hash: hash,
      rng,
    };
  }

  private parentHash(p: Runtime, tick: number) {
    const f = this.lineage(p).frames.find((x) => x.tick === tick);
    return f ? (f.hash ?? frameHash(f)) : '';
  }

  hashAlgo() {
    return HASH_ALGO;
  }
  support() {
    return MOCK_SUPPORT;
  }
}

/**
 * Give the child its own random streams. The engine core keeps its RNGs private, so this reaches into three known fields;
 * if the engine changes shape the fork honestly reports `inherited`. First-class hook requested in docs/engineering/seam-requests.md.
 */
function reseed(engine: Engine, salt: string): { stream: 'new' | 'inherited'; note: string } {
  let h = 2166136261;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0;
  const e = engine as unknown as { faults?: { rng?: unknown }; monitor?: { rng?: unknown }; orch?: { d?: { rng?: unknown } } };
  if (!e.faults || !('rng' in e.faults) || !e.monitor || !('rng' in e.monitor) || !e.orch?.d || !('rng' in e.orch.d)) {
    return { stream: 'inherited', note: 'Engine does not expose its random streams; the child continues the parent stream until an intervention changes the path.' };
  }
  e.faults.rng = createRng(h ^ 0x51ed270b);
  e.monitor.rng = createRng(h ^ 0x2545f491);
  e.orch.d.rng = createRng(h ^ 0x9e3779b1);
  return { stream: 'new', note: `Independent random streams seeded from the branch id (${h.toString(16)}). Authored scenario faults still fire; random fault arrival and sensor noise differ from the parent.` };
}

export { DT };
