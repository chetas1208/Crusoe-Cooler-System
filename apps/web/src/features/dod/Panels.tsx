import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BottomSheet, type SheetState } from '../responsive/BottomSheet';
import { usePhoneLayout } from '../responsive/phone';
import { ScorecardPanel } from '../scorecard/ScorecardPanel';
import { onCommStreamEvent } from '@loopkeeper/core/store';
import { parseContract } from './schemas';
import { useExec, activeLiveRunId, isReplayOnly } from '../../tabs/execution/state';
import { useDod } from './store';
import { LIFECYCLE, SEN_ROLES, TERMINALS, type DodCheck, type TeamTask } from './types';
import { fmtS, fmtVal, whyNotDone } from './schemas';
import { PromptStatusStrip } from '../mission/PromptStatusStrip';
import { usePromptRequest } from '../mission/promptStore';
import { useCommunications } from '../communications/communicationStore';
import './dod.css';

/** the run these panels describe: the Execution selection, else the active live run */
function useRunId() {
  const sel = useExec((s) => s.selectedId);
  const runs = useExec((s) => s.runs);
  return sel ?? activeLiveRunId(runs);
}

/** polls while either panel is visible; hiding a panel never touches the simulation, it only stops asking */
export function useDodPolling() {
  const runId = useRunId();
  const show = useDod((s) => s.showDod || s.showTeam);
  const running = useExec((s) => { const r = s.runs.find((x) => x.run_id === (s.selectedId ?? '')); return !!r && !isReplayOnly(r); });
  useEffect(() => {
    if (!runId || !show) return;
    void useDod.getState().refresh(runId);
    if (!running) return; // a finished run's contract does not change
    // `dod.contract` fires on every contract change: apply it directly; the team graph and incident list follow with one refresh.
    // A slow poll stays as the backstop for a missed event (reconnect gap).
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = onCommStreamEvent((e) => {
      if (e.type !== 'dod.contract') return;
      const p = (e.payload ?? {}) as { contract?: unknown; incident_id?: string };
      const c = parseContract(p.contract ? { contract: p.contract } : null);
      const st = useDod.getState();
      const inc = p.incident_id ?? (p.contract as { incident_id?: string } | undefined)?.incident_id;
      if (c && inc && inc === st.incidentId) useDod.setState({ contract: c, contractLoad: 'ready', updatedAt: Date.now() });
      if (!pending) pending = setTimeout(() => { pending = null; void useDod.getState().refresh(runId); }, 600);
    });
    const t = setInterval(() => void useDod.getState().refresh(runId), 10000);
    return () => {
      off();
      clearInterval(t);
      if (pending) clearTimeout(pending);
    };
  }, [runId, show, running]);
}

export function DodChips() {
  const d = useDod();
  return (
    <>
      <ScorecardChip />
      <button type="button" className="chip" data-active={d.showDod} aria-pressed={d.showDod} onClick={() => d.setShow('showDod', !d.showDod)} title="Definition of Done: what must be measured before this run counts as fixed" style={{ fontSize: 11, padding: '2px 8px' }}>
        Done
      </button>
      <button type="button" className="chip" data-active={d.showTeam} aria-pressed={d.showTeam} onClick={() => d.setShow('showTeam', !d.showTeam)} title="SENTINEL team and their tasks" style={{ fontSize: 11, padding: '2px 8px' }}>
        Team
      </button>
    </>
  );
}

const scoreOpen = { listeners: new Set<() => void>(), on: false };
function useScoreOpen(): [boolean, (v: boolean) => void] {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); scoreOpen.listeners.add(f); return () => void scoreOpen.listeners.delete(f); }, []);
  return [scoreOpen.on, (v) => { scoreOpen.on = v; scoreOpen.listeners.forEach((f) => f()); }];
}
function ScorecardChip() {
  const [open, set] = useScoreOpen();
  return (
    <button type="button" className="chip" data-active={open} aria-pressed={open} onClick={() => set(!open)} title="Frozen V11 evaluation: baselines vs single-pass, with denominators" style={{ fontSize: 11, padding: '2px 8px' }}>
      Scorecard
    </button>
  );
}
export function ScorecardHost() {
  const [open, set] = useScoreOpen();
  const phone = usePhoneLayout();
  const [sheet, setSheet] = useState<SheetState>('expanded');
  if (!open) return null;
  if (phone)
    return createPortal(
      <BottomSheet state={sheet} onState={setSheet} title="Evaluation scorecard" onClose={() => set(false)}>
        <ScorecardPanel onClose={() => set(false)} inSheet />
      </BottomSheet>,
      document.body,
    );
  return <ScorecardPanel onClose={() => set(false)} />;
}

const TONE: Record<string, string> = { PASS: 'pass', FAIL: 'fail', UNKNOWN: 'unk' };

function CheckRow({ c, openMessage }: { c: DodCheck; openMessage: (id: string) => void }) {
  const holding = c.hold_required_s !== undefined;
  const pct = holding && c.hold_required_s ? Math.min(100, Math.round(((c.hold_elapsed_s ?? 0) / c.hold_required_s) * 100)) : null;
  return (
    <li className="dd-check" data-state={TONE[c.state]}>
      <div className="dd-check__top">
        <span className="dd-pill" data-state={TONE[c.state]}>{c.state}</span>
        <b>{c.label}</b>
      </div>
      <div className="dd-check__row mono">
        <span>measured <b>{fmtVal(c.measured, c.unit)}</b></span>
        {c.threshold !== undefined && <span>threshold {c.comparator ?? ''} {String(c.threshold)}{c.unit ? ' ' + c.unit : ''}</span>}
        {c.asset_id && <span>{c.asset_id}</span>}
      </div>
      {holding && (
        <div className="dd-hold" title="How long the check has held continuously">
          <div className="dd-hold__bar" aria-hidden><i style={{ width: `${pct}%` }} /></div>
          <span className="mono">hold {fmtS(c.hold_elapsed_s ?? 0)} / {fmtS(c.hold_required_s!)}</span>
        </div>
      )}
      {c.evidence_ids.length > 0 && (
        <div className="dd-ev mono">
          {c.evidence_ids.slice(0, 4).map((e) => (
            <button key={e} type="button" className="dd-link" onClick={() => openMessage(e)} title="Open this evidence in Communications if it is a message id">{e}</button>
          ))}
          {c.evidence_ids.length > 4 && <span>+{c.evidence_ids.length - 4}</span>}
        </div>
      )}
    </li>
  );
}

function IncidentPicker() {
  const incidents = useDod((s) => s.incidents);
  const cur = useDod((s) => s.incidentId);
  const pick = useDod((s) => s.pickIncident);
  if (incidents.length < 2) return cur ? <span className="mono dd-rev">{cur}</span> : null;
  return (
    <select className="dd-pick" value={cur ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Incident">
      {incidents.map((i) => (
        <option key={i.incident_id} value={i.incident_id}>{i.incident_id}{i.terminal_state ? ` · ${i.terminal_state.toLowerCase()}` : ''}</option>
      ))}
    </select>
  );
}

export function DodPanel() {
  const d = useDod();
  const setOpen = useCommunications((s) => s.setOpen);
  const select = useCommunications((s) => s.select);
  if (!d.showDod) return null;
  const c = d.contract;
  const why = whyNotDone(c);
  const openMessage = (id: string) => {
    const ev = useCommunications.getState().events.find((e) => e.event_id === id || e.evidence_ids?.includes(id));
    if (ev) {
      setOpen(true, true);
      select(ev.event_id);
    }
  };
  return (
    <aside className="dd-panel" aria-label="Definition of Done">
      <header>
        <h2>Definition of Done</h2>
        {c && <span className="mono dd-rev">v{c.revision}</span>}
        <span className="dd-grow" />
        <IncidentPicker />
        <button type="button" className="dd-x" onClick={() => d.setShow('showDod', false)} aria-label="Hide Definition of Done">×</button>
      </header>
      {d.contractLoad === 'unavailable' || (d.contractLoad === 'idle' && !c) ? (
        <p className="dd-empty">This backend has not published a Definition of Done for this run. Nothing is shown rather than guessing one.</p>
      ) : d.contractLoad === 'error' ? (
        <p className="dd-empty" role="alert">Could not load the contract ({d.contractError}).</p>
      ) : c ? (
        <>
          <ol className="dd-life" aria-label="Contract lifecycle">
            {LIFECYCLE.filter((l) => l !== 'FAILED' && l !== 'ESCALATED' && l !== 'VERIFIED' ? true : String(c.lifecycle) === l || l === 'VERIFIED').map((l) => (
              <li key={l} data-on={String(c.lifecycle) === l || undefined} aria-current={String(c.lifecycle) === l ? 'step' : undefined}>{l}</li>
            ))}
          </ol>
          {c.revision_reason && <p className="dd-reason">Revision {c.revision}: {c.revision_reason}</p>}
          <div className="dd-term" data-terminal={c.terminal ?? 'NONE'}>
            <span>Terminal state</span>
            <b>{c.terminal && (TERMINALS as string[]).includes(c.terminal) ? c.terminal.replace(/_/g, ' ') : c.terminal ? c.terminal : 'not reached'}</b>
          </div>
          <p className="dd-why" role="status" data-done={why.done || undefined}><b>{why.done ? 'Done' : 'Why not done yet'}</b> {why.text}</p>
          <ul className="dd-checks">{c.checks.map((k) => <CheckRow key={k.id} c={k} openMessage={openMessage} />)}</ul>
          {c.checks.length === 0 && <p className="dd-empty">No checks in this revision.</p>}
        </>
      ) : (
        <p className="dd-empty">Loading…</p>
      )}
    </aside>
  );
}

const STATUS_TONE: Record<string, string> = { running: 'run', done: 'ok', failed: 'bad', blocked: 'warn', cancelled: 'dim', queued: 'dim' };

function TaskNode({ t, byParent }: { t: TeamTask; byParent: Map<string, TeamTask[]> }) {
  const kids = byParent.get(t.id) ?? [];
  const pct = t.budget_limit && t.budget_used !== undefined ? Math.min(100, Math.round((t.budget_used / t.budget_limit) * 100)) : null;
  return (
    <li className="tm-task" style={{ marginLeft: Math.min(t.depth, 4) * 10 }}>
      <div className="tm-task__top">
        <span className="tm-st" data-tone={STATUS_TONE[t.status] ?? 'dim'}>{t.status}</span>
        <b>{t.title}</b>
      </div>
      <div className="tm-task__row mono">
        <span>{t.role.toUpperCase()}{t.owner ? ` · ${t.owner}` : ''}</span>
        <span>depth {t.depth}</span>
        {t.incident_id && <span>{t.incident_id}</span>}
        {pct !== null && <span>budget {t.budget_used}/{t.budget_limit}{t.budget_unit ? ' ' + t.budget_unit : ''} ({pct}%)</span>}
        {t.tool_calls !== undefined && <span>{t.tool_calls} tool calls</span>}
        {t.model && <span>{t.model.fallback ? 'deterministic fallback' : `${t.model.provider ?? 'model'}${t.model.latency_ms ? ` ${Math.round(t.model.latency_ms)} ms` : ''}`}</span>}
      </div>
      {pct !== null && <div className="dd-hold__bar" aria-hidden data-hot={pct >= 90 || undefined}><i style={{ width: `${pct}%` }} /></div>}
      {t.warnings.map((w, i) => <p key={i} className="tm-warn" role="status">{w.kind === 'loop' ? 'Loop warning' : w.kind === 'drift' ? 'Drift warning' : 'Warning'}: {w.text}</p>)}
      {kids.length > 0 && <ul>{kids.map((k) => <TaskNode key={k.id} t={k} byParent={byParent} />)}</ul>}
    </li>
  );
}

export function TeamPanel() {
  const d = useDod();
  if (!d.showTeam) return null;
  const team = d.team;
  const byParent = new Map<string, TeamTask[]>();
  const roots: TeamTask[] = [];
  const ids = new Set((team?.tasks ?? []).map((t) => t.id));
  for (const t of team?.tasks ?? []) {
    if (t.parent_id && ids.has(t.parent_id)) byParent.set(t.parent_id, [...(byParent.get(t.parent_id) ?? []), t]);
    else roots.push(t);
  }
  const member = (id: string) => team?.members.find((m) => m.id === id);
  return (
    <aside className="dd-panel tm-panel" aria-label="Team">
      <header>
        <h2>Team</h2>
        <span className="dd-grow" />
        <button type="button" className="dd-x" onClick={() => d.setShow('showTeam', false)} aria-label="Hide Team">×</button>
      </header>
      {team?.budgets && (
        <p className="tm-budget mono" aria-label="Delegation budgets">
          depth {team.budgets.depth_seen ?? '?'}/{team.budgets.max_depth ?? '?'} · llm tasks {team.budgets.llm_tasks ?? '?'}/{team.budgets.max_llm_tasks ?? '?'} · plan revisions {team.budgets.plan_revisions ?? '?'}/{team.budgets.max_plan_revisions ?? '?'}{team.budgets.attempts !== null ? ` · attempts ${team.budgets.attempts}` : ''}
        </p>
      )}
      {team?.warnings.map((w, i) => <p key={i} className="tm-warn" role="status">{w.kind === 'loop' ? 'Loop warning' : w.kind === 'drift' ? 'Drift warning' : 'Warning'}: {w.text}</p>)}
      <ul className="tm-roles">
        {SEN_ROLES.map((r) => {
          const m = member(r.id);
          const open = (team?.tasks ?? []).filter((t) => t.owner === r.id && (t.status === 'running' || t.status === 'blocked')).length;
          return (
            <li key={r.id}>
              <b className="mono">{r.id}</b> <span>{m?.title ?? r.title}</span>
              <em>{m?.status ?? (d.teamLoad === 'ready' ? 'idle' : 'no status')}{open ? ` · ${open} active` : ''}</em>
            </li>
          );
        })}
      </ul>
      {d.teamLoad === 'unavailable' && <p className="dd-empty">This backend has not published the team task graph for this run.</p>}
      {d.teamLoad === 'error' && <p className="dd-empty" role="alert">Could not load the team ({d.teamError}).</p>}
      {team && team.tasks.length === 0 && d.teamLoad === 'ready' && <p className="dd-empty">No tasks yet.</p>}
      <ul className="tm-tasks">{roots.map((t) => <TaskNode key={t.id} t={t} byParent={byParent} />)}</ul>
    </aside>
  );
}

/** mounted by the Execution tab: polling + both panels in one rail */
export function DodRail() {
  useDodPolling();
  const d = useDod();
  const prompting = usePromptRequest((s) => s.startedAt !== null);
  const phone = usePhoneLayout();
  const [scoreShown] = useScoreOpen();
  const [sheet, setSheet] = useState<SheetState>('peek');
  if (phone && scoreShown) return null; // one sheet at a time on a phone: the scorecard takes over
  if (!d.showDod && !d.showTeam && !prompting) return null;
  // phones: the same panels inside the shell's tap-operable bottom sheet (closing it hides both, exactly like the chips do)
  if (phone)
    return createPortal(
      <BottomSheet state={sheet} onState={setSheet} title="Execution details" onClose={() => { d.setShow('showDod', false); d.setShow('showTeam', false); usePromptRequest.getState().dismiss(); setSheet('peek'); }}>
        <div className="dd-rail dd-rail--sheet">
          {/* the header chip rail sits behind the sheet on short screens: the same toggles live here */}
          <div className="dd-sheetchips"><DodChips /></div>
          <PromptStatusStrip />
          <DodPanel />
          <TeamPanel />
        </div>
      </BottomSheet>,
      document.body,
    );
  return (
    <div className="dd-rail">
      <PromptStatusStrip />
      <DodPanel />
      <TeamPanel />
    </div>
  );
}
