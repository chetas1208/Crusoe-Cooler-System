import React from 'react';
import { Play, RefreshCw, CheckCircle2, XCircle, Circle, ExternalLink } from 'lucide-react';
import { Badge, Button, Dialog, ErrorState } from '../../ui/kit/index';
import { useScenarioLive } from './scenarioLive';
import { TONE } from './ScenarioCard';
import { useExec } from './state';
import { useExecutionPanels } from './ExecutionPanelsStore';
import { useDod } from '../../features/dod/store';
import { useCommunications } from '../../features/communications/communicationStore';
import { buildSpec, chainOf, classify, compareToSpec, isTerminal, promptFor, toWireSpec, type Definition } from './scenarioSpec';

const ms = (v?: number) => (v === undefined ? null : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** Preview of the typed ScenarioSpec, Start, and the live result chain for one library scenario. */
export function ScenarioLaunch({ def, onClose }: { def: Definition; onClose(): void }) {
  const topo = useScenarioLive((s) => s.topo);
  const validation = useScenarioLive((s) => s.validations[def.scenario_id]);
  const plan = useScenarioLive((s) => s.plans[def.scenario_id]);
  const hazardNotes = useScenarioLive((s) => s.hazardNotes[def.scenario_id]);
  const verdict = useScenarioLive((s) => s.verdicts[def.scenario_id]);
  const launch = useScenarioLive((s) => (s.launch?.scenarioId === def.scenario_id ? s.launch : null));
  const anyLaunch = useScenarioLive((s) => s.launch);
  const start = useScenarioLive((s) => s.start);
  const dismissLaunch = useScenarioLive((s) => s.dismissLaunch);
  const setPanel = useExecutionPanels((s) => s.setPanel);

  const spec = plan ?? buildSpec(def, topo);
  const direct = spec.mode === 'hazard';
  const sup = classify(def, topo, validation?.view ?? null, verdict, spec);
  // the left column explains the pre-launch verdict only; what the live path said is on the right
  const pre = classify(def, topo, validation?.view ?? null, undefined, spec);
  const view = launch?.view ?? null;
  const inFlight = !!anyLaunch && (anyLaunch.submitting || (!!anyLaunch.view && !isTerminal(anyLaunch.view.status)));
  const blocked = sup.state === 'unsupported' && !verdict;
  const cmp = view ? compareToSpec(spec, view) : null;
  const terminalBad = view && isTerminal(view.status) && view.status !== 'READY';
  // every refusal the backend listed, minus the ones the banner above already quotes
  const banner = terminalBad && view ? `${view.errorCode ?? ''} ${view.errorMessage ?? ''}` : '';
  const extraReasons = view
    ? [
        ...view.unsupported.map((u) => ({ text: `unsupported${u.family ? ` ${u.family}` : ''}: ${u.reason}`, key: u.reason })),
        ...view.rejected.map((r) => ({ text: `${r.code}${r.family ? ` ${r.family}` : ''}${r.query ? ` (${r.query})` : ''}: ${r.reason}`, key: r.reason })),
      ].filter((x) => !banner.includes(x.key)).map((x) => x.text)
    : [];

  const openRun = () => {
    if (!view?.runId) return;
    useExec.getState().setMode('live');
    useExec.getState().select(view.runId);
    setPanel('scenarioLibrary', false);
    setPanel('timelinePanel', true);
    setPanel('runInspector', true);
    onClose();
  };
  const openDod = () => {
    const d = useDod.getState();
    d.setShow('showDod', true);
    d.setShow('showTeam', true);
    if (view?.incidentIds[0]) d.pickIncident(view.incidentIds[0]);
    openRun();
  };
  const openComms = () => {
    const c = useCommunications.getState();
    if (view?.incidentIds[0]) c.setAdv({ incident: view.incidentIds[0] });
    c.setOpen(true, true);
    openRun();
  };

  const chain = chainOf(view, launch?.submitting ?? false, direct);
  const startLabel = inFlight && launch ? 'Launching...' : launch?.view || launch?.httpError ? 'Launch again' : 'Start in live run';

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      panelId="scenario-launch"
      title={`${def.scenario_id} · ${def.label}`}
      description={def.learning_goal}
      footer={
        <>
          <span className="sl-foot-note">{blocked ? sup.reasons.join(' | ') : inFlight && !launch ? 'Another launch is still in progress.' : ''}</span>
          {launch && isTerminal(view?.status ?? '') && <Button onClick={dismissLaunch}>Reset</Button>}
          <Button
            variant="primary"
            icon={<Play size={14} />}
            loading={inFlight && !!launch}
            disabledReason={blocked ? `Cannot start: ${sup.reasons.join(' | ')}` : inFlight && !launch ? 'Another launch is still in progress' : undefined}
            onClick={() => void start(def)}
            data-testid="scenario-start"
            data-autofocus
          >
            {startLabel}
          </Button>
        </>
      }
    >
      <div className="sl-dialog" data-testid="scenario-launch">
        <div className="sl-cols">
          <div className="sl-col">
            <p className="sl-line"><Badge tone={TONE[sup.state]}>{sup.label}</Badge></p>
            {sup.outcome && <p className="sl-outcome">{sup.outcome}</p>}
            <h3 className="sl-h">Typed scenario spec</h3>
            <div className="sl-tablewrap">
              <table className="sl-spec">
                <thead>
                  <tr><th>Fault</th><th>Target (from topology)</th><th>Severity</th><th>Parameters</th></tr>
                </thead>
                <tbody>
                  {spec.faults.map((f, i) => (
                    <tr key={i}>
                      <td className="mono">{f.kind}{f.capability !== 'real' && <em className="sl-cap" data-cap={f.capability}>{f.capability}</em>}</td>
                      <td>
                        <span className="mono">{f.target_id}</span>
                        {f.resolved.found ? <small>{[f.resolved.type, f.resolved.label, f.resolved.zone, f.resolved.loop?.toUpperCase()].filter(Boolean).join(' · ')}</small> : <small className="sl-bad">{topo ? 'not in the backend topology' : 'topology not loaded'}</small>}
                      </td>
                      <td className="mono">{def.severity.toLowerCase()} ({f.severity})</td>
                      <td className="mono">{Object.entries(f.params).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sl-note">
              The live run receives exactly the faults in this table. Anything else in the scenario title (smoke, power loss, a flood) is simulated only if one of these faults models it.
            </p>
            <p className="sl-note">
              Seed {spec.seed} is the reference seed of the recorded episode. A live launch injects at the moment you press Start, into the running simulation, which keeps its own random stream. Onset tick {spec.faults.map((f) => f.onset_tick).join(', ')} applies to recorded episodes only.
            </p>
            <details>
              <summary>ScenarioSpec JSON</summary>
              <pre className="spec">{JSON.stringify(toWireSpec(spec), null, 2)}</pre>
            </details>

            <h3 className="sl-h">Backend check</h3>
            {hazardNotes && !direct && <p className="sl-note">Hazard fault kind not accepted by the validator: {hazardNotes.join(' | ')}. Showing the registry faults.</p>}
            {validation?.state === 'loading' && <p className="sl-note">Asking the backend validator...</p>}
            {validation?.state === 'error' && <ErrorState compact title="Validator unavailable" detail={validation.error ?? undefined} />}
            {validation?.view && (
              <>
                <p className="sl-note">POST /scenarios/validate: <b>{validation.view.valid ? 'valid' : 'invalid'}</b></p>
                {validation.view.issues.map((i, k) => (
                  <div key={k} className="issue" data-sev={i.severity}>
                    <b>{i.severity}</b>
                    <span>{i.path ? <span className="mono">{i.path}: </span> : null}{i.message}{i.fix ? <i>{i.fix}</i> : null}</span>
                  </div>
                ))}
                {validation.view.support.length > 0 && (
                  <table className="support">
                    <tbody>
                      {validation.view.support.map((s, k) => (
                        <tr key={k}><td>{s.path}</td><td className={s.applied ? '' : 'no'}>{s.applied ? 'applied' : 'not applied'}: {s.note}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
            {pre.reasons.length > 0 && (
              <ul className="sl-reasons" data-state={pre.state}>
                {pre.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            {pre.simulated.length > 0 && (
              <div className="sl-sim"><b>Simulated as</b><ul>{pre.simulated.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            )}
          </div>

          <div className="sl-col">
            <h3 className="sl-h">Live launch</h3>
            {direct ? (
              <p className="sl-note">
                Sends the typed hazard fault to the engine as <span className="mono">POST /commands</span> <span className="mono">test.inject_fault</span>, the only write path. The prompt planner has no mapping for hazard kinds yet, so the per-run fault cap does not apply here; launches are spaced 10 s apart by this page.
              </p>
            ) : (
              <p className="sl-note">
                Starts through the same path as the prompt box: <span className="mono">POST /scenario-requests</span>, faults submitted on the command bus, per-run fault cap and launch spacing enforced by the backend. The backend interprets the request text with a model, so what it injects can differ from the spec: the comparison below is what actually happened.
              </p>
            )}

            {!launch && !direct && (
              <details>
                <summary>Request text that will be sent</summary>
                <pre className="spec sl-wrap">{promptFor(spec)}</pre>
              </details>
            )}

            {launch && (
              <>
                {launch.httpError && <p className="sl-bad" role="alert" data-testid="launch-http-error">{launch.httpError}</p>}
                <ol className="sl-chain" aria-label="Launch chain">
                  {chain.map((s) => (
                    <li key={s.id} data-state={s.state}>
                      {s.state === 'done' ? <CheckCircle2 size={14} aria-hidden /> : s.state === 'failed' ? <XCircle size={14} aria-hidden /> : s.state === 'active' ? <RefreshCw size={14} className="spin" aria-hidden /> : <Circle size={14} aria-hidden />}
                      <span>{s.label}</span>
                      {s.note && s.state !== 'failed' && <em>{s.note}</em>}
                    </li>
                  ))}
                </ol>

                {view && (
                  <div className="sl-meta mono">
                    <span>{view.requestId}</span>
                    {view.runId && <span>live run {view.runId}</span>}
                    {view.laya && <span>{view.laya}</span>}
                    {view.crusoe && <span>{view.crusoe}</span>}
                    {view.latencies?.laya_ms !== undefined && <span>laya {ms(view.latencies.laya_ms)}</span>}
                    {view.latencies?.crusoe_ms !== undefined && <span>model {ms(view.latencies.crusoe_ms)}</span>}
                    {view.latencies?.total_pipeline_ms !== undefined && <span>pipeline {ms(view.latencies.total_pipeline_ms)}</span>}
                  </div>
                )}

                {terminalBad && view && (
                  <p className="sl-bad" role="alert" data-testid="launch-rejected">
                    {view.status}{view.errorCode ? ` ${view.errorCode}` : ''}: {view.errorMessage ?? 'no message from the backend'}
                  </p>
                )}

                {view && extraReasons.length > 0 && (
                  <ul className="sl-reasons" data-state="unsupported">
                    {extraReasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}

                {cmp && view && (view.injections.length > 0 || view.planned.length > 0) && (
                  <div className="sl-tablewrap">
                    <table className="sl-spec" aria-label="Spec versus injected">
                      <thead><tr><th>Spec fault</th><th>Backend injected</th></tr></thead>
                      <tbody>
                        {cmp.matches.map((m, i) => (
                          <tr key={i}>
                            <td className="mono">{m.fault.kind} → {m.fault.target_id}</td>
                            <td className="mono" data-ok={m.injection?.accepted ? 'true' : 'false'}>
                              {m.injection ? `${m.injection.accepted ? 'accepted' : 'refused'} ${m.injection.kind} → ${m.injection.target}${m.injection.reason ? ` (${m.injection.reason})` : ''}` : 'not injected'}
                            </td>
                          </tr>
                        ))}
                        {cmp.extra.map((x, i) => (
                          <tr key={'x' + i}><td>not in the spec</td><td className="mono">{x.accepted ? 'accepted' : 'refused'} {x.kind} → {x.target}{x.reason ? ` (${x.reason})` : ''}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {view && view.assumptions.length > 0 && (
                  <details>
                    <summary>Backend assumptions ({view.assumptions.length})</summary>
                    <ul className="sl-reasons" data-state="partial">{view.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </details>
                )}

                {view?.status === 'READY' && (
                  <div className="sl-links">
                    {view.incidentIds.length > 0 ? (
                      <span className="mono sl-wrap">incident {view.incidentIds.join(', ')}{Object.values(view.incidentBasis)[0] ? ` (${Object.values(view.incidentBasis)[0]})` : ''}</span>
                    ) : (
                      <span className="sl-note">{launch.linkTimedOut ? 'No incident opened within 90 s of the injection.' : 'Waiting for the monitor to open an incident...'}</span>
                    )}
                    <Button size="sm" icon={<ExternalLink size={13} />} onClick={openRun}>Live run</Button>
                    <Button size="sm" onClick={openDod} disabledReason={view.incidentIds.length ? undefined : 'No incident yet'}>DOD and team</Button>
                    <Button size="sm" onClick={openComms} disabledReason={view.incidentIds.length ? undefined : 'No incident yet'}>Communications</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
