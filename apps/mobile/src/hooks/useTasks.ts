import { useShallow } from 'zustand/react/shallow';
import { tasksOf, useWorld } from '@loopkeeper/core/store';
import type { AgentTask } from '@loopkeeper/core/contracts';

/** Agent trace for an incident, in causal/start order. */
export function useIncidentTasks(incidentId: string | undefined): AgentTask[] {
  return useWorld(
    useShallow((s) => {
      if (!incidentId) return [] as AgentTask[];
      return tasksOf(s, incidentId).sort((a, b) => a.started_tick - b.started_tick || a.id.localeCompare(b.id));
    }),
  );
}
