/**
 * LOOPKEEPER — API & stream contracts (v1)
 *
 * These types mirror backend.md §8–9: REST under /api/v1 and the WebSocket
 * stream at /api/v1/stream. They are hand-written for now; the backend owns the
 * source of truth (Pydantic → OpenAPI → generated TS) and should replace this
 * file with generated types. Everything the UI renders is derived from these
 * shapes — the frontend never invents physics, positions or outcomes.
 *
 * Units: SI. Geometry in metres. World axes: x/z ground plane, y vertical.
 */

import type { RobotControlInfo, RobotControlPayload } from './contracts.control';

export type EntityId = string;
export type Vec3 = [number, number, number];

/* ─────────────────────────────── Topology ─────────────────────────────── */

/** facility-water system (primary) vs technology-cooling system (secondary). */
export type LoopId = 'fws' | 'tcs';
export type PipeRole = 'supply' | 'return';

export type AssetType =
  | 'rack'
  | 'cdu'
  | 'pump'
  | 'valve'
  | 'strainer'
  | 'sensor'
  | 'port'
  | 'dock'
  | 'chiller';

export interface Zone {
  id: EntityId;
  name: string;
  rack_ids: EntityId[];
  anchor_xyz_m: Vec3;
}

export interface TopologyNode {
  id: EntityId;
  label: string;
  loop: LoopId;
  position_xyz_m: Vec3;
}

export interface PipeEdge {
  id: EntityId; // e.g. "p_17"
  label: string; // e.g. "P-17"
  name: string; // human description
  loop: LoopId;
  role: PipeRole;
  zone_id?: EntityId;
  from: EntityId;
  to: EntityId;
  /** Polyline control points. Clients round the corners (see fillet_radius_m). */
  centerline_xyz_m: Vec3[];
  fillet_radius_m: number;
  length_m: number;
  diameter_mm: number;
  /** Radial clearance available to a crawler, mm. */
  clearance_mm: number;
  robot_passable: boolean;
  /** Why a crawler cannot enter — shown to the operator, never hidden. */
  not_passable_reason?: string;
  access_port_ids: EntityId[];
}

export interface Asset {
  id: EntityId;
  type: AssetType;
  label: string;
  name: string;
  loop?: LoopId;
  zone_id?: EntityId;
  position_xyz_m: Vec3;
  /** Axis-aligned footprint (x, y, z) in metres, centred on position (y is base-up). */
  size_m?: Vec3;
  yaw_rad?: number;
  /** For assets that sit on a pipe (valve, strainer, sensor). */
  edge_id?: EntityId;
  s_m?: number;
  /** Which robot classes can physically service this asset. */
  accessible_by: Array<'inpipe' | 'outrig'>;
  /** Ground position from which an exterior robot services this asset. */
  service_xyz_m?: Vec3;
  /** Rated / design values shown in the inspector. */
  spec?: Record<string, string | number>;
}

export interface NavObstacle {
  id: EntityId;
  /** Axis-aligned rectangle on the ground plane: [minX, minZ, maxX, maxZ]. */
  rect: [number, number, number, number];
  label?: string;
}

export interface Topology {
  facility: {
    id: string;
    name: string;
    label: 'Simulated facility';
    config_version: string;
    topology_hash: string;
    /** everything incl. the external chiller — used to auto-fit the camera */
    bounds_min: Vec3;
    bounds_max: Vec3;
    /** the hall interior (floor slab / walls) */
    interior_min: Vec3;
    interior_max: Vec3;
    wall_height_m: number;
  };
  /** Reserved, un-instrumented rack bays — drawn as ghosts so expandability reads at a glance. */
  expansion_bays: Array<{ id: EntityId; position_xyz_m: Vec3; size_m: Vec3; yaw_rad: number }>;
  zones: Zone[];
  nodes: TopologyNode[];
  edges: PipeEdge[];
  assets: Asset[];
  nav: {
    cell_m: number;
    obstacles: NavObstacle[];
    dock_ids: EntityId[];
  };
  limits: {
    chip_limit_c: number;
    margin_warn_k: number;
    margin_crit_k: number;
    nominal_rack_kw: number;
  };
  site?: any;
  context_cabinets?: any[];
  context_equipment?: any[];
  fittings?: any[];
  supports?: any[];
  capacity?: any;
}


/* ───────────────────────────── World state ───────────────────────────── */

export type SimStatus = 'running' | 'recovering' | 'degraded' | 'paused';

export type Severity = 'nominal' | 'watch' | 'warning' | 'critical';

export type AssetStatus = Severity | 'offline' | 'isolated' | 'service';

/** Per-asset mutable truth. Readings are keyed by metric id (see READING_META). */
export interface AssetState {
  status: AssetStatus;
  readings: Record<string, number>;
  /** metric ids whose value is currently suspect (e.g. sensor drift). */
  suspect?: string[];
  /** Physical fault state that drives visuals. Only the simulator writes these. */
  fault?: {
    occlusion?: number; // 0..1 fraction of bore blocked (pipes, strainers)
    location_s_m?: number; // where along the pipe centerline the deposit sits
    opening?: number; // 0..1 effective valve opening
    commanded_opening?: number;
    health?: number; // 0..1 pump health
    leak_kg_s?: number;
  };
  locked_by?: EntityId; // mission holding a work lock
}

export type RobotClass = 'inpipe' | 'outrig';

export type RobotMode =
  | 'IDLE'
  | 'ASSIGNED'
  | 'ROUTE_PLANNING'
  | 'TRAVELING'
  | 'INSPECTING'
  | 'WORKING'
  | 'VERIFYING'
  | 'RETURNING'
  | 'DOCKED'
  | 'BLOCKED'
  | 'FAILED'
  | 'ABORTED'
  | 'NEEDS_CHARGE'
  | 'SAFE_HOLD';

export interface RobotPose {
  position_xyz_m: Vec3;
  /** Heading (radians about +y) for exterior robots; path tangent for crawlers. */
  yaw_rad: number;
  speed_m_s: number;
  /** INPIPE only. */
  segment_id?: EntityId;
  s_m?: number;
  /** INPIPE only: unit vector the nose points along (3-D, includes pitch). Server truth, not derived from motion. */
  heading_xyz?: Vec3;
  /** Orientation quaternion [x,y,z,w] in `frame_id` (V4 backend). Absent on the TS mock. */
  quaternion_xyzw?: [number, number, number, number];
  frame_id?: string;
  linear_velocity_mps_xyz?: Vec3;
  covariance_or_quality?: string;
}

/** Fleet bookkeeping added by the V4 backend (absent on the TS mock). */
export interface RobotFleetInfo {
  group: 'internal' | 'external';
  /** working | idle | repairing | manual | charging | blocked | safe_hold | failed (open vocabulary: show unknown values as-is) */
  state: string;
  dock_id?: EntityId;
  slot?: number;
}

export interface Robot {
  id: EntityId;
  class: RobotClass;
  name: string;
  mode: RobotMode;
  battery_pct: number;
  mission_id?: EntityId;
  agent_task_id?: EntityId;
  tool?: string | null;
  home_id: EntityId;
  pose: RobotPose;
  fleet?: RobotFleetInfo;
  nav?: { graph_id?: string; segment_id?: EntityId | null; s_m?: number | null; route_id?: string | null; floor_id?: string };
  dims_m?: Vec3;
  /** free radial/side clearance around the body in metres (V4+ backend) */
  clearance_m?: number;
  /** Remaining route polyline in world coordinates (for highlighting). */
  route_xyz_m?: Vec3[];
  /** Hardware envelope shown to operators. */
  spec: Record<string, string | number>;
  /** Manual-control authority (backend.md §10). Absent on backends without control leases. */
  control?: RobotControlInfo;
  /** Articulated arm and manipulation states (V5 MuJoCo) */
  arm_joint_names?: string[];
  arm_qpos_rad?: number[];
  gripper_aperture_m?: number;
  held_object_id?: string | null;
  grip_force_N?: number;
  end_effector_pose?: { pos_xyz: Vec3; quat_xyzw: [number, number, number, number] };
  contact_list?: string[];
  payload_mass_kg?: number;
  deposit_fouling_pct?: number;
}

export interface MissionStep {
  id: string;
  command: string; // launch, move_to, inspect, brush_clear, isolate_valve, ...
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  started_tick?: number;
  ended_tick?: number;
  result?: string;
}

export interface Mission {
  id: EntityId;
  incident_id: EntityId;
  robot_id: EntityId;
  kind: 'inspect' | 'clear' | 'service' | 'return';
  title: string;
  target_id: EntityId;
  status: RobotMode;
  progress: number; // 0..1
  steps: MissionStep[];
  route_xyz_m?: Vec3[];
  route_segment_ids?: EntityId[];
  opened_tick: number;
  closed_tick?: number;
}

export type IncidentStage =
  | 'observed'
  | 'hypothesized'
  | 'investigated'
  | 'repaired'
  | 'verified';

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'awaiting_approval'
  | 'mitigating'
  | 'verifying'
  | 'replanning'
  | 'escalated'
  | 'resolved'
  | 'dismissed';

export type FaultKind =
  | 'fouling'
  | 'strainer_blockage'
  | 'valve_stuck'
  | 'pump_degradation'
  | 'sensor_drift'
  | 'workload_spike'
  | 'leak'
  // V12 hazard kinds (backend physics: hazards.py, faults.py). Older clients must tolerate kinds they do not know (see faultLabels.ts).
  | 'manifold_leak'
  | 'power_failure'
  | 'rack_thermal_runaway'
  | 'cdu_pump_backup_failure'
  | 'facility_heat_rejection_loss';

export interface Hypothesis {
  id: string;
  cause: FaultKind;
  label: string;
  target_id: EntityId;
  confidence: number; // 0..1
  status: 'candidate' | 'supported' | 'refuted' | 'confirmed';
  evidence_for: string[];
  evidence_against: string[];
}

export interface Evidence {
  id: string;
  kind: 'telemetry' | 'observation' | 'topology' | 'verification' | 'action';
  summary: string;
  asset_id?: EntityId;
  tick: number;
  data?: Record<string, number | string>;
  tags?: string[];
}

export interface ApprovalRequest {
  id: string;
  incident_id: EntityId;
  task_id: string;
  action: string; // plain language
  steps: string[];
  requested_tick: number;
  /** Auto-approves at this sim-time unless an operator holds it (veto window). */
  auto_approve_at_s: number | null;
  status: 'pending' | 'approved' | 'held' | 'expired';
}

export interface Incident {
  id: EntityId; // "INC-009"
  opened_tick: number;
  opened_at_s: number;
  updated_tick: number;
  severity: Severity;
  status: IncidentStatus;
  stage: IncidentStage;
  stage_log: Array<{ stage: IncidentStage; tick: number; outcome?: 'ok' | 'rejected' }>;
  title: string;
  summary: string;
  cause: FaultKind | 'unknown';
  anchor: { entity_id: EntityId; position_xyz_m: Vec3 };
  affected_asset_ids: EntityId[];
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  mission_ids: EntityId[];
  task_ids: string[];
  approval?: ApprovalRequest;
  verification?: VerificationResult;
  attempts: number;
  closed_tick?: number;
  close_reason?: string;
}

export interface VerificationCheck {
  id: string;
  label: string;
  unit: string;
  before: number;
  after: number;
  target: number;
  /** 'min' → after must be ≥ target; 'max' → after must be ≤ target. */
  direction: 'min' | 'max';
  pass: boolean;
}

export interface VerificationResult {
  id: string;
  incident_id: EntityId;
  attempt: number;
  status: 'pending' | 'verified' | 'rejected';
  window_s: number;
  elapsed_s: number;
  progress: number;
  checks: VerificationCheck[];
  confidence: number;
  failed_reason?: string;
  started_tick: number;
  completed_tick?: number;
}

/* ──────────────────────────── Agent trace ────────────────────────────── */

export type AgentRole = 'sentinel' | 'inpipe' | 'outrig';

export type AgentTaskStatus =
  | 'queued'
  | 'working'
  | 'blocked'
  | 'completed'
  | 'verified'
  | 'rejected'
  | 'failed';

export interface ModelMeta {
  provider: 'crusoe' | 'mock' | 'deterministic';
  model_id: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  schema_version: string;
  /** true when the deterministic policy answered because the model was unavailable. */
  fallback: boolean;
}

export interface ToolCall {
  id: string;
  task_id: string;
  name: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: 'running' | 'ok' | 'error' | 'rejected';
  tick: number;
  latency_ms?: number;
}

export interface AgentTask {
  id: string;
  incident_id: EntityId;
  parent_id?: string;
  role: AgentRole;
  /** machine kind e.g. review.hydraulics, route, inspect, isolate */
  kind: string;
  title: string;
  /** the concrete question this task answers */
  question: string;
  status: AgentTaskStatus;
  depth: number;
  started_tick: number;
  ended_tick?: number;
  /** thought *summary* — never chain-of-thought. */
  summary?: string;
  outcome?: { label: string; ok: boolean };
  evidence_ids: string[];
  tool_calls: ToolCall[];
  model: ModelMeta;
  /** causal edges: tasks that triggered / fed this one. */
  caused_by: string[];
  robot_id?: EntityId;
  asset_ids: EntityId[];
}

/* ──────────────────────────── Engine health ──────────────────────────── */

export interface EngineHealth {
  status: SimStatus;
  tick_rate_hz: number;
  solver: { status: 'converged' | 'degraded' | 'failed'; residual: number };
  database: 'ok' | 'unavailable' | 'n/a';
  intelligence: {
    provider: 'crusoe' | 'mock' | 'deterministic';
    model_id: string;
    status: 'live' | 'unavailable' | 'mock';
    model_state?: string;
    fallback_active?: boolean;
    checkpointer?: string;
    last_latency_ms?: number;
  };
  safe_automation_mode: 'autonomous' | 'supervised';
  approval_window_s: number;
  /** "mock" when a development simulator (not the real backend) is serving. */
  backend: 'mock' | 'live';
  uptime_s: number;
  seed: number;
}

export interface Kpis {
  min_margin_k: number;
  total_heat_kw: number;
  tcs_flow_kg_s: number;
  fws_flow_kg_s: number;
  tcs_supply_c: number;
  tcs_return_c: number;
  open_incidents: number;
  resolved_incidents: number;
}

export interface RigidObjectState {
  id: string;
  name: string;
  mass_kg: number;
  pos_xyz: Vec3;
  quat_xyzw: [number, number, number, number];
  held_by_robot_id?: string | null;
  seated_in_fixture_id?: string | null;
}

export interface MechanicalFixtureState {
  id: string;
  target_component_id: string;
  is_isolated: boolean;
  cartridge_installed: boolean;
  mechanical_fit_pass: boolean;
  pos_xyz: Vec3;
}

/** Hazard zone emitted in `world.hazard_zones` (leak puddle, smoke/fire exclusion). Fields beyond the core set depend on `kind`. */
export interface HazardZone {
  zone_id: string;
  kind: string; // 'leak' | 'smoke' | 'fire' today; clients must tolerate new kinds
  severity: string; // 'high' | 'critical'
  status: string; // 'active' | 'contained'
  center_xyz: Vec3;
  radius_m: number;
  polygon: number[][]; // [x, z] corners
  road_blocked?: boolean;
  rate_kg_s?: number;
  total_lost_kg?: number;
  edge_id?: string;
  reserve_remaining_pct?: number;
  repair_requires?: string;
  escalated?: boolean;
  alarm_sounding?: boolean;
  heat_kw?: number;
  smoke_obscuration_pct_m?: number;
  prohibit_robot_entry?: boolean;
  escalation_required?: boolean;
  depowered?: boolean;
  supported_outcomes?: string[];
  /** Always false: the facility has no autonomous fire suppression; response is detect / depower / contain / escalate to humans. */
  autonomous_firefighting?: boolean;
}

/** Per power-row feed state (V12 hazards.py). */
export interface PowerRowFeed {
  failed: boolean;
  on_ups: boolean;
  racks_tripped: boolean;
  ups_remaining_s?: number | null;
  it_load_kw: number;
  supply_available: boolean;
  restored: boolean;
}

export interface PumpFeedState {
  failed: boolean;
  pumps_unpowered: string[];
  supply_available: boolean;
  restored: boolean;
}

/** `world.power_state`: legacy summary flags plus the V12 modelled domains (present only while a power hazard is active). */
export interface PowerState {
  utility_online?: boolean;
  backup_gen_available?: boolean;
  ups_runtime_remaining_s?: number;
  primary_pumps_powered?: boolean;
  robot_chargers_online?: boolean;
  telemetry_online?: boolean;
  compute_curtailed?: boolean;
  row_feeds?: Record<string, PowerRowFeed>;
  pump_feed_a?: PumpFeedState;
  racks_depowered?: string[];
}

export interface WorldSnapshot {
  facility_id: string;
  version: number;
  sim_tick: number;
  sim_time_s: number;
  sim_speed: number;
  sim_status: SimStatus;
  assets: Record<EntityId, AssetState>;
  robots: Record<EntityId, Robot>;
  missions: Record<EntityId, Mission>;
  incidents: Incident[]; // open + recently closed
  health: EngineHealth;
  kpis: Kpis;
  last_seq: number;
  rigid_objects?: Record<string, RigidObjectState>;
  mechanical_fixtures?: Record<string, MechanicalFixtureState>;
  hazard_zones?: HazardZone[];
  power_state?: PowerState;
}

/* ────────────────────────────── Streaming ────────────────────────────── */

export type EventType =
  | 'snapshot'
  | 'world.diff'
  | 'robot.pose'
  | 'robot.control'
  | 'mission.transition'
  | 'incident.opened'
  | 'incident.updated'
  | 'incident.closed'
  | 'agent.task'
  | 'agent.tool'
  | 'verification.result'
  | 'engine.health'
  | 'heartbeat';

export interface EventBase<T extends EventType, P> {
  event_id: string;
  seq: number;
  sim_tick: number;
  sim_time_s: number;
  world_version: number;
  type: T;
  entity_id: EntityId;
  facility_id: string;
  /** wall clock, ISO-8601 */
  ts: string;
  payload: P;
}

export interface WorldDiffPayload {
  assets: Record<EntityId, Partial<AssetState>>;
  kpis: Kpis;
  sim_speed: number;
  sim_status: SimStatus;
}

export interface RobotPosePayload {
  robot_id: EntityId;
  pose: RobotPose;
  battery_pct: number;
  mode: RobotMode;
  route_xyz_m?: Vec3[];
  tool?: string | null;
  mission_id?: EntityId | null;
  agent_task_id?: EntityId | null;
  /** present while a robot is under (or being released from) manual control */
  control?: RobotControlInfo;
  arm_joint_names?: string[];
  arm_qpos_rad?: number[];
  gripper_aperture_m?: number;
  held_object_id?: string | null;
  grip_force_N?: number;
  end_effector_pose?: { pos_xyz: Vec3; quat_xyzw: [number, number, number, number] };
  contact_list?: string[];
  payload_mass_kg?: number;
  deposit_fouling_pct?: number;
}

export interface MissionTransitionPayload {
  mission: Mission;
  robot_mode: RobotMode;
  tool?: string | null;
}

export type StreamEvent =
  | EventBase<'snapshot', WorldSnapshot>
  | EventBase<'world.diff', WorldDiffPayload>
  | EventBase<'robot.pose', RobotPosePayload>
  | EventBase<'robot.control', RobotControlPayload>
  | EventBase<'mission.transition', MissionTransitionPayload>
  | EventBase<'incident.opened', { incident: Incident }>
  | EventBase<'incident.updated', { incident: Incident }>
  | EventBase<'incident.closed', { incident: Incident }>
  | EventBase<'agent.task', { task: AgentTask }>
  | EventBase<'agent.tool', { task_id: string; tool_call: ToolCall }>
  | EventBase<'verification.result', { verification: VerificationResult }>
  | EventBase<'engine.health', { health: EngineHealth }>
  | EventBase<'heartbeat', { server_ts: string }>;

export type StreamEventOf<T extends EventType> = Extract<StreamEvent, { type: T }>;

/* ───────────────────────────── REST helpers ───────────────────────────── */

export interface IncidentTrace {
  incident_id: EntityId;
  tasks: AgentTask[];
}

export interface TelemetrySeries {
  asset_id: EntityId;
  metric: string;
  unit: string;
  points: Array<[number, number]>; // [sim_time_s, value]
}

export type CommandKind =
  | 'approve_action'
  | 'hold_action'
  | 'set_sim_speed'
  | 'pause'
  | 'resume'
  /** Engineering test controls — never the primary experience. */
  | 'test.inject_fault';

export interface CommandRequest {
  command_id: string;
  kind: CommandKind;
  target_id?: EntityId;
  args?: Record<string, unknown>;
}

export interface CommandAck {
  command_id: string;
  accepted: boolean;
  reason?: string;
}

export interface ReplayPage {
  events: StreamEvent[];
  next_seq: number | null;
}

/* ────────────────────────── Display metadata ─────────────────────────── */

export interface ReadingMeta {
  label: string;
  unit: string;
  decimals: number;
}

/** Single source for labels / units so every surface formats identically. */
export const READING_META: Record<string, ReadingMeta> = {
  flow_kg_s: { label: 'Mass flow', unit: 'kg/s', decimals: 2 },
  tcs_flow_kg_s: { label: 'TCS flow', unit: 'kg/s', decimals: 2 },
  fws_flow_kg_s: { label: 'FWS flow', unit: 'kg/s', decimals: 2 },
  strainer_dp_kpa: { label: 'Strainer ΔP', unit: 'kPa', decimals: 1 },
  dp_kpa: { label: 'Pressure drop', unit: 'kPa', decimals: 1 },
  velocity_m_s: { label: 'Velocity', unit: 'm/s', decimals: 2 },
  pressure_kpa: { label: 'Pressure', unit: 'kPa', decimals: 0 },
  t_in_c: { label: 'Inlet temp', unit: '°C', decimals: 1 },
  t_out_c: { label: 'Outlet temp', unit: '°C', decimals: 1 },
  t_chip_c: { label: 'GPU junction', unit: '°C', decimals: 1 },
  margin_k: { label: 'Thermal margin', unit: 'K', decimals: 1 },
  power_kw: { label: 'Rack load', unit: 'kW', decimals: 0 },
  heat_duty_kw: { label: 'Heat duty', unit: 'kW', decimals: 0 },
  approach_k: { label: 'HX approach', unit: 'K', decimals: 1 },
  speed_pct: { label: 'Speed', unit: '%', decimals: 0 },
  head_kpa: { label: 'Head', unit: 'kPa', decimals: 0 },
  vibration_mm_s: { label: 'Vibration', unit: 'mm/s', decimals: 2 },
  opening_pct: { label: 'Opening', unit: '%', decimals: 0 },
  occlusion_pct: { label: 'Bore blocked', unit: '%', decimals: 0 },
  fws_in_c: { label: 'FWS supply', unit: '°C', decimals: 1 },
  fws_out_c: { label: 'FWS return', unit: '°C', decimals: 1 },
  tcs_supply_c: { label: 'TCS supply', unit: '°C', decimals: 1 },
  tcs_return_c: { label: 'TCS return', unit: '°C', decimals: 1 },
};

export const SEVERITY_ORDER: Severity[] = ['nominal', 'watch', 'warning', 'critical'];

export const STAGES: IncidentStage[] = [
  'observed',
  'hypothesized',
  'investigated',
  'repaired',
  'verified',
];
