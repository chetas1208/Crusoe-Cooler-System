"""Mirrors of packages/core/src/runs/types.ts (Execution-tab wire types) + the problem envelope.

Request bodies (ForkRequest, ScenarioSpec, ScenarioValidateRequest) are ``extra="forbid"``. ``RunSummary`` and the
other responses allow extras so the engine can add fields without the API dropping them.
"""
from __future__ import annotations

import time
from typing import Any, Literal, Optional

from pydantic import Field

from .models_control import StrictWire
from .models import AssetState, Incident, Kpis, Mission, Robot, SimStatus, Wire

RUNS_SCHEMA_VERSION = "lk.runs.v1"
ID = r"^[A-Za-z0-9_.:\-]{1,128}$"
ScenarioId = Literal["CR-01", "CR-02", "CR-03", "CR-04", "CR-05", "CR-06", "CR-07", "MD-01", "MD-02"]

RunKind = Literal["baseline", "scenario", "fork"]
RunState = Literal["running", "paused", "stopped", "failed"]
RunMode = Literal["LIVE", "FORK"]
ApiProblemCode = Literal[
    "not_found", "hash_mismatch", "checkpoint_missing", "checkpoint_incompatible", "cannot_reconstruct",
    "quota", "invalid", "model_unavailable", "unsupported", "read_only",
]
IssueSeverity = Literal["error", "warning", "info"]
FaultKindT = Literal[
    "fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike", "leak",
    "manifold_leak", "power_failure", "rack_thermal_runaway", "cdu_pump_backup_failure", "facility_heat_rejection_loss",
]


class RunEngine(Wire):
    backend: Literal["mock", "live"]
    build: str


class RunRecording(Wire):
    frames: float
    checkpoints: float
    events: float
    commands: float
    approx_bytes: float


class RunIncidents(Wire):
    opened: float
    resolved: float


class RunSummary(Wire):
    run_id: str
    label: str
    kind: RunKind
    mode: RunMode
    state: RunState
    parent_run_id: Optional[str]
    fork_tick: Optional[float]
    fork_snapshot_id: Optional[str]
    scenario_id: Optional[str]
    facility_id: str
    seed: float
    topology_hash: str
    topology_version: Optional[str] = None
    schema_version: str
    engine: RunEngine
    created_at: str
    current_tick: float
    current_time_s: float
    first_tick: float
    recording: RunRecording
    incidents: RunIncidents
    children: list[str]
    head_hash: Optional[str]


class CheckpointInfo(Wire):
    snapshot_id: str
    run_id: str
    tick: float
    sim_time_s: float
    hash: str
    hash_algo: str
    schema_version: str
    compatible: bool
    reason: Optional[str] = None


class CheckpointList(Wire):
    run_id: str
    schema_version: str
    checkpoints: list[CheckpointInfo]


class ReplayFrame(Wire):
    tick: float
    sim_time_s: float
    sim_speed: float
    sim_status: SimStatus
    assets: dict[str, AssetState]
    robots: dict[str, Robot]
    kpis: Kpis
    incidents: list[Incident]
    missions: dict[str, Mission]
    hash: Optional[str] = None
    inherited: Optional[bool] = None


class RecordedCommand(Wire):
    tick: float
    sim_time_s: float
    command_id: str
    kind: str
    target_id: Optional[str] = None
    args: Optional[dict[str, Any]] = None
    accepted: bool
    reason: Optional[str] = None
    source: Literal["operator", "scenario"]
    run_id: str


class ReplayGap(Wire):
    from_tick: float
    to_tick: float
    kind: Literal["not_recorded", "reduced_resolution"]
    reason: str


class ReplayWindow(Wire):
    run_id: str
    schema_version: str
    start_tick: float
    end_tick: float
    stride: float
    recorded_from_tick: float
    recorded_to_tick: float
    frames: list[ReplayFrame]
    events: list[dict[str, Any]]  # RecordedEvent[] (= StreamEvent[])
    commands: list[RecordedCommand]
    checkpoints: list[CheckpointInfo]
    gaps: list[ReplayGap]
    frozen_agent_decisions: Literal[True]


class ForkRequest(StrictWire):
    fork_tick: int = Field(ge=0)
    expected_parent_hash: str = Field(min_length=1, max_length=256)
    chosen_snapshot_id: str = Field(pattern=ID)
    label: Optional[str] = Field(default=None, max_length=120)


class ForkRng(Wire):
    stream: Literal["new", "inherited"]
    note: str


class ForkResult(Wire):
    run: RunSummary
    parent_run_id: str
    fork_tick: float
    parent_hash_before: str
    parent_hash_after: str
    restored_hash: str
    rng: ForkRng


class ApiProblem(Wire):
    code: ApiProblemCode
    message: str
    detail: Optional[Any] = None


class ScenarioFault(StrictWire):
    kind: FaultKindT
    target_id: str = Field(pattern=ID)
    onset_tick: float = Field(ge=0, le=2_000_000)
    severity: float = Field(ge=0, le=1)
    progression_s: float = Field(ge=0, le=86_400)


class ScenarioSpec(StrictWire):
    scenario_id: str = Field(pattern=ID)
    title: str = Field(min_length=1, max_length=160)
    faults: list[ScenarioFault] = Field(max_length=50)
    seed: int = Field(ge=0, le=2**31 - 1)
    workload_factor: float = Field(ge=0.1, le=2.0)
    sim_speed: float = Field(ge=0.5, le=60)
    agent_policy: Literal["autonomous", "supervised"]
    approval_window_s: float = Field(ge=0, le=3600)
    background_faults: bool


class ValidationIssue(Wire):
    path: str
    severity: IssueSeverity
    message: str
    fix: Optional[str] = None


class FieldSupport(Wire):
    path: str
    applied: bool
    note: str


class ScenarioInterpreter(Wire):
    provider: str
    model_id: str
    kind: Literal["rules", "model"]
    unresolved: list[str]


class ScenarioValidation(Wire):
    valid: bool
    spec: Optional[ScenarioSpec]
    issues: list[ValidationIssue]
    support: list[FieldSupport]
    interpreter: Optional[ScenarioInterpreter] = None
    backend: Literal["mock", "live"]


class ScenarioValidateRequest(StrictWire):
    spec: Optional[Any] = None
    text: Optional[str] = Field(default=None, max_length=2000)


class ScenarioTextSupport(Wire):
    available: bool
    kind: Literal["model", "rules", "none"]
    reason: Optional[str] = None


class ModelStatus(Wire):
    provider: Literal["crusoe", "mock", "deterministic"]
    model_id: str
    status: Literal["live", "unavailable", "mock"]
    scenario_text: ScenarioTextSupport
    last_checked_at: Optional[str] = None


class StartEpisodeRequest(StrictWire):
    scenario_id: ScenarioId
    seed: int = Field(default=12000, ge=0, le=2**31 - 1)
    duration_sim_s: Literal[1800] = 1800
    mode: Literal["LIVE"] = "LIVE"
    simulation_speed: Literal[1, 2, 3] = 1
    idempotency_key: str = Field(default_factory=lambda: f"v8-{int(time.time()*1000)}", min_length=1, max_length=160)


class EpisodeClock(Wire):
    run_id: str
    sim_elapsed_ns: int
    sim_duration_ns: int = 1_800_000_000_000
    sim_tick: int
    tick_duration_ns: int
    committed_world_version: int
    speed_target: Literal[1, 2, 3]
    speed_effective: float
    paused: bool
    server_monotonic_sample_ns: int
    server_sent_at_unix_ms: int
    clock_seq: int


RUNS_CONTRACT_MODELS = {
    m.__name__: m
    for m in (
        RunSummary, CheckpointInfo, CheckpointList, ReplayFrame, RecordedCommand, ReplayGap, ReplayWindow,
        ForkRequest, ForkResult, ApiProblem, ScenarioFault, ScenarioSpec, ValidationIssue, FieldSupport,
        ScenarioValidation, ScenarioValidateRequest, ModelStatus, StartEpisodeRequest, EpisodeClock,
    )
}
