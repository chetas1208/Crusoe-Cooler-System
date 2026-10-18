import { create } from 'zustand';
import type { StreamEvent } from '../contracts';
import type { RunsApi } from './api';
import { projectWorld, frameIndexAtOrBefore, type Projection } from './project';
import { buildTimeline, type TimelineModel } from './timeline';
import { pushRunPose, resetRunPoses, showProjected } from './worldStore';
import { getLiveWorldState } from '../store';
import type { CheckpointInfo, ForkResult, RecordedCommand, ReplayFrame, ReplayGap, RunSummary } from './types';

export const SPEEDS = [0.25, 1, 2, 4] as const;
/** 1× plays 6 simulated seconds per wall second (the default live pace). */
export const BASE_SIM_S_PER_S = 6;
const TICKS_PER_SIM_S = 2;
const CHUNK = 480;
const MAX_CHUNKS = 14;

export interface PlayerProblem {
  code: string;
  message: string;
}

export interface PlayerState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  problem: PlayerProblem | null;
  runId: string | null;
  run: RunSummary | null;
  from: number;
  to: number;
  gaps: ReplayGap[];
  timeline: TimelineModel | null;
  checkpoints: CheckpointInfo[];
  playing: boolean;
  speed: number;
  proj: { requested: number; base: number; exact: boolean; hash: string; applied: number; coarse: boolean } | null;
  fetching: boolean;
  eventCount: number;
  /** live-tail monitor of the running baseline: timeline + real playhead, no scrubbing of the shown world */
  monitor: boolean;
}

const initial: PlayerState = { phase: 'idle', problem: null, runId: null, run: null, from: 0, to: 0, gaps: [], timeline: null, checkpoints: [], playing: false, speed: 1, proj: null, fetching: false, eventCount: 0, monitor: false };
export const usePlayer = create<PlayerState>()(() => initial);
/** The playhead changes ~10×/s while playing; kept apart so only the few readouts that need it re-render. */
export const usePlayhead = create<{ tick: number; simTimeS: number }>()(() => ({ tick: 0, simTimeS: 0 }));

let api: RunsApi | null = null;
let overview: ReplayFrame[] = [];
let events: StreamEvent[] = [];
let commands: RecordedCommand[] = [];
let eventTicks: number[] = [];
const chunks = new Map<number, ReplayFrame[]>();
const inflight = new Map<number, Promise<void>>();
let token = 0;
let playTimer: ReturnType<typeof setInterval> | null = null;
let tailTimer: ReturnType<typeof setInterval> | null = null;
let head = 0; // float playhead in ticks
let lastBase = -1;
let lastPublish = 0;
let lastWall = 0;

const set = usePlayer.setState;
const problem = (e: unknown): PlayerProblem => ({ code: (e as { code?: string }).code ?? 'error', message: e instanceof Error ? e.message : String(e) });

function strideFor(from: number, to: number) {
  return Math.max(1, Math.ceil((to - from) / 4 / 700));
}

/** the replay window only lists checkpoints inside its tick range / stride; the run's own checkpoint list is the source for forking */
async function allCheckpoints(a: RunsApi, runId: string, fromWindow: CheckpointInfo[]): Promise<CheckpointInfo[]> {
  if (fromWindow.length) return fromWindow;
  try {
    const l = await a.checkpoints(runId);
    return l.checkpoints ?? fromWindow;
  } catch {
    return fromWindow;
  }
}

async function loadOverview(runId: string) {
  const a = api!;
  const run = await a.getRun(runId);
  const w = await a.replay(runId, { start_tick: 0, end_tick: run.current_tick, stride: strideFor(0, run.current_tick), events: true });
  overview = w.frames;
  events = w.events;
  commands = w.commands;
  eventTicks = [...new Set([...events.map((e) => e.sim_tick), ...commands.map((c) => c.tick)])].sort((x, y) => x - y);
  const checkpoints = await allCheckpoints(a, runId, w.checkpoints);
  set({ run, from: w.recorded_from_tick, to: w.recorded_to_tick, gaps: w.gaps, checkpoints, timeline: buildTimeline(overview, events, commands, (id) => labelOf(id)), eventCount: events.length });
}

let labelOf: (id: string) => string = (id) => id.toUpperCase().replace('_', '-');
/** lets the UI supply asset labels (V-ZB instead of valve_zb) without core knowing the topology */
export function setLabelResolver(f: (id: string) => string) {
  labelOf = f;
}

/** Open a run for replay. Never starts, steps or commands anything on the run. */
export async function openReplay(a: RunsApi, runId: string, startAt?: number) {
  closeReplay();
  api = a;
  const my = ++token;
  set({ ...initial, phase: 'loading', runId, speed: 1 });
  try {
    await loadOverview(runId);
    if (my !== token) return;
    const s = usePlayer.getState();
    if (!overview.length) {
      set({ phase: 'error', problem: { code: 'empty', message: 'This run has no recorded world frames (GET /runs/{id}/replay returned frames: []), so there is nothing to scrub or fork from. Events and the live playhead are still available in Live mode.' } });
      return;
    }
    set({ phase: 'ready' });
    resetRunPoses();
    lastBase = -1;
    void seek(startAt ?? s.to, true);
    startTailWatch();
  } catch (e) {
    if (my === token) set({ phase: 'error', problem: problem(e) });
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let playheadTimer: ReturnType<typeof setInterval> | null = null;
const BIG_STRIDE = 100_000; // backend limit: stride <= 100000

/**
 * Follow the LIVE baseline run read-only: build the timeline from the recorded events (/replay), keep it growing with
 * incremental tail requests, and report the true engine tick / sim time as the playhead. It never shows a replay world,
 * never seeks and never sends a command. Works even when the backend has recorded no frames or checkpoints.
 */
export async function openMonitor(a: RunsApi, runId: string) {
  closeReplay();
  api = a;
  const my = ++token;
  set({ ...initial, phase: 'loading', runId, speed: 1, monitor: true });
  const rebuild = () => {
    const s = usePlayer.getState();
    const tl = buildTimeline(overview, events, commands, (id) => labelOf(id));
    const last = Math.max(s.run?.current_tick ?? 0, tl.to);
    set({ timeline: tl, eventCount: events.length, from: Math.min(tl.from, last), to: last });
    eventTicks = [...new Set([...events.map((e) => e.sim_tick), ...commands.map((c) => c.tick)])].sort((x, y) => x - y);
  };
  try {
    const run = await a.getRun(runId);
    const w = await a.replay(runId, { start_tick: 0, end_tick: run.current_tick, stride: BIG_STRIDE, events: true });
    if (my !== token) return;
    overview = w.frames;
    events = w.events;
    commands = w.commands;
    set({ run, gaps: w.gaps, checkpoints: await allCheckpoints(a, runId, w.checkpoints), phase: 'ready', monitor: true });
    rebuild();
  } catch (e) {
    if (my === token) set({ phase: 'error', problem: problem(e), monitor: true });
    return;
  }
  const publishHead = () => {
    const w = getLiveWorldState();
    usePlayhead.setState({ tick: w.simTick, simTimeS: w.simTimeS });
  };
  publishHead();
  playheadTimer = setInterval(publishHead, 400);
  monitorTimer = setInterval(() => {
    void (async () => {
      try {
        const cur = await a.getRun(runId);
        if (my !== token) return;
        const lastSeq = events.length ? events[events.length - 1].seq : 0;
        const lastTick = events.length ? events[events.length - 1].sim_tick : 0;
        const w = await a.replay(runId, { start_tick: lastTick, end_tick: cur.current_tick + 2, stride: BIG_STRIDE, events: true });
        if (my !== token) return;
        const fresh = w.events.filter((e) => e.seq > lastSeq);
        if (fresh.length) events = events.concat(fresh);
        if (w.commands.length) {
          const seen = new Set(commands.map((c) => `${c.command_id}:${c.tick}`));
          commands = commands.concat(w.commands.filter((c) => !seen.has(`${c.command_id}:${c.tick}`)));
        }
        set({ run: cur, checkpoints: w.checkpoints.length ? w.checkpoints : usePlayer.getState().checkpoints });
        rebuild();
      } catch {
        /* keep the last good recording */
      }
    })();
  }, 3000);
}

export function closeReplay() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (playheadTimer) clearInterval(playheadTimer);
  monitorTimer = playheadTimer = null;
  token++;
  stopPlay();
  if (tailTimer) clearInterval(tailTimer);
  tailTimer = null;
  chunks.clear();
  inflight.clear();
  overview = [];
  events = [];
  commands = [];
  eventTicks = [];
  api = null;
  lastBase = -1;
  set(initial);
}

function startTailWatch() {
  if (tailTimer) clearInterval(tailTimer);
  tailTimer = setInterval(() => {
    const s = usePlayer.getState();
    if (!api || !s.runId || s.phase !== 'ready' || s.run?.state === 'stopped') return;
    const my = token;
    void (async () => {
      try {
        await loadOverview(s.runId!);
        if (my !== token) return;
      } catch {
        /* keep the last good recording; the status bar shows the run's own state */
      }
    })();
  }, 5000);
}

/* ───────────────────────── seeking ───────────────────────── */

function detailFrames(tick: number): ReplayFrame[] | null {
  const c = chunks.get(Math.floor(tick / CHUNK));
  return c && c.length ? c : null;
}

function ensureChunk(runId: string, c: number): Promise<void> {
  if (chunks.has(c)) return Promise.resolve();
  const have = inflight.get(c);
  if (have) return have;
  const a = api!;
  const my = token;
  set({ fetching: true });
  const p = a
    .replay(runId, { start_tick: c * CHUNK, end_tick: c * CHUNK + CHUNK + 8, stride: 1, events: false })
    .then((w) => {
      if (my !== token) return;
      chunks.set(c, w.frames);
      if (chunks.size > MAX_CHUNKS) {
        const cur = Math.floor(head / CHUNK);
        const far = [...chunks.keys()].sort((x, y) => Math.abs(y - cur) - Math.abs(x - cur))[0];
        chunks.delete(far);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(c);
      if (my === token) set({ fetching: inflight.size > 0 });
    });
  inflight.set(c, p);
  return p;
}

function publish(p: Projection, coarse: boolean, force: boolean) {
  const now = performance.now();
  if (force || p.base_tick !== lastBase) {
    lastBase = p.base_tick;
    showProjected(p.state);
  }
  const cur = usePlayer.getState().proj;
  if (!cur || cur.base !== p.base_tick || cur.requested !== p.requested_tick || cur.coarse !== coarse || cur.hash !== p.hash) {
    set({ proj: { requested: p.requested_tick, base: p.base_tick, exact: p.exact, hash: p.hash, applied: p.applied_events, coarse } });
  }
  if (force || now - lastPublish > 90) {
    lastPublish = now;
    usePlayhead.setState({ tick: head, simTimeS: p.state.sim_time_s });
  }
}

/** Jump the playhead. Deterministic: same tick, same recording => same projected world and hash. */
export async function seek(tick: number, discontinuous = true) {
  const s = usePlayer.getState();
  if (!api || !s.runId) return;
  head = Math.max(s.from, Math.min(s.to, tick));
  const c = Math.floor(head / CHUNK);
  const d = detailFrames(head);
  if (discontinuous) resetRunPoses();
  const frames = d ?? overview;
  const p = projectWorld(frames, events, Math.floor(head));
  if (p) publish(p, !d, discontinuous);
  if (!d) {
    const my = token;
    await ensureChunk(s.runId, c);
    if (my !== token) return;
    const d2 = detailFrames(head);
    if (d2) {
      const p2 = projectWorld(d2, events, Math.floor(head));
      if (p2) publish(p2, false, true);
    }
  }
  // prefetch the next chunk for smooth playback
  void ensureChunk(s.runId, c + 1);
}

export function stepFrame(dir: 1 | -1) {
  const p = usePlayer.getState().proj;
  const frames = detailFrames(head) ?? overview;
  const i = frameIndexAtOrBefore(frames, Math.floor(head));
  const j = Math.max(0, Math.min(frames.length - 1, i + dir));
  if (frames[j]) void seek(frames[j].tick);
  void p;
}

/** Jump to the next/previous recorded event (incident, mission, agent, verification or operator command). */
export function stepEvent(dir: 1 | -1) {
  const t = Math.floor(head);
  if (dir === 1) {
    const n = eventTicks.find((x) => x > t);
    if (n !== undefined) void seek(n);
  } else {
    for (let i = eventTicks.length - 1; i >= 0; i--)
      if (eventTicks[i] < t) {
        void seek(eventTicks[i]);
        return;
      }
  }
}

/* ───────────────────────── playback ───────────────────────── */

export function setSpeed(x: number) {
  set({ speed: x });
}

export function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  if (usePlayer.getState().playing) set({ playing: false });
}

export function play(on: boolean) {
  const s = usePlayer.getState();
  if (!on) return stopPlay();
  if (s.phase !== 'ready') return;
  if (head >= s.to - 1) void seek(s.from);
  set({ playing: true });
  lastWall = performance.now();
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(frame, 50);
}

function frame() {
  const s = usePlayer.getState();
  const now = performance.now();
  const dt = Math.min(now - lastWall, 200) / 1000;
  lastWall = now;
  head = Math.min(s.to, head + dt * s.speed * BASE_SIM_S_PER_S * TICKS_PER_SIM_S);
  const d = detailFrames(head);
  if (!d) {
    // keep the clock honest: wait for detail rather than skipping through coarse data
    head -= dt * s.speed * BASE_SIM_S_PER_S * TICKS_PER_SIM_S;
    void ensureChunk(s.runId!, Math.floor(head / CHUNK)).then(() => seek(head, false));
    return;
  }
  const t = Math.floor(head);
  const i = frameIndexAtOrBefore(d, t);
  const p = projectWorld(d, events, t);
  if (p) publish(p, false, false);
  // interpolate robot poses between the two bracketing samples (read-only)
  const a = d[i];
  const b = d[i + 1];
  if (a && b && b.tick > a.tick) {
    const f = (head - a.tick) / (b.tick - a.tick);
    for (const id in a.robots) {
      const ra = a.robots[id].pose;
      const rb = b.robots[id]?.pose;
      if (!rb) continue;
      pushRunPose(id, { ...ra, position_xyz_m: [ra.position_xyz_m[0] + (rb.position_xyz_m[0] - ra.position_xyz_m[0]) * f, ra.position_xyz_m[1] + (rb.position_xyz_m[1] - ra.position_xyz_m[1]) * f, ra.position_xyz_m[2] + (rb.position_xyz_m[2] - ra.position_xyz_m[2]) * f] }, Date.now());
    }
  }
  if (head >= s.to) stopPlay();
  void ensureChunk(s.runId!, Math.floor(head / CHUNK) + 1);
}

/* ───────────────────────── reading the recording ───────────────────────── */

export function framesNear(tick: number): ReplayFrame[] {
  return detailFrames(tick) ?? overview;
}
export function overviewFrames() {
  return overview;
}
export function recordedEvents() {
  return events;
}
export function recordedCommands() {
  return commands;
}
export function playheadTick() {
  return head;
}

/** Series of one metric over the loaded overview, for inspector sparklines: [sim_time_s, value]. */
export function seriesOf(assetId: string, metric: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of overview) {
    const v = f.assets[assetId]?.readings[metric];
    if (v !== undefined) out.push([f.sim_time_s, v]);
  }
  return out;
}

/** Projection at an arbitrary tick (for diffs against the run start). */
export function projectAt(tick: number): Projection | null {
  return projectWorld(detailFrames(tick) ?? overview, events, tick);
}
export function firstFrame(): ReplayFrame | undefined {
  return overview[0];
}

/* ───────────────────────── fork ───────────────────────── */

export class ForkRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Sampled tick a fork from the current playhead would use, with the checkpoint and parent hash it would send. */
export function forkPlan(): { tick: number; hash: string; checkpoint: CheckpointInfo } | { error: string } {
  const s = usePlayer.getState();
  if (s.phase !== 'ready' || !s.proj) return { error: 'Open a run and pick a moment first.' };
  const frames = detailFrames(head) ?? overview;
  const f = frames[frameIndexAtOrBefore(frames, Math.floor(head))];
  if (!f) return { error: 'No recorded sample at or before the playhead.' };
  const p = projectWorld(frames, events, f.tick);
  if (!p) return { error: 'No recorded sample at or before the playhead.' };
  const cps = s.checkpoints.filter((c) => c.tick <= f.tick);
  const checkpoint = cps[cps.length - 1];
  if (!checkpoint) return { error: `No checkpoint exists at or before tick ${f.tick}. Earlier history was not checkpointed, so the run cannot be restored there.` };
  if (!checkpoint.compatible) return { error: `The nearest checkpoint (tick ${checkpoint.tick}) is not restorable: ${checkpoint.reason ?? `schema ${checkpoint.schema_version} is not supported`}.` };
  if (s.run?.state === 'failed') return { error: 'The run failed; its state cannot be restored.' };
  return { tick: f.tick, hash: p.hash, checkpoint };
}

export async function forkFromPlayhead(label?: string): Promise<ForkResult> {
  const plan = forkPlan();
  if ('error' in plan) throw new ForkRefused('plan', plan.error);
  const s = usePlayer.getState();
  return api!.fork(s.runId!, { fork_tick: plan.tick, expected_parent_hash: plan.hash, chosen_snapshot_id: plan.checkpoint.snapshot_id, label });
}
