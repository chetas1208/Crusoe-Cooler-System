"""Pydantic mirrors of packages/core/src/contracts.ts (API contract v1).

Rules
-----
* Names match the TypeScript names 1:1 so the golden parity test (tests/contracts) can compare them.
* Optional TS fields (`x?:`) are optional here and are *omitted* when unset (routes use
  ``response_model_exclude_unset=True`` so the wire never gains ``null`` where TS has ``undefined``).
  Fields that are explicitly nullable in TS (``tool: string | null``, ``auto_approve_at_s``) stay nullable.
* ``extra="allow"``: the engine may add fields (e.g. ``run_id``); the API never silently drops them.
  Secrets are removed by ``scrub`` instead, not by schema omission.
* SI units. Geometry in metres, x/z ground plane, y up.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

EntityId = str
Vec3 = tuple[float, float, float]


class Wire(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)




# ─────────────────────────────── Topology ───────────────────────────────

LoopId = Literal["fws", "tcs"]
PipeRole = Literal["supply", "return"]
AssetType = Literal["rack", "cdu", "pump", "valve", "strainer", "sensor", "port", "dock", "chiller"]


class Zone(Wire):
    id: EntityId
    name: str
    rack_ids: list[EntityId]
    anchor_xyz_m: Vec3


class TopologyNode(Wire):
    id: EntityId
    label: str
    loop: LoopId
    position_xyz_m: Vec3


class PipeEdge(Wire):
    id: EntityId
    label: str
    name: str
    loop: LoopId
    role: PipeRole
    zone_id: Optional[EntityId] = None
    from_: EntityId = Field(alias="from")
    to: EntityId
    centerline_xyz_m: list[Vec3]
    fillet_radius_m: float
    length_m: float
    diameter_mm: float
    clearance_mm: float
    robot_passable: bool
    not_passable_reason: Optional[str] = None
    access_port_ids: list[EntityId]


class Asset(Wire):
    id: EntityId
    type: AssetType
    label: str
    name: str
    loop: Optional[LoopId] = None
    zone_id: Optional[EntityId] = None
    position_xyz_m: Vec3
    size_m: Optional[Vec3] = None
    yaw_rad: Optional[float] = None
    edge_id: Optional[EntityId] = None
    s_m: Optional[float] = None
    accessible_by: list[Literal["inpipe", "outrig"]]
    service_xyz_m: Optional[Vec3] = None
    spec: Optional[dict[str, Union[str, float]]] = None


class NavObstacle(Wire):
    id: EntityId
    rect: tuple[float, float, float, float]
    label: Optional[str] = None


class ExpansionBay(Wire):
    id: EntityId
    position_xyz_m: Vec3
    size_m: Vec3
    yaw_rad: float


class TopologyFacility(Wire):
    id: str
    name: str
    label: Literal["Simulated facility"]
    config_version: str
    topology_hash: str
    bounds_min: Vec3
    bounds_max: Vec3
    interior_min: Vec3
    interior_max: Vec3
    wall_height_m: float


class TopologyNav(Wire):
    cell_m: float
    obstacles: list[NavObstacle]
    dock_ids: list[EntityId]


class TopologyLimits(Wire):
    chip_limit_c: float
    margin_warn_k: float
    margin_crit_k: float
    nominal_rack_kw: float


class Topology(Wire):
    facility: TopologyFacility
    expansion_bays: list[ExpansionBay]
    zones: list[Zone]
    nodes: list[TopologyNode]
    edges: list[PipeEdge]
    assets: list[Asset]
    nav: TopologyNav
    limits: TopologyLimits
    capacity: Optional[Any] = None
    context_cabinets: Optional[list[Any]] = None
    context_equipment: Optional[list[Any]] = None
    fittings: Optional[list[Any]] = None
    site: Optional[Any] = None
    supports: Optional[list[Any]] = None


# ───────────────────────────── World state ─────────────────────────────

SimStatus = Literal["running", "recovering", "degraded", "paused"]
Severity = Literal["nominal", "watch", "warning", "critical"]
AssetStatus = Literal["nominal", "watch", "warning", "critical", "offline", "isolated", "service"]


class AssetFault(Wire):
    occlusion: Optional[float] = None
    location_s_m: Optional[float] = None
    opening: Optional[float] = None
    commanded_opening: Optional[float] = None
    health: Optional[float] = None
    leak_kg_s: Optional[float] = None


class AssetState(Wire):
    status: AssetStatus
    readings: dict[str, float]
    suspect: Optional[list[str]] = None
    fault: Optional[AssetFault] = None
    locked_by: Optional[EntityId] = None


RobotClass = Literal["inpipe", "outrig"]
RobotMode = Literal[
    "IDLE", "ASSIGNED", "ROUTE_PLANNING", "TRAVELING", "INSPECTING", "WORKING", "VERIFYING",
    "RETURNING", "DOCKED", "BLOCKED", "FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD",
]


class RobotPose(Wire):
    position_xyz_m: Vec3
    yaw_rad: float
    speed_m_s: float
    segment_id: Optional[EntityId] = None
    s_m: Optional[float] = None
    heading_xyz: Optional[Vec3] = None
    quaternion_xyzw: Optional[tuple[float, float, float, float]] = None
    frame_id: Optional[str] = None
    linear_velocity_mps_xyz: Optional[Vec3] = None
    covariance_or_quality: Optional[str] = None


class RobotFleetInfo(Wire):
    group: Literal["internal", "external"]
    state: str
    dock_id: Optional[EntityId] = None
    slot: Optional[float] = None


class RobotNav(Wire):
    graph_id: Optional[str] = None
    segment_id: Optional[EntityId] = None
    s_m: Optional[float] = None
    route_id: Optional[str] = None
    floor_id: Optional[str] = None


class EndEffectorPose(Wire):
    pos_xyz: Vec3
    quat_xyzw: tuple[float, float, float, float]


class Robot(Wire):
    id: EntityId
    class_: RobotClass = Field(alias="class")
    name: str
    mode: RobotMode
    battery_pct: float
    mission_id: Optional[EntityId] = None
    agent_task_id: Optional[EntityId] = None
    tool: Optional[str] = None
    home_id: EntityId
    pose: RobotPose
    fleet: Optional[RobotFleetInfo] = None
    nav: Optional[RobotNav] = None
    dims_m: Optional[Vec3] = None
    clearance_m: Optional[float] = None
    route_xyz_m: Optional[list[Vec3]] = None
    spec: dict[str, Union[str, float]]
    control: Optional[RobotControlInfo] = None
    arm_joint_names: Optional[list[str]] = None
    arm_qpos_rad: Optional[list[float]] = None
    gripper_aperture_m: Optional[float] = None
    held_object_id: Optional[str] = None
    grip_force_N: Optional[float] = None
    end_effector_pose: Optional[EndEffectorPose] = None
    contact_list: Optional[list[str]] = None
    payload_mass_kg: Optional[float] = None
    deposit_fouling_pct: Optional[float] = None


class MissionStep(Wire):
    id: str
    command: str
    label: str
    status: Literal["pending", "active", "done", "failed", "skipped"]
    started_tick: Optional[float] = None
    ended_tick: Optional[float] = None
    result: Optional[str] = None


class Mission(Wire):
    id: EntityId
    incident_id: EntityId
    robot_id: EntityId
    kind: Literal["inspect", "clear", "service", "return"]
    title: str
    target_id: EntityId
    status: RobotMode
    progress: float
    steps: list[MissionStep]
    route_xyz_m: Optional[list[Vec3]] = None
    route_segment_ids: Optional[list[EntityId]] = None
    opened_tick: float
    closed_tick: Optional[float] = None


IncidentStage = Literal["observed", "hypothesized", "investigated", "repaired", "verified"]
IncidentStatus = Literal[
    "open", "investigating", "awaiting_approval", "mitigating", "verifying", "replanning",
    "escalated", "resolved", "dismissed",
]
FaultKind = Literal[
    "fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift",
    "workload_spike", "leak",
]


class Hypothesis(Wire):
    id: str
    cause: FaultKind
    label: str
    target_id: EntityId
    confidence: float
    status: Literal["candidate", "supported", "refuted", "confirmed"]
    evidence_for: list[str]
    evidence_against: list[str]


class Evidence(Wire):
    id: str
    kind: Literal["telemetry", "observation", "topology", "verification", "action"]
    summary: str
    asset_id: Optional[EntityId] = None
    tick: float
    data: Optional[dict[str, Union[str, float]]] = None
    tags: Optional[list[str]] = None


class ApprovalRequest(Wire):
    id: str
    incident_id: EntityId
    task_id: str
    action: str
    steps: list[str]
    requested_tick: float
    auto_approve_at_s: Optional[float]  # nullable in TS (`number | null`), required key
    status: Literal["pending", "approved", "held", "expired"]


class VerificationCheck(Wire):
    id: str
    label: str
    unit: str
    before: float
    after: float
    target: float
    direction: Literal["min", "max"]
    pass_: bool = Field(alias="pass")


class VerificationResult(Wire):
    id: str
    incident_id: EntityId
    attempt: float
    status: Literal["pending", "verified", "rejected"]
    window_s: float
    elapsed_s: float
    progress: float
    checks: list[VerificationCheck]
    confidence: float
    failed_reason: Optional[str] = None
    started_tick: float
    completed_tick: Optional[float] = None


class IncidentAnchor(Wire):
    entity_id: EntityId
    position_xyz_m: Vec3


class StageLogEntry(Wire):
    stage: IncidentStage
    tick: float
    outcome: Optional[Literal["ok", "rejected"]] = None


class Incident(Wire):
    id: EntityId
    opened_tick: float
    opened_at_s: float
    updated_tick: float
    severity: Severity
    status: IncidentStatus
    stage: IncidentStage
    stage_log: list[StageLogEntry]
    title: str
    summary: str
    cause: Union[FaultKind, Literal["unknown"]]
    anchor: IncidentAnchor
    affected_asset_ids: list[EntityId]
    hypotheses: list[Hypothesis]
    evidence: list[Evidence]
    mission_ids: list[EntityId]
    task_ids: list[str]
    approval: Optional[ApprovalRequest] = None
    verification: Optional[VerificationResult] = None
    attempts: float
    closed_tick: Optional[float] = None
    close_reason: Optional[str] = None


# ──────────────────────────── Agent trace ────────────────────────────

AgentRole = Literal["sentinel", "inpipe", "outrig"]
AgentTaskStatus = Literal["queued", "working", "blocked", "completed", "verified", "rejected", "failed"]
Provider = Literal["crusoe", "mock", "deterministic"]


class ModelMeta(Wire):
    provider: Provider
    model_id: str
    latency_ms: Optional[float] = None
    tokens_in: Optional[float] = None
    tokens_out: Optional[float] = None
    schema_version: str
    fallback: bool


class ToolCall(Wire):
    id: str
    task_id: str
    name: str
    input: dict[str, Any]
    output: Optional[dict[str, Any]] = None
    status: Literal["running", "ok", "error", "rejected"]
    tick: float
    latency_ms: Optional[float] = None


class AgentTaskOutcome(Wire):
    label: str
    ok: bool


class AgentTask(Wire):
    id: str
    incident_id: EntityId
    parent_id: Optional[str] = None
    role: AgentRole
    kind: str
    title: str
    question: str
    status: AgentTaskStatus
    depth: float
    started_tick: float
    ended_tick: Optional[float] = None
    summary: Optional[str] = None
    outcome: Optional[AgentTaskOutcome] = None
    evidence_ids: list[str]
    tool_calls: list[ToolCall]
    model: ModelMeta
    caused_by: list[str]
    robot_id: Optional[EntityId] = None
    asset_ids: list[EntityId]


# ──────────────────────────── Engine health ────────────────────────────


class SolverHealth(Wire):
    status: Literal["converged", "degraded", "failed"]
    residual: float


class IntelligenceHealth(Wire):
    provider: Provider
    model_id: str
    status: Literal["live", "unavailable", "mock"]
    model_state: Optional[str] = None
    fallback_active: Optional[bool] = None
    checkpointer: Optional[str] = None
    last_latency_ms: Optional[float] = None


class EngineHealth(Wire):
    status: SimStatus
    tick_rate_hz: float
    solver: SolverHealth
    database: Literal["ok", "unavailable", "n/a"]
    intelligence: IntelligenceHealth
    safe_automation_mode: Literal["autonomous", "supervised"]
    approval_window_s: float
    backend: Literal["mock", "live"]
    uptime_s: float
    seed: float


class Kpis(Wire):
    min_margin_k: float
    total_heat_kw: float
    tcs_flow_kg_s: float
    fws_flow_kg_s: float
    tcs_supply_c: float
    tcs_return_c: float
    open_incidents: int
    resolved_incidents: int


class RigidObjectState(Wire):
    id: str
    name: str
    mass_kg: float
    pos_xyz: Vec3
    quat_xyzw: tuple[float, float, float, float]
    held_by_robot_id: Optional[str] = None
    seated_in_fixture_id: Optional[str] = None


class MechanicalFixtureState(Wire):
    id: str
    target_component_id: str
    is_isolated: bool
    cartridge_installed: bool
    mechanical_fit_pass: bool
    pos_xyz: Vec3


class WorldSnapshot(Wire):
    facility_id: str
    version: int
    sim_tick: int
    sim_time_s: float
    sim_speed: float
    sim_status: SimStatus
    assets: dict[EntityId, AssetState]
    robots: dict[EntityId, Robot]
    missions: dict[EntityId, Mission]
    incidents: list[Incident]
    health: EngineHealth
    kpis: Kpis
    last_seq: int
    rigid_objects: Optional[dict[str, RigidObjectState]] = None
    mechanical_fixtures: Optional[dict[str, MechanicalFixtureState]] = None


# ────────────────────────────── Streaming ──────────────────────────────

EventType = Literal[
    "snapshot", "world.diff", "robot.pose", "robot.control", "mission.transition", "incident.opened",
    "incident.updated", "incident.closed", "agent.task", "agent.tool", "verification.result",
    "engine.health", "heartbeat",
]
# backend.md §9 / §11 additions (not in contracts.ts v1; the frontend ignores unknown types).
ExtendedEventType = Literal[
    "scenario.validated", "scenario.started", "scenario.completed",
    "run.fork_created",
]


class EventBase(Wire):
    event_id: str
    seq: int
    sim_tick: float
    sim_time_s: float
    world_version: float
    type: str
    entity_id: EntityId
    facility_id: str
    ts: str
    payload: Any


class WorldDiffPayload(Wire):
    assets: dict[EntityId, dict[str, Any]]  # Partial<AssetState>
    kpis: Kpis
    sim_speed: float
    sim_status: SimStatus


class RobotPosePayload(Wire):
    robot_id: EntityId
    pose: RobotPose
    battery_pct: float
    mode: RobotMode
    route_xyz_m: Optional[list[Vec3]] = None
    tool: Optional[str] = None
    mission_id: Optional[EntityId] = None
    agent_task_id: Optional[EntityId] = None
    control: Optional[RobotControlInfo] = None
    arm_joint_names: Optional[list[str]] = None
    arm_qpos_rad: Optional[list[float]] = None
    gripper_aperture_m: Optional[float] = None
    held_object_id: Optional[str] = None
    grip_force_N: Optional[float] = None
    end_effector_pose: Optional[EndEffectorPose] = None
    contact_list: Optional[list[str]] = None
    payload_mass_kg: Optional[float] = None
    deposit_fouling_pct: Optional[float] = None


class MissionTransitionPayload(Wire):
    mission: Mission
    robot_mode: RobotMode
    tool: Optional[str] = None


class IncidentPayload(Wire):
    incident: Incident


class AgentTaskPayload(Wire):
    task: AgentTask


class AgentToolPayload(Wire):
    task_id: str
    tool_call: ToolCall


class VerificationPayload(Wire):
    verification: VerificationResult


class EngineHealthPayload(Wire):
    health: EngineHealth


class HeartbeatPayload(Wire):
    server_ts: str


class SnapshotEvent(EventBase):
    type: Literal["snapshot"]
    payload: WorldSnapshot


class WorldDiffEvent(EventBase):
    type: Literal["world.diff"]
    payload: WorldDiffPayload


class RobotPoseEvent(EventBase):
    type: Literal["robot.pose"]
    payload: RobotPosePayload


class RobotControlEvent(EventBase):
    type: Literal["robot.control"]
    payload: RobotControlPayload


class MissionTransitionEvent(EventBase):
    type: Literal["mission.transition"]
    payload: MissionTransitionPayload


class IncidentOpenedEvent(EventBase):
    type: Literal["incident.opened"]
    payload: IncidentPayload


class IncidentUpdatedEvent(EventBase):
    type: Literal["incident.updated"]
    payload: IncidentPayload


class IncidentClosedEvent(EventBase):
    type: Literal["incident.closed"]
    payload: IncidentPayload


class AgentTaskEvent(EventBase):
    type: Literal["agent.task"]
    payload: AgentTaskPayload


class AgentToolEvent(EventBase):
    type: Literal["agent.tool"]
    payload: AgentToolPayload


class VerificationResultEvent(EventBase):
    type: Literal["verification.result"]
    payload: VerificationPayload


class EngineHealthEvent(EventBase):
    type: Literal["engine.health"]
    payload: EngineHealthPayload


class HeartbeatEvent(EventBase):
    type: Literal["heartbeat"]
    payload: HeartbeatPayload


class ExtendedEvent(EventBase):
    type: ExtendedEventType
    payload: dict[str, Any]


StreamEvent = Annotated[
    Union[
        SnapshotEvent, WorldDiffEvent, RobotPoseEvent, RobotControlEvent, MissionTransitionEvent, IncidentOpenedEvent,
        IncidentUpdatedEvent, IncidentClosedEvent, AgentTaskEvent, AgentToolEvent,
        VerificationResultEvent, EngineHealthEvent, HeartbeatEvent, ExtendedEvent,
    ],
    Field(discriminator="type"),
]

# TS event-type -> python event class (used by the parity test)
EVENT_CLASSES: dict[str, type[EventBase]] = {
    "snapshot": SnapshotEvent, "world.diff": WorldDiffEvent, "robot.pose": RobotPoseEvent, "robot.control": RobotControlEvent,
    "mission.transition": MissionTransitionEvent, "incident.opened": IncidentOpenedEvent,
    "incident.updated": IncidentUpdatedEvent, "incident.closed": IncidentClosedEvent,
    "agent.task": AgentTaskEvent, "agent.tool": AgentToolEvent,
    "verification.result": VerificationResultEvent, "engine.health": EngineHealthEvent,
    "heartbeat": HeartbeatEvent,
}


# ───────────────────────────── REST helpers ─────────────────────────────


class IncidentTrace(Wire):
    incident_id: EntityId
    tasks: list[AgentTask]


class TelemetrySeries(Wire):
    asset_id: EntityId
    metric: str
    unit: str
    points: list[tuple[float, float]]


CommandKind = Literal[
    "approve_action", "hold_action", "set_sim_speed", "pause", "resume", "test.inject_fault",
]


class CommandRequest(Wire):
    # request body: unknown fields are rejected (mass-assignment guard); responses stay extra="allow"
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:\-]+$")
    kind: CommandKind
    target_id: Optional[EntityId] = None
    args: Optional[dict[str, Any]] = None


class CommandAck(Wire):
    command_id: str
    accepted: bool
    reason: Optional[str] = None


class ReplayPage(Wire):
    events: list[dict[str, Any]]  # StreamEvent (validated per-type in tests; passthrough on the wire)
    next_seq: Optional[int]  # required key, nullable (`number | null`)


class ReadingMeta(Wire):
    label: str
    unit: str
    decimals: float


# Single source for units, mirrored from contracts.ts READING_META (parity-tested).
READING_UNITS: dict[str, str] = {
    "flow_kg_s": "kg/s", "tcs_flow_kg_s": "kg/s", "fws_flow_kg_s": "kg/s", "strainer_dp_kpa": "kPa",
    "dp_kpa": "kPa", "velocity_m_s": "m/s", "pressure_kpa": "kPa", "t_in_c": "°C", "t_out_c": "°C",
    "t_chip_c": "°C", "margin_k": "K", "power_kw": "kW", "heat_duty_kw": "kW", "approach_k": "K",
    "speed_pct": "%", "head_kpa": "kPa", "vibration_mm_s": "mm/s", "opening_pct": "%",
    "occlusion_pct": "%", "fws_in_c": "°C", "fws_out_c": "°C", "tcs_supply_c": "°C", "tcs_return_c": "°C",
}

SEVERITY_ORDER: list[str] = ["nominal", "watch", "warning", "critical"]
STAGES: list[str] = ["observed", "hypothesized", "investigated", "repaired", "verified"]

# Names the parity test maps 1:1 onto contracts.ts interfaces.
CONTRACT_MODELS: dict[str, type[BaseModel]] = {
    m.__name__: m
    for m in (
        Zone, TopologyNode, PipeEdge, Asset, NavObstacle, Topology, AssetState, RobotPose, RobotFleetInfo, Robot,
        MissionStep, Mission, Hypothesis, Evidence, ApprovalRequest, Incident, VerificationCheck,
        VerificationResult, ModelMeta, ToolCall, AgentTask, EngineHealth, Kpis, WorldSnapshot,
        WorldDiffPayload, RobotPosePayload, MissionTransitionPayload, IncidentTrace,
        TelemetrySeries, CommandRequest, CommandAck, ReplayPage, ReadingMeta,
        RigidObjectState, MechanicalFixtureState,
    )
}


# control models live in models_control (which imports Wire from here); bind forward refs now.
from .models_control import RobotControlInfo, RobotControlPayload  # noqa: E402

for _m in (Robot, RobotPosePayload, RobotControlEvent, SnapshotEvent, WorldSnapshot):
    _m.model_rebuild()
