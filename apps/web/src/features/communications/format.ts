import type { CommunicationEventV1 } from './types';

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

export const CLASS_TONE: Record<string, string> = { sentinel: '#a78bfa', inpipe: '#2fd3e8', outrig: '#ff9a3c', operator: '#5be3d0', verifier: '#41d6a3', system: '#8b93a7' };
export const toneOf = (c: string) => CLASS_TONE[c] ?? '#8b93a7';

export const partyLabel = (p?: { id: string; class: string }) => (p ? p.id : '');

export function aria(e: CommunicationEventV1) {
  return `${fmtSim(e.sim_time_ms)} ${e.sender.id}${e.recipient ? ` to ${e.recipient.id}` : ''}, ${kindLabel(eventKind(e))}${e.status ? `, ${e.status}` : ''}. ${e.summary}`;
}
