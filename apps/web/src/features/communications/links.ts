import { useWorld } from '@loopkeeper/core/store';
import { useMapCamera, useView } from '@loopkeeper/scene';
import { useUi } from '../../ui/store';
import { seek, usePlayer } from '@loopkeeper/core/runs';
import { flyTo } from '../../ui/EntityIds';
import type { CommunicationEventV1 } from './types';

export interface Target {
  kind: 'map-robot' | 'map-asset' | 'agents-task';
  id: string;
  label: string;
}

/** Where a message can take you. Only ids the message actually carries; the run and the playback cursor are global state and stay as they are. */
export function targetsOf(e: CommunicationEventV1): Target[] {
  const out: Target[] = [];
  if (e.robot_id) out.push({ kind: 'map-robot', id: e.robot_id, label: `Robot ${e.robot_id} on Map` });
  if (e.asset_id) out.push({ kind: 'map-asset', id: e.asset_id, label: `Asset ${e.asset_id} on Map` });
  if (e.task_id) out.push({ kind: 'agents-task', id: e.task_id, label: `Task ${e.task_id} in Agents` });
  return out;
}

export function jumpTo(t: Target) {
  const ui = useUi.getState();
  if (t.kind === 'agents-task') {
    ui.setTask(t.id);
    ui.setTab('agents');
    return true;
  }
  const w = useWorld.getState();
  if (t.kind === 'map-robot') {
    const r = w.robots[t.id];
    if (!r) return false; // not in the world on screen (e.g. an older run): say so instead of navigating nowhere
    ui.setTab('map');
    useMapCamera.getState().selectRobot(t.id, r.class);
    useView.getState().select(t.id);
    return true;
  }
  if (!w.assetsById[t.id] && !w.edgesById[t.id]) return false;
  ui.setTab('map');
  useView.getState().select(t.id);
  return true;
}

/**
 * Timeline: in a replay the playhead jumps to the message's tick (the same run, so the cursor and the panel follow). In the live tail the
 * recording cannot be rewound, and the answer says so instead of pretending.
 */
export function seekToMessage(e: CommunicationEventV1): { ok: boolean; note: string } {
  const p = usePlayer.getState();
  if (p.phase !== 'ready' || p.monitor || p.runId !== e.run_id) return { ok: false, note: 'The timeline can jump to this tick only while this run is open as a replay.' };
  void seek(e.sim_tick);
  return { ok: true, note: `Timeline moved to tick ${e.sim_tick}.` };
}

/** 3D camera: the robot or asset the message is about, if it exists in the world on screen. */
export function focusMessage(e: CommunicationEventV1): { ok: boolean; note: string } {
  const w = useWorld.getState();
  if (e.robot_id && w.robots[e.robot_id]) {
    useView.getState().select(e.robot_id);
    useView.getState().focusEntity(e.robot_id);
    return { ok: true, note: `Camera on ${e.robot_id}.` };
  }
  if (e.asset_id && (w.assetsById[e.asset_id] || w.edgesById[e.asset_id])) {
    useView.getState().select(e.asset_id);
    return flyTo(e.asset_id) ? { ok: true, note: `Camera on ${e.asset_id}.` } : { ok: false, note: `${e.asset_id} has no position in this facility model.` };
  }
  return { ok: false, note: 'This message carries no robot or asset that exists in the world on screen.' };
}
