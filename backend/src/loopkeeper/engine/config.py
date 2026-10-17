"""Engine configuration (env-driven; no secrets are read or logged here except the DB URL, which is never echoed)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from typing import Any, Callable

ENGINE_VERSION = "0.1.0"
STATE_SCHEMA_VERSION = 1


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class EngineConfig:
    facility_id: str = "lab_01"
    database_url: str | None = None          # None / 'memory:' => in-memory storage
    seed: int = 1
    dt_s: float = 0.5                        # fixed simulated seconds per physics tick
    sim_speed: float = 6.0                   # sim seconds per wall second
    safe_automation_mode: str = "autonomous" # autonomous | supervised
    approval_window_s: float = 24.0          # sim seconds the operator has to veto a high-impact action
    snapshot_interval_s: float = 60.0        # sim seconds between interval snapshots
    sample_interval_s: float = 5.0           # sim seconds between persisted sensor samples
    history_len: int = 450                   # in-memory telemetry ring (samples per series)
    max_catchup_ticks: int = 600
    loop_period_s: float = 0.05              # wall seconds between loop iterations
    pose_period_s: float = 0.1               # robot.pose cadence (wall)
    diff_period_s: float = 0.5               # world.diff cadence (wall)
    health_period_s: float = 5.0
    heartbeat_period_s: float = 10.0
    agent_tick_period_s: float = 1.0         # AgentRuntime.on_tick cadence (wall)
    ring_size: int = 20000                   # events kept in memory for events_since
    max_active_runs: int = 2
    leader_heartbeat_s: float = 2.0
    leader_retry_s: float = 5.0
    # manual control
    lease_ttl_s: float = 30.0                # hard lease lifetime, renewed by heartbeat (wall)
    deadman_s: float = 1.5                   # missed-heartbeat window => SAFE_HOLD (wall)
    manual_max_speed_m_s: float = 0.12              # INPIPE crawlers (bore-limited)
    manual_max_speed_outrig_m_s: float = 0.40       # OUTRIG rovers on the 36 m hall floor (service speed; autonomous cruise is 0.45)
    manual_accel_m_s2: float = 0.15
    manual_brake_m_s2: float = 0.4
    max_world_version_age_ticks: int = 2400  # stale expected_world_version tolerance
    # robots / safety
    battery_reserve_pct: float = 12.0
    safe_service_pressure_kpa: float = 40.0
    cordon_max_load_frac: float = 0.25
    blocked_timeout_s: float = 60.0
    allow_test_faults: bool = True
    # plant factory: (seed, scenario_spec|None) -> Plant ; set by the caller
    plant_factory: Callable[[int, dict | None], Any] | None = None
    plant_command_map: dict[str, str] = field(default_factory=dict)  # override engine->plant command kinds

    @classmethod
    def from_env(cls, **overrides: Any) -> "EngineConfig":
        mode = os.environ.get("SAFE_AUTOMATION_MODE", "autonomous")
        c = cls(
            database_url=os.environ.get("DATABASE_URL") or None,
            seed=int(_f("WORLD_SEED", 1)),
            dt_s=_f("SIM_TICK_S", 0.5),
            sim_speed=_f("SIM_SPEED_MULTIPLIER", 6.0),
            safe_automation_mode=mode if mode in ("autonomous", "supervised") else "supervised",
        )
        for k, v in overrides.items():
            if not hasattr(c, k):
                raise TypeError(f"unknown engine option: {k}")
            setattr(c, k, v)
        c.validate()
        return c

    def validate(self) -> None:
        if not (0.05 <= self.dt_s <= 5.0):
            raise ValueError("dt_s out of range")
        if not (0.5 <= self.sim_speed <= 60.0):
            raise ValueError("sim_speed must be within 0.5..60")
        if self.safe_automation_mode not in ("autonomous", "supervised"):
            raise ValueError("bad safe_automation_mode")

    def public(self) -> dict:
        """Config safe to expose (no URLs/credentials/callables)."""
        skip = {"database_url", "plant_factory", "plant_command_map"}
        return {f.name: getattr(self, f.name) for f in fields(self) if f.name not in skip}
