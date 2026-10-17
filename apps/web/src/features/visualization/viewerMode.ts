import { create } from 'zustand';
import { useView } from '@loopkeeper/scene';
import { detectCapabilities, REMOTE_RENDERER, type Capabilities } from './capability';

/**
 * Viewer mode policy. mode != layout != decoder resolution != network quality: this only chooses WHAT draws the spatial view.
 *  AUTO            pick from capability checks + measured frame time (default)
 *  STREAMED_VIDEO  server-rendered video; only offered when a real remote renderer exists (none today)
 *  LOCAL_3D        full-quality local WebGL (desktop default)
 *  LOCAL_LITE_3D   local WebGL at the performance tier (touch / small / low-memory devices)
 *  TACTICAL_2D     canvas plan view from /topology + live poses; every command stays available
 * Switching never touches run, selection or camera state: those live in their own stores.
 */
export type ViewerMode = 'AUTO' | 'STREAMED_VIDEO' | 'LOCAL_3D' | 'LOCAL_LITE_3D' | 'TACTICAL_2D';
export type EffectiveMode = Exclude<ViewerMode, 'AUTO' | 'STREAMED_VIDEO'>;
export const VIEWER_MODES: ViewerMode[] = ['AUTO', 'LOCAL_3D', 'LOCAL_LITE_3D', 'TACTICAL_2D', 'STREAMED_VIDEO'];
export const MODE_LABEL: Record<ViewerMode, string> = { AUTO: 'Auto', STREAMED_VIDEO: 'Streamed video', LOCAL_3D: '3D', LOCAL_LITE_3D: 'Lite 3D', TACTICAL_2D: 'Tactical 2D' };
const KEY = 'lk.viewer.mode';
const URL_MAP: Record<string, ViewerMode> = { auto: 'AUTO', '3d': 'LOCAL_3D', lite: 'LOCAL_LITE_3D', '2d': 'TACTICAL_2D' };

function readPreference(): ViewerMode {
  try {
    const q = new URLSearchParams(location.search).get('viewer')?.toLowerCase();
    if (q && URL_MAP[q]) return URL_MAP[q]; // explicit link/test override; deliberately not persisted
    const v = localStorage.getItem(KEY) as ViewerMode | null;
    if (v && VIEWER_MODES.includes(v) && v !== 'STREAMED_VIDEO') return v;
  } catch {
    /* private mode */
  }
  return 'AUTO';
}

/** Pure policy: what AUTO resolves to for these capabilities. */
export function resolveAuto(c: Capabilities): { mode: EffectiveMode; reason: string } {
  if (c.webgl === 'none') return { mode: 'TACTICAL_2D', reason: 'This browser cannot create a WebGL context.' };
  if (c.webgl === 'software') return { mode: 'LOCAL_LITE_3D', reason: 'Software WebGL active: 3D rendered at performance tier.' };
  if (c.saveData) return { mode: 'LOCAL_LITE_3D', reason: 'Data saver active: 3D rendered at performance tier.' };
  const small = c.screenMinPx <= 820;
  if (c.coarsePointer || small || (c.deviceMemoryGB !== null && c.deviceMemoryGB <= 4) || (c.cores !== null && c.cores <= 2))
    return { mode: 'LOCAL_LITE_3D', reason: 'Touch / mobile device: 3D rendered at performance tier.' };
  return { mode: 'LOCAL_3D', reason: 'Full 3D.' };
}

interface ViewerModeState {
  preference: ViewerMode;
  effective: EffectiveMode;
  reason: string;
  caps: Capabilities;
  /** a runtime problem that forced 2D (context loss, chunk load error, sustained slow frames); cleared by retry/choosing a mode */
  failure: string | null;
  setPreference(m: ViewerMode): void;
  fail(reason: string): void;
  retry(): void;
}

function compute(pref: ViewerMode, caps: Capabilities, failure: string | null): { effective: EffectiveMode; reason: string } {
  if (failure) return { effective: 'TACTICAL_2D', reason: failure };
  if (pref === 'AUTO' || pref === 'STREAMED_VIDEO') {
    if (pref === 'STREAMED_VIDEO' && !REMOTE_RENDERER.available) {
      const a = resolveAuto(caps);
      return { effective: a.mode, reason: `${REMOTE_RENDERER.reason} ${a.reason}` };
    }
    const a = resolveAuto(caps);
    return { effective: a.mode, reason: a.reason };
  }
  if (pref !== 'TACTICAL_2D' && caps.webgl === 'none') return { effective: 'TACTICAL_2D', reason: 'WebGL is unavailable, showing the 2D plan view instead.' };
  return { effective: pref, reason: pref === 'TACTICAL_2D' ? 'Tactical 2D selected.' : `${MODE_LABEL[pref]} selected.` };
}

export const useViewerMode = create<ViewerModeState>()((set, get) => {
  const caps = detectCapabilities();
  const preference = readPreference();
  return {
    preference,
    caps,
    failure: null,
    ...compute(preference, caps, null),
    setPreference(m) {
      if (m === 'STREAMED_VIDEO' && !REMOTE_RENDERER.available) return;
      try {
        localStorage.setItem(KEY, m);
      } catch {
        /* ignore */
      }
      set({ preference: m, failure: null, ...compute(m, get().caps, null) });
    },
    fail(reason) {
      if (get().failure) return;
      set({ failure: reason, ...compute(get().preference, get().caps, reason) });
    },
    retry() {
      set({ failure: null, ...compute(get().preference === 'TACTICAL_2D' ? 'AUTO' : get().preference, get().caps, null) });
    },
  };
});

/** Lite / performance defaults are applied when the effective mode becomes LOCAL_LITE_3D and the user has not picked a quality preset. */
export function applyModeQuality(mode: EffectiveMode) {
  const v = useView.getState();
  if (mode === 'LOCAL_LITE_3D' && v.qualityPreset === 'auto' && v.quality !== 'low') v.setQuality('low');
}
