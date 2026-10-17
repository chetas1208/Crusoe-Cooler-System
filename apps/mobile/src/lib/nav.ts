import { router } from 'expo-router';
import { useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { applyCameraPreset } from './camera';

export const goLive = () => router.navigate('/');

/** Jump to Live and put an incident's hardware in frame. */
export function showIncidentOnMap(incidentId: string) {
  const v = useView.getState();
  if (v.mode === 'pipe') v.exitPipe();
  v.select(null);
  v.focusIncident(incidentId);
  goLive();
}

export function showEntityOnMap(id: string) {
  const v = useView.getState();
  if (v.mode === 'pipe') v.exitPipe();
  v.select(id);
  v.focusEntity(id);
  goLive();
}

export function followRobot(id: string) {
  const v = useView.getState();
  if (v.mode === 'pipe') v.exitPipe();
  v.select(id);
  v.follow(id);
  goLive();
}

/** Enter a crawler's inside-pipe view, if the segment is robot-passable (else the scene explains why). */
export function openPipeCam(edgeId: string, robotId?: string | null) {
  const ok = useView.getState().enterPipe(edgeId, robotId ?? null);
  if (ok) goLive();
  return ok;
}

export function openIncident(id: string) {
  router.navigate({ pathname: '/incidents/[id]', params: { id } });
}

/** Pipe cam for an incident: its anchor segment when passable, with the crawler that is inside it if any. */
export function incidentPipeEdge(incidentId: string): string | null {
  const w = useWorld.getState();
  const inc = w.incidents[incidentId];
  if (!inc) return null;
  const edge = w.edgesById[inc.anchor.entity_id];
  return edge?.robot_passable ? edge.id : null;
}

export { applyCameraPreset };
