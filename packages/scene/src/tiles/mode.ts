import { create } from 'zustand';
import type { QualityTier } from '../view';

/**
 * Tile streaming switch.
 *
 *  off   never fetch a manifest; the procedural facility is the only static scene (the kill switch)
 *  auto  DEFAULT. Tiles stream and replace the procedural static scene only where measurement says it pays:
 *        the Performance tier (tier 'low', which Auto picks when the frame budget is overrun) or a software rasteriser.
 *        On High/Balanced with a hardware GPU the procedural hall (flow shader, hall furniture, equipment detail) stays:
 *        server tiles are geometry-only and visibly plainer (see artifacts/benchmarks/v12_tiles.json).
 *  on    always stream; tiles replace the procedural static scene as soon as LOD0 is resident
 *
 * Source of truth, strongest first: `?tiles=0|off|1|on|auto` in the URL, `localStorage lk.tiles`, DEFAULT_TILE_MODE.
 * In every mode the procedural facility is the LOD0 fallback: it is drawn until LOD0 of the manifest is resident and again whenever the
 * manifest/tile path fails (offline, 404, topology mismatch, decode failure of LOD0).
 */
export type TileMode = 'off' | 'auto' | 'on';
export const DEFAULT_TILE_MODE: TileMode = 'auto';

export function parseTileMode(v: string | null | undefined): TileMode | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 'off';
  if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return 'on';
  if (s === 'auto') return 'auto';
  return null;
}

/** `search` = location.search, `stored` = localStorage lk.tiles; URL wins, then storage, then the default */
export function readTileMode(search: string, stored: string | null | undefined): TileMode {
  return parseTileMode(new URLSearchParams(search).get('tiles')) ?? parseTileMode(stored) ?? DEFAULT_TILE_MODE;
}

function initial(): TileMode {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('lk.tiles') : null;
    return readTileMode(typeof location !== 'undefined' ? location.search : '', stored);
  } catch {
    return DEFAULT_TILE_MODE;
  }
}

export interface TileModeState {
  mode: TileMode;
  setMode(m: TileMode): void;
}

/** Operators (and the benchmark harness) can flip the mode at run time; the scene mounts/unmounts the tile layer reactively. */
export const useTileMode = create<TileModeState>((set) => ({
  mode: initial(),
  setMode: (mode) => {
    try {
      localStorage.setItem('lk.tiles', mode);
    } catch {
      /* private mode: the in-memory value still applies */
    }
    set({ mode });
  },
}));

/** should the tile layer be streaming right now */
export function tilesWanted(mode: TileMode, tier: QualityTier, softwareGl: boolean): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return tier === 'low' || softwareGl;
}

/** unmasked renderer string looks like a CPU rasteriser (SwiftShader / llvmpipe / WARP) */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic|warp/i.test(renderer);
}

/** `tilesRequested` kept for existing imports: true when the URL/storage did not switch tiles off */
export const tilesRequested = initial() !== 'off';

// measurement / verification hook, only when the page was opened with ?bench / ?probe
try {
  if (typeof window !== 'undefined' && /[?&](probe|bench)\b/.test(location.search)) (window as unknown as { __lkTileMode: typeof useTileMode }).__lkTileMode = useTileMode;
} catch {
  /* no window / location: nothing to expose */
}
