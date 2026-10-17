import type { CommunicationEventV1, Party } from './types';

/**
 * Hand-rolled validation at the trust boundary. Everything that reaches the store has bounded lengths, no control
 * characters and the right types; anything else is dropped with a reason (counted, never silently shown).
 * The panel renders these strings as React text nodes only: they are never interpreted as HTML.
 */
const MAX_SUMMARY = 600;
const MAX_ID = 160;
const MAX_EVIDENCE = 60;

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g; // control + bidi override characters

export const cleanText = (s: unknown, max: number): string => String(s ?? '').replace(CTRL, '').slice(0, max);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const optId = (x: unknown): string | undefined => (typeof x === 'string' && x ? cleanText(x, MAX_ID) : undefined);

function party(x: unknown): Party | null {
  if (!isObj(x)) return null;
  const id = optId(x.id);
  if (!id) return null;
  return { kind: cleanText(x.kind ?? 'agent', 40), id, class: cleanText(x.class ?? x.kind ?? 'unknown', 40).toLowerCase() };
}

export type ParseResult = { ok: true; event: CommunicationEventV1 } | { ok: false; reason: string };

export function parseCommunicationEvent(raw: unknown, fallbackSeq?: number, fallbackRun?: string): ParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'not an object' };
  const seq = num(raw.seq) ?? fallbackSeq ?? null;
  if (seq === null || seq < 0) return { ok: false, reason: 'missing seq' };
  const run = optId(raw.run_id) ?? fallbackRun;
  if (!run) return { ok: false, reason: 'missing run_id' };
  const id = optId(raw.event_id) ?? `${run}#${seq}`;
  const sender = party(raw.sender);
  if (!sender) return { ok: false, reason: 'missing sender' };
  const summary = cleanText(raw.summary, MAX_SUMMARY).trim();
  if (!summary) return { ok: false, reason: 'empty summary' };
  const tick = num(raw.sim_tick);
  if (tick === null) return { ok: false, reason: 'missing sim_tick' };
  const ev: CommunicationEventV1 = {
    event_id: id,
    run_id: run,
    seq,
    sim_tick: tick,
    sim_time_ms: num(raw.sim_time_ms) ?? tick * 500,
    wall_time_utc: cleanText(raw.wall_time_utc ?? '', 40),
    sender,
    message_type: cleanText(raw.message_type ?? raw.kind ?? 'agent_message', 40),
    summary,
    schema_version: cleanText(raw.schema_version ?? '1', 20),
  };
  const rec = party(raw.recipient);
  if (rec) ev.recipient = rec;
  const pid = optId(raw.parent_task_id);
  if (pid && !ev.parent_id) ev.parent_id = pid;
  for (const k of ['thread_id', 'task_id', 'parent_id', 'mission_id', 'incident_id', 'asset_id', 'robot_id'] as const) {
    const v = optId(raw[k]);
    if (v) ev[k] = v;
  }
  for (const k of ['kind', 'message_id', 'priority', 'subtype', 'causal_event_id', 'phase', 'status', 'model_provider', 'model_id', 'visibility'] as const) {
    const v = typeof raw[k] === 'string' ? cleanText(raw[k], 80) : '';
    if (v) ev[k] = v;
  }
  if (Array.isArray(raw.evidence_ids)) ev.evidence_ids = raw.evidence_ids.slice(0, MAX_EVIDENCE).map((e) => cleanText(e, MAX_ID)).filter(Boolean);
  if (isObj(raw.detail)) ev.detail = sanitizeDetail(raw.detail, 0) as Record<string, unknown>;
  return { ok: true, event: ev };
}

/** keep detail small and plain: depth <= 4, strings bounded, no functions/odd types */
function sanitizeDetail(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return cleanText(v, 400);
  if (depth >= 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => sanitizeDetail(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [cleanText(k, 60), sanitizeDetail(x, depth + 1)]));
  return String(v).slice(0, 60);
}

/** accepts a bare envelope, `{payload: envelope}` (stream event) or a REST page */
export function unwrapStreamPayload(e: { seq?: number; run_id?: string; payload?: unknown } & Record<string, unknown>): { raw: unknown; seq?: number; run?: string } {
  const p = isObj(e.payload) && ('summary' in e.payload || 'sender' in e.payload) ? e.payload : e;
  return { raw: p, seq: num(e.seq) ?? undefined, run: typeof e.run_id === 'string' ? e.run_id : undefined };
}
