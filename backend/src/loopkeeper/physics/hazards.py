"""V12 hazards: CR-02 manifold leak/rupture, CR-04 row/feed power failure, CR-05 rack thermal runaway / smoke.

Scope and honesty
-----------------
These are engineering simulation models, not certified fire-protection or electrical-protection engineering. Every
number below is either solved (pandapipes, CompOpt) or a documented proxy constant in this file.

CR-02  `manifold_leak`
    A leak is an ORIFICE to an ambient (atmospheric) fixed-pressure boundary hanging on the row's supply manifold node in
    the pandapipes TCS net (see hydraulics.py "V12 leak boundary"): Q = Cd*A*sqrt(2 dP/rho), dP = manifold pressure - ambient.
    The expansion tank (reference node) makes the lost mass up, so total mass is conserved and the loop sees real flow
    starvation / pressure drop in the affected row. The tank has finite usable make-up inventory (`reserve_kg`); when it is
    exhausted the TCS pumps lose suction and stop (a real consequence of an uncontained leak). Containment is derived, not
    flagged: closing the row's zone valve (valve_z<zone>, which also closes the row's rack valves) leaves the leaking manifold
    with no live element, the solver prunes the orifice and the leak flow is exactly 0. Containment is NOT repair: the leak stays
    `repaired=False` (and re-opens the moment the valve is reopened) until `replace_section` is applied to the leaking header
    AFTER it is isolated. `brush_clear` can never touch a leak. Nothing in this module ever sets `repaired` on its own.

CR-04  `power_failure`
    Two independent in-sim domains: a ROW feed (`zone_<z>`: every rack of the row rides a UPS whose energy is
    ups_runtime_s x the row's IT power at injection, drained by the row's actual IT power; when it is exhausted the row's racks
    trip to 0 W) and PUMP FEED A (`feed_a`: pump_t1 and pump_f1 lose power; the standby pumps pump_t2/pump_f2 are on feed B and
    can be started with switch_duty). Shedding load (set_load_factor) slows the UPS drain; losing the pumps while racks stay
    powered heats the racks - that is the shedding-vs-repair trade-off. Power returns only by an explicit `restore_power`,
    and only once the utility/generator is available (`restore_after_s`); the feed becoming available never restores anything
    by itself. Restored racks soft-start over RAMP_S.

CR-05  `rack_thermal_runaway`
    Electrical-origin overheating of one rack (connector/PSU heating proportional to the rack's powered fraction), modelled
    as logistic growth of extra heat dumped into the rack's coolant path, plus a smoke-obscuration proxy driven by that heat
    (first-order with ventilation time constant). Supported outcomes ONLY: detect (smoke alarm) -> safe shutdown (`depower_rack`:
    the heating source is removed, residual heat decays with TAU_DECAY_S) -> containment (depowered and heat source gone) or
    escalation (`escalate_hazard`, a recorded request for human/facility response). There is NO suppression model and NO
    autonomous firefighting; robots are prohibited from entering the zone. A depowered rack stays down until it is serviced
    (`service_rack_power`, only when de-energised, cooled and the source is gone) and then re-energised
    (`restore_rack_power`). Nothing reports serviced/repaired by itself.

All state is plain JSON (get_state/set_state), no RNG is used: given the same command sequence the result is bit-identical.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from .hydraulics import LEAK_CD, P_ATM_BAR

if TYPE_CHECKING:  # pragma: no cover
    from .plant import FacilityPlant

Json = dict[str, Any]

HAZARD_KINDS = ("manifold_leak", "power_failure", "rack_thermal_runaway")

# ---- CR-02 constants ----
LEAK_ORIFICE_RANGE = (1e-6, 3e-4)          # m2; above ~3e-4 the pandapipes solve leaves the physically meaningful regime (rack flow reversal)
LEAK_RESERVE_DEFAULT_KG = 600.0            # usable expansion-tank make-up inventory
PUDDLE_DEPTH_M = 0.005
PUDDLE_MAX_R_M = 6.5
ROAD_BLOCK_R_M = 0.8
P_REF_PA = 3.0e5                           # expansion-tank reference pressure (adapters.P_REF_BAR), absolute

# ---- CR-04 constants ----
RAMP_S = 60.0
POWER_FEED_A_PUMPS = ("pump_t1", "pump_f1")

# ---- CR-05 constants (proxies, see module docstring) ----
SMOKE_GAIN = 1.0 / (8.0 * 150.0)           # obscuration %/m per (kW * s): steady state 1 %/m at 8 kW with TAU_VENT_S = 150
TAU_VENT_S = 150.0
SMOKE_ALARM = 1.0                          # %/m  -> detected
SMOKE_CRITICAL = 5.0                       # %/m  -> escalation_required
TAU_DECAY_S = 45.0                         # residual-heat decay once the source is de-energised
CONTAINED_KW = 1.0
SERVICE_MAX_CHIP_C = 60.0


class HazardRefusal(Exception):
    """A hazard-aware command is physically/operationally refused (reason is returned to the caller verbatim)."""


def _rng(name: str, v: Any, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not (lo <= v <= hi):
        raise ValueError(f"param {name!r} must be a number in [{lo}, {hi}]")
    return float(v)


class HazardManager:
    def __init__(self, plant: "FacilityPlant"):
        self.p = plant
        self.leaks: dict[str, Json] = {}         # header edge id -> leak record
        self.power: dict[str, Json] = {}         # domain id ('row_<z>' | 'feed_a') -> record
        self.runaways: dict[str, Json] = {}      # rack key -> record
        self.breakers_open: dict[str, Json] = {}  # rack key -> {t, by}
        self.ramps: dict[str, float] = {}        # rack key -> soft-start t0
        self.log: list[Json] = []                # append-only hazard event log (truth, bounded)
        self._pos = {a["id"]: list(a["position_xyz_m"]) for a in plant.topo["assets"] if a["type"] == "rack"}
        self._node = {n["id"]: list(n["position_xyz_m"]) for n in plant.topo["nodes"]}
        self._edge = {e["id"]: e for e in plant.topo["edges"]}

    # ------------------------------------------------------------------ helpers
    def _t(self) -> float:
        return float(self.p.time)

    def _event(self, kind: str, target: str, **kw: Any) -> None:
        self.log.append({"t": round(self._t(), 3), "event": kind, "target": target, **kw})
        del self.log[:-200]

    @property
    def active(self) -> bool:
        return bool(self.leaks or self.power or self.runaways or self.breakers_open or self.ramps)

    def _zone_valve_closed(self, zone: str) -> bool:
        return bool(self.p.ctl["isolated"].get(f"valve_z{zone}"))

    def _rack_key(self, target: str | None) -> str:
        if not isinstance(target, str):
            raise ValueError("target must be a rack id")
        k = target[5:] if target.startswith("rack_") else target
        if k not in self.p.all_racks:
            raise ValueError(f"unknown rack {target!r}")
        return k

    # ------------------------------------------------------------------ injection (test.inject_fault)
    def inject(self, kind: str, target: str | None, params: Json) -> str:
        params = dict(params or {})
        if kind == "manifold_leak":
            return self._inject_leak(target, params)
        if kind == "power_failure":
            return self._inject_power(target, params)
        if kind == "rack_thermal_runaway":
            return self._inject_runaway(target, params)
        raise ValueError(f"unknown hazard kind {kind!r}")

    def _inject_leak(self, target: str | None, params: Json) -> str:
        sites = self.p.hydraulics.leak_sites
        eid = target or self.p.zone_hdr[self.p.zones[0]]["supply"]
        if eid not in sites:
            raise ValueError(f"manifold_leak target must be a row supply header: {sorted(sites)}")
        old = self.leaks.get(eid)
        if old is not None and not old["repaired"]:
            raise ValueError(f"{eid} already has an unrepaired leak")
        a = _rng("orifice_m2", params.get("orifice_m2", 2.8e-5), *LEAK_ORIFICE_RANGE)
        reserve = _rng("reserve_kg", params.get("reserve_kg", LEAK_RESERVE_DEFAULT_KG), 1.0, 1e6)
        zone = sites[eid][2:-6]                      # 'n_<z>_s_end'
        node = self._node.get(self._edge[eid]["to"], [0.0, 0.0, 0.0])
        self.leaks[eid] = {"id": f"mleak_{eid}", "edge": eid, "zone": zone, "orifice_m2": a, "t0": self._t(), "lost_kg": 0.0,
                           "rate_kg_s": 0.0, "reserve_kg": reserve, "repaired": False, "contained": False, "escalated_at": None,
                           "loc": [node[0], 0.0, node[2]], "tank_empty": False}
        self._event("leak_injected", eid, orifice_m2=a)
        self.p._hard = True
        return eid

    def _inject_power(self, target: str | None, params: Json) -> str:
        zones = self.p.zones
        tgt = target or f"zone_{zones[0]}"
        feed = tgt in ("feed_a", "power_feed_a")
        if not feed:
            z = tgt[5:] if tgt.startswith("zone_") else tgt[10:] if tgt.startswith("power_row_") else ""
            if z not in zones:
                raise ValueError(f"power_failure target must be zone_<{'|'.join(zones)}> or feed_a")
        racks = bool(_rng("racks", params.get("racks", 0 if feed else 1), 0, 1))
        pumps = bool(_rng("pumps", params.get("pumps", 1 if feed else 0), 0, 1))
        if feed:
            racks = False
            pumps = True
        if not racks and not pumps:
            raise ValueError("power_failure must fail racks and/or pumps")
        ups_s = _rng("ups_runtime_s", params.get("ups_runtime_s", 240.0), 0.0, 86400.0)
        restore_s = _rng("restore_after_s", params.get("restore_after_s", 600.0), 0.0, 86400.0)
        made: list[str] = []
        t = self._t()
        if racks:
            did = f"row_{z}"
            if did in self.power and not self.power[did]["restored"]:
                raise ValueError(f"{did} power already failed")
            kw = sum(self.p.load_w(r) for r in self.p.all_racks if self.p.rack_zone[r] == z) / 1e3
            self.power[did] = {"id": did, "kind": "row", "zone": z, "t0": t, "ups_s": ups_s, "ups_kj": ups_s * kw,
                               "ups_cap_kj": ups_s * kw, "available_at": t + restore_s, "restored": False, "restored_at": None,
                               "tripped": False, "tripped_at": None, "load_kw": kw}
            made.append(did)
        if pumps:
            did = "feed_a"
            if did in self.power and not self.power[did]["restored"]:
                raise ValueError("feed_a power already failed")
            self.power[did] = {"id": did, "kind": "pumps", "zone": None, "t0": t, "ups_s": 0.0, "ups_kj": 0.0, "ups_cap_kj": 0.0,
                               "available_at": t + restore_s, "restored": False, "restored_at": None, "tripped": True,
                               "tripped_at": t, "load_kw": 0.0}
            made.append(did)
        self._event("power_failed", ",".join(made), ups_runtime_s=ups_s, restore_after_s=restore_s)
        self.p._hard = True
        return ",".join(made)

    def _inject_runaway(self, target: str | None, params: Json) -> str:
        r = self._rack_key(target or f"rack_{self.p.racks[0]}")
        old = self.runaways.get(r)
        if old is not None and not old["serviced"]:
            raise ValueError(f"rack_{r} already has an unserviced thermal event")
        k0 = _rng("initial_kw", params.get("initial_kw", 5.0), 0.5, 50.0)
        tau = _rng("growth_tau_s", params.get("growth_tau_s", 60.0), 5.0, 3600.0)
        kmax = _rng("max_kw", params.get("max_kw", 140.0), 5.0, 400.0)
        if k0 >= kmax:
            raise ValueError("initial_kw must be below max_kw")
        self.runaways[r] = {"id": f"runaway_{r}", "rack": r, "t0": self._t(), "kw": k0, "tau": tau, "kmax": kmax, "smoke": 0.0,
                            "detected_at": None, "escalated_at": None, "depowered_at": None, "serviced": False, "serviced_at": None,
                            "contained_at": None, "peak_chip_c": 0.0}
        self._event("runaway_started", f"rack_{r}", initial_kw=k0)
        return f"rack_{r}"

    # ------------------------------------------------------------------ plant hooks (pure reads)
    def leak_inputs(self) -> dict[str, float]:
        return {e: lk["orifice_m2"] for e, lk in self.leaks.items() if not lk["repaired"]}

    def pump_blocked(self, pid: str) -> bool:
        d = self.power.get("feed_a")
        if d and not d["restored"] and pid in POWER_FEED_A_PUMPS:
            return True
        return pid.startswith("pump_t") and any(lk["tank_empty"] and not lk["repaired"] for lk in self.leaks.values())

    def rack_power_factor(self, r: str) -> float:
        if r in self.breakers_open:
            return 0.0
        zone = self.p.rack_zone[r]
        d = self.power.get(f"row_{zone}")
        f = 1.0
        if d and d["tripped"]:
            if not d["restored"]:
                return 0.0
            f = min(1.0, (self._t() - d["restored_at"]) / RAMP_S)
        t0 = self.ramps.get(r)
        if t0 is not None:
            f = min(f, (self._t() - t0) / RAMP_S)
        return max(0.0, f)

    def extra_heat_w(self, r: str) -> float:
        rn = self.runaways.get(r)
        return rn["kw"] * 1000.0 if rn else 0.0

    def total_extra_heat_w(self) -> float:
        return sum(rn["kw"] for rn in self.runaways.values()) * 1000.0

    # ------------------------------------------------------------------ stepping
    def _leak_rate(self, lk: Json) -> float:
        if self._zone_valve_closed(lk["zone"]):
            return 0.0
        h = self.p.hyd
        if h is not None and h.converged and h.q["tcs"] > 0.0:
            return float(h.leak_kg_s.get(lk["edge"], 0.0))
        # loop standing still: the expansion tank (reference pressure) still pushes fluid out of the orifice
        dp = max(P_REF_PA - P_ATM_BAR * 1e5, 0.0)
        rho = self.p.rho_loc("tcs")
        return LEAK_CD * lk["orifice_m2"] * math.sqrt(2.0 * rho * dp)

    def step(self, h: float) -> None:
        if not self.active:
            return
        p, t = self.p, self._t()
        for lk in self.leaks.values():
            if lk["repaired"]:
                lk["rate_kg_s"] = 0.0
                continue
            lk["contained"] = self._zone_valve_closed(lk["zone"])
            lk["rate_kg_s"] = self._leak_rate(lk)
            lk["lost_kg"] += lk["rate_kg_s"] * h
            if lk["lost_kg"] >= lk["reserve_kg"] and not lk["tank_empty"]:
                lk["tank_empty"] = True              # make-up exhausted: TCS pumps lose suction (pump_blocked)
                self._event("tank_empty", lk["edge"], lost_kg=round(lk["lost_kg"], 2))
        for d in self.power.values():
            if d["kind"] != "row" or d["restored"] or d["tripped"]:
                continue
            kw = sum(p.load_w(r) for r in p.all_racks if p.rack_zone[r] == d["zone"]) / 1e3
            d["load_kw"] = kw
            d["ups_kj"] = max(0.0, d["ups_kj"] - kw * h)
            if d["ups_kj"] <= 0.0:
                d["tripped"], d["tripped_at"] = True, t
                self._event("ups_exhausted_racks_tripped", d["id"])
        for r in [r for r, t0 in self.ramps.items() if t - t0 >= RAMP_S]:
            del self.ramps[r]
        for r, rn in self.runaways.items():
            f = self.rack_power_factor(r)
            if f > 0.0 and not rn["serviced"]:
                rn["kw"] = min(rn["kmax"], rn["kw"] + rn["kw"] / rn["tau"] * (1.0 - rn["kw"] / rn["kmax"]) * f * h)
            else:
                rn["kw"] = rn["kw"] * math.exp(-h / TAU_DECAY_S)
                if rn["kw"] < 0.01:
                    rn["kw"] = 0.0
            rn["smoke"] = max(0.0, rn["smoke"] + (SMOKE_GAIN * rn["kw"] - rn["smoke"] / TAU_VENT_S) * h)
            chip = p.thermal.rack[r].t_chip_c
            rn["peak_chip_c"] = max(rn["peak_chip_c"], chip)
            if rn["detected_at"] is None and rn["smoke"] >= SMOKE_ALARM:
                rn["detected_at"] = t
                self._event("smoke_detected", f"rack_{r}", smoke_pct_m=round(rn["smoke"], 3))
            if rn["contained_at"] is None and r in self.breakers_open and rn["kw"] <= CONTAINED_KW:
                rn["contained_at"] = t
                self._event("contained", f"rack_{r}")

    # ------------------------------------------------------------------ commands (called by commands.py)
    def check_brush(self, edge: str) -> None:
        lk = self.leaks.get(edge)
        if lk is not None and not lk["repaired"]:
            raise HazardRefusal(f"brushing cannot repair a leak: {edge} is leaking; isolate valve_z{lk['zone']} and replace the section")

    def on_replace_section(self, edge: str) -> Json:
        """Repair gate. Raises HazardRefusal unless the leak on `edge` is isolated. Returns effects to merge."""
        lk = self.leaks.get(edge)
        if lk is None or lk["repaired"]:
            return {}
        if not self._zone_valve_closed(lk["zone"]):
            raise HazardRefusal(f"cannot repair leaking {edge} while it is live: isolate valve_z{lk['zone']} first")
        lk["repaired"], lk["contained"], lk["rate_kg_s"] = True, True, 0.0
        lk["repaired_at"] = self._t()
        self._event("leak_repaired", edge, lost_kg=round(lk["lost_kg"], 2))
        return {"leak_repaired": lk["id"], "lost_kg": round(lk["lost_kg"], 3)}

    def depower(self, rack: str) -> Json:
        r = self._rack_key(rack)
        if r not in self.breakers_open:
            self.breakers_open[r] = {"t": self._t(), "by": "operator"}
            self.ramps.pop(r, None)
            self._event("rack_depowered", f"rack_{r}")
            self.p._hard = True
        rn = self.runaways.get(r)
        if rn and rn["depowered_at"] is None:
            rn["depowered_at"] = self._t()
        return {"rack": f"rack_{r}", "depowered": True, "thermal_event": bool(rn)}

    def service_rack(self, rack: str) -> Json:
        r = self._rack_key(rack)
        rn = self.runaways.get(r)
        if rn is None or rn["serviced"]:
            raise HazardRefusal(f"rack_{r} has no unserviced thermal event")
        if r not in self.breakers_open and self.rack_power_factor(r) > 0.0:
            raise HazardRefusal("rack is energised: depower it first (no work on an energised faulted rack)")
        if rn["kw"] > CONTAINED_KW:
            raise HazardRefusal(f"fault heat source still {rn['kw']:.1f} kW: wait for containment")
        chip = self.p.thermal.rack[r].t_chip_c
        if chip > SERVICE_MAX_CHIP_C:
            raise HazardRefusal(f"rack still hot ({chip:.0f} C > {SERVICE_MAX_CHIP_C:.0f} C): wait for cool-down")
        rn["serviced"], rn["serviced_at"] = True, self._t()
        self._event("rack_serviced", f"rack_{r}")
        return {"rack": f"rack_{r}", "serviced": True}

    def restore_rack(self, rack: str) -> Json:
        r = self._rack_key(rack)
        if r not in self.breakers_open:
            return {"rack": f"rack_{r}", "energised": True, "note": "breaker already closed"}
        rn = self.runaways.get(r)
        if rn is not None and not rn["serviced"]:
            raise HazardRefusal("faulted rack must be serviced before it is re-energised")
        d = self.power.get(f"row_{self.p.rack_zone[r]}")
        if d is not None and not d["restored"] and d["tripped"]:
            raise HazardRefusal("row feed is down")
        del self.breakers_open[r]
        self.ramps[r] = self._t()
        self._event("rack_restored", f"rack_{r}")
        self.p._hard = True
        return {"rack": f"rack_{r}", "energised": True, "soft_start_s": RAMP_S}

    def restore_power(self, target: str) -> Json:
        tgt = target or ""
        if tgt in ("feed_a", "power_feed_a"):
            did = "feed_a"
        else:
            z = tgt[5:] if tgt.startswith("zone_") else tgt[4:] if tgt.startswith("row_") else tgt[10:] if tgt.startswith("power_row_") else ""
            did = f"row_{z}"
        d = self.power.get(did)
        if d is None or d["restored"]:
            raise HazardRefusal(f"no failed power domain {target!r}")
        t = self._t()
        if t < d["available_at"]:
            raise HazardRefusal(f"supply not available yet: utility/generator ETA {d['available_at'] - t:.0f} s")
        d["restored"], d["restored_at"] = True, t
        self._event("power_restored", did)
        self.p._hard = True
        return {"domain": did, "restored": True, "soft_start_s": RAMP_S if d["tripped"] and d["kind"] == "row" else 0.0}

    def escalate(self, target: str) -> Json:
        t = self._t()
        tgt = target or ""
        r = tgt[5:] if tgt.startswith("rack_") else tgt
        rn = self.runaways.get(r)
        if rn is not None and not rn["serviced"]:
            if rn["escalated_at"] is None:
                rn["escalated_at"] = t
                self._event("escalated", f"rack_{r}")
            return {"escalated": rn["id"], "note": "recorded in-sim; no suppression or firefighting is modelled"}
        lk = self.leaks.get(tgt)
        if lk is not None and not lk["repaired"]:
            if lk["escalated_at"] is None:
                lk["escalated_at"] = t
                self._event("escalated", tgt)
            return {"escalated": lk["id"], "note": "recorded in-sim"}
        raise HazardRefusal(f"no active hazard {target!r}")

    # ------------------------------------------------------------------ exposure (world / assets / truth)
    def _square(self, x: float, z: float, r: float) -> list[list[float]]:
        return [[round(x - r, 2), round(z - r, 2)], [round(x + r, 2), round(z - r, 2)],
                [round(x + r, 2), round(z + r, 2)], [round(x - r, 2), round(z + r, 2)]]

    def get_hazard_zones(self) -> list[Json]:
        zones: list[Json] = []
        for lk in self.leaks.values():
            if lk["repaired"]:
                continue
            vol = lk["lost_kg"] / max(self.p.rho_loc("tcs"), 1.0)
            rad = min(PUDDLE_MAX_R_M, math.sqrt(max(0.01, vol / (math.pi * PUDDLE_DEPTH_M))))
            x, y, z = lk["loc"]
            zones.append({
                "zone_id": f"HAZARD_LEAK_{lk['edge'].upper()}", "kind": "leak",
                "severity": "critical" if (lk["rate_kg_s"] > 0.5 or rad >= ROAD_BLOCK_R_M) else "high",
                "status": "contained" if lk["contained"] else "active", "center_xyz": [x, y, z], "radius_m": round(rad, 2),
                "polygon": self._square(x, z, rad), "road_blocked": rad >= ROAD_BLOCK_R_M, "rate_kg_s": round(lk["rate_kg_s"], 4),
                "total_lost_kg": round(lk["lost_kg"], 2), "edge_id": lk["edge"],
                "reserve_remaining_pct": round(max(0.0, 1.0 - lk["lost_kg"] / lk["reserve_kg"]) * 100.0, 1),
                "repair_requires": f"isolate valve_z{lk['zone']} then replace_section {lk['edge']}",
                "escalated": lk["escalated_at"] is not None})
        for r, rn in self.runaways.items():
            if rn["serviced"]:
                continue
            x, y, z = self._pos.get(f"rack_{r}", [0.0, 0.0, 0.0])
            rad = min(5.5, 0.8 + 0.5 * rn["smoke"])
            contained = rn["contained_at"] is not None
            zones.append({
                "zone_id": f"HAZARD_SMOKE_RACK_{r.upper()}", "kind": "smoke", "severity": "high" if contained else "critical",
                "status": "contained" if contained else "active", "center_xyz": [x, y, z], "radius_m": round(rad, 2),
                "polygon": self._square(x, z, rad), "alarm_sounding": rn["detected_at"] is not None,
                "heat_kw": round(rn["kw"], 1), "smoke_obscuration_pct_m": round(rn["smoke"], 3), "prohibit_robot_entry": True,
                "escalation_required": rn["smoke"] >= SMOKE_CRITICAL and rn["escalated_at"] is None,
                "escalated": rn["escalated_at"] is not None, "depowered": r in self.breakers_open,
                "supported_outcomes": ["detect", "depower", "contain", "escalate"], "autonomous_firefighting": False})
        return zones

    def power_state(self) -> Json:
        rows = {d["zone"]: self._power_row(d) for d in self.power.values() if d["kind"] == "row"}
        out: Json = {}
        if rows:
            out["row_feeds"] = rows
        d = self.power.get("feed_a")
        if d is not None:
            out["pump_feed_a"] = {"failed": not d["restored"], "pumps_unpowered": [] if d["restored"] else list(POWER_FEED_A_PUMPS),
                                  "supply_available": self._t() >= d["available_at"], "restored": d["restored"]}
        if self.breakers_open:
            out["racks_depowered"] = sorted(f"rack_{r}" for r in self.breakers_open)
        failed = [d for d in self.power.values() if not d["restored"]]
        if failed:                                   # keep the legacy summary flags consistent with the modelled domains
            out["utility_online"] = False
            out["primary_pumps_powered"] = not (d_a := self.power.get("feed_a")) or d_a["restored"]
            rows = [d for d in failed if d["kind"] == "row"]
            if rows:
                out["ups_runtime_remaining_s"] = round(min((0.0 if d["tripped"] else d["ups_kj"] / max(d["load_kw"], 1e-6)) for d in rows), 1)
                out["compute_curtailed"] = any(d["tripped"] for d in rows)
        return out

    def _power_row(self, d: Json) -> Json:
        t = self._t()
        kw = d["load_kw"]
        rem = None if d["restored"] else (d["ups_kj"] / kw) if (kw > 1e-6 and not d["tripped"]) else (0.0 if d["tripped"] else None)
        return {"failed": not d["restored"], "on_ups": (not d["tripped"]) and not d["restored"], "racks_tripped": d["tripped"] and not d["restored"],
                "ups_remaining_s": None if rem is None else round(rem, 1), "it_load_kw": round(kw, 1),
                "supply_available": t >= d["available_at"], "restored": d["restored"]}

    def annotate(self, assets: Json) -> None:
        """Post-process measured assets for hazard truth. Only touches assets a hazard affects (no change when idle)."""
        if not self.active:
            return
        p = self.p
        for e, lk in self.leaks.items():
            if lk["repaired"] or e not in assets:
                continue
            a = assets[e]
            a["readings"]["leak_kg_s"] = round(lk["rate_kg_s"], 4)
            a["fault"] = {**a.get("fault", {}), "leak_kg_s": round(lk["rate_kg_s"], 4)}
            if not lk["contained"]:
                a["status"] = "critical" if lk["rate_kg_s"] > 0.2 else "warning"
        for d in self.power.values():
            if d["restored"]:
                continue
            if d["kind"] == "row":
                for r in p.all_racks:
                    if p.rack_zone[r] != d["zone"] or f"rack_{r}" not in assets:
                        continue
                    a = assets[f"rack_{r}"]
                    a["readings"]["power_available"] = 0.0 if d["tripped"] else 1.0
                    if not d["tripped"]:
                        a["readings"]["ups_remaining_s"] = round(d["ups_kj"] / max(d["load_kw"], 1e-6), 1)
                        if a["status"] in ("nominal", "watch"):
                            a["status"] = "warning"
                    elif a["status"] not in ("critical",):
                        a["status"] = "offline"
            else:
                for pid in POWER_FEED_A_PUMPS:
                    if pid in assets:
                        assets[pid]["readings"]["power_available"] = 0.0
                        assets[pid]["status"] = "offline"
        for r in self.breakers_open:
            a = assets.get(f"rack_{r}")
            if a is not None:
                a["readings"]["breaker_closed"] = 0.0
                if a["status"] in ("nominal", "watch", "warning", "isolated"):
                    a["status"] = "offline"
        for r, rn in self.runaways.items():
            a = assets.get(f"rack_{r}")
            if a is None or rn["serviced"]:
                continue
            a["readings"]["smoke_obscuration_pct_m"] = round(rn["smoke"], 3)
            a["readings"].setdefault("breaker_closed", 0.0 if r in self.breakers_open else 1.0)
            if r not in self.breakers_open and rn["detected_at"] is not None:
                a["status"] = "critical"

    def truth(self) -> Json:
        return {
            "leaks": {e: {k: (round(v, 6) if isinstance(v, float) else v) for k, v in lk.items() if k != "loc"} for e, lk in self.leaks.items()},
            "power": {d: {k: (round(v, 6) if isinstance(v, float) else v) for k, v in rec.items()} for d, rec in self.power.items()},
            "runaways": {r: {k: (round(v, 6) if isinstance(v, float) else v) for k, v in rn.items()} for r, rn in self.runaways.items()},
            "breakers_open": {r: dict(b) for r, b in self.breakers_open.items()},
            "log": [dict(x) for x in self.log[-50:]],
        }

    # ------------------------------------------------------------------ persistence
    def get_state(self) -> Json:
        cp = lambda d: {k: dict(v) for k, v in d.items()}  # noqa: E731
        s = {"leaks": cp(self.leaks), "power": cp(self.power), "runaways": cp(self.runaways), "breakers_open": cp(self.breakers_open),
             "ramps": dict(self.ramps), "log": [dict(x) for x in self.log]}
        for lk in s["leaks"].values():
            lk["loc"] = list(lk["loc"])
        return s

    def set_state(self, s: Json | None) -> None:
        s = s or {}
        cp = lambda d: {k: dict(v) for k, v in (d or {}).items()}  # noqa: E731
        self.leaks, self.power, self.runaways = cp(s.get("leaks")), cp(s.get("power")), cp(s.get("runaways"))
        self.breakers_open = cp(s.get("breakers_open"))
        self.ramps = {k: float(v) for k, v in (s.get("ramps") or {}).items()}
        self.log = [dict(x) for x in (s.get("log") or [])]
        for lk in self.leaks.values():
            lk["loc"] = list(lk["loc"])
