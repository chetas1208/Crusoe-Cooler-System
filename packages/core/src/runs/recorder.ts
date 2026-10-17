import type { CommandAck, CommandRequest, Incident, Mission, StreamEvent } from '../contracts';
import { Engine } from '../engine/engine';
import type { EngineOptions } from '../engine/engine';
import { HASH_ALGO, physicalHash } from './hash';
import { RUNS_SCHEMA_VERSION, type CheckpointInfo, type RecordedCommand, type ReplayFrame } from './types';

export const FRAME_EVERY = 4; // ticks (2 sim-s) — same cadence as the monitor
export const CHECKPOINT_EVERY = 60; // ticks (30 sim-s)
export const MAX_FRAMES = 2400;
export const MAX_EVENTS = 30000;

/** Everything needed to rebuild an engine bit-for-bit at tick 0 (the engine is deterministic from this + the command log). */
export interface RunConfig {
  seed: number;
  speed: number;
  approvalMode: 'autonomous' | 'supervised';
  approvalWindowS: number;
  faultsEnabled: boolean;
  workloadFactor: number;
  firstFaultS?: [number, number];
  meanGapS?: number;
}

export function configFromOptions(o: EngineOptions, workloadFactor = 1): RunConfig {
  return {
    seed: o.seed ?? 1,
    speed: o.speed ?? 6,
    approvalMode: o.approvalMode ?? 'autonomous',
    approvalWindowS: o.approvalWindowS ?? 24,
    faultsEnabled: o.faultsEnabled ?? true,
    workloadFactor,
    firstFaultS: o.firstFaultS,
    meanGapS: o.meanGapS,
  };
}

export function buildEngine(c: RunConfig): Engine {
  const e = new Engine({ seed: c.seed, speed: c.speed, approvalMode: c.approvalMode, approvalWindowS: c.approvalWindowS, faultsEnabled: c.faultsEnabled, firstFaultS: c.firstFaultS, meanGapS: c.meanGapS });
  if (c.workloadFactor !== 1) for (const k of Object.keys(e.plant.controls.loadFactor) as Array<keyof typeof e.plant.controls.loadFactor>) e.plant.controls.loadFactor[k] = c.workloadFactor;
  return e;
}

/** Commands that cannot change the physics; kept in the ledger (operator lane) but skipped when rebuilding an engine. */
export const NON_PHYSICAL = new Set(['pause', 'resume', 'set_sim_speed']);

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface Memo {
  incStr: string;
  inc: Incident[];
  misStr: string;
  mis: Record<string, Mission>;
}

/** Read the engine through its public API only. Incidents/missions are shared with the previous frame when unchanged. */
export function captureFrame(engine: Engine, memo?: Memo): { frame: ReplayFrame; memo: Memo } {
  const incStr = JSON.stringify(engine.incidents());
  const missionsObj: Record<string, Mission> = {};
  for (const m of engine.orch.missions.values()) missionsObj[m.id] = m;
  const misStr = JSON.stringify(missionsObj);
  const inc = memo && memo.incStr === incStr ? memo.inc : (JSON.parse(incStr) as Incident[]);
  const mis = memo && memo.misStr === misStr ? memo.mis : (JSON.parse(misStr) as Record<string, Mission>);
  const frame: ReplayFrame = {
    tick: engine.tick,
    sim_time_s: engine.plant.time,
    sim_speed: engine.speed,
    sim_status: engine.simStatus(),
    assets: clone(engine.monitor.last.assets),
    robots: clone(Object.fromEntries(Object.values(engine.robots).map((r) => [r.id, r.toContract()]))),
    kpis: clone(engine.kpis()),
    incidents: inc,
    missions: mis,
  };
  return { frame, memo: { incStr, inc, misStr, mis } };
}

export const frameHash = (f: ReplayFrame) =>
  physicalHash({ sim_tick: f.tick, sim_time_s: f.sim_time_s, assets: f.assets, robots: f.robots, missions: f.missions, incidents: f.incidents, kpis: f.kpis });

const KEEP: Set<StreamEvent['type']> = new Set(['incident.opened', 'incident.updated', 'incident.closed', 'mission.transition', 'agent.task', 'agent.tool', 'verification.result']);

export interface ScheduledCommand {
  tick: number;
  req: CommandRequest;
}

/**
 * Records one engine: tick-cadence snapshots (frames), hashed checkpoints, discrete stream events and the command ledger.
 * It instruments the engine INSTANCE (wraps `step` and `command`) so the engine core stays untouched; see docs/engineering/seam-requests.md
 * for the first-class hook request that would replace the wrapper.
 */
export class RunRecorder {
  frames: ReplayFrame[] = [];
  checkpoints: CheckpointInfo[] = [];
  events: StreamEvent[] = [];
  commands: RecordedCommand[] = [];
  firstTick: number;
  frameBytes = 0;
  private memo?: Memo;
  private schedule: ScheduledCommand[];
  private source: 'operator' | 'scenario' = 'operator';
  private cmdN = 0;
  private origStep!: () => void;
  private origCommand!: (r: CommandRequest) => CommandAck;
  private off?: () => void;
  private pendingCp = false;
  private frozen = false;

  constructor(
    readonly runId: string,
    readonly engine: Engine,
    schedule: ScheduledCommand[] = [],
  ) {
    this.firstTick = engine.tick;
    this.schedule = [...schedule].sort((a, b) => a.tick - b.tick);
    this.attach();
    this.capture(true);
  }

  private attach() {
    const e = this.engine;
    this.origStep = e.step.bind(e);
    this.origCommand = e.command.bind(e);
    e.step = () => {
      if (!this.frozen) this.applyDue();
      this.origStep();
      if (!this.frozen) this.afterStep();
    };
    e.command = (req: CommandRequest) => {
      const ack = this.origCommand(req);
      if (!this.frozen) this.log(req, ack);
      return ack;
    };
    this.off = e.subscribe((ev) => {
      if (this.frozen || !KEEP.has(ev.type)) return;
      this.events.push(ev);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      if (ev.type === 'incident.opened' || ev.type === 'incident.closed') this.pendingCp = true;
    });
  }

  /** Stop recording and give the engine its original methods back (run stopped). */
  detach() {
    this.frozen = true;
    this.off?.();
    this.engine.step = this.origStep;
    this.engine.command = this.origCommand;
  }

  private applyDue() {
    while (this.schedule.length && this.schedule[0].tick <= this.engine.tick) {
      const s = this.schedule.shift()!;
      this.source = 'scenario';
      this.engine.command(s.req);
      this.source = 'operator';
    }
  }

  private log(req: CommandRequest, ack: CommandAck) {
    this.commands.push({
      tick: this.engine.tick,
      sim_time_s: this.engine.plant.time,
      command_id: req.command_id || `cmd_${++this.cmdN}`,
      kind: req.kind,
      target_id: req.target_id,
      args: req.args ? clone(req.args) : undefined,
      accepted: ack.accepted,
      reason: ack.reason,
      source: this.source,
      run_id: this.runId,
    });
  }

  private afterStep() {
    if (this.engine.tick % FRAME_EVERY === 0) this.capture(false);
  }

  private capture(first: boolean) {
    const { frame, memo } = captureFrame(this.engine, this.memo);
    this.memo = memo;
    if (first || frame.tick % CHECKPOINT_EVERY === 0 || this.pendingCp) {
      frame.hash = frameHash(frame);
      this.pendingCp = false;
      this.checkpoints.push({
        snapshot_id: `${this.runId}@${frame.tick}`,
        run_id: this.runId,
        tick: frame.tick,
        sim_time_s: frame.sim_time_s,
        hash: frame.hash,
        hash_algo: HASH_ALGO,
        schema_version: RUNS_SCHEMA_VERSION,
        compatible: true,
      });
    }
    if (!this.frameBytes) this.frameBytes = JSON.stringify(frame).length;
    this.frames.push(frame);
    if (this.frames.length > MAX_FRAMES) this.thin();
  }

  /** Retention: halve the resolution of the older half; checkpoint frames and the first frame always survive. */
  private thin() {
    const n = this.frames.length;
    const keep: ReplayFrame[] = [];
    for (let i = 0; i < n; i++) {
      const f = this.frames[i];
      if (i >= n / 2 || i === 0 || f.hash !== undefined || i % 2 === 0) keep.push(f);
    }
    this.frames = keep;
  }

  addSchedule(s: ScheduledCommand) {
    this.schedule.push(s);
    this.schedule.sort((a, b) => a.tick - b.tick);
  }

  get lastFrame() {
    return this.frames[this.frames.length - 1];
  }
}
