import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, ShieldCheck, X } from 'lucide-react';
import { selectIncidentsSorted, useWorld } from '@loopkeeper/core/store';
import type { AgentRole, AgentTask } from '@loopkeeper/core/contracts';
import { useView } from '@loopkeeper/scene';
import { useUi } from '../../ui/store';
import { refitActivePreset, resetPreset } from '../../ui/presets';
import { AgentInspector } from './AgentInspector';
import { BottomRibbon } from './BottomRibbon';
import { DelegationGraph } from './DelegationGraph';
import { FamilyPanel } from './FamilyPanel';
import { useRobotCtxs, useRows } from './rows';
import type { DerivedStatus, StatusGroup } from './status';

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

  return (
    <div className="ag">
      <FamilyPanel rows={rows} group={group} family={family} selectedId={taskId} pendingApprovals={pendingApprovals} onGroup={setGroup} onFamily={setFamily} onSelect={select} />

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
        </header>

        {scoped.length === 0 ? (
          <div className="ag-void">
            <div className="ag-void__ico"><Bot size={22} /></div>
            <b>No agent tasks yet</b>
            <p>SENTINEL spawns reviewers and robot tasks when it opens an incident. Force a fault from Engineering test controls in the top bar, or wait for the seeded wear to produce one.</p>
            <button className="btn btn--sm" onClick={() => useUi.getState().setTab('dashboard')}>Open the dashboard</button>
          </div>
        ) : (
          <DelegationGraph tasks={scoped} incidents={incidents} robots={robots} selectedId={taskId} onSelect={select} matches={matches} scopeKey={`${scope}|${group}|${family}`} />
        )}
        {(group || family) && scoped.length > 0 && (
          <button className="ag-clear" onClick={() => (setGroup(null), setFamily(null))}>
            <X size={12} /> Clear filter
          </button>
        )}
      </section>

      <AgentInspector taskId={taskId} robots={robots} onSelect={select} />
      <BottomRibbon rows={rows} onSelect={select} />
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
