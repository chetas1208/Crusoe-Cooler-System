import { useLaya } from './laya';
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { AgentRole } from '@loopkeeper/core/contracts';
import { FAMILIES, type StatusGroup } from './status';
import { StatusIcon } from './DelegationGraph';
import type { Row } from './rows';
import { Button } from '../../ui/kit/index';

export interface FamilyPanelProps {
  rows: Row[];
  group: StatusGroup | null;
  family: AgentRole | null;
  selectedId: string | null;
  pendingApprovals: Array<{ id: string; taskId: string; incidentId: string; action: string }>;
  onGroup(g: StatusGroup | null): void;
  onFamily(f: AgentRole | null): void;
  onSelect(id: string): void;
}

const GROUPS: Array<{ id: StatusGroup; label: string; hint: string }> = [
  { id: 'working', label: 'Working', hint: 'Queued, planning, investigating, waiting, retrying, executing or verifying' },
  { id: 'blocked', label: 'Blocked', hint: 'Blocked, suspended by a human, or in a state this console does not recognise' },
  { id: 'done', label: 'Done', hint: 'Finished: completed, failed or cancelled. Failed work stays red.' },
];
const LIST_CAP = 6;

export function FamilyPanel(p: FamilyPanelProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const count = (g: StatusGroup) => p.rows.filter((r) => r.st.group === g).length;
  return (
    <aside className="ag-left ag-panel" data-inset="left" aria-label="Agent families">
      <div className="ag-groups" role="group" aria-label="Status filter">
        {GROUPS.map((g) => (
          <button key={g.id} className="ag-fchip" data-on={p.group === g.id} aria-pressed={p.group === g.id} title={g.hint} onClick={() => p.onGroup(p.group === g.id ? null : g.id)}>
            {g.label}
            <b className="num">{count(g.id)}</b>
          </button>
        ))}
      </div>

      {p.pendingApprovals.length > 0 && (
        <div className="ag-needs" role="status">
          <ShieldAlert size={14} />
          <span>
            {p.pendingApprovals.length} intervention{p.pendingApprovals.length === 1 ? '' : 's'} waiting for you
          </span>
          <Button size="sm" onClick={() => p.onSelect(p.pendingApprovals[0].taskId)}>Review</Button>
        </div>
      )}

      <div className="ag-fams scroll">
        {FAMILIES.map((f) => {
          const mine = p.rows.filter((r) => r.task.role === f.role);
          const live = mine.filter((r) => r.st.group !== 'done');
          const running = mine.filter((r) => r.st.group === 'working' && r.st.status !== 'queued').length;
          const blocked = mine.filter((r) => r.st.group === 'blocked').length;
          const queued = mine.filter((r) => r.st.status === 'queued').length;
          const done = mine.filter((r) => r.st.group === 'done');
          const failed = done.filter((r) => r.st.status === 'failed' || r.st.negative).length;
          const shown = (p.group ? mine.filter((r) => r.st.group === p.group) : live).sort((a, b) => b.task.started_tick - a.task.started_tick);
          const expanded = open[f.role];
          const list = expanded ? shown : shown.slice(0, LIST_CAP);
          return (
            <section key={f.role} className="ag-fam" data-on={p.family === f.role} style={{ ['--fam' as string]: f.color }}>
              <button className="ag-fam__head" onClick={() => p.onFamily(p.family === f.role ? null : f.role)} aria-pressed={p.family === f.role} title={`Show only ${f.label} in the graph`}>
                <span className="ag-fam__name">
                  <b>{f.label}</b>
                  <span>{f.sub}</span>
                </span>
                <span className="ag-fam__n num" data-zero={running === 0}>{running}</span>
                <span className="ag-fam__u">active</span>
              </button>
              <div className="ag-fam__stats num">
                <span>{blocked} blocked</span>
                <span>{queued} queued</span>
                <span>{done.length} done{failed ? <em> · {failed} failed</em> : null}</span>
              </div>
              {f.role === 'sentinel' && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0 6px', padding: '6px 8px', background: 'rgba(56, 189, 248, 0.05)', borderRadius: 6, border: '1px solid rgba(56, 189, 248, 0.2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        Laya Classifier
                      </span>
                      <span style={{ fontSize: 12, padding: '1px 5px', borderRadius: 4, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontWeight: 600 }}>
                        System 1 Router
                      </span>
                    </div>
                    <LayaMetrics />
                  </div>

                  <p className="sc-note" style={{ margin: '0 0 10px' }}>
                    The five SENTINEL seats are the cards above the graph. Their status comes from the incident's team graph.
                  </p>
                </>
              )}

              {list.length === 0 ? (
                <div className="ag-fam__empty">{mine.length === 0 ? `No ${f.label} tasks yet. They start when an incident opens.` : p.group ? `Nothing ${p.group} here.` : 'Idle. Nothing running right now.'}</div>
              ) : (
                <ul className="ag-fam__list">
                  {list.map((r) => (
                    <li key={r.task.id}>
                      <button className="ag-row" data-sel={p.selectedId === r.task.id} data-tone={r.st.tone} onClick={() => p.onSelect(r.task.id)}>
                        <span className="ag-row__ico"><StatusIcon st={r.st} size={12} /></span>
                        <span className="ag-row__t">{r.task.title}</span>
                        <span className="ag-row__s">{r.st.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {shown.length > LIST_CAP && (
                <button className="ag-more" onClick={() => setOpen((o) => ({ ...o, [f.role]: !expanded }))}>
                  {expanded ? 'Show fewer' : `Show ${shown.length - LIST_CAP} more`}
                </button>
              )}
            </section>
          );
        })}
      </div>
      <div className="ag-left__foot">
        <Button size="sm" disabledReason="The backend only has a global simulation pause. There is no autonomy-only pause, and no kill-all.">Pause autonomous commands</Button>
        <span id="ag-pause-why">Unavailable: backend has no autonomy-only pause.</span>
      </div>
    </aside>
  );
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** Figures come from the backend only; with none available the card says so instead of showing a number. */
function LayaMetrics() {
  const l = useLaya();
  if (l.state === 'loading') return <div style={{ fontSize: 12, color: 'var(--t3)' }}>Reading classifier status…</div>;
  if (l.accuracy === null)
    return (
      <div style={{ fontSize: 12, color: 'var(--t3)' }}>
        <span>Not evaluated</span>
        <span style={{ display: 'block', fontSize: 12 }}>{l.engine ? `engine: ${l.engine}` : 'No classifier metrics reported by this backend.'}{l.queries ? ` · ${l.queries} queries so far` : ''}</span>
      </div>
    );
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--t2)', display: 'flex', justifyContent: 'space-between' }}>
        <span>Triage accuracy</span>
        <strong>{pct(l.accuracy)}</strong>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)', display: 'flex', justifyContent: 'space-between' }}>
        <span>Latency p95: {l.latencyP95Ms === null ? '—' : `${l.latencyP95Ms.toFixed(l.latencyP95Ms < 10 ? 2 : 0)} ms`}</span>
        <span>Abstention: {pct(l.abstentionRate)}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)' }}>{[l.engine, l.provenance].filter(Boolean).join(' · ')}</div>
    </>
  );
}
