import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorld } from '@loopkeeper/core/store';
import type { AgentRole, AgentTask, Robot } from '@loopkeeper/core/contracts';
import { useSupervisors } from '@/hooks/useSupervisors';
import { deriveRobotStatus, deriveTaskStatus, type DerivedStatus } from './status';

export interface AgentEntry {
  id: string;
  kind: 'supervisor' | 'robot';
  role: AgentRole;
  title: string;
  sub: string;
  tasks: AgentTask[];
  status: DerivedStatus;
  robot?: Robot;
}

/**
 * The agent roster as the backend reports it: 5 SENTINEL supervisors (GET /agents/graph), the INPIPE robots and the OUTRIG
 * robots (world snapshot). A robot's tasks are the tasks whose `robot_id` is that robot. The wire contract has no
 * seat -> task attribution for supervisors, so supervisors share the SENTINEL-role task stream.
 */
export function useAgents(): { entries: AgentEntry[]; sentinelTasks: AgentTask[]; loaded: boolean } {
  const sup = useSupervisors();
  const robots = useWorld(useShallow((s) => Object.values(s.robots)));
  const tasksMap = useWorld((s) => s.tasks);
  return useMemo(() => {
    const tasks = Object.values(tasksMap).sort((a, b) => a.started_tick - b.started_tick || a.id.localeCompare(b.id));
    const sentinelTasks = tasks.filter((t) => t.role === 'sentinel');
    const sentinelActive = sentinelTasks.filter((t) => t.status === 'working' || t.status === 'queued' || t.status === 'blocked');
    const entries: AgentEntry[] = [];
    for (const s of sup.list) {
      const working = s.status === 'working' || sentinelActive.length > 0;
      entries.push({
        id: s.id,
        kind: 'supervisor',
        role: 'sentinel',
        title: s.id,
        sub: s.title,
        tasks: sentinelTasks,
        status: { label: s.status === 'working' ? 'Watching' : s.status, tone: 'sentinel', group: working ? 'working' : 'idle', verified: false, negative: false },
      });
    }
    for (const r of robots) {
      const mine = tasks.filter((t) => t.robot_id === r.id);
      entries.push({ id: r.id, kind: 'robot', role: r.class, title: r.id, sub: r.name, tasks: mine, status: deriveRobotStatus(r, mine), robot: r });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { entries, sentinelTasks, loaded: sup.loaded };
  }, [sup.list, sup.loaded, robots, tasksMap]);
}

export { deriveTaskStatus };
