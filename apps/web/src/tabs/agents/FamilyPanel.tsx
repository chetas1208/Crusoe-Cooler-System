import { useLaya } from './laya';
import { useSupervisors } from '../../lib/supervisors';
import { useMemo, useState } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { ShieldAlert } from 'lucide-react';
import type { AgentRole } from '@loopkeeper/core/contracts';
import { FAMILIES, type StatusGroup } from './status';
import { StatusIcon } from './DelegationGraph';
import type { Row } from './rows';

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

/** Which of the 18 physical robots a virtual supervisor is responsible for. The backend graph carries no explicit owner list, so it is read from the specialty text (crawler / internal -> INPIPE; OUTRIG / external -> OUTRIG; everything else is cross-cutting). */
function ownership(s: { title: string; specialty: string }, fleet: Array<{ id: string; cls: string }>): { text: string; note?: string } {
  const t = `${s.title} ${s.specialty}`.toLowerCase();
  const range = (ids: string[]) => (ids.length ? `${ids[0]} … ${ids[ids.length - 1]} (${ids.length})` : 'none');
  const inp = fleet.filter((r) => r.cls === 'inpipe').map((r) => r.id);
  const out = fleet.filter((r) => r.cls === 'outrig').map((r) => r.id);
  if (/crawler|inpipe|internal/.test(t)) return { text: `owns ${range(inp)}`, note: 'INPIPE crawlers' };
  if (/outrig|external/.test(t)) return { text: `owns ${range(out)}`, note: 'OUTRIG rovers' };
  return { text: `oversees all ${fleet.length} robots`, note: 'cross-cutting (no robots of its own)' };
}


export function FamilyPanel(p: FamilyPanelProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const sup = useSupervisors();
  const robots = useWorld((st) => st.robots);
  const fleet = useMemo(() => Object.values(robots).map((r) => ({ id: r.id, cls: r.class })).sort((a, b) => a.id.localeCompare(b.id)), [robots]);
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
          <button className="btn btn--sm" onClick={() => p.onSelect(p.pendingApprovals[0].taskId)}>Review</button>
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
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        Laya Classifier
                      </span>
                      <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontWeight: 600 }}>
                        System 1 Router
                      </span>
                    </div>
                    <LayaMetrics />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 10px', padding: '6px 8px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--sentinel, #a78bfa)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                      {sup.list.length ? `${sup.list.length} Virtual Supervisors` : 'Virtual Supervisors'}
                    </span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 3 }}>
                      {!sup.list.length && <span style={{ fontSize: 10, color: 'var(--t3)' }}>{sup.loaded ? 'This backend reports no SENTINEL supervisors.' : 'Loading…'}</span>}
                      {sup.list.map((s) => {
                        const own = ownership(s, fleet);
                        return (
                          <div key={s.id} title={`${s.specialty}${own.note ? ` · ${own.note}` : ''}`} style={{ display: 'flex', flexDirection: 'column', fontSize: 11, color: 'var(--t2)', gap: 1 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                              <span><strong style={{ color: 'var(--t1)' }}>{s.id}</strong> {s.title}</span>
                              <span style={{ fontSize: 9, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{s.status}</span>
                            </div>
                            <span className="mono" style={{ fontSize: 9.5, color: 'var(--t3)' }}>{own.text}</span>
                          </div>
                        );
                      })}
                      <span style={{ fontSize: 9, color: 'var(--t3)' }}>Virtual: no pose, no mesh, never drawn on the floor. Ownership is derived from each supervisor's specialty text.</span>
                    </div>
                  </div>
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
        <button className="btn btn--sm" disabled aria-describedby="ag-pause-why" title="The backend only has a global simulation pause. There is no autonomy-only pause, and no kill-all.">Pause autonomous commands</button>
        <span id="ag-pause-why">Unavailable: backend has no autonomy-only pause.</span>
      </div>
    </aside>
  );
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** Figures come from the backend only; with none available the card says so instead of showing a number. */
function LayaMetrics() {
  const l = useLaya();
  if (l.state === 'loading') return <div style={{ fontSize: 10, color: 'var(--t3)' }}>Reading classifier status…</div>;
  if (l.accuracy === null)
    return (
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>
        <span>Not evaluated</span>
        <span style={{ display: 'block', fontSize: 10 }}>{l.engine ? `engine: ${l.engine}` : 'No classifier metrics reported by this backend.'}{l.queries ? ` · ${l.queries} queries so far` : ''}</span>
      </div>
    );
  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--t2)', display: 'flex', justifyContent: 'space-between' }}>
        <span>Triage accuracy</span>
        <strong>{pct(l.accuracy)}</strong>
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)', display: 'flex', justifyContent: 'space-between' }}>
        <span>Latency p95: {l.latencyP95Ms === null ? '—' : `${l.latencyP95Ms.toFixed(l.latencyP95Ms < 10 ? 2 : 0)} ms`}</span>
        <span>Abstention: {pct(l.abstentionRate)}</span>
      </div>
      <div style={{ fontSize: 9, color: 'var(--t3)' }}>{[l.engine, l.provenance].filter(Boolean).join(' · ')}</div>
    </>
  );
}
