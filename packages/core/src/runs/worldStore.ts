import { create } from 'zustand';
import type { WorldSnapshot } from '../contracts';
import { getLiveWorldState, normalizeRobots, setWorldSource, createPoseBuffers, pushPose, resetPoses, setPoseBuffers, type WorldState } from '../store';
import type { ProjectedState } from './project';

/**
 * A second, separate world store for runs the Execution tab is looking at (replay projection, scenario run, fork).
 * It has the exact shape of the live WorldState so the shared 3D scene renders it unchanged, but nothing here ever
 * touches the live store, and live events never touch this one.
 */
export const useRunWorld = create<WorldState>()(() => ({ ...getLiveWorldState(), phase: 'idle' }));
export const runPoseBuffers = createPoseBuffers();

let active = false;

/** Point the scene/panels at the run world (true) or back at the live world (false). Safe to call repeatedly. */
export function selectRunWorld(on: boolean) {
  if (on === active) return;
  active = on;
  if (on) {
    const live = getLiveWorldState();
    resetPoses(runPoseBuffers);
    useRunWorld.setState({
      ...live,
      // topology is static; everything dynamic is replaced as soon as a run world is shown
      phase: 'ready',
      connection: 'live',
      stale: false,
      feed: [],
      series: {},
      tasks: {},
      transport: live.transport,
    });
    setPoseBuffers(runPoseBuffers);
    setWorldSource(useRunWorld);
  } else {
    setWorldSource(null);
    setPoseBuffers(null);
  }
}
export const isRunWorldActive = () => active;
export const resetRunPoses = () => resetPoses(runPoseBuffers);

/** Show a historical projection. `wall` is the timestamp poses are interpolated against. */
export function showProjected(p: ProjectedState, extra: { stale?: boolean } = {}, wall = Date.now()) {
  for (const r of Object.values(p.robots)) pushPose(r.id, r.pose, wall, runPoseBuffers);
  const incidents: WorldState['incidents'] = {};
  for (const i of p.incidents) incidents[i.id] = i;
  const live = getLiveWorldState();
  useRunWorld.setState({
    simTick: p.sim_tick,
    version: p.sim_tick,
    simTimeS: p.sim_time_s,
    simSpeed: p.sim_speed,
    simStatus: 'paused',
    assets: p.assets,
    robots: normalizeRobots(p.robots),
    missions: p.missions,
    incidents,
    kpis: p.kpis,
    health: live.health,
    lastEventAt: wall,
    stale: extra.stale ?? false,
    seriesVersion: useRunWorld.getState().seriesVersion + 1,
  });
}

/** Poses only (no React state): playback interpolation between two projected samples. */
export function pushRunPose(id: string, pose: WorldState['robots'][string]['pose'], wall = Date.now()) {
  pushPose(id, pose, wall, runPoseBuffers);
}

/** Show a live snapshot of a non-baseline run (scenario/fork). Poses go to the buffer every call; React state only when `full`. */
export function showLiveSnapshot(s: WorldSnapshot, full: boolean, wall = Date.now()) {
  for (const r of Object.values(s.robots)) pushPose(r.id, r.pose, wall, runPoseBuffers);
  if (!full) return;
  const incidents: WorldState['incidents'] = {};
  for (const i of s.incidents) incidents[i.id] = i;
  const st = useRunWorld.getState();
  useRunWorld.setState({
    simTick: s.sim_tick,
    version: s.version,
    simTimeS: s.sim_time_s,
    simSpeed: s.sim_speed,
    simStatus: s.sim_status,
    assets: s.assets,
    robots: normalizeRobots(s.robots),
    missions: s.missions,
    incidents,
    kpis: s.kpis,
    health: s.health,
    lastEventAt: wall,
    lastSeq: s.last_seq,
    stale: false,
    seriesVersion: st.seriesVersion + 1,
  });
}

/**
 * Replay/fork of a run recorded with another topology version: show THAT topology (never today's) in the run world.
 * Pass null to fall back to the live topology. History is never re-laid-out.
 */
export function setRunTopology(topo: import('../contracts').Topology | null) {
  const t = topo ?? getLiveWorldState().topology;
  if (!t) return;
  useRunWorld.setState({ topology: t, edgesById: Object.fromEntries(t.edges.map((e) => [e.id, e])), assetsById: Object.fromEntries(t.assets.map((a) => [a.id, a])) });
}
