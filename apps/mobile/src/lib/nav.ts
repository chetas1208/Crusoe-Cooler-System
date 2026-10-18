import { router } from 'expo-router';
import { useMapSel } from '@/features/map/store';

export const goDashboard = () => router.navigate('/' as never);

export function openIncident(id: string) {
  router.push(`/incident/${encodeURIComponent(id)}` as never);
}

export function openAgent(id: string) {
  router.push(`/agents/${encodeURIComponent(id)}` as never);
}

/** Select a robot on the Map tab and switch to it. */
export function showRobotOnMap(id: string) {
  useMapSel.getState().select(id);
  router.navigate('/map' as never);
}

export function showEntityOnMap(id: string) {
  useMapSel.getState().select(id);
  router.navigate('/map' as never);
}
