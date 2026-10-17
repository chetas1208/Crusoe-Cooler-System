import { create, useStore, type StoreApi } from 'zustand';
import type {
  AgentTask,
  CommandAck,
  CommandRequest,
  Asset,
  AssetState,
  CommandKind,
  EngineHealth,
  FaultKind,
  Incident,
  Kpis,
  Mission,
  PipeEdge,
  Robot,
  RobotPosePayload,
  SimStatus,
  StreamEvent,
  Topology,
  WorldSnapshot,
  RigidObjectState,
  MechanicalFixtureState,
} from '../contracts';
import type { ConnectionState, Transport, TransportInfo } from '../client/transport';
import { describeEvent, type FeedItem } from './feed';
import { pushPose, resetPoses } from './poses';
import { setControlApi } from '../control/registry';

/**
 * Server-authoritative world state. Only the event reducer below writes to it
 * (frontend-ui.md §8). View state — selection, camera, layers — lives elsewhere.
 */
export interface WorldState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  transport: TransportInfo | null;
  topology: Topology | null;
  edgesById: Record<string, PipeEdge>;
  assetsById: Record<string, Asset>;
  facilityId: string;
  version: number;
  simTick: number;
  simTimeS: number;
  simSpeed: number;
  simStatus: SimStatus;
  assets: Record<string, AssetState>;
  robots: Record<string, Robot>;
  missions: Record<string, Mission>;
  incidents: Record<string, Incident>;
  tasks: Record<string, AgentTask>;
  health: EngineHealth | null;
  kpis: Kpis | null;
  rigid_objects: Record<string, RigidObjectState>;
  mechanical_fixtures: Record<string, MechanicalFixtureState>;
  connection: ConnectionState;
  /** connected but nothing received lately — render a STALE banner, never a fake heartbeat */
  stale: boolean;
  lastSeq: number;
  lastEventAt: number;
  feed: FeedItem[];
  /** rolling telemetry per `${assetId}.${metric}` → [simTimeS, value] */
  series: Record<string, Array<[number, number]>>;
  seriesVersion: number;
}

const initial: WorldState = {
  phase: 'idle',
  transport: null,
  topology: null,
  edgesById: {},
  assetsById: {},
  facilityId: 'lab_01',
  version: 0,
  simTick: 0,
  simTimeS: 0,
  simSpeed: 1,
  simStatus: 'running',
  assets: {},
  robots: {},
  missions: {},
  incidents: {},
  tasks: {},
  health: null,
  kpis: null,
  rigid_objects: {},
  mechanical_fixtures: {},
  connection: 'connecting',
  stale: false,
  lastSeq: 0,
  lastEventAt: 0,
  feed: [],
  series: {},
  seriesVersion: 0,
};

/** The authoritative live store. Only the reducer below writes to it. */
const liveWorld = create<WorldState>()(() => initial);

/**
 * `useWorld` is a facade over "whichever world is on screen". It is the live store unless the Execution tab selects a
 * replay/branch world store (setWorldSource). Everything that reads `useWorld` (scene, panels) follows without edits.
 * Live events always write `liveWorld` directly, so a replay can never alter or be altered by the live world.
 */
const useWorldSource = create<{ api: StoreApi<WorldState> }>()(() => ({ api: liveWorld }));
export function setWorldSource(api: StoreApi<WorldState> | null) {
  useWorldSource.setState({ api: api ?? liveWorld });
}
export const isLiveWorldSource = () => useWorldSource.getState().api === liveWorld;

interface UseWorld {
  (): WorldState;
  <T>(selector: (s: WorldState) => T): T;
  getState(): WorldState;
  setState: StoreApi<WorldState>['setState'];
  subscribe: StoreApi<WorldState>['subscribe'];
}
function useWorldHook<T>(selector?: (s: WorldState) => T) {
  const api = useWorldSource((s) => s.api);
  return useStore(api, (selector ?? ((s: WorldState) => s as unknown as T)) as (s: WorldState) => T);
}
export const useWorld: UseWorld = Object.assign(useWorldHook as UseWorld, {
  getState: () => useWorldSource.getState().api.getState(),
  setState: ((...a: Parameters<StoreApi<WorldState>['setState']>) => useWorldSource.getState().api.setState(...a)) as StoreApi<WorldState>['setState'],
  subscribe: ((l: Parameters<StoreApi<WorldState>['subscribe']>[0]) => {
    let off = useWorldSource.getState().api.subscribe(l);
    const offSrc = useWorldSource.subscribe((n, p) => {
      if (n.api === p.api) return;
      off();
      off = n.api.subscribe(l);
    });
    return () => {
      off();
      offSrc();
    };
  }) as StoreApi<WorldState>['subscribe'],
});
export const getLiveWorldState = () => liveWorld.getState();

const SERIES_MAX = 360;
const FEED_MAX = 240;

let transport: Transport | null = null;
/** the transport the live world was started with (the Execution tab picks its runs backend from it) */
export const activeTransport = () => transport;
let closeStream: (() => void) | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let recorder: ReturnType<typeof setInterval> | null = null;
let seenIds = new Set<string>();
const meta = { incidentStatus: {} as Record<string, string>, stepKey: '' };

function pushSeries(series: WorldState['series'], assets: Record<string, Partial<AssetState>>, simTimeS: number) {
  for (const [id, a] of Object.entries(assets)) {
    if (!a.readings) continue;
    for (const [metric, v] of Object.entries(a.readings)) {
      const k = `${id}.${metric}`;
      let arr = series[k];
      if (!arr) arr = series[k] = [];
      const last = arr[arr.length - 1];
      if (last && simTimeS <= last[0]) continue;
      arr.push([simTimeS, v]);
      if (arr.length > SERIES_MAX) arr.shift();
    }
  }
}

/**
 * Robots are keyed by their own `id`, whatever key the server used. A stale or buggy backend that repeats an id (or keys
 * the map differently from the ids inside) must never produce two rows / two meshes for one robot: first wins.
 */
export function normalizeRobots(robots: Record<string, Robot> | undefined): Record<string, Robot> {
  const out: Record<string, Robot> = {};
  for (const [k, r] of Object.entries(robots ?? {})) {
    const id = r?.id ?? k;
    if (!(id in out)) out[id] = r.id === id ? r : { ...r, id };
  }
  return out;
}

const POSE_FLUSH_MS = 250;
const pendingPose = new Map<string, { p: RobotPosePayload; seq: number; t: number; now: number }>();
let poseFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPoses() {
  if (poseFlushTimer) clearTimeout(poseFlushTimer);
  poseFlushTimer = null;
  if (!pendingPose.size) return;
  const batch = [...pendingPose.values()];
  pendingPose.clear();
  liveWorld.setState((st) => {
    const robots = { ...st.robots };
    let any = false;
    for (const { p } of batch) {
      const r = robots[p.robot_id];
      if (!r) continue;
      any = true;
      robots[p.robot_id] = {
        ...r,
        mode: p.mode,
        battery_pct: p.battery_pct,
        pose: p.pose,
        route_xyz_m: p.route_xyz_m,
        control: p.control ?? r.control,
        arm_joint_names: p.arm_joint_names ?? r.arm_joint_names,
        arm_qpos_rad: p.arm_qpos_rad ?? r.arm_qpos_rad,
        gripper_aperture_m: p.gripper_aperture_m ?? r.gripper_aperture_m,
        held_object_id: p.held_object_id !== undefined ? p.held_object_id : r.held_object_id,
        grip_force_N: p.grip_force_N ?? r.grip_force_N,
        end_effector_pose: p.end_effector_pose ?? r.end_effector_pose,
        contact_list: p.contact_list ?? r.contact_list,
        payload_mass_kg: p.payload_mass_kg ?? r.payload_mass_kg,
        deposit_fouling_pct: p.deposit_fouling_pct ?? r.deposit_fouling_pct,
        ...(p.tool !== undefined ? { tool: p.tool } : {}),
      };
    }
    const last = batch[batch.length - 1];
    return any ? { robots, simTimeS: last.t, lastSeq: Math.max(st.lastSeq, last.seq), lastEventAt: last.now, stale: false } : {};
  });
}

function applySnapshot(s: WorldSnapshot) {
  pendingPose.clear();
  s = { ...s, robots: normalizeRobots(s.robots) };
  resetPoses();
  for (const r of Object.values(s.robots)) pushPose(r.id, r.pose);
  const incidents = Object.fromEntries(s.incidents.map((i) => [i.id, i]));
  for (const i of s.incidents) meta.incidentStatus[i.id] = i.status;
  liveWorld.setState((st) => {
    const series = st.series;
    pushSeries(series, s.assets, s.sim_time_s);
    return {
      facilityId: s.facility_id,
      version: s.version,
      simTick: s.sim_tick,
      simTimeS: s.sim_time_s,
      simSpeed: s.sim_speed,
      simStatus: s.sim_status,
      assets: s.assets,
      robots: s.robots,
      missions: s.missions,
      incidents,
      health: s.health,
      kpis: s.kpis,
      rigid_objects: s.rigid_objects ?? st.rigid_objects ?? {},
      mechanical_fixtures: s.mechanical_fixtures ?? st.mechanical_fixtures ?? {},
      lastSeq: s.last_seq,
      lastEventAt: Date.now(),
      stale: false,
      seriesVersion: st.seriesVersion + 1,
    };
  });
}

/** The one place server events change world state. */
export function applyEvent(e: StreamEvent) {
  // replay never mutates the authoritative world: live events are dropped while scrubbing,
  // and a fresh snapshot is fetched when the operator returns to live.
  if (useReplay.getState().active && e.type !== 'heartbeat') return;
  // duplicate protection (reconnect overlap)
  if (e.type !== 'heartbeat' && e.type !== 'snapshot') {
    if (seenIds.has(e.event_id)) return;
    seenIds.add(e.event_id);
    if (seenIds.size > 4000) seenIds = new Set([...seenIds].slice(-2000));
  }
  const now = Date.now();
  switch (e.type) {
    case 'snapshot':
      applySnapshot(e.payload);
      void loadTraces();
      return;
    case 'heartbeat':
      liveWorld.setState({ lastEventAt: now, stale: false });
      return;
    case 'world.diff': {
      liveWorld.setState((st) => {
        const assets = { ...st.assets };
        for (const [id, patch] of Object.entries(e.payload.assets)) assets[id] = { ...assets[id], ...patch } as AssetState;
        pushSeries(st.series, e.payload.assets, e.sim_time_s);
        return {
          assets,
          kpis: e.payload.kpis,
          simSpeed: e.payload.sim_speed,
          simStatus: e.payload.sim_status,
          simTick: e.sim_tick,
          simTimeS: e.sim_time_s,
          version: e.world_version,
          lastSeq: e.seq,
          lastEventAt: now,
          stale: false,
          seriesVersion: st.seriesVersion + 1,
        };
      });
      return;
    }
    case 'robot.pose': {
      const p = e.payload;
      // The renderer reads the pose buffer directly. React state only changes when something a panel shows changes
      // (mode, tool, mission, control, battery by whole percent, held object) — a pose-only update is merged into the
      // store at most 4x per second, so 18 robots streaming at 10 Hz do not re-render the UI 180 times a second.
      pushPose(p.robot_id, p.pose, now);
      const r0 = liveWorld.getState().robots[p.robot_id];
      const coarse =
        !r0 ||
        r0.mode !== p.mode ||
        (p.tool !== undefined && r0.tool !== p.tool) ||
        Math.abs(r0.battery_pct - p.battery_pct) >= 1 ||
        (p.control !== undefined && (r0.control?.authority !== p.control.authority || r0.control?.controller_state !== p.control.controller_state)) ||
        (p.held_object_id !== undefined && p.held_object_id !== r0.held_object_id);
      pendingPose.set(p.robot_id, { p, seq: e.seq, t: e.sim_time_s, now });
      if (coarse) flushPoses();
      else if (!poseFlushTimer) poseFlushTimer = setTimeout(flushPoses, POSE_FLUSH_MS);
      return;
    }
    case 'robot.control': {
      const p = e.payload;
      const item = describeEvent(e);
      liveWorld.setState((st) => {
        const r = st.robots[p.robot_id];
        return {
          robots: r ? { ...st.robots, [p.robot_id]: { ...r, control: p.control } } : st.robots,
          feed: item ? [item, ...st.feed].slice(0, FEED_MAX) : st.feed,
          lastSeq: e.seq,
          lastEventAt: now,
        };
      });
      return;
    }
    case 'mission.transition': {
      const m = e.payload.mission;
      const item = describeEvent(e, { stepKey: meta.stepKey });
      const active = m.steps.find((s) => s.status === 'active');
      if (active) meta.stepKey = `${m.id}:${active.id}`;
      liveWorld.setState((st) => {
        const r = st.robots[m.robot_id];
        return {
          missions: { ...st.missions, [m.id]: m },
          robots: r ? { ...st.robots, [m.robot_id]: { ...r, mode: e.payload.robot_mode, tool: e.payload.tool, mission_id: m.closed_tick ? undefined : m.id } } : st.robots,
          feed: item ? [item, ...st.feed].slice(0, FEED_MAX) : st.feed,
          lastSeq: e.seq,
          lastEventAt: now,
        };
      });
      return;
    }
    case 'incident.opened':
    case 'incident.updated':
    case 'incident.closed': {
      const inc = e.payload.incident;
      const item = describeEvent(e, { incidentStatus: meta.incidentStatus[inc.id] });
      meta.incidentStatus[inc.id] = inc.status;
      liveWorld.setState((st) => ({
        incidents: { ...st.incidents, [inc.id]: inc },
        feed: item ? [item, ...st.feed].slice(0, FEED_MAX) : st.feed,
        lastSeq: e.seq,
        lastEventAt: now,
      }));
      return;
    }
    case 'agent.task': {
      const t = e.payload.task;
      const item = describeEvent(e);
      liveWorld.setState((st) => ({
        tasks: { ...st.tasks, [t.id]: t },
        feed: item ? [item, ...st.feed].slice(0, FEED_MAX) : st.feed,
        lastSeq: e.seq,
        lastEventAt: now,
      }));
      return;
    }
    case 'agent.tool': {
      const { task_id, tool_call } = e.payload;
      liveWorld.setState((st) => {
        const t = st.tasks[task_id];
        if (!t) return { lastSeq: e.seq };
        const calls = t.tool_calls.some((c) => c.id === tool_call.id) ? t.tool_calls.map((c) => (c.id === tool_call.id ? tool_call : c)) : [...t.tool_calls, tool_call];
        return { tasks: { ...st.tasks, [task_id]: { ...t, tool_calls: calls } }, lastSeq: e.seq, lastEventAt: now };
      });
      return;
    }
    case 'verification.result': {
      const v = e.payload.verification;
      const item = describeEvent(e);
      liveWorld.setState((st) => {
        const inc = st.incidents[v.incident_id];
        return {
          incidents: inc ? { ...st.incidents, [inc.id]: { ...inc, verification: v } } : st.incidents,
          feed: item ? [item, ...st.feed].slice(0, FEED_MAX) : st.feed,
          lastSeq: e.seq,
          lastEventAt: now,
        };
      });
      return;
    }
    case 'engine.health':
      liveWorld.setState({ health: e.payload.health, simStatus: e.payload.health.status, lastSeq: e.seq, lastEventAt: now, stale: false });
      return;
  }
}

async function loadTraces() {
  if (!transport) return;
  const { incidents, tasks } = liveWorld.getState();
  const missing = Object.values(incidents).filter((i) => i.task_ids.some((id) => !tasks[id]));
  await Promise.all(
    missing.map(async (i) => {
      try {
        const list = await transport!.fetchTrace(i.id);
        liveWorld.setState((st) => {
          const next = { ...st.tasks };
          for (const t of list) next[t.id] = next[t.id] ?? t;
          return { tasks: next };
        });
      } catch {
        /* trace is best-effort */
      }
    }),
  );
}

/** Bootstrap: topology → snapshot → stream (per frontend-ui.md §8). Returns teardown. */
export async function startWorld(t: Transport): Promise<() => void> {
  stopWorld();
  transport = t;
  setControlApi(t.control);
  seenIds = new Set();
  liveWorld.setState({ ...initial, phase: 'loading', transport: t.info, series: {} });
  try {
    const [topology, snapshot] = await Promise.all([t.fetchTopology(), t.fetchSnapshot()]);
    liveWorld.setState({
      topology,
      edgesById: Object.fromEntries(topology.edges.map((e) => [e.id, e])),
      assetsById: Object.fromEntries(topology.assets.map((a) => [a.id, a])),
    });
    applySnapshot(snapshot);
    liveWorld.setState({ phase: 'ready', connection: 'connecting' });
    void loadTraces();
    closeStream = t.connect(snapshot.last_seq, {
      onEvent: applyEvent,
      onConnection: (c) => liveWorld.setState({ connection: c, ...(c === 'live' ? {} : {}) }),
      onGap: () => {
        void t.fetchSnapshot().then(applySnapshot).catch(() => undefined);
      },
    });
    frames.length = 0;
    recorder = setInterval(recordFrame, 1000);
    watchdog = setInterval(() => {
      const st = liveWorld.getState();
      const stale = st.connection === 'live' && Date.now() - st.lastEventAt > 5000;
      if (stale !== st.stale) liveWorld.setState({ stale });
    }, 1000);
  } catch (err) {
    liveWorld.setState({ phase: 'error', error: err instanceof Error ? err.message : String(err), connection: 'offline' });
  }
  return stopWorld;
}

export function stopWorld() {
  if (poseFlushTimer) clearTimeout(poseFlushTimer);
  poseFlushTimer = null;
  pendingPose.clear();
  closeStream?.();
  closeStream = null;
  if (recorder) clearInterval(recorder);
  recorder = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

/* ───────────────────────────── commands ───────────────────────────── */

let cmdSeq = 0;
type CommandRouter = (req: CommandRequest) => Promise<CommandAck>;
let commandRouter: CommandRouter | null = null;
/**
 * Additive seam for the Execution tab: while a replay or a fork is on screen, operator commands must not reach the
 * baseline transport. The router either refuses ("Fork to interact") or sends the command to the run being shown.
 */
export function setCommandRouter(r: CommandRouter | null) {
  commandRouter = r;
}
export async function sendCommand(kind: CommandKind, targetId?: string, args?: Record<string, unknown>) {
  const req: CommandRequest = { command_id: `ui_${Date.now()}_${++cmdSeq}`, kind, target_id: targetId, args };
  if (commandRouter) return commandRouter(req);
  if (!transport) return { command_id: '', accepted: false, reason: 'not connected' };
  return transport.sendCommand(req);
}

export const commands = {
  approve: (approvalId: string) => sendCommand('approve_action', approvalId),
  hold: (approvalId: string) => sendCommand('hold_action', approvalId),
  setSpeed: (speed: number) => sendCommand('set_sim_speed', undefined, { speed }),
  pause: () => sendCommand('pause'),
  resume: () => sendCommand('resume'),
  injectFault: (kind: FaultKind, target?: string) => sendCommand('test.inject_fault', undefined, { kind, target }),
};

export async function fetchSeriesBackfill(assetId: string, metrics: string[], windowS = 480) {
  if (!transport) return;
  const results = await Promise.all(metrics.map((m) => transport!.fetchTelemetry(assetId, m, windowS)));
  liveWorld.setState((st) => {
    const series = st.series;
    results.forEach((r, i) => {
      if (!r || !r.points.length) return;
      const k = `${assetId}.${metrics[i]}`;
      const cur = series[k] ?? [];
      if (cur.length && cur[0][0] <= r.points[0][0]) return;
      const firstLive = cur[0]?.[0] ?? Infinity;
      series[k] = [...r.points.filter((p) => p[0] < firstLive), ...cur].slice(-SERIES_MAX);
    });
    return { seriesVersion: st.seriesVersion + 1 };
  });
}

/* ───────────────────────────── selectors ───────────────────────────── */

export const selectIncidentsSorted = (s: WorldState) => Object.values(s.incidents).sort((a, b) => b.opened_tick - a.opened_tick);
export const selectOpenIncidents = (s: WorldState) => selectIncidentsSorted(s).filter((i) => !i.closed_tick);
export const tasksOf = (s: WorldState, incidentId: string) =>
  (s.incidents[incidentId]?.task_ids ?? []).map((id) => s.tasks[id]).filter(Boolean);

/* ───────────────────────────── replay ───────────────────────────── */

/** A compact copy of everything the scene and panels render, sampled at 1 Hz. */
export interface Frame {
  wall: number;
  simTimeS: number;
  seq: number;
  assets: Record<string, AssetState>;
  robots: Record<string, Robot>;
  incidents: Record<string, Incident>;
  missions: Record<string, Mission>;
  kpis: Kpis | null;
}

const FRAME_CAP = 900; // ~15 minutes of wall time
const frames: Frame[] = [];

interface ReplayState {
  active: boolean;
  index: number;
  playing: boolean;
  rate: number;
  count: number;
}

export const useReplay = create<ReplayState>()(() => ({ active: false, index: 0, playing: false, rate: 1, count: 0 }));

function recordFrame() {
  if (useReplay.getState().active) return;
  const st = liveWorld.getState();
  if (st.phase !== 'ready' || st.connection !== 'live' || st.simStatus === 'paused') return;
  frames.push({ wall: Date.now(), simTimeS: st.simTimeS, seq: st.lastSeq, assets: st.assets, robots: st.robots, incidents: st.incidents, missions: st.missions, kpis: st.kpis });
  if (frames.length > FRAME_CAP) frames.shift();
  useReplay.setState({ count: frames.length });
}

export const replayFrames = () => frames;

function showFrame(i: number) {
  const f = frames[Math.max(0, Math.min(i, frames.length - 1))];
  if (!f) return;
  resetPoses();
  for (const r of Object.values(f.robots)) pushPose(r.id, r.pose);
  liveWorld.setState({ assets: f.assets, robots: normalizeRobots(f.robots), incidents: f.incidents, missions: f.missions, kpis: f.kpis, simTimeS: f.simTimeS });
}

let playTimer: ReturnType<typeof setInterval> | null = null;

export function enterReplay() {
  if (!frames.length) return false;
  const index = frames.length - 1;
  useReplay.setState({ active: true, index, playing: false, count: frames.length });
  showFrame(index);
  return true;
}

export function seekReplay(i: number) {
  const index = Math.max(0, Math.min(i, frames.length - 1));
  useReplay.setState({ index });
  showFrame(index);
}

export function playReplay(on: boolean, rate?: number) {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  useReplay.setState({ playing: on, ...(rate ? { rate } : {}) });
  if (!on) return;
  playTimer = setInterval(() => {
    const { index, rate: r } = useReplay.getState();
    if (index >= frames.length - 1) {
      playReplay(false);
      return;
    }
    seekReplay(Math.min(index + r, frames.length - 1));
  }, 1000);
}

export async function exitReplay() {
  playReplay(false);
  useReplay.setState({ active: false });
  if (!transport) return;
  try {
    const snap = await transport.fetchSnapshot();
    applySnapshot(snap);
    void loadTraces();
  } catch {
    /* the stream will resync with the next snapshot */
  }
}
