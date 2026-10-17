import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import type { AgentTask } from '@loopkeeper/core/contracts';
import { deriveStatus, isHumanControlled, type DerivedStatus, type RobotCtx } from './status';

export interface Row {
  task: AgentTask;
  st: DerivedStatus;
}

/**
 * Robot mode/ownership as a plain string key. The robots map is replaced on every 10 Hz pose tick,
 * but the key only changes when a mode, owning task or human-control flag changes — so nothing
 * downstream re-renders per pose.
 */
export function useRobotCtxs(): Record<string, RobotCtx> {
  const key = useWorld((s) =>
    Object.values(s.robots)
      .map((r) => `${r.id}|${r.mode}|${r.agent_task_id ?? ''}|${isHumanControlled(r) ? 1 : 0}`)
      .join(';'),
  );
  return useMemo(() => {
    const out: Record<string, RobotCtx> = {};
    for (const part of key ? key.split(';') : []) {
      const [id, mode, taskId, human] = part.split('|');
      out[id] = { mode, taskId: taskId || undefined, human: human === '1' };
    }
    return out;
  }, [key]);
}

export function useRows(tasks: AgentTask[], robots: Record<string, RobotCtx>): Row[] {
  return useMemo(() => tasks.map((task) => ({ task, st: deriveStatus(task, task.robot_id ? robots[task.robot_id] : undefined) })), [tasks, robots]);
}
