export type Lifecycle = 'PROPOSED' | 'VALIDATED' | 'FROZEN' | 'EVALUATING' | 'VERIFIED' | 'FAILED' | 'ESCALATED';
export const LIFECYCLE: Lifecycle[] = ['PROPOSED', 'VALIDATED', 'FROZEN', 'EVALUATING', 'VERIFIED', 'FAILED', 'ESCALATED'];
export type Terminal = 'VERIFIED' | 'PARTIAL' | 'CONTAINED_NOT_REPAIRED' | 'ESCALATED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';
export const TERMINALS: Terminal[] = ['VERIFIED', 'PARTIAL', 'CONTAINED_NOT_REPAIRED', 'ESCALATED', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
export type CheckState = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface DodCheck {
  id: string;
  label: string;
  asset_id?: string;
  metric?: string;
  comparator?: string;
  threshold?: number | string;
  unit?: string;
  /** the value the physics/sensor path measured, or null when it has not been measured (never defaulted to 0) */
  measured: number | string | null;
  /** how long the check has continuously held, and how long it must */
  hold_required_s?: number;
  hold_elapsed_s?: number;
  state: CheckState;
  evidence_ids: string[];
  evaluated_tick?: number;
}

export interface DodContract {
  contract_id: string;
  revision: number;
  lifecycle: Lifecycle | string;
  /** why the last revision happened (version bump reason) */
  revision_reason?: string;
  frozen_tick?: number;
  checks: DodCheck[];
  terminal: Terminal | string | null;
  /** server-authored sentence; when absent the panel derives one from the checks, deterministically */
  why_not_done?: string;
}

export type TaskStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled' | string;
export interface TeamTask {
  id: string;
  title: string;
  role: string;
  owner?: string;
  parent_id?: string;
  incident_id?: string;
  depth: number;
  status: TaskStatus;
  budget_used?: number;
  budget_limit?: number;
  budget_unit?: string;
  kind?: string;
  tool_calls?: number;
  model?: { provider?: string; model_id?: string; fallback?: boolean; latency_ms?: number };
  warnings: { kind: 'loop' | 'drift' | string; text: string }[];
}
export interface TeamMember {
  id: string;
  role: string;
  title: string;
  status?: string;
}
export interface TeamBudgets {
  max_depth: number | null;
  depth_seen: number | null;
  max_llm_tasks: number | null;
  llm_tasks: number | null;
  max_plan_revisions: number | null;
  plan_revisions: number | null;
  attempts: number | null;
}
export interface TeamGraph {
  members: TeamMember[];
  tasks: TeamTask[];
  budgets: TeamBudgets | null;
  /** loop / drift detections for the incident (from the event log), newest last */
  warnings: { kind: string; text: string; seq?: number }[];
}
export interface ContractSummary {
  incident_id: string;
  id: string;
  version: number;
  state: string;
  terminal_state: string | null;
}

/** the five SENTINEL roles of the V11 checklist; shown even before the backend names them, labelled by what the spec says they do */
export const SEN_ROLES: { id: string; title: string }[] = [
  { id: 'SEN-01', title: 'Goal Architect' },
  { id: 'SEN-02', title: 'INPIPE Field Coordinator' },
  { id: 'SEN-03', title: 'OUTRIG Maintenance Coordinator' },
  { id: 'SEN-04', title: 'Safety & Governance Arbiter' },
  { id: 'SEN-05', title: 'Independent Verifier' },
];
