"""Strict (extra=forbid) argument models for every command kind: the mass-assignment whitelist."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

_ID = r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$"


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=False, str_max_length=512)


class Empty(_M):
    pass


class SetSpeed(_M):
    speed: float = Field(ge=0.5, le=60.0)


class InjectFault(_M):
    kind: Literal["fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike", "leak", "manifold_leak", "power_failure", "rack_thermal_runaway",
                  "cdu_pump_backup_failure", "facility_heat_rejection_loss"]
    target: str | None = Field(default=None, pattern=_ID)
    target_id: str | None = Field(default=None, pattern=_ID)
    severity: float | None = Field(default=None, ge=0.0, le=1.0)
    params: dict[str, float] | None = None            # engine fault parameters (physics range-checks them and rejects bad values)

    @field_validator("params")
    @classmethod
    def _params(cls, v: dict[str, float] | None) -> dict[str, float] | None:
        if v is None:
            return v
        allowed = {"omax", "tau_s", "opening", "health_end", "duration_s", "rate", "cap", "extra", "orifice_m2", "reserve_kg", "racks", "pumps", "ups_runtime_s", "restore_after_s", "initial_kw", "growth_tau_s", "max_kw",
               # L1/V12 hazards A (cdu_pump_backup_failure standby_mode: 0 failed, 1 degraded, 2 fails_on_start)
               "primary_health_end", "repair_failures", "standby_health", "start_fail_s", "standby_mode", "capacity_frac_end", "flow_health_end", "rated_margin", "buffer_mj_per_k", "rise_max_k"}
        bad = sorted(set(v) - allowed)
        if bad or len(v) > 8:
            raise ValueError(f"params: unknown keys {bad}" if bad else "params: at most 8 keys")
        import math
        if any(isinstance(x, bool) or not math.isfinite(float(x)) for x in v.values()):
            raise ValueError("params: values must be finite numbers")
        return {k: float(x) for k, x in v.items()}


class StepIn(_M):
    command: str = Field(pattern=_ID)
    label: str | None = Field(default=None, max_length=200)
    args: dict[str, Any] = Field(default_factory=dict)

    @field_validator("args")
    @classmethod
    def _small(cls, v: dict) -> dict:
        if len(v) > 12:
            raise ValueError("too many args")
        return v


class MissionParams(_M):
    s_m: float | None = Field(default=None, ge=0, le=1e6)
    gauge: Literal["deposit", "bore", "flow", "general"] | None = None
    max_torque_pct: float | None = Field(default=None, ge=1, le=100)
    action: str | None = Field(default=None, pattern=_ID)
    isolate_valve: str | None = Field(default=None, pattern=_ID)


class MissionCreate(_M):
    robot_id: str = Field(pattern=_ID)
    kind: Literal["inspect", "clear", "service", "return"] | None = None
    mission_kind: Literal["inspect", "clear", "service", "return"] | None = None
    target_id: str = Field(pattern=_ID)
    mission_id: str | None = None
    title: str | None = Field(default=None, max_length=200)
    incident_id: str | None = Field(default=None, pattern=_ID)
    approval_id: str | None = Field(default=None, pattern=_ID)
    agent_task_id: str | None = Field(default=None, pattern=_ID)
    params: MissionParams | None = None
    steps: list[StepIn] | None = Field(default=None, max_length=40)
    isolation: dict[str, Any] | None = None


class MissionAbort(_M):
    reason: str = Field(default="aborted_by_request", max_length=200)
    mission_id: str | None = None


class SetLoad(_M):
    load_factor: float = Field(ge=0.0, le=1.0)


class Acquire(_M):
    robot_id: str | None = Field(default=None, pattern=_ID)
    idempotency_key: str | None = None
    expected_world_version: int | None = None
    topology_revision: str | None = None
    client_id: str | None = None
    connection_id: str | None = Field(default=None, pattern=_ID)


class Heartbeat(_M):
    lease_id: str = Field(pattern=_ID)
    lease_epoch: int | None = None


class Release(_M):
    lease_id: str = Field(pattern=_ID)
    lease_epoch: int | None = None
    idempotency_key: str | None = None
    reason: str = Field(default="released", max_length=64)


class Drive(_M):
    lease_id: str = Field(pattern=_ID)
    lease_epoch: int | None = None
    command_seq: int = Field(ge=1, le=2**40)
    idempotency_key: str | None = None
    topology_revision: str = Field(max_length=128)
    known_world_version: int | None = Field(default=None, ge=0)
    throttle: float = Field(ge=-1.0, le=1.0)
    steer: float = Field(ge=-1.0, le=1.0, default=0.0)
    brake: bool = False
    selected_exit_segment_id: str | None = Field(default=None, pattern=_ID)
    # V7: exterior robots pick a legal junction branch (left / right / straight or an exact graph edge id); envelope carries the graph revision
    branch: str | None = Field(default=None, pattern=_ID)
    graph_revision: str | None = Field(default=None, max_length=64)
    duration_ms: int = Field(ge=20, le=250)
    # manipulation intents (same wire fields as api.models_control.DriveIntent): the arm/gripper/tool are actuated by the server's MuJoCo cell,
    # only for the OUTRIG that holds the lease and the workcell; everything is range-checked here and again by the physics
    tool: Literal["lamp_on", "lamp_off", "scan"] | None = None
    action: Literal["joint_jog", "pick", "place", "clean_deposit"] | None = None
    joint_idx: int | None = Field(default=None, ge=0, le=5)
    delta_rad: float | None = Field(default=None, ge=-0.5, le=0.5)
    gripper_aperture: float | None = Field(default=None, ge=0.0, le=0.08)
    pick: bool | None = None
    place: bool | None = None


class RouteCommit(_M):
    """Commit a previewed route. Optimistic on the graph / traffic revision (never on the world tick)."""
    plan_id: str = Field(pattern=_ID)
    graph_revision: str | None = Field(default=None, max_length=64)
    traffic_revision: int | None = Field(default=None, ge=0)
    lease_id: str | None = Field(default=None, pattern=_ID)


class RouteCancel(_M):
    reason: str = Field(default="operator", max_length=64)


class ClosureSet(_M):
    edge_ids: list[str] = Field(min_length=1, max_length=40)
    closed: bool = True


class Internal(_M):
    lease_id: str | None = None
    robot_id: str | None = None
    reason: str = Field(default="", max_length=64)
    mission_id: str | None = None


def check(model: type[BaseModel], data: Any) -> tuple[BaseModel | None, str | None]:
    """Validate; the error text never echoes input values."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, "args must be an object"
    try:
        return model.model_validate(data), None
    except ValidationError as e:
        parts = [(".".join(str(x) for x in err["loc"]) or "args") + ": " + err["msg"].split(",")[0][:60] for err in e.errors()[:4]]
        return None, "invalid args - " + "; ".join(parts)
