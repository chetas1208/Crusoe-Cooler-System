/** CommunicationEventV1 as the backend emits it (docs/engineering/v10-comms-mobile.md §A). Every field beyond the envelope is optional. */
export type MessageKind = 'agent_message' | 'task_transition' | 'tool_event' | 'verification' | 'safety' | 'operator' | 'simulation' | 'provider';

/** V11 Agent Envelope kinds (docs/engineering/V11_CHECKLIST.md G4). They arrive in `message_type` (or `kind`) beside the V10 kinds. */
export const V11_KINDS = [
  'TASK_ASSIGN', 'ACK', 'OBSERVATION', 'HYPOTHESIS', 'REQUEST_TOOL', 'TOOL_ACCEPTED', 'TOOL_REJECTED', 'PROPOSE_PLAN', 'PLAN_APPROVED', 'PLAN_REJECTED',
  'SAFETY_VETO', 'PROGRESS', 'REPLAN', 'VERIFICATION_REQUEST', 'VERIFICATION_RESULT', 'ESCALATION', 'STOP', 'HEARTBEAT', 'MODEL_ERROR', 'HUMAN_OVERRIDE',
] as const;
export type V11Kind = (typeof V11_KINDS)[number];

export interface Party {
  kind: string;
  id: string;
  class: string;
}

export interface CommunicationEventV1 {
  event_id: string;
  run_id: string;
  /** the canonical run sequence (shared with every other stream event) */
  seq: number;
  sim_tick: number;
  sim_time_ms: number;
  wall_time_utc: string;
  sender: Party;
  recipient?: Party;
  thread_id?: string;
  task_id?: string;
  mission_id?: string;
  incident_id?: string;
  asset_id?: string;
  robot_id?: string;
  message_type: MessageKind | V11Kind | string;
  /** agent-envelope.v1 kind (TASK_ASSIGN ... VERIFICATION_RESULT), when the backend sends one */
  kind?: V11Kind | string;
  message_id?: string;
  priority?: string;
  /** envelope parent (the message this one answers / the task it belongs under) */
  parent_id?: string;
  /** the concrete boundary: task.delegated, tool.failed, verification.failed, mission.ack, lease.deadman, provider.error, nav.arrived, run.ended ... */
  subtype?: string;
  causal_event_id?: string;
  phase?: string;
  status?: string;
  /** bounded plain text produced by a deterministic template from authoritative fields */
  summary: string;
  evidence_ids?: string[];
  model_provider?: string;
  model_id?: string;
  visibility?: string;
  schema_version: string;
  /** compact structured detail (tool name, args digest, trace ids...). Rendered as escaped JSON text only. */
  detail?: Record<string, unknown>;
}

export type ConnState = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'REPLAY' | 'STALE' | 'OFFLINE' | 'ERROR';

export type RoleFilter = 'all' | 'sentinel' | 'inpipe' | 'outrig' | 'tools' | 'failures' | 'operator';
export const ROLE_FILTERS: Array<{ id: RoleFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sentinel', label: 'SENTINEL' },
  { id: 'inpipe', label: 'INPIPE' },
  { id: 'outrig', label: 'OUTRIG' },
  { id: 'tools', label: 'Tools' },
  { id: 'failures', label: 'Failures' },
  { id: 'operator', label: 'Operator' },
];
