import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, ShieldCheck, X } from 'lucide-react';
import { selectIncidentsSorted, useWorld } from '@loopkeeper/core/store';
import type { AgentRole, AgentTask } from '@loopkeeper/core/contracts';
import { useView } from '@loopkeeper/scene';
import { useUi } from '../../ui/store';
import { refitActivePreset, resetPreset } from '../../ui/presets';
import { useLayoutMode } from '../../features/responsive/layout';
import { useRunsPolling } from '../execution/controller';
import { useExec } from '../execution/state';
import { AgentInspector } from './AgentInspector';
import { BottomRibbon } from './BottomRibbon';
import { DelegationGraph } from './DelegationGraph';
import { FamilyPanel } from './FamilyPanel';
import { SeatStrip } from './SeatCards';
import { useAgentsHide, type HideState } from './hide';
import { useRobotCtxs, useRows } from './rows';
import { deriveSeatCards, type SeatEnrich } from './seats';
import type { DerivedStatus, StatusGroup } from './status';
import { useAgentsRunId, useSeatTeam } from './teamStore';
import './seats.css';
import { Button } from '../../ui/kit/index';

type AgentsPanel = 'seats' | 'roster' | 'inspector' | 'ribbon';
const PANEL_LABEL: Record<AgentsPanel, string> = { seats: 'Seats', roster: 'Roster', inspector: 'Inspector', ribbon: 'Activity' };

/** Runs are polled by Execution and the panel host; make sure the run id exists when this tab is the first one opened. */
function RunsFeed() {
  useRunsPolling();
  return null;
}

/** Hide / reopen every panel of this tab. Pressed = visible. */
function PanelToggles({ hidden, toggle }: { hidden: HideState<AgentsPanel>['hidden']; toggle(k: AgentsPanel): void }) {
  return (
    <div className="ag-panels" role="group" aria-label="Show or hide panels">
      <span className="ag-panels__lab">Panels</span>
      {(Object.keys(PANEL_LABEL) as AgentsPanel[]).map((k) => (
        <Button key={k} size="sm" variant="ghost" pressed={!hidden[k]} onClick={() => toggle(k)} title={hidden[k] ? `Show ${PANEL_LABEL[k].toLowerCase()}` : `Hide ${PANEL_LABEL[k].toLowerCase()}`}>
          {PANEL_LABEL[k]}
        </Button>
      ))}
    </div>
  );
}

/**
 * Agents tab. Owner: agents agent.
 * Left: SENTINEL / INPIPE / OUTRIG with live counts and status filters. Centre: delegation graph over the dimmed
 * 3D facility (the shared canvas, not a second one). Right: inspector for the selected task. Bottom: latest activity.
 */
export function AgentsTab() {
  const tasksMap = useWorld((s) => s.tasks);
  const incidents = useWorld((s) => s.incidents);
  const sorted = useWorld(useShallow(selectIncidentsSorted));
  const robots = useRobotCtxs();
  const focused = useView((s) => s.focusedIncidentId);
  const pinned = useUi((s) => s.pinned);
  const taskId = useUi((s) => s.taskId);
  const setTask = useUi((s) => s.setTask);
  const [scopeSel, setScopeSel] = useState<string | null>(null); // null = follow the focused incident, 'all' = everything
  const [group, setGroup] = useState<StatusGroup | null>(null);
  const [family, setFamily] = useState<AgentRole | null>(null);

  // the dimmed facility behind the graph is the whole hall, not a zoomed-in incident close-up (the incident pills still fly to it)
  useEffect(() => {
    resetPreset();
    const t = setTimeout(refitActivePreset, 350);
    return () => clearTimeout(t);
  }, []);

  const allTasks = useMemo(() => Object.values(tasksMap), [tasksMap]);
  const rows = useRows(allTasks, robots);

  const withTasks = useMemo(() => sorted.filter((i) => i.task_ids.length > 0), [sorted]);
  const auto = (focused && incidents[focused]) || (pinned && incidents[pinned]) || withTasks.find((i) => !i.closed_tick) || withTasks[0];
  const scope = scopeSel ?? auto?.id ?? 'all';
  const scoped = useMemo(() => (scope === 'all' ? allTasks : allTasks.filter((t) => t.incident_id === scope)), [allTasks, scope]);

  const matches = useCallback((t: AgentTask, s: DerivedStatus) => (!family || t.role === family) && (!group || s.group === group), [family, group]);

  const pendingApprovals = useMemo(
    () =>
      Object.values(incidents)
        .filter((i) => i.approval?.status === 'pending')
        .map((i) => ({ id: i.approval!.id, taskId: i.approval!.task_id, incidentId: i.id, action: i.approval!.action })),
    [incidents],
  );

  const select = useCallback((id: string | null) => setTask(id), [setTask]);

  // the five SENTINEL seats for the incident the graph is scoped to (the newest open one when the scope is "all")
  const { compact } = useLayoutMode();
  const hide = useAgentsHide();
  const runsLoaded = useExec((s) => s.runsLoaded);
  const runId = useAgentsRunId();
  const teamIncident = scope !== 'all' ? scope : (auto?.id ?? null);
  const teamOpen = !!(teamIncident && incidents[teamIncident] && !incidents[teamIncident].closed_tick);
  const teamState = useSeatTeam(runId, teamIncident, teamOpen);
  const teamTasks = useMemo(() => (teamIncident ? allTasks.filter((t) => t.incident_id === teamIncident) : []), [allTasks, teamIncident]);
  const enrich = useMemo<SeatEnrich>(() => {
    const outcomes: NonNullable<SeatEnrich['outcomes']> = {};
    for (const t of teamTasks) if (t.outcome) outcomes[t.id] = t.outcome;
    const v = teamIncident ? incidents[teamIncident]?.verification : undefined;
    return { outcomes, verification: v ? { status: String(v.status), passed: v.checks.filter((c) => c.pass).length, total: v.checks.length, reason: v.failed_reason, attempt: v.attempt } : null };
  }, [teamTasks, incidents, teamIncident]);
  const teamForIncident = teamState.incidentId === teamIncident ? teamState.team : null;
  const cards = useMemo(() => deriveSeatCards(teamForIncident, enrich), [teamForIncident, enrich]);
  const seatStrip = !hide.hidden.seats && (
    <SeatStrip cards={cards} team={teamForIncident} incidentId={teamIncident} load={teamState.incidentId === teamIncident ? teamState.load : 'loading'} error={teamState.error} selectedTaskId={taskId} onSelect={select} onHide={() => hide.set('seats', true)} />
  );

  return (
    <div className="ag" data-hide-roster={hide.hidden.roster || undefined} data-hide-inspector={hide.hidden.inspector || undefined} data-hide-ribbon={hide.hidden.ribbon || undefined}>
      {!runsLoaded && <RunsFeed />}
      {compact && <PanelToggles hidden={hide.hidden} toggle={hide.toggle} />}
      {compact && seatStrip}
      {!hide.hidden.roster && <FamilyPanel rows={rows} group={group} family={family} selectedId={taskId} pendingApprovals={pendingApprovals} onGroup={setGroup} onFamily={setFamily} onSelect={select} />}

      <section className="ag-centre" aria-label="Delegation graph">
        <header className="ag-head">
          <div className="ag-scopes" role="group" aria-label="Incident scope">
            <button className="pill" data-on={scope === 'all'} onClick={() => setScopeSel('all')}>All incidents</button>
            {withTasks.slice(0, 5).map((i) => (
              <button key={i.id} className="pill" data-on={scope === i.id} onClick={() => (setScopeSel(i.id), select(null), useView.getState().focusIncident(i.id))} title={i.title}>
                <span className={`dot tone-${i.closed_tick ? 'nominal' : i.severity}`} />
                <span className="mono">{i.id}</span>
                <span className="pill__t">{i.title}</span>
              </button>
            ))}
          </div>
          <Legend />
          {!compact && <PanelToggles hidden={hide.hidden} toggle={hide.toggle} />}
        </header>
        {!compact && seatStrip}

        {scoped.length === 0 ? (
          <div className="ag-void">
            <div className="ag-void__ico"><Bot size={22} /></div>
            <b>No agent tasks yet</b>
            <p>SENTINEL spawns reviewers and robot tasks when it opens an incident. Force a fault from Engineering test controls in the top bar, or wait for the seeded wear to produce one.</p>
            <Button size="sm" onClick={() => useUi.getState().setTab('dashboard')}>Open the dashboard</Button>
          </div>
        ) : (
          <DelegationGraph tasks={scoped} incidents={incidents} robots={robots} selectedId={taskId} onSelect={select} matches={matches} envelopes={teamState.incidentId === teamIncident && scope !== 'all' ? teamState.envelopes : undefined} scopeKey={`${scope}|${group}|${family}`} />
        )}
        {(group || family) && scoped.length > 0 && (
          <button className="ag-clear" onClick={() => (setGroup(null), setFamily(null))}>
            <X size={12} /> Clear filter
          </button>
        )}
      </section>

      {!hide.hidden.inspector && <AgentInspector taskId={taskId} robots={robots} onSelect={select} />}
      {!hide.hidden.ribbon && <BottomRibbon rows={rows} onSelect={select} />}
    </div>
  );
}

function Legend() {
  return (
    <ul className="ag-legend" aria-label="Edge types">
      <li><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="#8b93a7" strokeWidth="1.6" /><path d="M20,1 L25,4 L20,7z" fill="#8b93a7" /></svg>Delegated</li>
      <li><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="#8b93a7" strokeWidth="1" strokeDasharray="2 3" /></svg>Shared evidence</li>
      <li><span className="ag-glyph"><Bot size={10} /></span>Robot mission</li>
      <li><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="#ff9a3c" strokeWidth="2.2" /><path d="M18,0.5 L25,4 L18,7.5z" fill="#ff9a3c" /></svg>Escalation or replan</li>
      <li><span className="ag-vbadge" data-v="pass"><ShieldCheck size={11} />verified</span><span className="ag-vbadge" data-v="reject"><X size={11} />rejected</span></li>
    </ul>
  );
}
