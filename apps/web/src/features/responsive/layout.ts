import { useSyncExternalStore } from 'react';

/**
 * Explicit layout model (replaces the old single `(max-width: 860px), (max-height: 480px)` phone query).
 *   phone-portrait  : short side <= 500 px, taller than wide
 *   phone-landscape : short side <= 500 px, wider than tall
 *   tablet          : everything between a phone and a fine-pointer desktop window (touch tablets, small laptops, split windows)
 *   desktop         : >= 1280 x 720 with a fine pointer
 * Derived values drive every host (see `PanelsHost`) and the CSS (`html[data-layout]`, `data-compact`, `data-orient`, `data-comms-host`).
 */
export type LayoutMode = 'phone-portrait' | 'phone-landscape' | 'tablet' | 'desktop';
export type CommsHost = 'dock' | 'drawer' | 'sheet';

export interface LayoutInfo {
  layout: LayoutMode;
  orientation: 'portrait' | 'landscape';
  /** compact chrome: slim top bar + tab bar (phones, and tablets narrower than 861 px, e.g. portrait) */
  compact: boolean;
  /** where side panels (Communications, Done, Team, Scorecard) are hosted */
  host: CommsHost;
  coarse: boolean;
  width: number;
  height: number;
}

export const PHONE_SHORT_SIDE = 500;
export const DESKTOP_MIN = { w: 1280, h: 720 };
export const DOCK_MIN = { w: 900, h: 520 };
export const COMPACT_MAX_W = 860;

export function computeLayout(width: number, height: number, coarse: boolean): LayoutInfo {
  const landscape = width > height;
  const orientation = landscape ? 'landscape' : 'portrait';
  const short = Math.min(width, height);
  let layout: LayoutMode;
  if (short <= PHONE_SHORT_SIDE) layout = landscape ? 'phone-landscape' : 'phone-portrait';
  else if (!coarse && width >= DESKTOP_MIN.w && height >= DESKTOP_MIN.h) layout = 'desktop';
  else layout = 'tablet';
  const compact = layout === 'phone-portrait' || layout === 'phone-landscape' || width <= COMPACT_MAX_W;
  const host: CommsHost = !compact && width >= DOCK_MIN.w && height >= DOCK_MIN.h ? 'dock' : landscape ? 'drawer' : 'sheet';
  return { layout, orientation, compact, host, coarse, width, height };
}

const read = (): LayoutInfo => {
  if (typeof window === 'undefined') return computeLayout(1440, 900, false);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return computeLayout(window.innerWidth, window.innerHeight, coarse);
};

let current: LayoutInfo = read();
const listeners = new Set<() => void>();

function apply(l: LayoutInfo) {
  if (typeof document === 'undefined') return;
  const d = document.documentElement.dataset;
  d.layout = l.layout;
  d.orient = l.orientation;
  d.compact = l.compact ? '1' : '0';
  d.commsHost = l.host;
  d.phone = l.compact ? '1' : '0'; // legacy hook used by older CSS / canvases: "compact chrome"
}
apply(current);

function update() {
  const next = read();
  if (next.layout === current.layout && next.orientation === current.orientation && next.compact === current.compact && next.host === current.host && next.coarse === current.coarse && next.width === current.width && next.height === current.height) return;
  // keep the object identity stable unless a *class* of layout changed, so that plain window resizes do not re-render every consumer
  const classChanged = next.layout !== current.layout || next.orientation !== current.orientation || next.compact !== current.compact || next.host !== current.host || next.coarse !== current.coarse;
  current = classChanged ? next : { ...current, width: next.width, height: next.height };
  apply(current);
  if (classChanged) listeners.forEach((f) => f());
}

let installed = false;
function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  window.visualViewport?.addEventListener('resize', update);
  if (typeof matchMedia === 'function') matchMedia('(pointer: coarse)').addEventListener?.('change', update);
}
install();

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

export function getLayout(): LayoutInfo {
  return current;
}

/** The one source of truth for "which layout am I in". Re-renders only when the layout class changes (not on every pixel of a resize). */
export function useLayoutMode(): LayoutInfo {
  return useSyncExternalStore(subscribe, getLayout, getLayout);
}
