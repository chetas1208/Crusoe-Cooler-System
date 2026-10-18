import { memo } from 'react';
import { AlertTriangle, EyeOff, Repeat2 } from 'lucide-react';
import { Badge, Button, type Tone as KitTone } from '../../ui/kit/index';
import { TIER_LABEL, activeLlm, incidentWarnings, type SeatCard, type SeatTeam, type Tier, type Verdict } from './seats';

const STATE_CLASS: Record<SeatCard['state'], string> = { working: 'run', blocked: 'warn', failed: 'bad', done: 'idle', idle: 'idle', unknown: 'warn', no_data: 'nodata' };

const TIER_TONE: Record<Tier, KitTone> = { nano: 'accent', super: 'sentinel', policy: 'neutral', other: 'neutral', none: 'neutral' };
const STATE_TONE_KIT: Record<SeatCard['state'], KitTone> = { working: 'accent', blocked: 'warning', failed: 'critical', done: 'neutral', idle: 'neutral', unknown: 'watch', no_data: 'neutral' };
const VERDICT_TONE: Record<Verdict['tone'], KitTone> = { good: 'nominal', warn: 'warning', bad: 'critical', neutral: 'neutral' };

function TierChip({ tier, n }: { tier: Tier; n?: number }) {
  return (
    <Badge tone={TIER_TONE[tier]} variant={tier === 'none' ? 'outline' : 'soft'} sm icon={null} title={tier === 'policy' ? 'Deterministic policy engine, no model call' : tier === 'none' ? 'The backend recorded no model for this seat' : `Recorded model tier: ${TIER_LABEL[tier]}`}>
      {TIER_LABEL[tier]}
      {n !== undefined && n > 1 ? ` ×${n}` : ''}
    </Badge>
  );
}

function VerdictLine({ v }: { v: Verdict | null }) {
  if (!v) return <p className="sc-verdict sc-muted">Last verdict: none yet</p>;
  return (
    <p className="sc-verdict" data-tone={v.tone}>
      <Badge tone={VERDICT_TONE[v.tone]} sm>Last verdict</Badge> {v.text}
    </p>
  );
}

const Seat = memo(function Seat({ c, selectedTaskId, onSelect }: { c: SeatCard; selectedTaskId: string | null; onSelect(id: string): void }) {
  const focus = c.currentTask ?? c.lastTask;
  return (
    <li className="sc" data-state={STATE_CLASS[c.state]} aria-label={`${c.id} ${c.title}: ${c.stateLabel}`}>
      <header>
        <span className="sc-id mono">{c.id}</span>
        <b className="sc-title">{c.title}</b>
      </header>
      <p className="sc-state" data-state={STATE_CLASS[c.state]} role="status">
        <Badge tone={STATE_TONE_KIT[c.state]} sm>{c.stateLabel}</Badge>
      </p>
      {c.state === 'no_data' ? (
        <p className="sc-muted">No team data for this incident. Nothing is shown rather than guessing.</p>
      ) : c.taskCount === 0 ? (
        <p className="sc-muted">No task in this incident.</p>
      ) : (
        <>
          <button type="button" className="sc-task" disabled={!focus} aria-pressed={focus ? selectedTaskId === focus.id : false} onClick={() => focus && onSelect(focus.id)} title={focus ? `Open ${focus.id} in the inspector` : undefined}>
            <span className="sc-k">{c.currentTask ? 'Current task' : 'Last task'}</span>
            <span className="sc-v">{focus ? focus.title : 'No task in this incident'}</span>
          </button>
          <div className="sc-row" aria-label="Model tier">
            <span className="sc-k">Model</span>
            <span className="sc-chips">
              {c.tierTally.length === 0 ? <TierChip tier="none" /> : c.tierTally.map((t) => <TierChip key={t.tier} tier={t.tier} n={t.n} />)}
            </span>
          </div>
          <div className="sc-row" aria-label="Budget used">
            <span className="sc-k">Budget</span>
            <span className="sc-v num">
              {c.modelCalls} model · {c.toolCalls} tool calls
            </span>
          </div>
          {c.warnings.map((w, i) => (
            <p key={i} className="sc-warn" role="status">
              {w.kind === 'loop' ? <Repeat2 size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
              <span>
                <b>{w.kind === 'loop' ? 'Loop warning' : w.kind === 'drift' ? 'Drift warning' : 'Warning'}</b> {w.text}
              </span>
            </p>
          ))}
          <VerdictLine v={c.verdict} />
        </>
      )}
    </li>
  );
});

export interface SeatStripProps {
  cards: SeatCard[];
  team: SeatTeam | null;
  incidentId: string | null;
  load: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  error: string | null;
  selectedTaskId: string | null;
  onSelect(id: string): void;
  onHide(): void;
}

/** The five SENTINEL seats, first-class, for the incident the graph is scoped to. */
export function SeatStrip({ cards, team, incidentId, load, error, selectedTaskId, onSelect, onHide }: SeatStripProps) {
  const al = activeLlm(team);
  const b = team?.budgets;
  const loose = incidentWarnings(team);
  return (
    <section className="ag-seats" aria-label="SENTINEL seats">
      <header className="ag-seats__head">
        <h2>SENTINEL seats</h2>
        {incidentId && <span className="mono ag-seats__inc">{incidentId}</span>}
        {b && (
          <span className="ag-seats__bud num" title="Incident-level delegation limits reported by the backend">
            model tasks active {al.active}
            {al.limit !== null ? `/${al.limit}` : ''} · depth {b.depthSeen ?? '?'}/{b.maxDepth ?? '?'} · plan revisions {b.planRevisions ?? '?'}/{b.maxPlanRevisions ?? '?'}
          </span>
        )}
        <span className="ag-grow" />
        <Button size="sm" variant="ghost" icon={<EyeOff size={13} />} onClick={onHide} title="Hide SENTINEL seats">Hide</Button>
      </header>
      {load === 'unavailable' && <p className="sc-note">The backend has not published a team graph for this incident (it exists for the live run only).</p>}
      {load === 'error' && (
        <p className="sc-note" role="alert">
          Could not load the team ({error ?? 'unknown error'}). Seats show no data.
        </p>
      )}
      {load === 'loading' && !team && <p className="sc-note">Loading the team…</p>}
      {!incidentId && <p className="sc-note">No incident with tasks yet. Seats fill in when SENTINEL opens one.</p>}
      {loose.map((w, i) => (
        <p key={i} className="sc-warn sc-warn--inc" role="status">
          <AlertTriangle size={12} aria-hidden />
          <span>
            <b>{w.kind === 'loop' ? 'Loop warning' : w.kind === 'drift' ? 'Drift warning' : 'Warning'}</b> {w.text}
          </span>
        </p>
      ))}
      <ul className="sc-list">
        {cards.map((c) => (
          <Seat key={c.id} c={c} selectedTaskId={selectedTaskId} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  );
}
