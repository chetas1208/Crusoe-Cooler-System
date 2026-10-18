import { ArrowRight, Check } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { INCIDENT_STATUS_LABEL, formatDuration } from '@loopkeeper/core';
import type { Incident } from '@loopkeeper/core/contracts';
import { useView } from '@loopkeeper/scene';
import { useUi } from '../../ui/store';
import { useExec } from '../execution/state';
import { deriveSeatCards } from '../agents/seats';
import { classifyModel, fmtInt, fmtUsd, seatChips, tallyChecks, terminalWording, usageOf } from './summary';
import { useDashRunId, useDashSummary } from './summaryStore';
import { Badge, Button } from '../../ui/kit/index';

const TONE: Record<string, 'nominal' | 'warning' | 'critical' | 'neutral'> = { good: 'nominal', warn: 'warning', bad: 'critical', neutral: 'neutral' };

/** Open the ongoing run in Execution (the one place the run is operated), with the incident pinned and focused. */
export function openRunInExecution(inc: Incident | undefined, runId: string | null) {
  if (inc) {
    useUi.getState().pin(inc.id);
    useView.getState().focusIncident(inc.id);
  }
  if (runId) useExec.setState({ selectedId: runId });
  useUi.getState().setTab('execution');
}

/**
 * Call to action for the open incident: where it stands against its Definition of Done, in plain words, and what each
 * of the five SENTINEL seats is doing. Everything here is read from the backend; nothing is operated from the Dashboard.
 */
export function RunSummary({ inc, onLocate }: { inc: Incident; onLocate(): void }) {
  const simTime = useWorld((s) => s.simTimeS);
  const runId = useDashRunId();
  const sum = useDashSummary();
  const fresh = sum.incidentId === inc.id;
  const contract = fresh ? sum.contract : null;
  const available = fresh && sum.contractLoad === 'ready';
  const tally = contract ? tallyChecks(contract.checks) : null;
  const w = terminalWording(contract?.terminal ?? null, tally, available || sum.contractLoad === 'loading');
  const verification = inc.verification ? { status: String(inc.verification.status), passed: inc.verification.checks.filter((c) => c.pass).length, total: inc.verification.checks.length, reason: inc.verification.failed_reason, attempt: inc.verification.attempt } : null;
  const cards = deriveSeatCards(fresh ? sum.team : null, { verification });
  const chips = seatChips(cards);
  const tone = inc.status === 'escalated' ? 'critical' : inc.severity;
  return (
    <article className="dd__inc" data-tone={tone} aria-label={`Open incident ${inc.id}`}>
      <header>
        <span className="mono dd__id">{inc.id}</span>
        <span className="dd__muted">open {formatDuration(simTime - inc.opened_at_s)}</span>
        <Badge tone={tone} sm>{inc.status === 'escalated' ? 'Needs operator' : INCIDENT_STATUS_LABEL[inc.status]}</Badge>
      </header>
      <h3>{inc.title}</h3>
      <div className="rs-dod" data-tone={w.tone} role="status">
        <span className="rs-k">Definition of Done</span>
        <b>{w.headline}</b>
        <span className="rs-d">{w.detail}</span>
      </div>
      <ul className="rs-seats" aria-label="SENTINEL seats">
        {chips.map((c) => (
          <li key={c.id} data-tone={c.tone} title={`${c.id}: ${cards.find((x) => x.id === c.id)?.stateLabel ?? c.label}`}>
            <i aria-hidden />
            <span className="mono">{c.id.replace('SEN-', '')}</span>
            <span>{c.label}</span>
          </li>
        ))}
      </ul>
      <div className="dd__actions rs-actions">
        <Button size="sm" variant="primary" iconRight={<ArrowRight size={13} />} onClick={() => openRunInExecution(inc, runId)}>
          Open ongoing run in Execution
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (useUi.getState().pin(inc.id), useView.getState().focusIncident(inc.id), useUi.getState().setTab('agents'))}>Seats in Agents</Button>
        <Button size="sm" variant="ghost" onClick={onLocate}>Locate in Map</Button>
      </div>
    </article>
  );
}

/** Nothing open: say so, and say how the last incident ended (from its contract) rather than leaving a blank. */
export function QuietSummary() {
  const last = useDashSummary((s) => s.last);
  const w = last ? terminalWording(last.terminal, null, true) : null;
  return (
    <div className="dd__quiet rs-quiet" role="status">
      <Check size={14} strokeWidth={2.4} aria-hidden />
      <span>
        No open incidents.
        {last && w && (
          <>
            {' '}
            Last, <span className="mono">{last.incident_id}</span>: <b data-tone={w.tone}>{w.headline.toLowerCase()}</b>.
          </>
        )}
      </span>
    </div>
  );
}

export function ModelCard() {
  const s = useDashSummary();
  const intel = useWorld((st) => st.health?.intelligence) as Parameters<typeof classifyModel>[1];
  const v = classifyModel(s.model, intel, { fetched: s.modelFetched, failed: s.modelFailed });
  const u = usageOf(s.model, intel);
  return (
    <div className="mc" data-state={v.state} aria-label="Crusoe model status">
      <div className="mc__top">
        <span className="mc__name">Crusoe model</span>
        <Badge tone={TONE[v.tone]} sm>{v.label}</Badge>
      </div>
      <p className="mc__detail">{v.detail}</p>
      <dl className="mc__kv num">
        {v.modelId && (
          <div>
            <dt>Model</dt>
            <dd className="mono">{v.modelId.replace(/^nvidia\/NVIDIA-/, '')}</dd>
          </div>
        )}
        {v.latencyMs !== null && (
          <div>
            <dt>Last answer</dt>
            <dd>{Math.round(v.latencyMs)} ms</dd>
          </div>
        )}
        <div>
          <dt>Tokens so far</dt>
          <dd>{u.tokensIn === null && u.tokensOut === null ? 'not reported' : `${fmtInt(u.tokensIn)} in · ${fmtInt(u.tokensOut)} out`}</dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>{u.calls === null ? 'not reported' : `${fmtInt(u.calls)}${u.failures !== null ? ` (${fmtInt(u.failures)} failed)` : ''}`}</dd>
        </div>
        <div>
          <dt>Cost so far</dt>
          <dd>{fmtUsd(u.costUsd)}</dd>
        </div>
      </dl>
    </div>
  );
}
