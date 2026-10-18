import { create } from 'zustand';
import { useWorld } from '@loopkeeper/core/store';
import type { Topology, Vec3 } from '@loopkeeper/core/contracts';
import { fitCamera, measureInsets, stageSize, OVERVIEW_VIEW, overviewBoxes, siteModel, useDashView, useMapCamera, useView, type CamGoal, type Road } from '@loopkeeper/scene';
import { useUi } from './store';

/**
 * Camera presets shared by Dashboard and Map. Pure view changes: nothing here sends a command.
 * Every goal comes from fitCamera() with the MEASURED panel insets, so a preset never tucks the building under a panel.
 */
export type PresetId = 'topdown' | 'iso' | 'cooling' | 'road' | 'robot' | 'fit';

interface PresetState {
  id: PresetId;
  /** manifest road id for the 'road' preset (ROAD-01..04) */
  road: string | null;
  set(id: PresetId, road?: string | null): void;
}
export const usePreset = create<PresetState>()((set) => ({ id: 'fit', road: null, set: (id, road = null) => set({ id, road }) }));

export const PRESET_LABEL: Record<Exclude<PresetId, 'road'>, { label: string; hint: string }> = {
  topdown: { label: 'Top-down planner', hint: 'Straight-down plan of all five rows, four roads, cross-aisles and the CDU bay' },
  iso: { label: 'Isometric overview', hint: '3/4 view of the whole facility' },
  cooling: { label: 'Cooling cutaway', hint: 'Fade walls, floor and servers; the TCS/FWS pipes stay solid' },
  robot: { label: 'Selected robot', hint: 'Follow the selected robot' },
  fit: { label: 'Fit facility', hint: 'Frame the whole hall in the free area between the panels' },
};

const common = () => ({ ...stageSize(), insets: measureInsets(), fov: OVERVIEW_VIEW.fov });

export function roadBox(r: Road, wallH = 3.3): { min: Vec3; max: Vec3 } {
  return { min: [r.x0 - 1, 0, r.z0 - 2.2], max: [r.x1 + 1, wallH, r.z1 + 2.2] };
}

export function goalFor(p: PresetId, topo: Topology, road?: string | null): CamGoal {
  const boxes = overviewBoxes(topo);
  switch (p) {
    case 'topdown':
      return fitCamera({ ...common(), boxes, azimuth: 0, elevation: 1.5, fill: OVERVIEW_VIEW.fill });
    case 'iso':
      return fitCamera({ ...common(), boxes, azimuth: 0.7, elevation: 0.62, fill: OVERVIEW_VIEW.fill });
    case 'cooling':
      return fitCamera({ ...common(), boxes, azimuth: 0.35, elevation: 0.95, fill: OVERVIEW_VIEW.fill });
    case 'road': {
      const r = siteModel(topo).roads.find((x) => (x.roadId ?? x.id) === road) ?? siteModel(topo).roads[0];
      return r ? fitCamera({ ...common(), boxes: [roadBox(r)], azimuth: 0.3, elevation: 0.95, fill: 0.9 }) : goalFor('fit', topo);
    }
    default:
      return fitCamera({ ...common(), boxes, ...OVERVIEW_VIEW });
  }
}

/** Layer side effects of a preset (walls/roof off, x-ray + 'loops' filter only for the cooling cutaway). */
function applyLayers(p: PresetId, road: string | null) {
  const v = useView.getState();
  v.setLayer('roof', false);
  v.setLayer('walls', false);
  const cutaway = p === 'cooling';
  if (v.xray !== cutaway) v.toggleXray();
  const dv = useDashView.getState();
  if (cutaway) dv.setFilter('loops');
  else if (dv.filter === 'loops') dv.setFilter('overview');
  if (p === 'topdown' || p === 'road') {
    v.setLayer('roads', true);
    v.setLayer('rows', true);
  }
  v.setRoadFocus(null);
  if (p === 'road' && road) {
    const topo = useWorld.getState().topology;
    const r = topo ? siteModel(topo).roads.find((x) => (x.roadId ?? x.id) === road) : undefined;
    v.setRoadFocus(r?.id ?? null);
  }
}

/** Apply a preset in whichever tab is on screen. */
export function applyPreset(p: PresetId, road: string | null = null) {
  const topo = useWorld.getState().topology;
  if (!topo) return;
  const tab = useUi.getState().tab;
  const v = useView.getState();
  const mc = useMapCamera.getState();
  usePreset.getState().set(p, road);
  if (p === 'robot') {
    const id = tab === 'map' ? mc.selectedRobotId : v.selectedId && useWorld.getState().robots[v.selectedId] ? v.selectedId : mc.selectedRobotId;
    if (!id || !useWorld.getState().robots[id]) {
      v.say('Select a robot first (fleet list or click one in the scene).', 'warn');
      return;
    }
    if (v.selectedId !== id) v.select(id);
    if (tab === 'map') mc.setThirdPersonMode('chase');
    else v.follow(id);
    return;
  }
  // the preset frames the facility / a road: drop a non-robot selection FIRST (clearing it triggers a refit that this goal then replaces)
  if (p !== 'road' && v.selectedId && !useWorld.getState().robots[v.selectedId]) v.select(null);
  usePreset.getState().set(p, road);
  applyLayers(p, road);
  v.follow(null);
  if (mc.cameraMode !== 'tactical' && tab === 'map') mc.setCameraMode('tactical');
  const goal = goalFor(p, topo, road);
  if (tab === 'map') mc.setTactical(p === 'fit' ? null : goal);
  else v.setCam(goal);
}

/** Re-solve the active preset's camera after the window or the panels changed size (does not touch layers). */
export function refitActivePreset() {
  const topo = useWorld.getState().topology;
  if (!topo) return;
  const { id, road } = usePreset.getState();
  if (id === 'robot') return;
  const tab = useUi.getState().tab;
  const goal = goalFor(id, topo, road);
  if (tab === 'map') useMapCamera.getState().setTactical(id === 'fit' ? null : goal);
  else useView.getState().setCam(goal);
}

/** A tab opened: back to the 'fit facility' preset (layers too), keeping whatever is selected (selection is shared across tabs). */
export function resetPreset() {
  usePreset.getState().set('fit');
  applyLayers('fit', null);
}
