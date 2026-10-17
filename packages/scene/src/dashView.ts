import { create } from 'zustand';
import { C, mix } from './theme';

/** View-only scene filters used by the Dashboard tab. They only change how the scene is drawn. */
export type SceneFilter = 'overview' | 'loops' | 'robots' | 'thermal' | 'pressure';
export const SCENE_FILTERS: SceneFilter[] = ['overview', 'loops', 'robots', 'thermal', 'pressure'];

export interface Structure {
  /** server hall: racks, aisle containment, cable trays, lighting */
  hall: boolean;
  /** cooling plant: CDU, pump skids, strainers, dry cooler */
  plant: boolean;
}

interface DashViewState {
  filter: SceneFilter;
  structure: Structure;
  setFilter(f: SceneFilter): void;
  setStructure(k: keyof Structure, v: boolean): void;
  reset(): void;
}

export const useDashView = create<DashViewState>()((set) => ({
  filter: 'overview',
  structure: { hall: true, plant: true },
  setFilter: (filter) => set({ filter }),
  setStructure: (k, v) => set((s) => ({ structure: { ...s.structure, [k]: v } })),
  reset: () => set({ filter: 'overview', structure: { hall: true, plant: true } }),
}));

/** numeric filter id for shaders: 0 overview, 1 loops, 2 robots, 3 thermal, 4 pressure */
export const filterIndex = (f: SceneFilter) => SCENE_FILTERS.indexOf(f);

/** pressure view: ΔP across a segment (kPa) → colour; the legend in the Dashboard uses the same scale */
export const PRESSURE_MAX_KPA = 14;
export function pressureColor(dpKpa: number): string {
  const t = Math.min(Math.max(dpKpa / PRESSURE_MAX_KPA, 0), 1);
  return t < 0.5 ? mix(C.tcsSupply, C.watch, t * 2) : mix(C.watch, C.critical, (t - 0.5) * 2);
}
