import type { AgentRole, AgentTask, Robot } from '@loopkeeper/core/contracts';
import type { Tone } from '@/theme';

/**
 * Operator-facing agent status. The wire contract (`AgentTaskStatus`) only knows queued | working | blocked | completed |
 * verified | rejected | failed; finer states are DERIVED from the task kind, its tool calls and the owning robot's mode.
 * Every derivation reads a field that is on the wire. Anything unmapped stays as the raw value.
 */
export type StatusGroup = 'working' | 'blocked' | 'done' | 'idle';

export interface DerivedStatus {
  label: string;
  tone: Tone;
  group: StatusGroup;
  verified: boolean;
  negative: boolean;
}

const WORKING_ROBOT = new Set(['ASSIGNED', 'ROUTE_PLANNING', 'TRAVELING', 'INSPECTING', 'WORKING', 'VERIFYING', 'RETURNING']);
const BLOCKED_ROBOT = new Set(['BLOCKED', 'SAFE_HOLD', 'NEEDS_CHARGE', 'FAILED', 'ABORTED']);

export function isHumanControlled(r: Robot | undefined): boolean {
  return r?.control?.authority === 'HUMAN';
}

export function deriveTaskStatus(t: AgentTask, robot?: Robot): DerivedStatus {
  const raw = String(t.status);
  if (robot && isHumanControlled(robot) && (raw === 'working' || raw === 'queued') && (!robot.agent_task_id || robot.agent_task_id === t.id)) {
    return { label: 'Suspended by human', tone: 'watch', group: 'blocked', verified: false, negative: false };
  }
  switch (raw) {
    case 'queued':
      return { label: 'Queued', tone: 'isolated', group: 'working', verified: false, negative: false };
    case 'working': {
      if (t.kind === 'escalate') return { label: 'Needs operator', tone: 'warning', group: 'blocked', verified: false, negative: false };
      if (robot && t.robot_id && BLOCKED_ROBOT.has(robot.mode)) return { label: `Blocked · ${robot.mode.toLowerCase().replace('_', ' ')}`, tone: 'warning', group: 'blocked', verified: false, negative: false };
      if (t.tool_calls.some((c) => c.status === 'running')) return { label: 'Waiting on tool', tone: 'watch', group: 'working', verified: false, negative: false };
      return { label: t.kind === 'replan' ? 'Retrying' : 'Working', tone: t.role, group: 'working', verified: false, negative: false };
    }
    case 'blocked':
      return { label: 'Blocked', tone: 'warning', group: 'blocked', verified: false, negative: false };
    case 'completed': {
      const neg = t.outcome?.ok === false;
      return { label: neg ? 'Completed · negative result' : 'Completed', tone: neg ? 'warning' : 'nominal', group: 'done', verified: false, negative: neg };
    }
    case 'verified':
      return { label: 'Verified', tone: 'nominal', group: 'done', verified: true, negative: false };
    case 'rejected':
      return { label: 'Rejected', tone: 'critical', group: 'done', verified: false, negative: true };
    case 'failed':
      return { label: 'Failed', tone: 'critical', group: 'done', verified: false, negative: true };
    default:
      return { label: raw, tone: 'isolated', group: 'blocked', verified: false, negative: false };
  }
}

/** status of a robot as an agent: its current task if any, else its mode */
export function deriveRobotStatus(r: Robot, tasks: AgentTask[]): DerivedStatus {
  const live = tasks.filter((t) => t.status === 'working' || t.status === 'queued' || t.status === 'blocked');
  if (isHumanControlled(r)) return { label: 'Manual control', tone: 'watch', group: 'blocked', verified: false, negative: false };
  if (live.length) return deriveTaskStatus(live[live.length - 1], r);
  if (BLOCKED_ROBOT.has(r.mode)) return { label: r.mode.toLowerCase().replace('_', ' '), tone: 'warning', group: 'blocked', verified: false, negative: false };
  if (WORKING_ROBOT.has(r.mode)) return { label: r.mode.toLowerCase().replace('_', ' '), tone: r.class, group: 'working', verified: false, negative: false };
  return { label: r.mode === 'DOCKED' ? 'Docked' : 'Idle', tone: 'isolated', group: 'idle', verified: false, negative: false };
}

export const FAMILY_LABEL: Record<AgentRole, string> = { sentinel: 'SENTINEL', inpipe: 'INPIPE', outrig: 'OUTRIG' };
export const FAMILY_SUB: Record<AgentRole, string> = { sentinel: 'Supervisors', inpipe: 'Internal robots', outrig: 'External robots' };

const SECRET_KEY = /(key|token|secret|passw|authoriz|credential|cookie|prompt|chain|thought|reasoning|scratch)/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Agent/tool payloads are untrusted: drop secret-looking keys, clamp depth/size. Rendered only as plain text. */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clip(v, 160);
  if (depth >= 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 14)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1);
    return out;
  }
  return String(v);
}
