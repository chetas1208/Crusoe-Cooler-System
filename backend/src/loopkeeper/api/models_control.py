"""Mirrors of packages/core/src/contracts.control.ts (manual-control wire types).

Requests (LeaseRequest, HeartbeatRequest, DriveIntent, ReleaseRequest) are ``extra="forbid"``.
Responses are validated pass-through of what the engine acks (``extra="allow"``).
The client only sends INTENT; the single-writer engine owns pose, lease epoch/TTL and physics.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import ConfigDict, Field, field_validator

from .models import EntityId, Vec3, Wire

TOKEN = r"^[A-Za-z0-9_\-]{8,128}$"

ControlAuthority = Literal["AUTO", "HUMAN", "STOP"]
ControllerState = Literal["AUTONOMOUS", "LEASE_PENDING", "MANUAL", "SAFE_HOLD"]
ControlReason = Literal[
    "operator_release", "deadman_timeout", "lease_expired", "client_hidden", "client_disconnect",
    "link_lost", "safety_interlock", "low_battery", "operator_stop", "safe_hold_timeout", "resume_blocked",
]
# Legacy short reasons some callers still send; mapped to the canonical contract values on the way in
# (the wire type itself stays identical to contracts.control.ts).
_REASON_ALIASES = {
    "deadman": "deadman_timeout", "expired": "lease_expired", "released": "operator_release",
    "disconnect": "client_disconnect", "hidden": "client_hidden",
}


def _canon_reason(v: Any) -> Any:
    return _REASON_ALIASES.get(v, v) if isinstance(v, str) else v
ControlErrorCode = Literal[
    "unknown_robot", "not_controllable", "lease_held", "stale_world_version", "topology_changed",
    "bad_request", "no_lease", "stale_epoch", "stale_seq", "not_passable", "lease_revoked", "replay_readonly",
]
ToolAction = Literal["lamp_on", "lamp_off", "scan"]
# arm actions (engine/robots/manipulator.py ARM_ACTIONS) + the crawler brush tool
DRIVE_ACTIONS = frozenset({"joint_jog", "joint_targets", "gripper_open", "gripper_close", "pick", "place", "arm_home", "arm_stow", "arm_stop",
                           "clean_deposit"})
ControlEventKind = Literal["human.override", "agent.resumed", "safe_hold", "drive.rejected", "scan.result", "end_of_line"]

# mirrors HTTP_STATUS_FOR_CODE in contracts.control.ts (parity-tested)
HTTP_STATUS_FOR_CODE: dict[str, int] = {
    "unknown_robot": 404, "not_controllable": 409, "lease_held": 409, "stale_world_version": 409,
    "topology_changed": 409, "bad_request": 422, "no_lease": 403, "stale_epoch": 409, "stale_seq": 409,
    "not_passable": 409, "lease_revoked": 409, "replay_readonly": 403,
}


class StrictWire(Wire):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ControlRefusal(Wire):
    accepted: Literal[False]
    code: ControlErrorCode
    reason: str
    holder: Optional[str] = None
    current_world_version: Optional[float] = None
    revoked_reason: Optional[ControlReason] = None

    _canon = field_validator("revoked_reason", mode="before")(_canon_reason)


class JunctionExit(Wire):
    segment_id: EntityId
    label: str
    passable: bool
    reason: Optional[str] = None
    bearing_deg: float


class JunctionInfo(Wire):
    node_id: EntityId
    node_label: str
    distance_m: float
    exits: list[JunctionExit]
    selected: Optional[EntityId] = None


class ToolCapability(Wire):
    id: Literal["lamp", "scan", "brush_clear"]
    label: str
    available: bool
    reason: Optional[str] = None


class ScanResult(Wire):
    tick: float
    segment_id: EntityId
    s_m: float
    occlusion_pct: float
    effective_bore_mm: float
    provenance: Literal["simulated"]


class NextNode(Wire):
    id: EntityId
    label: str
    distance_m: float


class RobotControlInfo(Wire):
    authority: ControlAuthority
    controller_state: ControllerState
    controllable: bool
    uncontrollable_reason: Optional[str] = None
    lease_id: Optional[str] = None
    lease_epoch: float
    holder: Optional[str] = None
    facing: Literal[1, -1]
    velocity_m_s: float
    lamp: bool
    last_applied_seq: float
    last_reason: Optional[ControlReason] = None

    _canon = field_validator("last_reason", mode="before")(_canon_reason)
    next_node: Optional[NextNode] = None
    junction: Optional[JunctionInfo] = None
    tools: list[ToolCapability]
    last_scan: Optional[ScanResult] = None
    odometer_m: float


class DriveLimits(Wire):
    max_speed_m_s: float
    max_accel_m_s2: float
    intent_ttl_ms: tuple[float, float]
    max_intent_rate_hz: float


# ── requests (forbid unknown fields) ───────────────────────────────────────
class LeaseRequest(StrictWire):
    expected_world_version: int = Field(ge=0)
    idempotency_key: str = Field(pattern=TOKEN)          # UUIDv4 from the client; repeating returns the original response
    client_id: str = Field(min_length=1, max_length=128)   # mock-only stand-in for the principal; ignored (principal comes from auth)
    topology_revision: str = Field(min_length=1, max_length=128)


class HeartbeatRequest(StrictWire):
    lease_id: str = Field(pattern=TOKEN)
    lease_epoch: int = Field(ge=0)


class DriveIntent(StrictWire):
    lease_id: str = Field(pattern=TOKEN)
    lease_epoch: int = Field(ge=0)
    command_seq: int = Field(ge=1)
    idempotency_key: str = Field(pattern=TOKEN)
    topology_revision: str = Field(min_length=1, max_length=128)
    known_world_version: Optional[int] = Field(default=None, ge=0)
    throttle: float = Field(ge=-1, le=1)
    steer: float = Field(ge=-1, le=1)
    brake: bool
    selected_exit_segment_id: Optional[EntityId] = Field(default=None, max_length=128)
    branch: Optional[str] = Field(default=None, max_length=128)
    graph_revision: Optional[str] = Field(default=None, max_length=64)
    duration_ms: int = Field(ge=20, le=250)
    tool: Optional[ToolAction] = None
    # OUTRIG arm / gripper intents (identical for every OUTRIG; crawlers are refused in the ack). All optional.
    action: Optional[str] = Field(default=None, max_length=32)
    joint_idx: Optional[int] = Field(default=None, ge=0, le=5)                          # 0-based joint index (joint_1 = 0)
    delta_rad: Optional[float] = Field(default=None, ge=-0.8, le=0.8, allow_inf_nan=False)
    joint_targets_rad: Optional[list[float]] = Field(default=None, min_length=6, max_length=6)   # absolute targets for all 6 joints
    gripper_aperture: Optional[float] = Field(default=None, ge=0.0, le=0.07, allow_inf_nan=False)
    arm_speed_scale: Optional[float] = Field(default=None, ge=0.1, le=1.0, allow_inf_nan=False)
    pick: Optional[bool] = None
    place: Optional[bool] = None

    @field_validator("action")
    @classmethod
    def _known_action(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in DRIVE_ACTIONS:
            raise ValueError(f"unknown action {v!r}; expected one of {sorted(DRIVE_ACTIONS)}")
        return v

    @field_validator("joint_targets_rad")
    @classmethod
    def _finite_targets(cls, v: Optional[list[float]]) -> Optional[list[float]]:
        if v is not None and not all(abs(x) <= 10.0 and x == x for x in v):
            raise ValueError("joint_targets_rad must be 6 finite angles in radians")
        return v


class ReleaseRequest(StrictWire):
    lease_id: str = Field(pattern=TOKEN)
    lease_epoch: int = Field(ge=0)
    idempotency_key: str = Field(pattern=TOKEN)
    reason: Optional[ControlReason] = None

    _canon = field_validator("reason", mode="before")(_canon_reason)


# ── responses ──────────────────────────────────────────────────────────────
class LeaseGrant(Wire):
    accepted: Literal[True]
    robot_id: EntityId
    lease_id: str
    lease_epoch: float
    granted_world_version: float
    expires_in_ms: float
    heartbeat_interval_ms: float
    deadman_ms: float
    limits: DriveLimits
    topology_revision: str
    control: RobotControlInfo


class DrivePose(Wire):
    segment_id: EntityId
    s_m: float
    speed_m_s: float
    velocity_m_s: float
    facing: Literal[1, -1]
    position_xyz_m: Vec3


class DriveAck(Wire):
    accepted: Literal[True]
    robot_id: EntityId
    lease_epoch: float
    applied_seq: float
    controller_state: ControllerState
    world_version: float
    pose: DrivePose
    junction: Optional[JunctionInfo] = None
    next_node: Optional[NextNode] = None
    odometer_m: float


class ReleaseAck(Wire):
    accepted: Literal[True]
    robot_id: EntityId
    controller_state: ControllerState
    resumed: Literal["mission", "return_to_port", "docked", "blocked", "none"]
    already_released: Optional[bool] = None
    control: RobotControlInfo


class HeartbeatAck(Wire):
    accepted: Literal[True]
    expires_in_ms: float
    controller_state: ControllerState


class RobotControlPayload(Wire):
    robot_id: EntityId
    event: ControlEventKind
    reason: Optional[str] = None
    control: RobotControlInfo
    data: Optional[dict[str, Union[str, float]]] = None


CONTROL_CONTRACT_MODELS = {
    m.__name__: m
    for m in (
        ControlRefusal, JunctionExit, JunctionInfo, ToolCapability, ScanResult, RobotControlInfo, DriveLimits,
        LeaseRequest, LeaseGrant, HeartbeatRequest, DriveIntent, DriveAck, ReleaseRequest, ReleaseAck,
        RobotControlPayload,
    )
}
