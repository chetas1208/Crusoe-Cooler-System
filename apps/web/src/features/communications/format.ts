import type { CommunicationEventV1 } from './types';
import { isFailure } from './communicationStore';

export const fmtSim = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const KIND_LABEL: Record<string, string> = {
  agent_message: 'Message',
  task_transition: 'Task',
  tool_event: 'Tool',
  verification: 'Verification',
  safety: 'Safety',
  operator: 'Operator',
  simulation: 'Simulation',
  provider: 'Provider',
};
const V11_LABEL: Record<string, string> = {
  TASK_ASSIGN: 'Task assigned', ACK: 'Acknowledged', OBSERVATION: 'Observation', HYPOTHESIS: 'Hypothesis', REQUEST_TOOL: 'Tool requested', TOOL_ACCEPTED: 'Tool accepted', TOOL_REJECTED: 'Tool rejected',
  PROPOSE_PLAN: 'Plan proposed', PLAN_APPROVED: 'Plan approved', PLAN_REJECTED: 'Plan rejected', SAFETY_VETO: 'Safety veto', PROGRESS: 'Progress', REPLAN: 'Replan', VERIFICATION_REQUEST: 'Verification requested',
  VERIFICATION_RESULT: 'Verification result', ESCALATION: 'Escalation', STOP: 'Stop', HEARTBEAT: 'Heartbeat', MODEL_ERROR: 'Model error', HUMAN_OVERRIDE: 'Human override',
};
/** the envelope kind when there is one, else the V10 message type */
export const eventKind = (e: { kind?: string; message_type: string }) => (e.kind && /^[A-Z_]+$/.test(e.kind) ? e.kind : e.message_type);
export const kindLabel = (k: string) => KIND_LABEL[k] ?? V11_LABEL[k] ?? k.replace(/_/g, ' ').toLowerCase();

export const CLASS_TONE: Record<string, string> = { sentinel: '#a78bfa', inpipe: '#2fd3e8', outrig: '#ff9a3c', operator: '#5be3d0', verifier: '#41d6a3', provider: '#8fb4ff', system: '#8b93a7' };
export const toneOf = (c: string) => CLASS_TONE[c] ?? '#8b93a7';

export const partyLabel = (p?: { id: string; class: string }) => (p ? p.id : '');

export function aria(e: CommunicationEventV1) {
  return `${fmtSim(e.sim_time_ms)} ${e.sender.id}${e.recipient ? ` to ${e.recipient.id}` : ''}, ${kindLabel(eventKind(e))}${e.status ? `, ${e.status}` : ''}. ${e.summary}`;
}

/** "2026-10-17T23:44:44.483Z" -> "2026-10-17 23:44:44 UTC" (shown on hover over the sim time) */
export const fmtWall = (iso?: string) => (iso ? `${iso.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '')} UTC` : '');

export type Tone = 'bad' | 'good' | 'warn' | 'info' | 'mute';
export type OutcomeId = 'failed' | 'rejected' | 'blocked' | 'verified' | 'accepted' | 'escalated' | 'warning' | 'pending' | 'done';
export interface Outcome {
  id: OutcomeId;
  label: string;
  tone: Tone;
}
const lc = (x?: string) => (x ?? '').toLowerCase();
const dstr = (e: CommunicationEventV1, k: string) => {
  const v = e.detail?.[k];
  return typeof v === 'string' ? v.toLowerCase() : '';
};

/**
 * What happened to this message, in one word. Derived only from fields the backend sent: a message is "verified" only when the
 * envelope says so (a passing verification subtype, a VERIFIED terminal state or a pass verdict), never because it merely completed.
 */
export function outcomeOf(e: CommunicationEventV1): Outcome | null {
  const k = eventKind(e);
  const st = lc(e.status);
  const sub = lc(e.subtype);
  if (k === 'TOOL_REJECTED' || k === 'PLAN_REJECTED' || k === 'SAFETY_VETO' || /^(rejected|denied|refused)/.test(st)) return { id: 'rejected', label: k === 'SAFETY_VETO' ? 'Vetoed' : 'Rejected', tone: 'bad' };
  if (k === 'MODEL_ERROR' || /^(failed|error|timeout|aborted|expired|unavailable)/.test(st) || /(\.|^)(failed|error)$/.test(sub)) return { id: 'failed', label: 'Failed', tone: 'bad' };
  if (st === 'blocked' || lc(e.phase) === 'blocked' || /(\.|^)(blocked|denied|deadman)$/.test(sub)) return { id: 'blocked', label: 'Blocked', tone: 'bad' };
  if (k === 'VERIFICATION_RESULT' || k === 'PLAN_APPROVED' || st === 'verified') {
    const verdict = dstr(e, 'verdict');
    if (st === 'verified' || /(passed|verified)$/.test(sub) || dstr(e, 'terminal_state') === 'verified' || verdict === 'pass' || verdict === 'passed' || verdict === 'verified') return { id: 'verified', label: 'Verified', tone: 'good' };
    if (k === 'PLAN_APPROVED') return { id: 'accepted', label: 'Approved', tone: 'good' };
  }
  if (k === 'ESCALATION' && st !== 'ok') return { id: 'escalated', label: 'Escalated', tone: 'warn' };
  if (isFailure(e)) return { id: 'failed', label: 'Failed', tone: 'bad' };
  if (k === 'TOOL_ACCEPTED' || k === 'ACK' || st === 'accepted') return { id: 'accepted', label: 'Accepted', tone: 'good' };
  if (st === 'warning' || st === 'watch') return { id: 'warning', label: 'Warning', tone: 'warn' };
  if (st === 'pending' || st === 'requested' || st === 'running') return { id: 'pending', label: 'Pending', tone: 'info' };
  if (st === 'ok' || st === 'done' || st === 'completed') return { id: 'done', label: 'Done', tone: 'mute' };
  return null;
}

export interface MsgChip {
  id: 'tool' | 'model' | 'tokens' | 'evidence' | 'robot' | 'task' | 'asset';
  text: string;
  title: string;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const shortModel = (id: string) => id.replace(/^[^/]+\//, '').replace(/NVIDIA-/i, '');

/** the small evidence / tool / model chips under a row, from real fields only */
export function chipsOf(e: CommunicationEventV1): MsgChip[] {
  const d = e.detail ?? {};
  const out: MsgChip[] = [];
  const tool = typeof d.tool === 'string' ? d.tool : '';
  const lat = num(d.latency_ms);
  if (tool) out.push({ id: 'tool', text: lat !== null ? `${tool} ${fmtMs(lat)}` : tool, title: `Tool ${tool}${lat !== null ? `, ${fmtMs(lat)}` : ''}` });
  if (e.model_id) out.push({ id: 'model', text: shortModel(e.model_id), title: `Model ${e.model_id}${e.model_provider ? ` via ${e.model_provider}` : ''}${!tool && lat !== null ? `, ${fmtMs(lat)}` : ''}` });
  const ti = num(d.tokens_in);
  const to = num(d.tokens_out);
  if (ti !== null || to !== null) out.push({ id: 'tokens', text: `${ti ?? '?'} in / ${to ?? '?'} out`, title: 'Tokens in and out' });
  if (e.evidence_ids?.length) out.push({ id: 'evidence', text: `${e.evidence_ids.length} evidence`, title: `${e.evidence_ids.length} evidence id${e.evidence_ids.length === 1 ? '' : 's'}` });
  if (e.robot_id) out.push({ id: 'robot', text: e.robot_id, title: `Robot ${e.robot_id}` });
  if (e.task_id) out.push({ id: 'task', text: e.task_id, title: `Task ${e.task_id}` });
  if (e.asset_id) out.push({ id: 'asset', text: e.asset_id, title: `Asset ${e.asset_id}` });
  return out;
}

const SENSITIVE_KEY = /(^|[_-])(secret|password|passwd|authorization|apikey|api[_-]?key|bearer|credentials?|cookie|private[_-]?key|token|access[_-]?token|refresh[_-]?token|auth)$/i;
const SENSITIVE_VAL = /^(Bearer\s+\S+|(sk|pk|rk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{16,})$/;
export const REDACTED = '[redacted]';
/** deep copy with secret-looking keys / values masked and long strings clipped; what the detail drawer prints for tool args and results */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return SENSITIVE_VAL.test(v.trim()) ? REDACTED : v.length > 400 ? `${v.slice(0, 400)}…` : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 5) return '…';
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 60).map(([k, x]) => [k, SENSITIVE_KEY.test(k) && x !== null && x !== undefined ? REDACTED : redact(x, depth + 1)]));
}

/** sub-task nesting for display: task -> parent task chain, capped so a deep tree never eats the row width */
export function taskDepths(events: CommunicationEventV1[], cap = 3): Map<string, number> {
  const parent = new Map<string, string>();
  for (const e of events) if (e.task_id && e.parent_id && e.parent_id !== e.task_id) parent.set(e.task_id, e.parent_id);
  const depth = new Map<string, number>();
  for (const t of parent.keys()) {
    let d = 0;
    let cur = t;
    const seen = new Set<string>();
    while (parent.has(cur) && d < cap && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur)!;
      d++;
    }
    depth.set(t, d);
  }
  return depth;
}
