"""Validated conservative physical model for liquid coolant leakage and floor hazards.

Implements standard orifice discharge hydraulics:
  q_leak = C_d * A_orifice * sqrt(2 * rho * delta_P)

Couples lost coolant inventory to loop pressure derating and models puddle
expansion on the data center floor as a spatial hazard zone.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, List, Optional

Json = dict[str, Any]

DISCHARGE_COEFF = 0.62
FLUID_DENSITY_KG_M3 = 1000.0  # water / treated glycol
NOMINAL_INVENTORY_KG = 1200.0
NOMINAL_PUDDLE_DEPTH_M = 0.005  # 5 mm thin film


@dataclass
class LeakState:
    leak_id: str
    target_edge_id: str
    orifice_m2: float
    location_xyz: tuple[float, float, float]
    active: bool = True
    isolated: bool = False
    repaired: bool = False
    rate_kg_s: float = 0.0
    total_lost_kg: float = 0.0
    puddle_radius_m: float = 0.0
    hazard_zone_id: str = "HAZARD_ROAD_02"
    road_blocked: bool = False

    def to_dict(self) -> Json:
        return {
            "leak_id": self.leak_id,
            "target_edge_id": self.target_edge_id,
            "orifice_m2": self.orifice_m2,
            "location_xyz": list(self.location_xyz),
            "active": self.active,
            "isolated": self.isolated,
            "repaired": self.repaired,
            "rate_kg_s": round(self.rate_kg_s, 4),
            "total_lost_kg": round(self.total_lost_kg, 2),
            "puddle_radius_m": round(self.puddle_radius_m, 2),
            "hazard_zone_id": self.hazard_zone_id,
            "road_blocked": self.road_blocked,
        }


class CoolantLeakSimulator:
    """Server-authoritative coolant leak and hazard zone model."""

    def __init__(self, total_inventory_kg: float = NOMINAL_INVENTORY_KG):
        self.initial_inventory_kg = total_inventory_kg
        self.current_inventory_kg = total_inventory_kg
        self.leaks: dict[str, LeakState] = {}

    def inject_leak(
        self,
        leak_id: str,
        target_edge_id: str,
        orifice_m2: float = 2.8e-5,
        location_xyz: tuple[float, float, float] = (-12.0, 0.0, -6.0),
    ) -> LeakState:
        st = LeakState(
            leak_id=leak_id,
            target_edge_id=target_edge_id,
            orifice_m2=max(1e-6, orifice_m2),
            location_xyz=location_xyz,
            hazard_zone_id=f"HAZARD_{target_edge_id.upper()}",
        )
        self.leaks[leak_id] = st
        return st

    def isolate(self, leak_id: str) -> bool:
        if leak_id in self.leaks:
            self.leaks[leak_id].isolated = True
            self.leaks[leak_id].rate_kg_s = 0.0
            return True
        return False

    def repair(self, leak_id: str) -> bool:
        if leak_id in self.leaks and self.leaks[leak_id].isolated:
            self.leaks[leak_id].active = False
            self.leaks[leak_id].repaired = True
            self.leaks[leak_id].rate_kg_s = 0.0
            self.leaks[leak_id].road_blocked = False
            return True
        return False

    def step(self, dt_s: float, loop_pressure_kpa: float = 240.0) -> None:
        """Advance orifice flow, mass inventory depletion, and floor spread."""
        if dt_s <= 0:
            return

        delta_p_pa = max(0.0, loop_pressure_kpa * 1000.0 - 101325.0)  # gauge pressure

        for st in self.leaks.values():
            if not st.active or st.isolated or st.repaired or self.current_inventory_kg <= 0:
                st.rate_kg_s = 0.0
                continue

            # Standard orifice equation: q = Cd * A * sqrt(2 * rho * delta_P)
            # Pressure derating based on remaining inventory
            inv_ratio = max(0.05, self.current_inventory_kg / self.initial_inventory_kg)
            eff_delta_p = delta_p_pa * math.pow(inv_ratio, 1.4)
            q_kg_s = DISCHARGE_COEFF * st.orifice_m2 * math.sqrt(2.0 * FLUID_DENSITY_KG_M3 * eff_delta_p)

            # Cap flow by available mass
            step_loss_kg = min(self.current_inventory_kg, q_kg_s * dt_s)
            st.rate_kg_s = step_loss_kg / dt_s
            st.total_lost_kg += step_loss_kg
            self.current_inventory_kg = max(0.0, self.current_inventory_kg - step_loss_kg)

            # Floor spreading: V = m / rho, Area = pi * r^2 = V / h
            puddle_vol_m3 = st.total_lost_kg / FLUID_DENSITY_KG_M3
            st.puddle_radius_m = min(6.5, math.sqrt(max(0.01, puddle_vol_m3 / (math.pi * NOMINAL_PUDDLE_DEPTH_M))))

            # Road blockage threshold: >0.8m puddle crosses rover traffic corridor
            st.road_blocked = st.puddle_radius_m >= 0.8

    @property
    def pressure_derate_factor(self) -> float:
        """Hydraulic head reduction factor caused by inventory depletion."""
        ratio = max(0.0, self.current_inventory_kg / self.initial_inventory_kg)
        return max(0.15, math.pow(ratio, 1.5))

    def get_hazard_zones(self) -> list[Json]:
        zones = []
        for st in self.leaks.values():
            if not st.active and st.repaired:
                continue
            x, y, z = st.location_xyz
            r = st.puddle_radius_m
            zones.append({
                "zone_id": st.hazard_zone_id,
                "kind": "leak",
                "severity": "critical" if st.rate_kg_s > 0.5 or st.road_blocked else "high",
                "status": "contained" if st.isolated else "active",
                "center_xyz": [x, y, z],
                "radius_m": r,
                "polygon": [
                    [round(x - r, 2), round(z - r, 2)],
                    [round(x + r, 2), round(z - r, 2)],
                    [round(x + r, 2), round(z + r, 2)],
                    [round(x - r, 2), round(z + r, 2)],
                ],
                "road_blocked": st.road_blocked,
                "rate_kg_s": round(st.rate_kg_s, 3),
                "total_lost_kg": round(st.total_lost_kg, 1),
            })
        return zones
