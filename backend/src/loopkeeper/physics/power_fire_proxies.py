"""Conservative power contingency and rack fire/smoke hazard models.

Provides physically and operationally coherent representations for:
- CR-04: Combined power & cooling double contingency (utility outage, UPS battery domains, pump power loss, charger isolation).
- CR-05: Electrical rack smoke/fire (heat surge, smoke exclusion zone, automatic alarm, emergency power trip, robot evacuation).

Note: These are engineering test models for data center operational simulation;
they do not substitute for certified NFPA-75 fire suppression engineering.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, List, Optional

Json = dict[str, Any]


@dataclass
class PowerState:
    utility_online: bool = True
    backup_gen_available: bool = False
    ups_runtime_remaining_s: float = 900.0  # 15 minutes control UPS
    primary_pumps_powered: bool = True
    robot_chargers_online: bool = True
    telemetry_online: bool = True
    compute_curtailed: bool = False

    def to_dict(self) -> Json:
        return {
            "utility_online": self.utility_online,
            "backup_gen_available": self.backup_gen_available,
            "ups_runtime_remaining_s": round(self.ups_runtime_remaining_s, 1),
            "primary_pumps_powered": self.primary_pumps_powered,
            "robot_chargers_online": self.robot_chargers_online,
            "telemetry_online": self.telemetry_online,
            "compute_curtailed": self.compute_curtailed,
        }


class PowerContingencySimulator:
    """Simulates common-mode power contingency (CR-04)."""

    def __init__(self):
        self.state = PowerState()
        self.outage_active = False

    def trigger_outage(self) -> None:
        self.outage_active = True
        self.state.utility_online = False
        self.state.backup_gen_available = False
        self.state.primary_pumps_powered = False
        self.state.robot_chargers_online = False

    def step(self, dt_s: float) -> None:
        if self.outage_active:
            self.state.ups_runtime_remaining_s = max(0.0, self.state.ups_runtime_remaining_s - dt_s)
            if self.state.ups_runtime_remaining_s <= 0:
                self.state.telemetry_online = False

    def apply_compute_curtailment(self) -> None:
        self.state.compute_curtailed = True


@dataclass
class FireHazardState:
    target_rack_id: str
    location_xyz: tuple[float, float, float]
    active: bool = False
    tripped: bool = False
    contained: bool = False
    heat_kw: float = 0.0
    smoke_radius_m: float = 0.0
    alarm_sounding: bool = False
    evacuation_zone_id: str = "HAZARD_FIRE_RACK_A1"

    def to_dict(self) -> Json:
        return {
            "target_rack_id": self.target_rack_id,
            "location_xyz": list(self.location_xyz),
            "active": self.active,
            "tripped": self.tripped,
            "contained": self.contained,
            "heat_kw": round(self.heat_kw, 1),
            "smoke_radius_m": round(self.smoke_radius_m, 2),
            "alarm_sounding": self.alarm_sounding,
            "evacuation_zone_id": self.evacuation_zone_id,
        }


class RackFireHazardSimulator:
    """Simulates electrical rack thermal overload, smoke plume proxy, and emergency response (CR-05)."""

    def __init__(self, target_rack_id: str = "rack_a1", location_xyz: tuple[float, float, float] = (-14.0, 1.2, -4.0)):
        self.state = FireHazardState(
            target_rack_id=target_rack_id,
            location_xyz=location_xyz,
            evacuation_zone_id=f"HAZARD_FIRE_{target_rack_id.upper()}",
        )

    def trigger_fire(self, initial_heat_kw: float = 48.0) -> None:
        self.state.active = True
        self.state.heat_kw = initial_heat_kw
        self.state.alarm_sounding = True
        self.state.smoke_radius_m = 1.5

    def emergency_trip(self) -> None:
        """Emergency electrical power trip of the affected rack."""
        self.state.tripped = True
        self.state.contained = True

    def step(self, dt_s: float) -> None:
        if not self.state.active:
            return

        if self.state.tripped:
            # Heat decays after power cutoff
            self.state.heat_kw = max(2.0, self.state.heat_kw - 4.5 * dt_s)
            self.state.smoke_radius_m = max(1.0, self.state.smoke_radius_m - 0.1 * dt_s)
        else:
            # Growing fire / smoke exclusion zone
            self.state.heat_kw = min(95.0, self.state.heat_kw + 2.0 * dt_s)
            self.state.smoke_radius_m = min(5.5, self.state.smoke_radius_m + 0.15 * dt_s)

    def get_hazard_zones(self) -> list[Json]:
        if not self.state.active:
            return []
        x, y, z = self.state.location_xyz
        r = self.state.smoke_radius_m
        return [{
            "zone_id": self.state.evacuation_zone_id,
            "kind": "fire" if not self.state.contained else "smoke",
            "severity": "critical" if not self.state.contained else "high",
            "status": "contained" if self.state.contained else "active",
            "center_xyz": [x, y, z],
            "radius_m": r,
            "polygon": [
                [round(x - r, 2), round(z - r, 2)],
                [round(x + r, 2), round(z - r, 2)],
                [round(x + r, 2), round(z + r, 2)],
                [round(x - r, 2), round(z + r, 2)],
            ],
            "alarm_sounding": self.state.alarm_sounding,
            "heat_kw": round(self.state.heat_kw, 1),
            "prohibit_robot_entry": True,
        }]
