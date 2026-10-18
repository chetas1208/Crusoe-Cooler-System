import { create } from 'zustand';
import { getLayout } from '../../features/responsive/layout';

export interface ExecutionPanelsState {
  scenarioLibrary: boolean;
  runsPanel: boolean;
  runInspector: boolean;
  timelinePanel: boolean;
  activeView: 'library' | 'player';
  togglePanel(name: 'scenarioLibrary' | 'runsPanel' | 'runInspector' | 'timelinePanel'): void;
  setPanel(name: 'scenarioLibrary' | 'runsPanel' | 'runInspector' | 'timelinePanel', visible: boolean): void;
  setActiveView(view: 'library' | 'player'): void;
  openAll(): void;
  closeAll(): void;
}

type PanelName = 'scenarioLibrary' | 'runsPanel' | 'runInspector' | 'timelinePanel';
const PANEL_NAMES: PanelName[] = ['scenarioLibrary', 'runsPanel', 'runInspector', 'timelinePanel'];

/** Compact chrome (the layout model, features/responsive/layout.ts): three absolute panels cannot share a 390 px screen, so a phone shows one at a time. */
const onPhone = () => typeof window !== 'undefined' && getLayout().compact;
const only = (name: PanelName) => Object.fromEntries(PANEL_NAMES.map((n) => [n, n === name])) as Record<PanelName, boolean>;

export const useExecutionPanels = create<ExecutionPanelsState>()((set) => ({
  ...(onPhone()
    ? only('scenarioLibrary')
    : { scenarioLibrary: true, runsPanel: false, runInspector: true, timelinePanel: true }),
  activeView: 'library',
  togglePanel: (name) => set((s) => (onPhone() && !s[name] ? only(name) : { [name]: !s[name] })),
  setPanel: (name, visible) => set(onPhone() && visible ? only(name) : { [name]: visible }),
  setActiveView: (activeView) => set({ activeView }),
  openAll: () =>
    set(onPhone() ? only('scenarioLibrary') : {
      scenarioLibrary: true,
      runsPanel: true,
      runInspector: true,
      timelinePanel: true,
    }),
  closeAll: () =>
    set({
      scenarioLibrary: false,
      runsPanel: false,
      runInspector: false,
      timelinePanel: false,
    }),
}));

// Global Esc key handler to close floating panels or toggle all
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const s = useExecutionPanels.getState();
      if (s.scenarioLibrary || s.runsPanel || s.runInspector || s.timelinePanel) {
        useExecutionPanels.getState().closeAll();
      } else if (s.activeView === 'player') {
        useExecutionPanels.setState({
          scenarioLibrary: false,
          runsPanel: true,
          runInspector: true,
          timelinePanel: true,
        });
      } else {
        useExecutionPanels.getState().openAll();
      }
    }
  });
}
