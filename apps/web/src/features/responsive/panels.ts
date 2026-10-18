import { create } from 'zustand';
import { useCommunications } from '../communications/communicationStore';
import { useDod } from '../dod/store';

/**
 * One registry for the four side panels (Communications, Definition of Done, Team, Scorecard). Each keeps its own store
 * (ingestion, polling, filters, scroll position and run context never live in a host component), this file only answers
 * "which one is showing" and enforces ONE visible panel at a time so hosts (dock, drawer, sheet) never stack overlays.
 */
export type PanelKey = 'comms' | 'dod' | 'team' | 'scorecard';
export const PANELS: Array<{ key: PanelKey; label: string; title: string }> = [
  { key: 'comms', label: 'Comms', title: 'Communications' },
  { key: 'dod', label: 'Done', title: 'Definition of Done' },
  { key: 'team', label: 'Team', title: 'Team' },
  { key: 'scorecard', label: 'Scorecard', title: 'Evaluation scorecard' },
];

export const useScorecardOpen = create<{ on: boolean; set(v: boolean): void }>()((set) => ({ on: false, set: (on) => set({ on }) }));
/** which tab the host shows when more than one was requested; resolved against what is actually open */
export const usePanelFocus = create<{ focus: PanelKey | null; set(k: PanelKey | null): void }>()((set) => ({ focus: null, set: (focus) => set({ focus }) }));

export function openState(): Record<PanelKey, boolean> {
  return { comms: useCommunications.getState().open, dod: useDod.getState().showDod, team: useDod.getState().showTeam, scorecard: useScorecardOpen.getState().on };
}

function write(k: PanelKey, v: boolean, focus = false) {
  if (k === 'comms') useCommunications.getState().setOpen(v, focus && v);
  else if (k === 'dod') useDod.getState().setShow('showDod', v);
  else if (k === 'team') useDod.getState().setShow('showTeam', v);
  else useScorecardOpen.getState().set(v);
}

let busy = false;
/** who opened each panel, so closing it (Escape, X, the chip again) puts keyboard focus back where the reader was */
const openers: Partial<Record<PanelKey, HTMLElement>> = {};
const visibleLauncher = (k: PanelKey) =>
  [...document.querySelectorAll<HTMLElement>(k === 'comms' ? 'button.cm-launcher' : `.chip--panel[data-panel="${k}"], .mtabs__panels`)].find((b) => b.offsetParent !== null);
export function restorePanelFocus(k: PanelKey) {
  if (typeof document === 'undefined') return;
  const o = openers[k];
  const el = o && o.isConnected && o.offsetParent !== null ? o : visibleLauncher(k);
  delete openers[k];
  requestAnimationFrame(() => el?.focus({ preventScroll: true }));
}
const remember = (k: PanelKey, el?: HTMLElement | null) => {
  if (typeof document === 'undefined') return;
  const a = el ?? (document.activeElement as HTMLElement | null);
  if (a && a !== document.body && !a.closest('.phost, .sheet') && !openers[k]) openers[k] = a;
};

/** show one panel (closing the others) */
export function openPanel(k: PanelKey, focus = false, opener?: HTMLElement | null) {
  remember(k, opener);
  busy = true;
  try {
    for (const p of PANELS) if (p.key !== k && openState()[p.key]) write(p.key, false);
    usePanelFocus.getState().set(k);
    write(k, true, focus);
  } finally {
    busy = false;
    prev = openState();
  }
}
export function closePanel(k: PanelKey, restore = true) {
  const wasOpen = openState()[k];
  busy = true;
  write(k, false);
  busy = false;
  prev = openState();
  const rest = PANELS.find((p) => openState()[p.key]);
  usePanelFocus.getState().set(rest?.key ?? null);
  if (wasOpen && restore && !rest) restorePanelFocus(k);
}
export function togglePanel(k: PanelKey, focus = false, opener?: HTMLElement | null) {
  if (openState()[k]) closePanel(k);
  else openPanel(k, focus, opener);
}

/** the panel the host shows: the focused one if it is open, else the first open one */
export function resolveActive(open: Record<PanelKey, boolean>, focus: PanelKey | null): PanelKey | null {
  if (focus && open[focus]) return focus;
  return PANELS.find((p) => open[p.key])?.key ?? null;
}

// Anything may set a store flag directly (an evidence link opening Communications, a persisted flag at start-up): the newest request wins.
let prev = openState();
function reconcile() {
  if (busy) return;
  const now = openState();
  const opened = PANELS.filter((p) => now[p.key] && !prev[p.key]).map((p) => p.key);
  const visible = PANELS.filter((p) => now[p.key]).map((p) => p.key);
  prev = now;
  if (visible.length < 2) {
    if (opened[0]) usePanelFocus.getState().set(opened[0]);
    return;
  }
  const keep = opened[opened.length - 1] ?? usePanelFocus.getState().focus ?? visible[0];
  const k = visible.includes(keep) ? keep : visible[0];
  openPanel(k);
  prev = openState();
}
useCommunications.subscribe(reconcile);
useDod.subscribe(reconcile);
useScorecardOpen.subscribe(reconcile);
reconcile();

export function usePanelOpen(): Record<PanelKey, boolean> {
  const comms = useCommunications((s) => s.open);
  const dod = useDod((s) => s.showDod);
  const team = useDod((s) => s.showTeam);
  const scorecard = useScorecardOpen((s) => s.on);
  return { comms, dod, team, scorecard };
}
export function useActivePanel(): PanelKey | null {
  const open = usePanelOpen();
  const focus = usePanelFocus((s) => s.focus);
  return resolveActive(open, focus);
}
