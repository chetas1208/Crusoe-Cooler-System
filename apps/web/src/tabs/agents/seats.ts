/**
 * The five SENTINEL seats as data. Pure: no React, no fetch, no store. Input is the `/runs/{id}/incidents/{id}/team`
 * payload (seats + tasks + budgets + warnings), optionally enriched with what the world stream already knows about
 * the same tasks (outcome label) and the incident's verification. Nothing is invented: a field the wire does not
 * carry stays `null` / 'unknown' and the card says so. A failure is never given a green tone.
 */

export const SEAT_SPEC: Array<{ id: string; title: string; short: string }> = [
  { id: 'SEN-01', title: 'Goal Architect', short: 'Plans the goal, the Definition of Done and the repair' },
  { id: 'SEN-02', title: 'INPIPE Field Coordinator', short: 'Assigns and supervises in-pipe crawlers' },
  { id: 'SEN-03', title: 'OUTRIG Maintenance Coordinator', short: 'Assigns and supervises exterior maintainers' },
  { id: 'SEN-04', title: 'Safety & Governance Arbiter', short: 'Checks every action against policy and interlocks' },
  { id: 'SEN-05', title: 'Independent Verifier', short: 'Re-measures the plant; never trusts the repairer' },
];

export type Tier = 'nano' | 'super' | 'policy' | 'other' | 'none';
export type TaskState = 'working' | 'blocked' | 'queued' | 'done' | 'verified' | 'failed' | 'cancelled' | 'unknown';
export type SeatState = 'working' | 'blocked' | 'failed' | 'done' | 'idle' | 'unknown' | 'no_data';
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface SeatTask {
  id: string;
  seat: string;
  role: string;
  kind: string;
  title: string;
  rawStatus: string;
  state: TaskState;
  parent_id?: string;
  depth: number;
  robot_id?: string;
  tier: Tier;
  provider?: string;
  model_id?: string;
  latency_ms?: number;
  tool_calls: number;
}

export interface TeamWarning {
  kind: 'drift' | 'loop' | 'warning';
  text: string;
  taskId?: string;
  seat?: string;
  seq?: number;
}

export interface TeamBudget {
  maxDepth: number | null;
  depthSeen: number | null;
  maxActiveLlm: number | null;
  llmTasks: number | null;
  maxPlanRevisions: number | null;
  planRevisions: number | null;
  attempts: number | null;
}

export interface SeatTeam {
  incidentId: string;
  seats: Array<{ id: string; fn: string; taskIds: string[] }>;
  tasks: SeatTask[];
  budgets: TeamBudget | null;
  warnings: TeamWarning[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const txt = (v: unknown, max = 120): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(CTRL, '').trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function taskState(raw: unknown): TaskState {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'working' || s === 'running' || s === 'in_progress') return 'working';
  if (s === 'blocked' || s === 'suspended' || s === 'waiting') return 'blocked';
  if (s === 'queued' || s === 'pending') return 'queued';
  if (s === 'verified') return 'verified';
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'failed' || s === 'rejected' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'unknown';
}

/** Model tier from the decision metadata the backend recorded on the task. Never guessed from the title. */
export function tierOf(m: { provider?: string; model_id?: string; fallback?: boolean } | undefined): Tier {
  if (!m || (!m.provider && !m.model_id)) return 'none';
  const id = m.model_id ?? '';
  if (m.provider === 'deterministic' || m.provider === 'mock' || m.fallback === true || /policy-engine|deterministic/i.test(id)) return 'policy';
  if (/nano/i.test(id)) return 'nano';
  if (/super/i.test(id)) return 'super';
  return 'other';
}

export const TIER_LABEL: Record<Tier, string> = { nano: 'Nano', super: 'Super', policy: 'Policy engine', other: 'Other model', none: 'No model data' };

export function parseSeatTeam(raw: unknown, incidentId: string): SeatTeam | null {
  if (!isObj(raw) || !Array.isArray(raw.tasks)) return null;
  const tasks: SeatTask[] = raw.tasks.flatMap((t: unknown) => {
    if (!isObj(t)) return [];
    const id = txt(t.id, 80);
    if (!id) return [];
    const m = isObj(t.model) ? t.model : undefined;
    const model = m ? { provider: txt(m.provider, 30), model_id: txt(m.model_id, 80), fallback: typeof m.fallback === 'boolean' ? m.fallback : undefined } : undefined;
    return [
      {
        id,
        seat: txt(t.seat ?? t.agent_id, 20) ?? 'SEN-01',
        role: (txt(t.role, 24) ?? 'sentinel').toLowerCase(),
        kind: txt(t.kind, 40) ?? '',
        title: txt(t.title, 120) ?? id,
        rawStatus: txt(t.status, 24) ?? 'unknown',
        state: taskState(t.status),
        parent_id: txt(t.parent_id, 80),
        depth: num(t.depth) ?? 0,
        robot_id: txt(t.robot_id, 40),
        tier: tierOf(model),
        provider: model?.provider,
        model_id: model?.model_id,
        latency_ms: m ? num(m.latency_ms) : undefined,
        tool_calls: num(t.tool_calls) ?? 0,
      },
    ];
  });
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  const seats = (Array.isArray(raw.seats) ? raw.seats : []).flatMap((s: unknown) => {
    if (!isObj(s)) return [];
    const id = txt(s.seat ?? s.id, 20);
    return id ? [{ id, fn: txt(s.function, 60) ?? '', taskIds: Array.isArray(s.tasks) ? s.tasks.filter((x): x is string => typeof x === 'string') : [] }] : [];
  });
  const b = isObj(raw.budgets) ? raw.budgets : null;
  const lim = b && isObj(b.limits) ? b.limits : {};
  const budgets: TeamBudget | null = b
    ? {
        maxDepth: num(lim.max_depth) ?? null,
        depthSeen: num(b.max_depth_seen) ?? null,
        maxActiveLlm: num(lim.max_active_llm_subtasks_per_incident) ?? null,
        llmTasks: num(b.llm_tasks) ?? null,
        maxPlanRevisions: num(lim.max_plan_revisions) ?? null,
        planRevisions: num(b.plan_revisions) ?? null,
        attempts: num(b.attempts) ?? null,
      }
    : null;
  const warnings: TeamWarning[] = (Array.isArray(raw.warnings) ? raw.warnings : []).flatMap((w: unknown): TeamWarning[] => {
    if (typeof w === 'string') return [{ kind: 'warning' as const, text: txt(w, 160) ?? 'warning' }];
    if (!isObj(w)) return [];
    const type = String(w.type ?? w.kind ?? 'warning');
    const kind: TeamWarning['kind'] = /drift/i.test(type) ? 'drift' : /loop/i.test(type) ? 'loop' : 'warning';
    const detail = txt(w.message ?? w.text ?? w.reason ?? w.detail) ?? txt(typeof w.kind === 'string' && !/\./.test(w.kind) ? w.kind.replace(/_/g, ' ') : undefined) ?? txt(typeof w.stage === 'string' ? `stage ${w.stage}` : undefined);
    return [{ kind, text: detail ?? `${kind} detected`, taskId: txt(w.task_id, 80), seat: txt(w.seat ?? w.agent_id, 20), seq: num(w.seq) }];
  });
  return { incidentId, seats, tasks, budgets, warnings };
}

/* ───────────── per-seat card model ───────────── */

export interface Verdict {
  tone: Tone;
  text: string;
}
export interface VerificationInfo {
  status: string;
  passed: number;
  total: number;
  reason?: string;
  attempt?: number;
}
export interface SeatEnrich {
  /** world-stream outcome per task id: the label the agent itself recorded and whether it was ok */
  outcomes?: Record<string, { label: string; ok: boolean } | undefined>;
  verification?: VerificationInfo | null;
}
export interface SeatCard {
  id: string;
  title: string;
  fn: string;
  short: string;
  state: SeatState;
  stateLabel: string;
  currentTask: SeatTask | null;
  lastTask: SeatTask | null;
  /** the most recent task's tier, then the tally across the seat's tasks */
  tier: Tier;
  tierTally: Array<{ tier: Tier; n: number }>;
  modelCalls: number;
  toolCalls: number;
  taskCount: number;
  warnings: TeamWarning[];
  verdict: Verdict | null;
}

const ACTIVE: TaskState[] = ['blocked', 'working', 'queued'];
const FINISHED: TaskState[] = ['done', 'verified', 'failed', 'cancelled'];

function verdictOf(seat: string, last: SeatTask | null, enrich: SeatEnrich): Verdict | null {
  if (seat === 'SEN-05' && enrich.verification) {
    const v = enrich.verification;
    const checks = v.total ? ` ${v.passed}/${v.total} checks` : '';
    const att = v.attempt ? `, attempt ${v.attempt}` : '';
    if (v.status === 'verified') return { tone: 'good', text: `Verified${checks}${att}` };
    if (v.status === 'rejected') return { tone: 'bad', text: `Rejected${checks}${att}${v.reason ? `: ${v.reason}` : ''}` };
    return { tone: 'neutral', text: `Verification ${v.status || 'pending'}${checks}` };
  }
  if (!last) return null;
  const o = enrich.outcomes?.[last.id];
  switch (last.state) {
    case 'verified':
      return { tone: 'good', text: `Verified: ${last.title}` };
    case 'failed':
      return { tone: 'bad', text: `${last.rawStatus === 'rejected' ? 'Rejected' : 'Failed'}: ${o?.label ?? last.title}` };
    case 'cancelled':
      return { tone: 'neutral', text: `Cancelled: ${last.title}` };
    case 'done':
      return o && o.ok === false ? { tone: 'warn', text: `Negative result: ${o.label}` } : { tone: 'neutral', text: `Completed: ${o?.label ?? last.title}` };
    default:
      return null;
  }
}

export function deriveSeatCards(team: SeatTeam | null, enrich: SeatEnrich = {}): SeatCard[] {
  return SEAT_SPEC.map((spec) => {
    const fn = team?.seats.find((s) => s.id === spec.id)?.fn ?? '';
    if (!team) {
      return { id: spec.id, title: spec.title, fn, short: spec.short, state: 'no_data', stateLabel: 'No data', currentTask: null, lastTask: null, tier: 'none', tierTally: [], modelCalls: 0, toolCalls: 0, taskCount: 0, warnings: [], verdict: null };
    }
    const mine = team.tasks.filter((t) => t.seat === spec.id);
    const active = mine.filter((t) => ACTIVE.includes(t.state));
    const current = active.find((t) => t.state === 'blocked') ?? active.find((t) => t.state === 'working') ?? active[0] ?? null;
    const finished = mine.filter((t) => FINISHED.includes(t.state));
    const last = finished[finished.length - 1] ?? null;
    const tally = new Map<Tier, number>();
    for (const t of mine) tally.set(t.tier, (tally.get(t.tier) ?? 0) + 1);
    const latest = current ?? mine[mine.length - 1] ?? null;
    const ownTaskIds = new Set(mine.map((t) => t.id));
    const warnings = team.warnings.filter((w) => w.seat === spec.id || (w.taskId && ownTaskIds.has(w.taskId)));
    let state: SeatState;
    let stateLabel: string;
    if (current?.state === 'blocked') (state = 'blocked'), (stateLabel = 'Blocked');
    else if (current?.state === 'working') (state = 'working'), (stateLabel = 'Working');
    else if (current) (state = 'working'), (stateLabel = 'Queued');
    else if (!mine.length) (state = 'idle'), (stateLabel = 'Idle');
    else if (latest?.state === 'unknown') (state = 'unknown'), (stateLabel = `Unrecognised state (${latest.rawStatus})`);
    else if (last?.state === 'failed') (state = 'failed'), (stateLabel = last.rawStatus === 'rejected' ? 'Last task rejected' : 'Last task failed');
    else (state = 'done'), (stateLabel = 'Idle · last task done');
    const verdict = verdictOf(spec.id, last, enrich);
    // a verifier rejection is a failure even when the task that carried it "completed"
    if (spec.id === 'SEN-05' && verdict?.tone === 'bad' && state === 'done') (state = 'failed'), (stateLabel = 'Rejected the repair');
    return {
      id: spec.id,
      title: spec.title,
      fn,
      short: spec.short,
      state,
      stateLabel,
      currentTask: current,
      lastTask: last,
      tier: latest?.tier ?? 'none',
      tierTally: [...tally.entries()].map(([tier, n]) => ({ tier, n })).sort((a, b) => b.n - a.n),
      modelCalls: mine.filter((t) => t.tier === 'nano' || t.tier === 'super' || t.tier === 'other').length,
      toolCalls: mine.reduce((a, t) => a + t.tool_calls, 0),
      taskCount: mine.length,
      warnings,
      verdict,
    };
  });
}

/** warnings that name no seat or task: they belong to the incident, not to a card */
export function incidentWarnings(team: SeatTeam | null): TeamWarning[] {
  if (!team) return [];
  const owned = new Set(team.tasks.map((t) => t.id));
  return team.warnings.filter((w) => !w.seat && !(w.taskId && owned.has(w.taskId)));
}

/** LLM tasks running right now against the incident's concurrent-LLM limit (null when the server gives no limit) */
export function activeLlm(team: SeatTeam | null): { active: number; limit: number | null } {
  const active = (team?.tasks ?? []).filter((t) => (t.state === 'working' || t.state === 'blocked') && (t.tier === 'nano' || t.tier === 'super' || t.tier === 'other')).length;
  return { active, limit: team?.budgets?.maxActiveLlm ?? null };
}

export const STATE_TONE: Record<SeatState, Tone | 'idle'> = { working: 'neutral', blocked: 'warn', failed: 'bad', done: 'idle', idle: 'idle', unknown: 'warn', no_data: 'idle' };
