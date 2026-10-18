import React, { useState, useEffect } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { Button, IconButton, Panel, SegmentedControl, ErrorState, EmptyState, LoadingSkeleton } from '../../ui/kit/index';
import { ScenarioCard } from './ScenarioCard';
import { ScenarioLaunch } from './ScenarioLaunch';
import { useExecutionPanels } from './ExecutionPanelsStore';
import { useExec } from './state';
import { apiFetch } from './api';
import { ScenarioComposer } from './ScenarioComposer';
import { useScenarioLive } from './scenarioLive';
import { buildSpec, classify, isTerminal } from './scenarioSpec';

export function ScenarioLibrary() {
  const [filter, setFilter] = useState<'ALL' | 'SEVERE' | 'MODERATE'>('ALL');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const setPanel = useExecutionPanels((s) => s.setPanel);
  const setActiveView = useExecutionPanels((s) => s.setActiveView);
  const say = useExec((s) => s.say);

  const defs = useScenarioLive((s) => s.defs);
  const load = useScenarioLive((s) => s.defsLoad);
  const loadError = useScenarioLive((s) => s.defsError);
  const topo = useScenarioLive((s) => s.topo);
  const topoError = useScenarioLive((s) => s.topoError);
  const validations = useScenarioLive((s) => s.validations);
  const plans = useScenarioLive((s) => s.plans);
  const hazardNotes = useScenarioLive((s) => s.hazardNotes);
  const verdicts = useScenarioLive((s) => s.verdicts);
  const openId = useScenarioLive((s) => s.openId);
  const launch = useScenarioLive((s) => s.launch);
  const loadCatalog = useScenarioLive((s) => s.loadCatalog);
  const open = useScenarioLive((s) => s.open);

  useEffect(() => {
    if (load === 'idle') void loadCatalog();
  }, [load, loadCatalog]);

  const busy = !!launch && (launch.submitting || (!!launch.view && !isTerminal(launch.view.status)));

  // "recorded episode" path (older V8 flow): a replay to scrub, separate from the live launch
  const handleRecord = async (scenarioId: string, speed: number) => {
    setRecordingId(scenarioId);
    say('info', `Generating 30:00 recorded episode for ${scenarioId}...`);
    const sc = defs.find((s) => s.scenario_id === scenarioId);
    try {
      const res = await apiFetch('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: scenarioId,
          seed: sc?.seed ?? 12002,
          duration_sim_s: 1800,
          simulation_speed: speed,
          mode: 'LIVE',
          idempotency_key: `v8-exec-${scenarioId}-${Date.now()}`,
        }),
      });
      if (!res.ok) {
        say('warning', `Failed to record episode: HTTP ${res.status} ${await res.text()}`);
        return;
      }
      const run = await res.json();
      say('ok', `Episode ${run.run_id} ready (30:00 horizon, outcome: ${run.meta?.verdict?.outcome ?? 'not reported'}).`);
      useExec.getState().select(run.run_id);
      useExec.getState().setMode('replay');
      setActiveView('player');
      setPanel('scenarioLibrary', false);
      setPanel('runsPanel', true);
      setPanel('timelinePanel', true);
      setPanel('runInspector', true); // on a phone the last one wins: Run Details
    } catch (e: any) {
      say('warning', `Episode record error: ${e.message || String(e)}`);
    } finally {
      setRecordingId(null);
    }
  };

  const severe = defs.filter((s) => s.severity === 'SEVERE').length;
  const moderate = defs.filter((s) => s.severity === 'MODERATE').length;
  const filtered = defs.filter((s) => filter === 'ALL' || s.severity === filter);
  const tally = { live: 0, partial: 0, unsupported: 0 };
  for (const d of defs) tally[classify(d, topo, validations[d.scenario_id]?.view ?? null, verdicts[d.scenario_id], plans[d.scenario_id]).state]++;
  const openDef = defs.find((d) => d.scenario_id === openId) ?? null;

  const sub =
    load === 'ready' && defs.length > 0
      ? `${tally.live} live · ${tally.partial} partial · ${tally.unsupported} unsupported, as reported by this backend`
      : load === 'loading'
        ? 'Loading the scenario catalog from the backend...'
        : 'Catalog comes from the backend only';

  return (
    <Panel
      panelId="scenario-library"
      className="ex-library sl-lib"
      surface="solid"
      icon={<Layers size={16} />}
      title={`Scenario Library: ${defs.length ? `${defs.length} incidents` : 'incidents'}`}
      subtitle={sub}
      flush
      scroll
      onClose={() => setPanel('scenarioLibrary', false)}
      closeLabel="Close Library (Esc)"
      actions={
        <>
          <SegmentedControl
            label="Severity filter"
            size="sm"
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'ALL', label: `All (${defs.length})` },
              { id: 'SEVERE', label: `Severe (${severe})` },
              { id: 'MODERATE', label: `Moderate (${moderate})` },
            ]}
          />
          <IconButton aria-label="Reload the catalog" size="sm" icon={<RefreshCw size={15} className={load === 'loading' ? 'spin' : undefined} />} onClick={() => void loadCatalog()} />
        </>
      }
    >
      <div className="sl-composer">
        <ScenarioComposer
          compact
          onCompleted={() => {
            setPanel('scenarioLibrary', false);
            setPanel('runsPanel', true);
            setPanel('timelinePanel', true);
            setPanel('runInspector', true); // on a phone the last one wins: Run Details
          }}
        />
      </div>

      <div className="sl-grid">
        {load === 'error' && (
          <div className="sl-wide" data-testid="catalog-error">
            <ErrorState title="Scenario catalog unavailable" detail={loadError ?? undefined} onRetry={() => void loadCatalog()} retryLabel="Retry">
              GET /scenarios failed. No scenarios are shown because none are made up locally.
            </ErrorState>
          </div>
        )}
        {load === 'ready' && defs.length === 0 && (
          <div className="sl-wide">
            <EmptyState title="No scenarios reported">{loadError ?? 'GET /scenarios returned no entries.'}</EmptyState>
          </div>
        )}
        {(load === 'idle' || load === 'loading') && defs.length === 0 && <div className="sl-wide"><LoadingSkeleton lines={4} label="Loading scenarios" /></div>}
        {load === 'ready' && topoError && <p className="sl-wide sl-note sl-note--warn" role="status">Topology unavailable ({topoError}): targets cannot be resolved, so asset checks are skipped.</p>}
        {filtered.map((sc) => (
          <ScenarioCard
            key={sc.scenario_id}
            data={sc}
            topo={topo}
            validator={validations[sc.scenario_id]?.view ?? null}
            spec={plans[sc.scenario_id] ?? buildSpec(sc, topo)}
            hazardNotes={hazardNotes[sc.scenario_id]}
            verdict={verdicts[sc.scenario_id]}
            busy={busy && launch?.scenarioId !== sc.scenario_id}
            recording={recordingId === sc.scenario_id}
            onOpen={open}
            onRecord={handleRecord}
          />
        ))}
      </div>

      {openDef && <ScenarioLaunch def={openDef} onClose={() => open(null)} />}
    </Panel>
  );
}
