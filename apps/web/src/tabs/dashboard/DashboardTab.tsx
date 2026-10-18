import { useEffect } from 'react';
import { Eye } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { useDashView, useView } from '@loopkeeper/scene';
import { usePinnedIncident } from '../../ui/store';
import { useExec } from '../execution/state';
import { useRunsPolling } from '../execution/controller';
import { AssetDrawer } from './AssetDrawer';
import { HealthStrip } from './HealthStrip';
import { useDashHide, type DashPanel } from './hide';
import { RightDock } from './RightDock';
import { SceneBar } from './SceneBar';
import { useDashPolling, useDashRunId } from './summaryStore';
import { useOverviewFit } from './useOverviewFit';
import './dashboard.css';
import { Button } from '../../ui/kit/index';

/** Runs are polled by Execution and the panel host; the summary needs the live run id when the Dashboard is the first tab opened. */
function RunsFeed() {
  useRunsPolling();
  return null;
}

const REOPEN: Record<DashPanel, { label: string; cls: string }> = {
  health: { label: 'Show cooling health', cls: 'dash-reopen--health' },
  dock: { label: 'Show summary', cls: 'dash-reopen--dock' },
  scene: { label: 'Show view controls', cls: 'dash-reopen--scene' },
};

/** A hidden panel leaves one small chip where it was, so reopening is always one tap away. */
function Reopen({ k, onOpen }: { k: DashPanel; onOpen(): void }) {
  return (
    <Button size="sm" variant="secondary" className={`dash-reopen ${REOPEN[k].cls}`} icon={<Eye size={13} />} onClick={onOpen}>
      {REOPEN[k].label}
    </Button>
  );
}

/**
 * Dashboard tab: the facility is the page. Three small overlays (health strip, operations dock, scene bar) and
 * one contextual drawer that only exists while something is selected. Everything is read-only; actions that
 * change the plant live in Map, Agents and Execution.
 */
export function DashboardTab() {
  useOverviewFit();
  const hide = useDashHide();
  const runsLoaded = useExec((s) => s.runsLoaded);
  const runId = useDashRunId();
  const inc = usePinnedIncident();
  useDashPolling(runId, inc && !inc.closed_tick ? inc.id : null);
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
      {!runsLoaded && <RunsFeed />}
      {hide.hidden.health ? <Reopen k="health" onOpen={() => hide.set('health', false)} /> : <HealthStrip onHide={() => hide.set('health', true)} />}
      {hide.hidden.dock ? <Reopen k="dock" onOpen={() => hide.set('dock', false)} /> : <RightDock onHide={() => hide.set('dock', true)} />}
      <AssetDrawer />
      {hide.hidden.scene ? <Reopen k="scene" onOpen={() => hide.set('scene', false)} /> : <SceneBar onFit={() => useView.getState().select(null)} onHide={() => hide.set('scene', true)} />}
    </div>
  );
}
