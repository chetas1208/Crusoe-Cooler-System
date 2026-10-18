/**
 * Agent-envelope message kinds on the delegation graph's edges. Pure.
 * An edge parent -> child gets the envelope kinds the run log recorded for the CHILD task (TASK_ASSIGN, ACK, REPLAN,
 * SAFETY_VETO, MODEL_ERROR ...). Verification envelopes carry no task id, so they are paired by order with the
 * incident's verify tasks and never invented: an edge with no recorded envelope has no label.
 */

export interface EnvEvent {
  seq: number;
  kind: string;
  subtype?: string;
  task_id?: string | null;
  status?: string;
}
export interface EnvTag {
  kind: string;
  /** a failure kind or a negative outcome: drawn amber / red, never green */
  bad: boolean;
}
export interface EnvTask {
  id: string;
  kind: string;
  seat?: string;
}

/** delegation-relevant kinds, most significant first; tool chatter and progress ticks are deliberately absent */
export const ENV_PRIORITY = ['SAFETY_VETO', 'PLAN_REJECTED', 'MODEL_ERROR', 'ESCALATION', 'REPLAN', 'VERIFICATION_RESULT', 'VERIFICATION_REQUEST', 'TASK_ASSIGN', 'ACK', 'PROPOSE_PLAN', 'PLAN_APPROVED', 'HUMAN_OVERRIDE'] as const;
const RELEVANT = new Set<string>(ENV_PRIORITY);
const BAD = new Set(['SAFETY_VETO', 'PLAN_REJECTED', 'MODEL_ERROR', 'ESCALATION']);

const rank = (k: string) => {
  const i = (ENV_PRIORITY as readonly string[]).indexOf(k);
  return i < 0 ? 99 : i;
};

export function parseEnvEvents(raw: unknown): EnvEvent[] {
  const evs = typeof raw === 'object' && raw !== null && Array.isArray((raw as { events?: unknown }).events) ? ((raw as { events: unknown[] }).events as unknown[]) : [];
  return evs.flatMap((e) => {
    if (typeof e !== 'object' || e === null) return [];
    const o = e as Record<string, unknown>;
    const kind = typeof o.kind === 'string' && /^[A-Z_]+$/.test(o.kind) ? o.kind : undefined;
    const seq = typeof o.seq === 'number' ? o.seq : undefined;
    if (!kind || seq === undefined) return [];
    return [{ seq, kind, subtype: typeof o.subtype === 'string' ? o.subtype : undefined, task_id: typeof o.task_id === 'string' ? o.task_id : null, status: typeof o.status === 'string' ? o.status : undefined }];
  });
}

/** child task id -> envelope tags, most significant first, de-duplicated */
export function edgeEnvelopes(events: EnvEvent[], tasks: EnvTask[]): Record<string, EnvTag[]> {
  const ids = new Set(tasks.map((t) => t.id));
  const by = new Map<string, Map<string, boolean>>();
  const add = (id: string, kind: string, bad: boolean) => {
    const m = by.get(id) ?? new Map<string, boolean>();
    m.set(kind, (m.get(kind) ?? false) || bad);
    by.set(id, m);
  };
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) if (e.task_id && ids.has(e.task_id) && RELEVANT.has(e.kind) && e.kind !== 'VERIFICATION_REQUEST' && e.kind !== 'VERIFICATION_RESULT') add(e.task_id, e.kind, BAD.has(e.kind));
  // verification: k-th attempt <-> k-th verify task
  const verifyTasks = tasks.filter((t) => t.kind === 'verify' || t.seat === 'SEN-05').sort((a, b) => a.id.localeCompare(b.id));
  const requests = ordered.filter((e) => e.kind === 'VERIFICATION_REQUEST' && /verification\.started$/.test(e.subtype ?? ''));
  const results = ordered.filter((e) => e.kind === 'VERIFICATION_RESULT' && /verification\.(passed|failed|rejected)$/.test(e.subtype ?? ''));
  verifyTasks.forEach((t, i) => {
    if (requests[i]) add(t.id, 'VERIFICATION_REQUEST', false);
    const r = results[i];
    if (r) add(t.id, 'VERIFICATION_RESULT', !/passed$/.test(r.subtype ?? ''));
  });
  const out: Record<string, EnvTag[]> = {};
  for (const [id, m] of by) out[id] = [...m.entries()].map(([kind, bad]) => ({ kind, bad })).sort((a, b) => rank(a.kind) - rank(b.kind));
  return out;
}

/** the one-line edge label: the most significant kind, plus how many more were recorded */
export function edgeLabel(tags: EnvTag[] | undefined): { text: string; bad: boolean; title: string } | null {
  if (!tags?.length) return null;
  const [first, ...rest] = tags;
  return { text: rest.length ? `${first.kind} +${rest.length}` : first.kind, bad: tags.some((t) => t.bad), title: tags.map((t) => t.kind).join(', ') };
}
