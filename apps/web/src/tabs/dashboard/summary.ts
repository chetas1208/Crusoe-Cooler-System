/**
 * Dashboard summary logic. Pure: wording and classification only, no fetching, no React.
 * Two rules drive everything here: a state we cannot verify is never shown as healthy, and a bad outcome is
 * never given a good tone.
 */
import type { SeatCard, Tone } from '../agents/seats';

/* ───────────── terminal state, in plain language ───────────── */

export interface TerminalWording {
  tone: Tone;
  headline: string;
  detail: string;
}
export interface ChecksTally {
  pass: number;
  fail: number;
  unknown: number;
  total: number;
}

export function tallyChecks(checks: Array<{ state: string }> | undefined): ChecksTally {
  const c = checks ?? [];
  return { pass: c.filter((k) => k.state === 'PASS').length, fail: c.filter((k) => k.state === 'FAIL').length, unknown: c.filter((k) => k.state !== 'PASS' && k.state !== 'FAIL').length, total: c.length };
}

/** What the incident's Definition-of-Done terminal state means, for someone who has not read the spec. */
export function terminalWording(terminal: string | null | undefined, tally: ChecksTally | null, contractAvailable: boolean): TerminalWording {
  const t = (terminal ?? '').toUpperCase();
  const checks = tally && tally.total ? `${tally.pass} of ${tally.total} checks pass${tally.fail ? `, ${tally.fail} fail` : ''}${tally.unknown ? `, ${tally.unknown} not measured` : ''}.` : '';
  switch (t) {
    case 'VERIFIED':
      return { tone: 'good', headline: 'Fixed and verified', detail: `An independent check re-measured the plant and every check held. ${checks}`.trim() };
    case 'PARTIAL':
      return { tone: 'warn', headline: 'Partly fixed', detail: `Some checks pass, others still fail, so this is not counted as fixed. ${checks}`.trim() };
    case 'CONTAINED_NOT_REPAIRED':
      return { tone: 'warn', headline: 'Contained, not repaired', detail: `The hazard is isolated, but the fault itself is still there. ${checks}`.trim() };
    case 'ESCALATED':
      return { tone: 'bad', headline: 'Handed to an operator', detail: `Automation stopped because it could not finish safely. A person has to decide next. ${checks}`.trim() };
    case 'FAILED':
      return { tone: 'bad', headline: 'Repair failed', detail: `The verifier did not accept the outcome. ${checks}`.trim() };
    case 'TIMED_OUT':
      return { tone: 'bad', headline: 'Ran out of time', detail: `The checks did not pass before the deadline. ${checks}`.trim() };
    case 'UNKNOWN':
      return { tone: 'neutral', headline: 'Outcome not known', detail: 'The system could not establish the result. Treat it as unresolved.' };
    case '':
      if (!contractAvailable) return { tone: 'neutral', headline: 'No Definition of Done published', detail: 'This backend has not published a contract for the incident, so no outcome is claimed.' };
      return { tone: 'neutral', headline: 'In progress', detail: tally && tally.total ? `Not finished. ${checks}` : 'Not finished. No checks are being evaluated yet.' };
    default:
      return { tone: 'warn', headline: 'Unrecognised outcome', detail: `The backend reported "${t.replace(/_/g, ' ').toLowerCase()}", which this page does not know. Treat it as unresolved.` };
  }
}

/* ───────────── Crusoe model status ───────────── */

export type ModelState = 'checking' | 'live' | 'degraded' | 'unavailable' | 'mock';
export interface ModelView {
  state: ModelState;
  label: string;
  detail: string;
  tone: Tone;
  modelId: string | null;
  latencyMs: number | null;
}
export interface ModelStatusWire {
  provider?: string;
  model_id?: string;
  status?: string;
  fallback_active?: boolean;
  last_latency_ms?: number;
  detail?: string;
  [k: string]: unknown;
}
export interface IntelWire {
  model_state?: string;
  status?: string;
  fallback_active?: boolean;
  calls?: number;
  failures?: number;
  invalid_outputs?: number;
  tokens_in?: number;
  tokens_out?: number;
  [k: string]: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * live / degraded / unavailable, from the model-status endpoint and the engine's own intelligence health.
 * `fetched` is false until the first answer; `failed` is true when the last request errored.
 */
export function classifyModel(ms: ModelStatusWire | null, intel: IntelWire | null | undefined, opts: { fetched: boolean; failed: boolean }): ModelView {
  const modelId = typeof ms?.model_id === 'string' && ms.model_id !== 'none' ? ms.model_id : null;
  const latencyMs = num(ms?.last_latency_ms) ?? num(intel?.last_latency_ms);
  const base = { modelId, latencyMs };
  if (!opts.fetched) return { ...base, state: 'checking', label: 'Checking', detail: 'Asking the backend for the model status.', tone: 'neutral' };
  if (opts.failed || !ms) return { ...base, state: 'unavailable', label: 'Unavailable', detail: 'The model status endpoint did not answer. Treating the model as unavailable, not as live.', tone: 'bad' };
  const status = String(ms.status ?? '').toLowerCase();
  const detailed = String(intel?.model_state ?? '').toLowerCase();
  if (status === 'mock') return { ...base, state: 'mock', label: 'Simulated', detail: 'This backend is using a mock model. No real inference is happening.', tone: 'warn' };
  if (status === 'unavailable' || detailed === 'unavailable') return { ...base, state: 'unavailable', label: 'Unavailable', detail: typeof ms.detail === 'string' ? ms.detail : 'Crusoe is not reachable. The deterministic policy engine is doing the work.', tone: 'bad' };
  if (status === 'degraded' || detailed === 'degraded' || detailed === 'fallback' || ms.fallback_active === true || intel?.fallback_active === true)
    return { ...base, state: 'degraded', label: 'Degraded', detail: detailed === 'fallback' || ms.fallback_active ? 'Some work is running on the deterministic fallback policy instead of the model.' : 'The model is answering with errors or delays.', tone: 'warn' };
  if (status === 'live') return { ...base, state: 'live', label: 'Live', detail: 'Crusoe is answering.', tone: 'good' };
  return { ...base, state: 'unavailable', label: 'Unknown', detail: `The backend reported "${status || 'nothing'}", which this page does not know. Not treated as live.`, tone: 'warn' };
}

export interface UsageView {
  tokensIn: number | null;
  tokensOut: number | null;
  calls: number | null;
  failures: number | null;
  costUsd: number | null;
}
/** tokens / calls from the engine's intelligence health, cost only if the status endpoint reports one (it is never estimated here) */
export function usageOf(ms: ModelStatusWire | null, intel: IntelWire | null | undefined): UsageView {
  const u = (typeof ms?.usage === 'object' && ms.usage !== null ? ms.usage : {}) as Record<string, unknown>;
  const cost = num(ms?.cost_usd) ?? num(ms?.spend_usd) ?? num(u.cost_usd) ?? num(u.spend_usd);
  return {
    tokensIn: num(ms?.tokens_in) ?? num(u.tokens_in) ?? num(intel?.tokens_in),
    tokensOut: num(ms?.tokens_out) ?? num(u.tokens_out) ?? num(intel?.tokens_out),
    calls: num(ms?.calls) ?? num(u.calls) ?? num(intel?.calls),
    failures: num(ms?.failures) ?? num(u.failures) ?? num(intel?.failures),
    costUsd: cost,
  };
}

export const fmtInt = (n: number | null) => (n === null ? 'not reported' : n.toLocaleString('en-US'));
export const fmtUsd = (n: number | null) => (n === null ? 'not reported' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`);

/* ───────────── five-supervisor activity ───────────── */

export interface SeatChip {
  id: string;
  label: string;
  state: SeatCard['state'];
  tone: 'run' | 'warn' | 'bad' | 'idle';
}
const SEAT_TONE: Record<SeatCard['state'], SeatChip['tone']> = { working: 'run', blocked: 'warn', failed: 'bad', done: 'idle', idle: 'idle', unknown: 'warn', no_data: 'idle' };
const SHORT: Record<SeatCard['state'], string> = { working: 'working', blocked: 'blocked', failed: 'failed', done: 'idle', idle: 'idle', unknown: 'unknown', no_data: 'no data' };

export function seatChips(cards: SeatCard[]): SeatChip[] {
  return cards.map((c) => ({ id: c.id, label: SHORT[c.state], state: c.state, tone: SEAT_TONE[c.state] }));
}
