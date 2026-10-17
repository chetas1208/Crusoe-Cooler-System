import { create } from 'zustand';

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

export const useExecutionPanels = create<ExecutionPanelsState>()((set) => ({
  scenarioLibrary: true,
  runsPanel: false,
  runInspector: true,
  timelinePanel: true,
  activeView: 'library',
  togglePanel: (name) => set((s) => ({ [name]: !s[name] })),
  setPanel: (name, visible) => set({ [name]: visible }),
  setActiveView: (activeView) => set({ activeView }),
  openAll: () =>
    set({
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
