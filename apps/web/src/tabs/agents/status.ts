import type { AgentRole, AgentTask, Incident, Mission, Robot, ToolCall } from '@loopkeeper/core/contracts';

/**
 * Operator-facing agent status taxonomy. The wire contract (`AgentTaskStatus`) only knows
 * queued | working | blocked | completed | verified | rejected | failed, so the finer states are
 * DERIVED from the task kind, its tool calls and the owning robot's mode. Nothing is invented:
 * every derivation reads a field that is on the wire. Anything we cannot map becomes `unknown`.
 */
export type AgentStatus =
  | 'queued'
  | 'planning'
  | 'investigating'
  | 'waiting_on_robot'
  | 'waiting_on_tool'
  | 'blocked'
  | 'retrying'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'suspended_by_human'
  | 'unknown';

export type StatusGroup = 'working' | 'blocked' | 'done';
export type StatusTone = 'sentinel' | 'accent' | 'watch' | 'warning' | 'critical' | 'nominal' | 'isolated' | 'human';

export const STATUS_META: Record<AgentStatus, { label: string; tone: StatusTone; group: StatusGroup }> = {
  queued: { label: 'Queued', tone: 'isolated', group: 'working' },
  planning: { label: 'Planning', tone: 'sentinel', group: 'working' },
  investigating: { label: 'Investigating', tone: 'sentinel', group: 'working' },
  waiting_on_robot: { label: 'Waiting on robot', tone: 'watch', group: 'working' },
  waiting_on_tool: { label: 'Waiting on tool', tone: 'watch', group: 'working' },
  blocked: { label: 'Blocked', tone: 'warning', group: 'blocked' },
  retrying: { label: 'Retrying', tone: 'warning', group: 'working' },
  executing: { label: 'Executing', tone: 'accent', group: 'working' },
  verifying: { label: 'Verifying', tone: 'accent', group: 'working' },
  completed: { label: 'Completed', tone: 'nominal', group: 'done' },
  failed: { label: 'Failed', tone: 'critical', group: 'done' },
  cancelled: { label: 'Cancelled', tone: 'isolated', group: 'done' },
  suspended_by_human: { label: 'Suspended by human', tone: 'human', group: 'blocked' },
  unknown: { label: 'Unrecognised state', tone: 'isolated', group: 'blocked' },
};

export interface RobotCtx {
  mode: string;
  /** the task this robot is currently executing, when the stream says so */
  taskId?: string;
  human: boolean;
}

export interface DerivedStatus {
  status: AgentStatus;
  label: string;
  tone: StatusTone;
  group: StatusGroup;
  /** an independent verification confirmed the outcome */
  verified: boolean;
  /** finished, but the outcome was negative / inconclusive (never painted green) */
  negative: boolean;
  /** raw wire status, shown when we could not map it */
  raw: string;
}

const ALL = new Set<string>(Object.keys(STATUS_META));

/**
 * Human takeover. The control events (`human.override` / `agent.resumed`) are being added by the map
 * agent; the store does not carry them yet, so this reads any control marker defensively from the
 * robot object and renders nothing when absent.
 */
export function isHumanControlled(r: Robot | undefined): boolean {
  if (!r) return false;
  const x = r as unknown as { control?: { mode?: string; authority?: string; holder?: string; lease_id?: string }; controlled_by?: string; control_mode?: string; manual?: boolean };
  const v = x.control?.mode ?? x.control?.authority ?? x.control_mode ?? x.controlled_by;
  return x.manual === true || v === 'human' || v === 'manual' || v === 'operator' || (!!x.control?.lease_id && x.control.holder !== undefined);
}

export function robotCtx(r: Robot | undefined): RobotCtx | undefined {
  return r ? { mode: r.mode, taskId: r.agent_task_id, human: isHumanControlled(r) } : undefined;
}

const REASONING = /^(review\.|classify|reconcile)/;
const PLANNING = /^(plan|decide|mission\.request|safety|cordon|mitigate)/;

export function deriveStatus(t: AgentTask, robot?: RobotCtx): DerivedStatus {
  const raw = String(t.status);
  let status: AgentStatus;
  let verified = false;
  if (ALL.has(raw) && raw !== 'unknown') status = raw as AgentStatus;
  else if (raw === 'working') status = deriveWorking(t, robot);
  else if (raw === 'verified') (status = 'completed'), (verified = true);
  else if (raw === 'rejected') status = 'failed';
  else if (raw === 'suspended') status = 'suspended_by_human';
  else status = 'unknown';
  // a human holding the robot suspends autonomy for any task still in flight on it
  if (robot?.human && (!robot.taskId || robot.taskId === t.id) && STATUS_META[status].group === 'working' && status !== 'queued') status = 'suspended_by_human';
  const negative = status === 'completed' && t.outcome?.ok === false;
  const m = STATUS_META[status];
  return { status, label: negative ? 'Completed · negative result' : m.label, tone: negative ? 'warning' : m.tone, group: m.group, verified, negative, raw };
}

function deriveWorking(t: AgentTask, robot?: RobotCtx): AgentStatus {
  const k = t.kind;
  if (k === 'replan') return 'retrying';
  if (k === 'escalate') return 'blocked'; // waiting for the operator
  if (robot && t.robot_id && (!robot.taskId || robot.taskId === t.id)) {
    switch (robot.mode) {
      case 'BLOCKED':
      case 'SAFE_HOLD':
      case 'NEEDS_CHARGE':
      case 'FAILED':
      case 'ABORTED':
        return 'blocked';
      case 'ASSIGNED':
      case 'ROUTE_PLANNING':
      case 'TRAVELING':
      case 'RETURNING':
        return 'waiting_on_robot';
      case 'INSPECTING':
        return t.role === 'inpipe' && k === 'inspect' ? 'investigating' : 'executing';
      case 'WORKING':
        return 'executing';
      case 'VERIFYING':
        return 'verifying';
    }
  }
  if (t.tool_calls.some((c) => c.status === 'running')) return 'waiting_on_tool';
  if (REASONING.test(k) || k === 'inspect') return 'investigating';
  if (PLANNING.test(k)) return 'planning';
  if (k === 'verify' || k === 'trial') return 'verifying';
  return t.role === 'sentinel' ? 'planning' : 'executing';
}

/* ───────────── families ───────────── */

export interface Family {
  role: AgentRole;
  label: string;
  sub: string;
  color: string;
}
export const FAMILIES: Family[] = [
  { role: 'sentinel', label: 'SENTINEL', sub: 'Supervisor and monitor', color: 'var(--sentinel)' },
  { role: 'inpipe', label: 'INPIPE', sub: 'Internal pipe robots', color: 'var(--inpipe)' },
  { role: 'outrig', label: 'OUTRIG', sub: 'Exterior robots', color: 'var(--outrig)' },
];
export const familyOf = (role: AgentRole | string) => FAMILIES.find((f) => f.role === role) ?? FAMILIES[0];
export const robotLabel = (id: string) => id.toUpperCase().replace('_', '-');

/* ───────────── redaction ───────────── */

const SECRET_KEY = /(key|token|secret|passw|authoriz|credential|cookie|prompt|chain|thought|reasoning|scratch)/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Agent/tool payloads are untrusted: drop secret-looking keys, clamp depth/size. Rendered only through React text. */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clip(v, 120);
  if (depth >= 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 12)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1);
    return out;
  }
  return String(v);
}

const scalar = (x: unknown): string => (typeof x === 'object' && x !== null ? (Array.isArray(x) ? `[${x.length}]` : '{…}') : String(x));
/** one-line `k=v` summary of a redacted payload */
export function oneLine(o: Record<string, unknown> | undefined, max = 90): string {
  if (!o) return '';
  const r = redact(o) as Record<string, unknown>;
  return clip(Object.entries(r).map(([k, x]) => `${k}=${scalar(x)}`).join('  '), max);
}

/* ───────────── planned / executed / verified ───────────── */

export interface PlanLadder {
  plannedSteps: string[] | null;
  plannedSource: string;
  executedOk: number;
  executedFailed: number;
  executedTotal: number;
  executedSource: string;
  verification: { state: 'na' | 'not_yet' | 'pending' | 'verified' | 'rejected'; passed: number; total: number; reason?: string; attempt?: number };
}

const ACTION_KINDS = /^(service|clear|mitigate|trial|cordon)/;

export function planLadder(t: AgentTask, inc: Incident | undefined, missions: Mission[]): PlanLadder {
  let plannedSteps: string[] | null = null;
  let plannedSource = 'no plan recorded';
  const ap = inc?.approval;
  const mission = t.robot_id
    ? missions
        .filter((m) => m.robot_id === t.robot_id && m.incident_id === t.incident_id && m.opened_tick >= t.started_tick - 2 && (t.ended_tick === undefined || m.opened_tick <= t.ended_tick + 2))
        .sort((a, b) => a.opened_tick - b.opened_tick)[0]
    : undefined;
  let executedOk = 0;
  let executedFailed = 0;
  let executedTotal = 0;
  let executedSource = 'tool calls';
  if (mission) {
    plannedSteps = mission.steps.map((s) => s.label);
    plannedSource = `mission ${mission.id}`;
    executedOk = mission.steps.filter((s) => s.status === 'done').length;
    executedFailed = mission.steps.filter((s) => s.status === 'failed').length;
    executedTotal = mission.steps.length;
    executedSource = `mission steps (${mission.id})`;
  } else if (ap && ap.task_id === t.id) {
    plannedSteps = ap.steps;
    plannedSource = 'approval request';
  }
  if (!mission) {
    executedTotal = t.tool_calls.length;
    executedOk = t.tool_calls.filter((c) => c.status === 'ok').length;
    executedFailed = t.tool_calls.filter((c) => c.status === 'error' || c.status === 'rejected').length;
  }
  const v = inc?.verification;
  const applicable = t.kind === 'verify' || ACTION_KINDS.test(t.kind) || t.kind === 'clear' || !!(ap && ap.task_id === t.id);
  let verification: PlanLadder['verification'];
  if (!applicable) verification = { state: 'na', passed: 0, total: 0 };
  else if (!v) verification = { state: 'not_yet', passed: 0, total: 0 };
  else
    verification = {
      state: v.status === 'verified' ? 'verified' : v.status === 'rejected' ? 'rejected' : 'pending',
      passed: v.checks.filter((c) => c.pass).length,
      total: v.checks.length,
      reason: v.failed_reason,
      attempt: v.attempt,
    };
  return { plannedSteps, plannedSource, executedOk, executedFailed, executedTotal, executedSource, verification };
}

/* ───────────── model honesty ───────────── */

export interface ModelNote {
  inference: boolean;
  headline: string;
  detail?: string;
  tone: StatusTone;
}
export function modelNote(t: AgentTask): ModelNote {
  const m = t.model;
  if (m.fallback) return { inference: false, headline: 'Deterministic fallback', detail: 'Model was unavailable; the policy engine answered. No inference occurred.', tone: 'warning' };
  if (m.provider === 'deterministic') return { inference: false, headline: 'Deterministic policy', detail: 'Rule-based step. No model call.', tone: 'isolated' };
  if (m.provider === 'mock') return { inference: false, headline: 'Mock agent', detail: 'Simulated reasoning from the development engine. No real inference occurred.', tone: 'sentinel' };
  return { inference: true, headline: `${m.provider} · ${m.model_id}`, tone: 'accent' };
}

export const latestRunning = (calls: ToolCall[]) => calls.find((c) => c.status === 'running');
