import { useEffect } from 'react';
import { useMapCamera, useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { useUi } from '../ui/store';
import { AgentsTab } from './agents/AgentsTab';
import { DashboardTab } from './dashboard/DashboardTab';
import { ExecutionTab } from './execution/ExecutionTab';
import { MapTab } from './map/MapTab';
import { flyTo } from '../ui/EntityIds';
import { refitActivePreset } from '../ui/presets';

/**
 * Mounts exactly one tab's overlays over the shared 3D stage. The 3D scene itself is persistent;
 * switching tabs only changes the scene's view mode and the overlay set.
 * (Scene modes: 'facility' = tactical/overview, 'pipe' = robot cockpit, 'agents' = dimmed facility behind the graph.)
 */
/** One selection for every tab: the view store's `selectedId` is the truth; the Map tab's robot camera follows it (and feeds it back). */
function useSelectionSync() {
  useEffect(() => {
    const offView = useView.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return;
      const w = useWorld.getState();
      const mc = useMapCamera.getState();
      const id = s.selectedId;
      const robot = id ? w.robots[id] : undefined;
      if (robot) {
        if (mc.selectedRobotId !== robot.id) mc.selectRobot(robot.id, robot.class);
      } else if (mc.selectedRobotId && mc.cameraMode === 'tactical') mc.clearRobot();
    });
    const offMc = useMapCamera.subscribe((s, prev) => {
      if (s.selectedRobotId === prev.selectedRobotId || !s.selectedRobotId) return;
      if (useView.getState().selectedId !== s.selectedRobotId) useView.getState().select(s.selectedRobotId);
    });
    return () => {
      offView();
      offMc();
    };
  }, []);
}

/** Clicking a rack, row, road, pipe, robot or equipment flies the camera to its bounds; clearing the selection returns to the fitted overview. */
function useFlyOnSelect() {
  useEffect(() => {
    let prev: string | null = useView.getState().selectedId;
    return useView.subscribe((s) => {
      const id = s.selectedId;
      if (id === prev) return;
      const was = prev;
      prev = id;
      const tab = useUi.getState().tab;
      if (tab !== 'dashboard' && tab !== 'map') return;
      const mc = useMapCamera.getState();
      // a robot chase / POV camera owns the view while it is active
      if (tab === 'map' && mc.cameraMode !== 'tactical') return;
      if (id) {
        // wait one layout pass: the details drawer opens on selection and must be part of the safe area the camera fits into
        setTimeout(() => {
          if (useView.getState().selectedId === id) flyTo(id);
        }, 90);
      } else if (was) refitActivePreset();
    });
  }, []);
}

export function TabHost() {
  useSelectionSync();
  useFlyOnSelect();
  const tab = useUi((s) => s.tab);
  const setMode = useView((s) => s.setMode);
  useEffect(() => {
    const v = useView.getState();
    if (tab === 'agents') setMode('agents');
    else if (tab === 'map') {
      if (v.mode === 'agents') setMode('facility'); // keep 'pipe' if returning to a cockpit
    } else if (v.mode !== 'facility') {
      if (v.mode === 'pipe') v.exitPipe();
      setMode('facility');
    }
  }, [tab, setMode]);
  switch (tab) {
    case 'dashboard':
      return <DashboardTab />;
    case 'map':
      return <MapTab />;
    case 'agents':
      return <AgentsTab />;
    case 'execution':
      return <ExecutionTab />;
  }
}
