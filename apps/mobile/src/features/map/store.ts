import { create } from 'zustand';

/** Map-tab view state (selection and which surface is shown). Server state stays in the world store. */
interface MapSel {
  selectedId: string | null;
  /** '2d' = tactical map from /topology + poses (works everywhere); '3d' = shared R3F-native scene (native only) */
  view: '2d' | '3d';
  /** control surface semantics: preview = local ghost, nothing sent; live = lease-based control of the robot */
  mode: 'preview' | 'live';
  select(id: string | null): void;
  setView(v: '2d' | '3d'): void;
  setMode(m: 'preview' | 'live'): void;
}

export const useMapSel = create<MapSel>()((set) => ({
  selectedId: null,
  view: '2d',
  mode: 'preview',
  select: (selectedId) => set({ selectedId }),
  setView: (view) => set({ view }),
  setMode: (mode) => set({ mode }),
}));
