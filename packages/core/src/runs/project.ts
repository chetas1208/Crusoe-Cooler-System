import type { AssetState, Incident, Kpis, Mission, Robot, SimStatus, StreamEvent } from '../contracts';
import { physicalHash } from './hash';
import type { ReplayFrame } from './types';

export interface ProjectedState {
  sim_tick: number;
  sim_time_s: number;
  sim_speed: number;
  sim_status: SimStatus;
  assets: Record<string, AssetState>;
  robots: Record<string, Robot>;
  missions: Record<string, Mission>;
  incidents: Incident[];
  kpis: Kpis;
}

export interface Projection {
  requested_tick: number;
  /** tick of the sample the state is based on */
  base_tick: number;
  /** true when requested_tick is a recorded sample: the state is exactly what the run held at that tick */
  exact: boolean;
  /** discrete events (incident/mission/verification) applied on top of the base sample */
  applied_events: number;
  hash: string;
  state: ProjectedState;
}

/** index of the last frame with tick <= t (binary search); -1 if none */
export function frameIndexAtOrBefore(frames: ReplayFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tick <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * seek(): nearest recorded sample at or before the target + the discrete events recorded after it.
 * Pure and deterministic: same inputs, same state, same hash. Never calls an agent or a model.
 * Returns null when the target precedes the first sample (caller must show "cannot reconstruct").
 */
export function projectWorld(frames: ReplayFrame[], events: StreamEvent[], tick: number): Projection | null {
  const i = frameIndexAtOrBefore(frames, tick);
  if (i < 0) return null;
  const f = frames[i];
  let incidents = f.incidents;
  let missions = f.missions;
  let applied = 0;
  if (f.tick < tick) {
    const incMap = new Map(incidents.map((x) => [x.id, x]));
    const mis = { ...missions };
    // events are chronological; start at the first one after the base sample
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].sim_tick <= f.tick) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < events.length; k++) {
      const e = events[k];
      if (e.sim_tick > tick) break;
      switch (e.type) {
        case 'incident.opened':
        case 'incident.updated':
        case 'incident.closed':
          incMap.set(e.payload.incident.id, e.payload.incident);
          applied++;
          break;
        case 'mission.transition':
          mis[e.payload.mission.id] = e.payload.mission;
          applied++;
          break;
        case 'verification.result': {
          const inc = incMap.get(e.payload.verification.incident_id);
          if (inc) incMap.set(inc.id, { ...inc, verification: e.payload.verification });
          applied++;
          break;
        }
        default:
          break;
      }
    }
    if (applied) {
      incidents = [...incMap.values()].sort((a, b) => b.opened_tick - a.opened_tick || (a.id < b.id ? -1 : 1));
      missions = mis;
    }
  }
  const state: ProjectedState = { sim_tick: f.tick, sim_time_s: f.sim_time_s, sim_speed: f.sim_speed, sim_status: f.sim_status, assets: f.assets, robots: f.robots, missions, incidents, kpis: f.kpis };
  const exact = f.tick === tick;
  const hash = exact && f.hash ? f.hash : physicalHash({ sim_tick: f.tick, sim_time_s: f.sim_time_s, assets: f.assets, robots: f.robots, missions, incidents, kpis: f.kpis });
  return { requested_tick: tick, base_tick: f.tick, exact, applied_events: applied, hash, state };
}

/** Linear blend of robot poses between two samples, for smooth playback. Allocates; call only at ~20 Hz. */
export function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}
