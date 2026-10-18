/** CommunicationEventV1 as the backend emits it. Every field beyond the envelope is optional. */
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
  message_type: string;
  kind?: string;
  message_id?: string;
  priority?: string;
  parent_id?: string;
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
  detail?: Record<string, unknown>;
}

export type ConnState = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'REPLAY' | 'STALE' | 'OFFLINE' | 'ERROR';

export type RoleFilter = 'all' | 'sentinel' | 'inpipe' | 'outrig' | 'tools' | 'failures' | 'operator';
export const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sentinel', label: 'SENTINEL' },
  { id: 'inpipe', label: 'INPIPE' },
  { id: 'outrig', label: 'OUTRIG' },
  { id: 'tools', label: 'Tools' },
  { id: 'failures', label: 'Failures' },
  { id: 'operator', label: 'Operator' },
];
