/**
 * Execution-tab wire types (backend.md §9 "Execution" rows and §11).
 * New file on purpose: contracts.ts is shared; the backend owns the canonical OpenAPI and these are
 * replaced by generated types when it lands. Everything marked `mock` is honest about the TS simulator.
 */
import type { AssetState, FaultKind, Incident, Kpis, Mission, Robot, SimStatus, StreamEvent } from '../contracts';

export const RUNS_SCHEMA_VERSION = 'lk.runs.v1';

/* ───────────────────────────── runs ───────────────────────────── */

export type RunKind = 'baseline' | 'scenario' | 'fork';
export type RunState = 'running' | 'paused' | 'stopped' | 'failed';
/** The three legal UI statuses of backend.md §11. A run is LIVE or FORK; REPLAY is a way of looking at any run. */
export type RunMode = 'LIVE' | 'FORK';

export interface RunSummary {
  run_id: string;
  label: string;
  kind: RunKind;
  mode: RunMode;
  state: RunState;
  parent_run_id: string | null;
  fork_tick: number | null;
  fork_snapshot_id: string | null;
  scenario_id: string | null;
  facility_id: string;
  seed: number;
  topology_hash: string;
  /** `facility_layout_v6@1#<hash>`: the layout this run was recorded on (replay/fork use it, never the current one) */
  topology_version?: string | null;
  schema_version: string;
  engine: { backend: 'mock' | 'live'; build: string };
  created_at: string;
  current_tick: number;
  current_time_s: number;
  /** first tick this run's own recording covers (history before it is inherited from the parent, or absent) */
  first_tick: number;
  recording: { frames: number; checkpoints: number; events: number; commands: number; approx_bytes: number };
  incidents: { opened: number; resolved: number };
  children: string[];
  head_hash: string | null;
}

export interface CheckpointInfo {
  snapshot_id: string;
  run_id: string;
  tick: number;
  sim_time_s: number;
  hash: string;
  hash_algo: string;
  schema_version: string;
  /** false => this client/engine cannot restore it; shown explicitly, never skipped silently */
  compatible: boolean;
  reason?: string;
}

export interface CheckpointList {
  run_id: string;
  schema_version: string;
  checkpoints: CheckpointInfo[];
}

/* ───────────────────────────── replay ───────────────────────────── */

/** One recorded world sample (a full physical snapshot at a tick; incidents/missions shared structurally). */
export interface ReplayFrame {
  tick: number;
  sim_time_s: number;
  sim_speed: number;
  sim_status: SimStatus;
  assets: Record<string, AssetState>;
  robots: Record<string, Robot>;
  kpis: Kpis;
  incidents: Incident[];
  missions: Record<string, Mission>;
  /** present on checkpoint frames only */
  hash?: string;
  /** frame belongs to an ancestor run (pre-fork history) */
  inherited?: boolean;
}

export interface RecordedCommand {
  tick: number;
  sim_time_s: number;
  command_id: string;
  kind: string;
  target_id?: string;
  args?: Record<string, unknown>;
  accepted: boolean;
  reason?: string;
  source: 'operator' | 'scenario';
  run_id: string;
}

export interface ReplayGap {
  from_tick: number;
  to_tick: number;
  kind: 'not_recorded' | 'reduced_resolution';
  reason: string;
}

export interface ReplayWindow {
  run_id: string;
  schema_version: string;
  start_tick: number;
  end_tick: number;
  stride: number;
  /** first / last tick the run has recorded, for the scrub rail */
  recorded_from_tick: number;
  recorded_to_tick: number;
  frames: ReplayFrame[];
  events: RecordedEvent[];
  commands: RecordedCommand[];
  checkpoints: CheckpointInfo[];
  gaps: ReplayGap[];
  /** agent decisions are frozen in `events` (agent.task/agent.tool); replay never re-runs agents */
  frozen_agent_decisions: true;
}

/** Stream events the recorder keeps (the discrete, causal ones — not wall-cadence telemetry). */
export type RecordedEvent = StreamEvent;

/* ───────────────────────────── fork ───────────────────────────── */

export interface ForkRequest {
  fork_tick: number;
  expected_parent_hash: string;
  chosen_snapshot_id: string;
  label?: string;
}

export interface ForkResult {
  run: RunSummary;
  parent_run_id: string;
  fork_tick: number;
  /** hash of the parent at fork_tick before and after the fork — equal by construction, returned so the UI can show it */
  parent_hash_before: string;
  parent_hash_after: string;
  restored_hash: string;
  rng: { stream: 'new' | 'inherited'; note: string };
}

export type ApiProblemCode =
  | 'not_found'
  | 'hash_mismatch'
  | 'checkpoint_missing'
  | 'checkpoint_incompatible'
  | 'cannot_reconstruct'
  | 'quota'
  | 'invalid'
  | 'model_unavailable'
  | 'unsupported'
  | 'read_only';

export interface ApiProblem {
  code: ApiProblemCode;
  message: string;
  detail?: unknown;
}

/* ───────────────────────────── scenarios ───────────────────────────── */

export type ScenarioFaultKind = Exclude<FaultKind, never>;
export type SupportStatus = 'supported' | 'planned';

export interface ScenarioFault {
  kind: ScenarioFaultKind;
  target_id: string;
  /** engine tick (0.5 sim-s each) at which the fault is injected */
  onset_tick: number;
  /** 0..1 — fraction of the affected capacity lost at full development */
  severity: number;
  /** seconds from onset to full development; 0 = step change */
  progression_s: number;
}

export interface ScenarioSpec {
  scenario_id: string;
  title: string;
  faults: ScenarioFault[];
  seed: number;
  /** multiplier on nominal rack load */
  workload_factor: number;
  sim_speed: number;
  agent_policy: 'autonomous' | 'supervised';
  approval_window_s: number;
  /** random background faults on top of the authored ones */
  background_faults: boolean;
}

export type IssueSeverity = 'error' | 'warning' | 'info';
export interface ValidationIssue {
  path: string;
  severity: IssueSeverity;
  message: string;
  /** how to fix it, in plain words */
  fix?: string;
}

/** What the simulator will really do with each authored field (the mock does not apply every field). */
export interface FieldSupport {
  path: string;
  applied: boolean;
  note: string;
}

export interface ScenarioValidation {
  valid: boolean;
  spec: ScenarioSpec | null;
  issues: ValidationIssue[];
  support: FieldSupport[];
  /** present when the spec came from text */
  interpreter?: { provider: string; model_id: string; kind: 'rules' | 'model'; unresolved: string[] };
  backend: 'mock' | 'live';
}

export interface ScenarioValidateRequest {
  spec?: unknown;
  text?: string;
}

export interface ModelStatus {
  provider: 'crusoe' | 'mock' | 'deterministic';
  model_id: string;
  status: 'live' | 'unavailable' | 'mock';
  /** can POST /scenarios/validate accept free text right now */
  scenario_text: { available: boolean; kind: 'model' | 'rules' | 'none'; reason?: string };
  last_checked_at?: string;
}

export type ScenarioId = 'CR-01' | 'CR-02' | 'CR-03' | 'CR-04' | 'CR-05' | 'CR-06' | 'CR-07' | 'MD-01' | 'MD-02';

export interface StartEpisodeRequest {
  scenario_id: ScenarioId;
  seed?: number;
  duration_sim_s?: 1800;
  mode?: 'LIVE';
  simulation_speed?: 1 | 2 | 3;
  idempotency_key?: string;
}

export interface EpisodeClock {
  run_id: string;
  sim_elapsed_ns: number;
  sim_duration_ns?: number;
  sim_tick: number;
  tick_duration_ns: number;
  committed_world_version: number;
  speed_target: 1 | 2 | 3;
  speed_effective: number;
  paused: boolean;
  server_monotonic_sample_ns: number;
  server_sent_at_unix_ms: number;
  clock_seq: number;
}

/** Fault kinds the authoring UI knows about, with honest support status. */
export const FAULT_CATALOG: Array<{ kind: FaultKind; label: string; support: SupportStatus; targets: string; blurb: string; reason?: string }> = [
  { kind: 'fouling', label: 'Pipe fouling', support: 'supported', targets: 'a supply header', blurb: 'Deposit grows along the bore and raises pressure drop.' },
  { kind: 'strainer_blockage', label: 'Strainer blockage', support: 'supported', targets: 'a strainer', blurb: 'Debris loads the basket; strainer dP climbs.' },
  { kind: 'valve_stuck', label: 'Valve stuck', support: 'supported', targets: 'a rack balancing valve', blurb: 'Valve freezes part-open and starves a rack.' },
  { kind: 'pump_degradation', label: 'Pump degradation', support: 'supported', targets: 'a pump', blurb: 'Head falls and vibration rises.' },
  { kind: 'sensor_drift', label: 'Sensor drift', support: 'supported', targets: 'a flow sensor', blurb: 'Reading walks away from the redundant meters.' },
  { kind: 'workload_spike', label: 'Workload spike', support: 'supported', targets: 'a rack', blurb: 'Rack draws extra power for a few minutes.' },
  { kind: 'leak', label: 'Leak', support: 'planned', targets: 'a pipe', blurb: 'Coolant loss.', reason: 'Leaks are listed in the contract but the simulator has no leak physics yet.' },
];
