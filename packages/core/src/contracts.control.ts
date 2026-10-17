/**
 * Manual-control contracts (backend.md §9 "Map" rows and §10 "Secure manual driving").
 *
 * Shapes mirror the backend's DriveIntent and the lease / heartbeat / release endpoints:
 *   POST /runs/{run_id}/robots/{robot_id}/control/lease
 *   POST /runs/{run_id}/robots/{robot_id}/control/heartbeat
 *   POST /runs/{run_id}/robots/{robot_id}/drive
 *   POST /runs/{run_id}/robots/{robot_id}/control/release
 * plus the `robot.control` stream event. The client only ever sends INTENT; the server owns pose.
 */
import type { EntityId, Vec3 } from './contracts';

/** Who currently owns the robot's motor executor. HUD shows AUTO / HUMAN / STOP. */
export type ControlAuthority = 'AUTO' | 'HUMAN' | 'STOP';

/** Server-side controller states (backend.md §10): AUTONOMOUS → LEASE_PENDING → MANUAL → SAFE_HOLD → AUTONOMOUS. */
export type ControllerState = 'AUTONOMOUS' | 'LEASE_PENDING' | 'MANUAL' | 'SAFE_HOLD';

/** Reason codes attached to every stop / handoff so the UI never has to guess. */
export type ControlReason =
  | 'operator_release'
  | 'deadman_timeout'
  | 'lease_expired'
  | 'client_hidden'
  | 'client_disconnect'
  | 'link_lost'
  | 'safety_interlock'
  | 'low_battery'
  | 'operator_stop'
  | 'safe_hold_timeout'
  | 'resume_blocked';

export type ControlErrorCode =
  | 'unknown_robot'
  | 'not_controllable'
  | 'lease_held'
  | 'stale_world_version'
  | 'topology_changed'
  | 'bad_request'
  | 'no_lease'
  | 'stale_epoch'
  | 'stale_seq'
  | 'not_passable'
  | 'lease_revoked'
  | 'replay_readonly';

export interface ControlRefusal {
  accepted: false;
  code: ControlErrorCode;
  reason: string;
  holder?: string;
  current_world_version?: number;
  /** lease revoked by the server: why */
  revoked_reason?: ControlReason;
}

export interface JunctionExit {
  segment_id: EntityId;
  label: string;
  passable: boolean;
  /** shown verbatim when passable is false */
  reason?: string;
  /** signed angle relative to the direction of travel, degrees (negative = left) */
  bearing_deg: number;
}

export interface JunctionInfo {
  node_id: EntityId;
  node_label: string;
  distance_m: number;
  exits: JunctionExit[];
  /** the exit latched by the operator, if any */
  selected?: EntityId | null;
}

export interface ToolCapability {
  id: 'lamp' | 'scan' | 'brush_clear';
  label: string;
  available: boolean;
  /** concrete reason when unavailable, in plain verbs */
  reason?: string;
}

export interface ScanResult {
  tick: number;
  segment_id: EntityId;
  s_m: number;
  occlusion_pct: number;
  effective_bore_mm: number;
  /** how this value was produced */
  provenance: 'simulated';
}

/** Control state attached to every robot (snapshot, robot.pose while controlled, robot.control). */
export interface RobotControlInfo {
  authority: ControlAuthority;
  controller_state: ControllerState;
  controllable: boolean;
  uncontrollable_reason?: string;
  lease_id?: string;
  lease_epoch: number;
  /** principal that holds the lease (mock: the client id; real backend: the authenticated user) */
  holder?: string;
  /** +1 = nose points toward increasing s along the segment */
  facing: 1 | -1;
  /** signed longitudinal velocity along the nose direction (m/s) */
  velocity_m_s: number;
  lamp: boolean;
  last_applied_seq: number;
  last_reason?: ControlReason;
  /** next graph node ahead of the nose */
  next_node?: { id: EntityId; label: string; distance_m: number };
  junction?: JunctionInfo;
  tools: ToolCapability[];
  last_scan?: ScanResult;
  /** metres driven under this lease */
  odometer_m: number;
}

/* ───────────────────────────── lease ───────────────────────────── */

export interface DriveLimits {
  max_speed_m_s: number;
  max_accel_m_s2: number;
  intent_ttl_ms: [number, number];
  max_intent_rate_hz: number;
}

export interface LeaseRequest {
  expected_world_version: number;
  /** UUIDv4 — repeating it returns the original response */
  idempotency_key: string;
  /** mock only: stands in for the authenticated principal */
  client_id: string;
  topology_revision: string;
}

export interface LeaseGrant {
  accepted: true;
  robot_id: EntityId;
  lease_id: string;
  lease_epoch: number;
  granted_world_version: number;
  expires_in_ms: number;
  heartbeat_interval_ms: number;
  deadman_ms: number;
  limits: DriveLimits;
  topology_revision: string;
  control: RobotControlInfo;
}

export type LeaseResponse = LeaseGrant | ControlRefusal;

export interface HeartbeatRequest {
  lease_id: string;
  lease_epoch: number;
}
export type HeartbeatResponse = { accepted: true; expires_in_ms: number; controller_state: ControllerState } | ControlRefusal;

/* ───────────────────────────── drive ───────────────────────────── */

export type ToolAction = 'lamp_on' | 'lamp_off' | 'scan';

export interface DriveIntent {
  lease_id: string;
  lease_epoch: number;
  command_seq: number;
  idempotency_key: string;
  topology_revision: string;
  /** informational for high-rate drive — not an exact-match optimistic lock */
  known_world_version?: number;
  /** [-1, 1] along the nose direction (W/S) */
  throttle: number;
  /** [-1, 1]: biases the branch choice at a junction when no exit is selected explicitly */
  steer: number;
  brake: boolean;
  selected_exit_segment_id?: EntityId | null;
  /** V7: exterior robots choose a legal junction branch ('left' | 'right' | 'straight' or an exact graph edge id); envelope carries the graph revision */
  branch?: string;
  graph_revision?: string;
  /** how long this intent stays valid, 20..250 ms — after that the robot brakes to a stop */
  duration_ms: number;
  tool?: ToolAction;
  /** V5 Articulated manipulation parameters (MuJoCo) */
  action?: 'joint_jog' | 'pick' | 'place' | 'clean_deposit' | string;
  joint_idx?: number;
  delta_rad?: number;
  gripper_aperture?: number;
  pick?: boolean;
  place?: boolean;
}

export interface DriveAck {
  accepted: true;
  robot_id: EntityId;
  lease_epoch: number;
  applied_seq: number;
  controller_state: ControllerState;
  world_version: number;
  /** authoritative pose at the time the intent was committed */
  pose: { segment_id: EntityId; s_m: number; speed_m_s: number; velocity_m_s: number; facing: 1 | -1; position_xyz_m: Vec3 };
  junction?: JunctionInfo;
  next_node?: { id: EntityId; label: string; distance_m: number };
  odometer_m: number;
}
export type DriveResponse = DriveAck | ControlRefusal;

/* ───────────────────────────── release ───────────────────────────── */

export interface ReleaseRequest {
  lease_id: string;
  lease_epoch: number;
  idempotency_key: string;
  reason?: ControlReason;
}

export interface ReleaseAck {
  accepted: true;
  robot_id: EntityId;
  /** AUTONOMOUS when the agent resumed, SAFE_HOLD when it could not */
  controller_state: ControllerState;
  resumed: 'mission' | 'return_to_port' | 'docked' | 'blocked' | 'none';
  already_released?: boolean;
  control: RobotControlInfo;
}
export type ReleaseResponse = ReleaseAck | ControlRefusal;

/* ───────────────────────────── stream ───────────────────────────── */

/** `human.override` = operator took the motors, `agent.resumed` = autonomy took them back. */
export type ControlEventKind =
  | 'human.override'
  | 'agent.resumed'
  | 'safe_hold'
  | 'drive.rejected'
  | 'scan.result'
  | 'end_of_line';

export interface RobotControlPayload {
  robot_id: EntityId;
  event: ControlEventKind;
  reason?: ControlReason | string;
  control: RobotControlInfo;
  data?: Record<string, number | string>;
}

export const CONTROL_DEFAULTS = {
  heartbeat_interval_ms: 500,
  deadman_ms: 1500,
  lease_ttl_ms: 5000,
  max_stale_ticks: 400,
  safe_hold_resume_ms: 8000,
  max_speed_m_s: 0.3,
  max_accel_m_s2: 0.6,
  intent_ttl_ms: [20, 250] as [number, number],
  max_intent_rate_hz: 20,
} as const;

export const HTTP_STATUS_FOR_CODE: Record<ControlErrorCode, number> = {
  unknown_robot: 404,
  not_controllable: 409,
  lease_held: 409,
  stale_world_version: 409,
  topology_changed: 409,
  bad_request: 422,
  no_lease: 403,
  stale_epoch: 409,
  stale_seq: 409,
  not_passable: 409,
  lease_revoked: 409,
  replay_readonly: 403,
};
