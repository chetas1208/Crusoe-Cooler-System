import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, Check, Crosshair, ExternalLink, Info, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { commands, useWorld } from '@loopkeeper/core/store';
import { formatDuration, formatSimClock } from '@loopkeeper/core';
import type { AgentTask, Incident, ToolCall } from '@loopkeeper/core/contracts';
import { useView } from '@loopkeeper/scene';
import { Chip, useTick } from '../../ui/kit';
import { useUi } from '../../ui/store';
import { StatusIcon } from './DelegationGraph';
import { deriveStatus, familyOf, isHumanControlled, modelNote, oneLine, planLadder, redact, robotLabel, type DerivedStatus, type RobotCtx } from './status';
import { Button, IconButton } from '../../ui/kit/index';

const ROLE_POLICY: Record<string, string> = {
  sentinel: 'Reads telemetry and topology, proposes missions and work orders. Cannot move hardware directly; changes go through the approved command bus.',
  inpipe: 'Plans a route and inspects or clears a pipe segment. Changes the plant only through the approved command bus.',
  outrig: 'Executes an approved work order with whitelisted, interlocked service actions only. Cannot override isolation.',
};

function useDt() {
  return useWorld((s) => (s.health && s.health.tick_rate_hz > 0 ? 1 / s.health.tick_rate_hz : null));
}

const goMap = (after: () => void) => {
  useUi.getState().setTab('map');
  // the tab host switches the scene mode in an effect; apply the camera goal right after it settles
  setTimeout(after, 80);
};

export function AgentInspector({ taskId, robots, onSelect }: { taskId: string | null; robots: Record<string, RobotCtx>; onSelect(id: string | null): void }) {
  const task = useWorld((s) => (taskId ? s.tasks[taskId] : undefined));
  if (!taskId || !task) return <Empty />;
  return <Detail key={task.id} task={task} robots={robots} onSelect={onSelect} />;
}

function Empty() {
  const stats = useWorld(
    useShallow((s) => {
      let tools = 0;
      let failed = 0;
      for (const t of Object.values(s.tasks)) {
        tools += t.tool_calls.length;
        failed += t.tool_calls.filter((c) => c.status === 'error' || c.status === 'rejected').length;
      }
      return { tasks: Object.keys(s.tasks).length, tools, failed };
    }),
  );
  return (
    <aside className="ag-right ag-panel" data-inset="right" aria-label="Agent inspector">
      <div className="ag-empty">
        <b>Nothing selected</b>
        <p>Pick a task in the graph or on the left to see what it was asked, which tools it called, and whether anyone checked the result.</p>
        <div className="ag-kv num">
          <div><span>Tasks on record</span><b>{stats.tasks}</b></div>
          <div><span>Tool calls</span><b>{stats.tools}</b></div>
          <div><span>Tool failures</span><b>{stats.failed}</b></div>
        </div>
      </div>
    </aside>
  );
}

function Detail({ task, robots, onSelect }: { task: AgentTask; robots: Record<string, RobotCtx>; onSelect(id: string | null): void }) {
  useTick(1000);
  const dt = useDt();
  const inc = useWorld((s) => s.incidents[task.incident_id]);
  const allTasks = useWorld((s) => s.tasks);
  const missions = useWorld(useShallow((s) => Object.values(s.missions).filter((m) => m.incident_id === task.incident_id)));
  const robot = useWorld(
    useShallow((s) => {
      const r = task.robot_id ? s.robots[task.robot_id] : undefined;
      return r ? { id: r.id, mode: r.mode, battery: Math.round(r.battery_pct), human: isHumanControlled(r), tool: r.tool ?? null } : null;
    }),
  );
  const st = deriveStatus(task, task.robot_id ? robots[task.robot_id] : undefined);
  const fam = familyOf(task.role);
  const note = modelNote(task);
  const children = useMemo(() => Object.values(allTasks).filter((t) => t.parent_id === task.id).sort((a, b) => a.started_tick - b.started_tick), [allTasks, task.id]);
  const parent = task.parent_id ? allTasks[task.parent_id] : undefined;
  const ladder = useMemo(() => planLadder(task, inc, missions), [task, inc, missions]);
  const reviewRef = useRef<HTMLDivElement>(null);
  const nowTick = useWorld.getState().simTick;
  const ap = inc?.approval;
  const pending = ap?.status === 'pending';

  const elapsed = dt === null ? null : ((task.ended_tick ?? nowTick) - task.started_tick) * dt;
  const clock = (tick: number) => (dt === null ? `tick ${tick}` : formatSimClock(tick * dt));
  const tokens = task.model.tokens_in !== undefined || task.model.tokens_out !== undefined ? `${task.model.tokens_in ?? '?'} in / ${task.model.tokens_out ?? '?'} out` : null;
  const target = task.asset_ids[0] ?? inc?.anchor.entity_id;

  const locate = () => {
    if (!target) return;
    useView.getState().select(target);
    goMap(() => useView.getState().focusEntity(target));
  };
  const follow = () => {
    if (!task.robot_id) return;
    const id = task.robot_id;
    goMap(() => useView.getState().follow(id));
  };
  const openExec = () => {
    if (!inc) return;
    useUi.getState().pin(inc.id);
    useView.getState().focusIncident(inc.id);
    useUi.getState().setTab('execution');
  };

  return (
    <aside className="ag-right ag-panel" data-inset="right" aria-label="Agent inspector" style={{ ['--fam' as string]: fam.color }}>
      <header className="ag-ih">
        <span className="ag-ih__bar" />
        <div className="ag-ih__main">
          <div className="ag-ih__t">{task.title}</div>
          <div className="ag-ih__id mono">{task.id} · {task.role} · {task.kind}</div>
        </div>
        <IconButton size="sm" onClick={() => onSelect(null)} aria-label="Close inspector" icon={<X size={15} />} />
      </header>

      <div className="ag-ibody scroll">
        <div className="ag-status" data-tone={st.tone}>
          <StatusIcon st={st} size={14} />
          <b>{st.label}</b>
          {st.status === 'suspended_by_human' && <span>A human holds this robot. Autonomy is paused, not failed.</span>}
          {st.status === 'unknown' && <span className="mono">wire status “{st.raw}”</span>}
          {task.outcome && st.group === 'done' && <span>{task.outcome.label}</span>}
        </div>

        {inc?.approval && <Review inc={inc} reviewRef={reviewRef} highlight={pending && ap!.task_id === task.id} />}

        <Sec title="Goal">
          <p className="ag-p">{task.question}</p>
        </Sec>

        <Sec title="Decision and rationale" hint="Summary only. Prompts and chain-of-thought are never shown.">
          {task.summary ? <p className="ag-p">{task.summary}</p> : <p className="ag-p ag-p--mute">{st.group === 'done' ? 'This task recorded no summary.' : 'No decision yet.'}</p>}
          {rationaleOf(task) && <p className="ag-p ag-p--q">{rationaleOf(task)}</p>}
        </Sec>

        <Sec title="Planned, executed, verified" hint="Three separate claims. Only the last is independent.">
          <div className="ag-ladder">
            <div className="ag-lad" data-k="planned">
              <span className="ag-lad__k">Planned</span>
              <b className="num">{ladder.plannedSteps ? `${ladder.plannedSteps.length} step${ladder.plannedSteps.length === 1 ? '' : 's'}` : 'none recorded'}</b>
              <span className="ag-lad__s">{ladder.plannedSource}</span>
            </div>
            <div className="ag-lad" data-k="executed" data-bad={ladder.executedFailed > 0}>
              <span className="ag-lad__k">Executed</span>
              <b className="num">{ladder.executedTotal === 0 ? 'nothing yet' : `${ladder.executedOk} of ${ladder.executedTotal} ok${ladder.executedFailed ? `, ${ladder.executedFailed} failed` : ''}`}</b>
              <span className="ag-lad__s">{ladder.executedSource}</span>
            </div>
            <div className="ag-lad" data-k="verified" data-v={ladder.verification.state}>
              <span className="ag-lad__k">Independently verified</span>
              <b className="num">{verifText(ladder.verification)}</b>
              <span className="ag-lad__s">{ladder.verification.reason ?? (ladder.verification.state === 'na' ? 'this task does not change the plant' : 'twin comparison, not the agent’s own claim')}</span>
            </div>
          </div>
          {ladder.plannedSteps && ladder.plannedSteps.length > 0 && (
            <ol className="ag-steps">
              {ladder.plannedSteps.slice(0, 10).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              {ladder.plannedSteps.length > 10 && <li>+{ladder.plannedSteps.length - 10} more</li>}
            </ol>
          )}
        </Sec>

        <Sec title="Context">
          <div className="ag-kv">
            <div>
              <span>Incident</span>
              {inc ? <button className="ag-link mono" onClick={openExec} title={inc.title}>{inc.id}</button> : <b>{task.incident_id}</b>}
            </div>
            <div><span>Category</span><b className="mono">{task.kind}</b></div>
            <div>
              <span>Parent</span>
              {parent ? <button className="ag-link" onClick={() => onSelect(parent.id)}>{parent.title}</button> : <b>{task.parent_id ? task.parent_id : 'none (root)'}</b>}
            </div>
            {task.caused_by.filter((c) => c !== task.parent_id).length > 0 && (
              <div>
                <span>Fed by</span>
                <b className="ag-wrapb">
                  {task.caused_by.filter((c) => c !== task.parent_id).map((c) => (
                    <button key={c} className="ag-link" onClick={() => onSelect(c)}>{allTasks[c]?.title ?? c}</button>
                  ))}
                </b>
              </div>
            )}
            <div>
              <span>Robot</span>
              {robot ? (
                <b>
                  <span className="mono">{robotLabel(robot.id)}</span> · {robot.human ? 'human control' : robot.mode.toLowerCase().replace('_', ' ')} · <span className="num">{robot.battery}%</span>
                </b>
              ) : (
                <b>{task.robot_id ? `${robotLabel(task.robot_id)} (no longer reported)` : 'none assigned'}</b>
              )}
            </div>
            <div>
              <span>Assets</span>
              <b className="ag-wrapb">
                {task.asset_ids.length === 0 && 'none'}
                {task.asset_ids.slice(0, 6).map((a) => (
                  <button key={a} className="ag-link mono" onClick={() => (useView.getState().select(a), useView.getState().focusEntity(a))}>{a}</button>
                ))}
              </b>
            </div>
            <div><span>Started</span><b className="num">{clock(task.started_tick)}</b></div>
            <div><span>Duration</span><b className="num">{elapsed === null ? 'unknown' : `${formatDuration(Math.max(0, elapsed))}${task.ended_tick === undefined ? ' so far' : ''}`}</b></div>
            <div><span>Tokens</span><b className="num">{tokens ?? 'unknown'}</b></div>
          </div>
        </Sec>

        <Sec title="Model">
          <div className="ag-model" data-tone={note.tone}>
            <b>{note.headline}</b>
            {note.detail && <span>{note.detail}</span>}
            {note.inference && (
              <span className="num">
                {task.model.latency_ms !== undefined ? `${task.model.latency_ms} ms` : 'latency unknown'} · schema {task.model.schema_version}
              </span>
            )}
          </div>
        </Sec>

        <EvidenceList task={task} inc={inc} />

        <Sec title="Tools">
          <p className="ag-p ag-p--mute">
            <Info size={12} style={{ verticalAlign: '-2px' }} /> The contract does not list per-task grants. Role policy: {ROLE_POLICY[task.role]}
          </p>
          <Timeline calls={task.tool_calls} clock={clock} />
        </Sec>

        <Sec title={`Child tasks · ${children.length}`}>
          {children.length === 0 ? (
            <p className="ag-p ag-p--mute">{st.group === 'done' ? 'Spawned no child tasks.' : 'No child tasks yet.'}</p>
          ) : (
            <ul className="ag-kids">
              {children.slice(0, 14).map((c, i, arr) => {
                const cs = deriveStatus(c, c.robot_id ? robots[c.robot_id] : undefined);
                const retry = arr.slice(0, i).filter((x) => x.kind === c.kind).length;
                return (
                  <li key={c.id}>
                    <button className="ag-kid" data-tone={cs.tone} onClick={() => onSelect(c.id)}>
                      <span className="ag-kid__i"><StatusIcon st={cs} size={12} /></span>
                      <span className="ag-kid__t">{c.title}</span>
                      {retry > 0 && <Chip sm tone="warning">retry {retry}</Chip>}
                      <span className="ag-kid__s">{cs.group === 'done' ? c.outcome?.label ?? cs.label : cs.label}</span>
                    </button>
                  </li>
                );
              })}
              {children.length > 14 && <li className="ag-p ag-p--mute">+{children.length - 14} more</li>}
            </ul>
          )}
        </Sec>

        <Sec title="Operator actions">
          <ul className="ag-unavail">
            <li><b>Reprioritise</b> is hidden: the contract has no priority control.</li>
            <li><b>Request fresh investigation</b> is unavailable: no command exists for it yet.</li>
          </ul>
        </Sec>
      </div>

      <footer className="ag-iact">
        <Button size="sm" icon={<Crosshair size={13} />} disabledReason={target ? undefined : 'This task has no asset to locate'} title={target ? `Show ${target} on the map` : undefined} onClick={locate}>Locate asset</Button>
        <Button size="sm" icon={<Bot size={13} />} disabledReason={!task.robot_id ? 'No robot is assigned to this task' : !robot ? 'The robot is no longer reported' : undefined} title={robot ? 'Follow the robot on the map' : undefined} onClick={follow}>Follow robot</Button>
        <Button size="sm" icon={<ExternalLink size={13} />} disabledReason={inc ? undefined : 'This task has no incident to open'} onClick={openExec}>Open in Execution</Button>
        <Button
          size="sm"
          variant={pending ? 'warn' : 'secondary'}
          icon={<ShieldAlert size={13} />}
          disabledReason={pending ? undefined : ap ? `Approval is ${ap.status}` : 'No intervention is waiting on this incident'}
          title={pending ? 'Approve or hold the waiting intervention' : undefined}
          onClick={() => reviewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
        >
          Review intervention
        </Button>
      </footer>
    </aside>
  );
}

const verifText = (v: ReturnType<typeof planLadder>['verification']) =>
  v.state === 'na' ? 'not applicable' : v.state === 'not_yet' ? 'not yet' : v.state === 'pending' ? 'checking…' : `${v.state === 'verified' ? 'passed' : 'rejected'} · ${v.passed} of ${v.total} checks${v.attempt ? ` · attempt ${v.attempt}` : ''}`;

function rationaleOf(t: AgentTask): string | null {
  for (const c of [...t.tool_calls].reverse()) {
    const r = c.output?.rationale ?? c.output?.conclusion;
    if (typeof r === 'string') return `${c.name}: ${r}`;
  }
  return null;
}

function Sec({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="ag-sec">
      <h3>{title}</h3>
      {hint && <div className="ag-sec__hint">{hint}</div>}
      {children}
    </section>
  );
}

function EvidenceList({ task, inc }: { task: AgentTask; inc?: Incident }) {
  const ev = task.evidence_ids.map((id) => inc?.evidence.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <Sec title={`Evidence · ${task.evidence_ids.length}`}>
      {ev.length === 0 ? (
        <p className="ag-p ag-p--mute">{task.evidence_ids.length ? `${task.evidence_ids.length} reference(s) not found on the incident.` : 'No evidence attached.'}</p>
      ) : (
        <ul className="ag-evi">
          {ev.slice(0, 6).map((e) => (
            <li key={e.id}>
              <button disabled={!e.asset_id} onClick={() => e.asset_id && (useView.getState().select(e.asset_id), useView.getState().focusEntity(e.asset_id))}>
                <span className="ag-evi__k">{e.kind}</span>
                <span>{e.summary}</span>
              </button>
            </li>
          ))}
          {ev.length > 6 && <li className="ag-p ag-p--mute">+{ev.length - 6} more</li>}
        </ul>
      )}
    </Sec>
  );
}

const TL_CAP = 40;
function Timeline({ calls, clock }: { calls: ToolCall[]; clock: (t: number) => string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (calls.length === 0) return <p className="ag-p ag-p--mute">No tool calls. This step reasons over evidence already gathered.</p>;
  const shown = calls.slice(-TL_CAP);
  return (
    <ol className="ag-tl">
      {calls.length > TL_CAP && <li className="ag-p ag-p--mute">{calls.length - TL_CAP} earlier calls not shown</li>}
      {shown.map((c) => {
        const bad = c.status === 'error' || c.status === 'rejected';
        return (
          <li key={c.id} className="ag-tc" data-status={c.status}>
            <button className="ag-tc__h" onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))} aria-expanded={!!open[c.id]}>
              <span className="ag-tc__s">{c.status === 'running' ? <span className="spinner" style={{ width: 10, height: 10 }} /> : bad ? <X size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}</span>
              <b className="mono">{c.name}</b>
              <span className="ag-tc__d num">{c.status === 'running' ? 'running' : c.latency_ms !== undefined ? `${c.latency_ms} ms` : 'duration unknown'}</span>
              <span className="ag-tc__t num">{clock(c.tick)}</span>
            </button>
            <div className="ag-tc__a mono" title="Arguments (redacted)">{oneLine(c.input) || 'no arguments'}</div>
            <div className="ag-tc__r mono" title="Result (redacted)">{c.status === 'running' ? 'waiting for result' : c.output ? `→ ${oneLine(c.output)}` : bad ? `${c.status}: no result returned` : '→ no result returned'}</div>
            {open[c.id] && <pre className="ag-tc__j mono">{JSON.stringify(redact({ input: c.input, output: c.output }), null, 1)}</pre>}
          </li>
        );
      })}
    </ol>
  );
}

function Review({ inc, reviewRef, highlight }: { inc: Incident; reviewRef: React.RefObject<HTMLDivElement | null>; highlight: boolean }) {
  useTick(1000);
  const [busy, setBusy] = useState(false);
  const ap = inc.approval!;
  const now = useWorld.getState().simTimeS;
  const left = ap.auto_approve_at_s === null ? null : Math.max(0, Math.round(ap.auto_approve_at_s - now));
  const run = async (kind: 'approve' | 'hold') => {
    setBusy(true);
    try {
      const ack = await (kind === 'approve' ? commands.approve(ap.id) : commands.hold(ap.id));
      if (!ack.accepted) useView.getState().say(`Not accepted${ack.reason ? `: ${ack.reason}` : ''}`, 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ag-review" ref={reviewRef} data-status={ap.status} data-hl={highlight}>
      <div className="ag-review__h">
        <ShieldAlert size={14} />
        <b>{ap.status === 'pending' ? 'Intervention waiting for you' : `Intervention ${ap.status}`}</b>
      </div>
      <p className="ag-p">{ap.action}</p>
      <ol className="ag-steps">
        {ap.steps.slice(0, 8).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {ap.status === 'pending' && (
        <>
          <div className="ag-review__t num">{left === null ? 'Explicit approval required. Nothing runs until you approve.' : `Auto-approves in ${left} s unless you hold it.`}</div>
          <div className="ag-review__b">
            <Button size="sm" variant="primary" loading={busy} icon={<ShieldCheck size={13} />} onClick={() => void run('approve')}>Approve</Button>
            <Button size="sm" disabled={busy} onClick={() => void run('hold')}>Hold</Button>
          </div>
        </>
      )}
    </div>
  );
}

export type { DerivedStatus };
