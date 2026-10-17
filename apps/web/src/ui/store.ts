import { create } from 'zustand';
import { useWorld } from '@loopkeeper/core/store';
import type { TabId } from '../tabs/types';

export type PanelId = 'layers' | 'fleet' | 'incidents' | null;

interface UiState {
  tab: TabId;
  setTab(t: TabId): void;
  panel: PanelId;
  palette: boolean;
  launcher: boolean;
  drawer: boolean;
  /** incident pinned in the card; null = auto (most severe open) */
  pinned: string | null;
  incidentCollapsed: boolean;
  /** agent mode: selected task */
  taskId: string | null;
  setPanel(p: PanelId): void;
  togglePanel(p: Exclude<PanelId, null>): void;
  setPalette(v: boolean): void;
  setLauncher(v: boolean): void;
  setDrawer(v: boolean): void;
  pin(id: string | null): void;
  setCollapsed(v: boolean): void;
  setTask(id: string | null): void;
}

export const useUi = create<UiState>()((set) => ({
  tab: 'dashboard',
  setTab: (tab) => set({ tab }),
  panel: null,
  palette: false,
  launcher: false,
  drawer: false,
  pinned: null,
  incidentCollapsed: false,
  taskId: null,
  setPanel: (panel) => set({ panel }),
  togglePanel(p) { set((s) => ({ panel: s.panel === p ? null : p })); },
  setPalette: (palette) => set({ palette }),
  setLauncher: (launcher) => set({ launcher }),
  setDrawer: (drawer) => set({ drawer }),
  pin: (pinned) => set({ pinned, incidentCollapsed: false }),
  setCollapsed: (incidentCollapsed) => set({ incidentCollapsed }),
  setTask: (taskId) => set({ taskId }),
}));

const SEV = { critical: 3, warning: 2, watch: 1, nominal: 0 } as const;

/** The incident the card shows: the pinned one, else the most severe open one, else the latest closed (briefly). */
export function usePinnedIncident() {
  const pinned = useUi((s) => s.pinned);
  return useWorld((s) => {
    if (pinned && s.incidents[pinned]) return s.incidents[pinned];
    const open = Object.values(s.incidents).filter((i) => !i.closed_tick);
    if (!open.length) return undefined;
    return open.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.opened_tick - a.opened_tick)[0];
  });
}
