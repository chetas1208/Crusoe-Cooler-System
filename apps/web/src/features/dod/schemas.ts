import { cleanText } from '../communications/schemas';
import type { CheckState, DodCheck, DodContract, TeamGraph, TeamMember, TeamTask } from './types';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const txt = (x: unknown, n = 160): string | undefined => (typeof x === 'string' && x ? cleanText(x, n) : undefined);

function checkState(x: unknown): CheckState {
  const s = String(x ?? '').toUpperCase();
  return s === 'PASS' || s === 'PASSED' ? 'PASS' : s === 'FAIL' || s === 'FAILED' ? 'FAIL' : 'UNKNOWN';
}

const CMP: Record<string, string> = { min: '>=', max: '<=' };

/** `ev` = the evaluation entry for this check ({status: pending|failing|passing|held, measured, held_s, ...}) when the contract is being evaluated */
function parseCheck(raw: unknown, i: number, ev?: unknown): DodCheck | null {
  if (!isObj(raw)) return null;
  const e = isObj(ev) ? ev : {};
  const m = e.measured ?? raw.measured ?? raw.measured_value ?? raw.value;
  const measured = typeof m === 'number' && Number.isFinite(m) ? m : typeof m === 'string' ? cleanText(m, 60) : null;
  const status = String(e.status ?? raw.state ?? raw.status ?? '').toLowerCase();
  const hold = num(raw.hold_sim_s ?? raw.hold_required_s ?? raw.hold_s ?? raw.hold_period_s);
  let state: CheckState = status === 'held' || status === 'pass' || status === 'passed' || status === 'passing' ? 'PASS' : status === 'fail' || status === 'failed' || status === 'failing' ? 'FAIL' : 'UNKNOWN';
  // never PASS without a measurement, and "passing" only counts once the hold elapsed or the server says held
  if (measured === null && state === 'PASS') state = 'UNKNOWN';
  const heldS = num(e.held_s ?? raw.hold_elapsed_s ?? raw.held_s);
  return {
    id: txt(raw.check_id ?? raw.id, 80) ?? `check_${i + 1}`,
    label: txt(raw.label ?? raw.description ?? raw.name, 200) ?? txt(raw.metric ?? raw.type, 80) ?? `Check ${i + 1}`,
    asset_id: txt(Array.isArray(raw.subject) ? raw.subject[0] : raw.asset_id, 80),
    metric: txt(raw.metric ?? raw.type, 80),
    comparator: txt(CMP[String(raw.direction)] ?? raw.comparator ?? raw.op, 12),
    threshold: typeof raw.threshold === 'number' || typeof raw.threshold === 'string' ? (typeof raw.threshold === 'string' ? cleanText(raw.threshold, 40) : raw.threshold) : undefined,
    unit: txt(raw.unit, 16),
    measured,
    hold_required_s: hold,
    hold_elapsed_s: heldS,
    state,
    evidence_ids: Array.isArray(raw.evidence_ids) ? raw.evidence_ids.slice(0, 40).map((x) => cleanText(x, 120)).filter(Boolean) : [],
    evaluated_tick: num(e.evaluated_tick ?? raw.evaluated_tick ?? raw.last_evaluated_tick),
  };
}

export function parseContract(raw: unknown): DodContract | null {
  const c = isObj(raw) && isObj(raw.contract) ? raw.contract : raw;
  if (!isObj(c)) return null;
  const evChecks = isObj(c.evaluation) && isObj(c.evaluation.checks) ? c.evaluation.checks : {};
  const checks = (Array.isArray(c.checks) ? c.checks : []).map((k, i) => parseCheck(k, i, isObj(k) ? evChecks[String(k.id ?? k.check_id)] : undefined)).filter((x): x is DodCheck => x !== null);
  const id = txt(c.contract_id ?? c.id, 80);
  if (!id && !checks.length) return null;
  const term = txt(c.terminal_state ?? c.terminal, 40);
  const revs = Array.isArray(c.revisions) ? c.revisions : [];
  const lastRev = revs.length && isObj(revs[revs.length - 1]) ? (revs[revs.length - 1] as Record<string, unknown>) : null;
  return {
    contract_id: id ?? 'contract',
    revision: num(c.version ?? c.revision) ?? 1,
    lifecycle: (txt(c.lifecycle ?? c.state, 20) ?? 'PROPOSED').toUpperCase(),
    revision_reason: txt(lastRev?.reason ?? c.revision_reason ?? c.reason, 240),
    frozen_tick: num(c.frozen_tick),
    checks,
    terminal: term ? term.toUpperCase() : null,
    why_not_done: txt(isObj(raw) ? (raw.why_not_done ?? c.why_not_done) : c.why_not_done, 300),
  };
}

export function parseTeam(raw: unknown): TeamGraph {
  const r = isObj(raw) ? raw : {};
  const members: TeamMember[] = (Array.isArray(r.seats) ? r.seats : Array.isArray(r.members) ? r.members : Array.isArray(r.agents) ? r.agents : []).flatMap((m: unknown) => {
    if (!isObj(m)) return [];
    const id = txt(m.seat ?? m.id, 40);
    const open = Array.isArray(m.tasks) ? m.tasks.length : undefined;
    return id ? [{ id, role: txt(m.role, 40) ?? 'sentinel', title: txt(m.title ?? m.name ?? m.function, 80) ?? id, status: txt(m.status, 24) ?? (open === undefined ? undefined : open ? `${open} task${open === 1 ? '' : 's'}` : 'no tasks') }] : [];
  });
  const tasks: TeamTask[] = (Array.isArray(r.tasks) ? r.tasks : []).flatMap((t: unknown) => {
    if (!isObj(t)) return [];
    const id = txt(t.task_id ?? t.id, 80);
    if (!id) return [];
    const b = isObj(t.budget) ? t.budget : {};
    const mdl = isObj(t.model) ? t.model : undefined;
    return [{
      id,
      title: txt(t.title ?? t.summary, 160) ?? id,
      role: (txt(t.role, 24) ?? 'sentinel').toLowerCase(),
      owner: txt(t.robot_id ?? (isObj(t.owner) ? t.owner.id : t.owner ?? t.owner_id) ?? t.seat, 40),
      parent_id: txt(t.parent_id ?? t.parent_task_id, 80),
      incident_id: txt(t.incident_id, 80),
      depth: num(t.depth) ?? 0,
      status: (txt(t.status, 24) ?? 'queued').toLowerCase(),
      budget_used: num(b.used ?? t.budget_used),
      budget_limit: num(b.limit ?? t.budget_limit),
      budget_unit: txt(b.unit ?? t.budget_unit, 16),
      kind: txt(t.kind, 24),
      tool_calls: num(t.tool_calls),
      model: mdl ? { provider: txt(mdl.provider, 30), model_id: txt(mdl.model_id, 60), fallback: typeof mdl.fallback === 'boolean' ? mdl.fallback : undefined, latency_ms: num(mdl.latency_ms) } : undefined,
      warnings: [],
    }];
  });
  const bd = isObj(r.budgets) ? r.budgets : null;
  const lim = bd && isObj(bd.limits) ? bd.limits : {};
  const budgets = bd ? { max_depth: num(lim.max_depth) ?? null, depth_seen: num(bd.max_depth_seen) ?? null, max_llm_tasks: num(lim.max_active_llm_subtasks_per_incident) ?? null, llm_tasks: num(bd.llm_tasks) ?? null, max_plan_revisions: num(lim.max_plan_revisions) ?? null, plan_revisions: num(bd.plan_revisions) ?? null, attempts: num(bd.attempts) ?? null } : null;
  const warnings: Array<{ kind: string; text: string; seq?: number }> = (Array.isArray(r.warnings) ? r.warnings : []).flatMap((w: unknown) => {
    if (typeof w === 'string') return [{ kind: 'warning', text: cleanText(w, 200) }];
    if (!isObj(w)) return [];
    const kind = String(w.type ?? w.kind ?? 'warning').replace(/\.detected$/, '');
    const text = txt(w.message ?? w.text ?? w.reason ?? w.detail, 200) ?? `${kind} detected${w.task_id ? ` on ${String(w.task_id)}` : ''}`;
    return [{ kind, text, seq: num(w.seq) }];
  });
  // attach each warning to the task it names so it shows on that task, and keep the rest at the top of the panel
  const loose: TeamGraph['warnings'] = [];
  for (const w of warnings) {
    const raw = (Array.isArray(r.warnings) ? r.warnings : []).find((x) => isObj(x) && num(x.seq) === w.seq);
    const tid = isObj(raw) ? txt(raw.task_id, 80) : undefined;
    const t = tasks.find((x) => x.id === tid);
    if (t) t.warnings.push({ kind: w.kind, text: w.text });
    else loose.push(w);
  }
  return { members, tasks, budgets, warnings: loose };
}

/**
 * The always-visible "why not done yet" line. A server sentence wins. Otherwise it is derived from the checks only
 * (never from timers, animation or elapsed wall time) and says exactly which check blocks completion and why.
 */
export function whyNotDone(c: DodContract | null): { done: boolean; text: string } {
  if (!c) return { done: false, text: 'No Definition of Done has been published for this run yet.' };
  if (c.terminal === 'VERIFIED') return { done: true, text: 'Verified: every frozen check passed and held.' };
  if (c.why_not_done) return { done: false, text: c.why_not_done };
  if (c.terminal && c.terminal !== 'UNKNOWN') return { done: false, text: `Run ended as ${c.terminal.replace(/_/g, ' ').toLowerCase()}; not verified.` };
  const life = String(c.lifecycle);
  if (life === 'PROPOSED' || life === 'VALIDATED') return { done: false, text: `Contract is ${life.toLowerCase()}, not frozen yet: nothing is being evaluated.` };
  if (!c.checks.length) return { done: false, text: 'The frozen contract has no checks, so nothing can be verified.' };
  const fail = c.checks.find((k) => k.state === 'FAIL');
  if (fail) return { done: false, text: `${fail.label}: measured ${fmtVal(fail.measured, fail.unit)} against ${fail.comparator ?? ''} ${fail.threshold ?? '?'}${fail.unit ? ' ' + fail.unit : ''}.` };
  const unknown = c.checks.find((k) => k.state === 'UNKNOWN');
  if (unknown) return { done: false, text: `${unknown.label}: ${unknown.measured === null ? 'not measured yet' : 'result unknown'}.` };
  const hold = c.checks.find((k) => k.hold_required_s !== undefined && (k.hold_elapsed_s ?? 0) < k.hold_required_s);
  if (hold) return { done: false, text: `${hold.label}: passing, but held ${fmtS(hold.hold_elapsed_s ?? 0)} of the required ${fmtS(hold.hold_required_s!)}.` };
  return { done: false, text: 'All checks pass now; waiting for the independent verifier to record the terminal state.' };
}

export const fmtVal = (v: number | string | null, unit?: string) => (v === null ? 'not measured' : `${typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : v}${unit ? ' ' + unit : ''}`);
export const fmtS = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)} s`);
