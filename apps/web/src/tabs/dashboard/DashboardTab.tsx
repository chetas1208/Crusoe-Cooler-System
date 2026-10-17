import { useEffect } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { useDashView, useView } from '@loopkeeper/scene';
import { AssetDrawer } from './AssetDrawer';
import { HealthStrip } from './HealthStrip';
import { RightDock } from './RightDock';
import { SceneBar } from './SceneBar';
import { useOverviewFit } from './useOverviewFit';
import './dashboard.css';

/**
 * Dashboard tab: the facility is the page. Three small overlays (health strip, operations dock, scene bar) and
 * one contextual drawer that only exists while something is selected. Everything is read-only; actions that
 * change the plant live in Map, Agents and Execution.
 */
export function DashboardTab() {
  useOverviewFit();
  const conn = useWorld((s) => (s.connection !== 'live' || s.stale ? 'bad' : 'ok'));

  // this tab owns scene filters and structure toggles only while it is on screen
  useEffect(() => {
    const before = useView.getState().layers;
    useDashView.getState().reset();
    return () => {
      useDashView.getState().reset();
      const now = useView.getState().layers;
      for (const k of ['roof', 'walls', 'technology_cooling', 'facility_water'] as const) if (now[k] !== before[k]) useView.getState().setLayer(k, before[k]);
    };
  }, []);

  return (
    <div className="dash" data-conn={conn}>
      <HealthStrip />
      <RightDock />
      <AssetDrawer />
      <SceneBar onFit={() => useView.getState().select(null)} />
    </div>
  );
}
