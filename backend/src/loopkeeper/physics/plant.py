"""FacilityPlant: the authoritative physics actor implementing interfaces.Plant.

  pandapipes (quasi-steady hydraulics, re-solved on change)  ->  coupling  ->  CompOpt (thermal RC, every step)

Single-writer, deterministic given (seed, command order, step sequence). Sensors are sampled inside step() on a
fixed cadence; reads (assets/world/topology/solver_health) never touch RNG or physics state.

Command vocabulary (apply): see commands.py. Fault injection never mutates truth through sensors.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import time as _time
from dataclasses import asdict
from typing import Any

from . import measurement
from .commands import dispatch
from .config import load_config
from .coupling import ThermalNetwork
from .faults import FaultManager, FaultState
from .fluids import Fluid
from .hazards import HazardManager
from .hydraulics import FacilityHydraulics, HydInputs, HydResult
from .leak_model import CoolantLeakSimulator
from .power_fire_proxies import PowerContingencySimulator, RackFireHazardSimulator
from .rng import Rng
from .topology import build_topology

log = logging.getLogger(__name__)
Json = dict[str, Any]
SCHEMA_VERSION = 1
PUMP_IDS = ("pump_t1", "pump_t2", "pump_f1", "pump_f2")


class FacilityPlant:
    def __init__(self, seed: int = 1, *, config: Json | None = None, config_path: str | None = None,
                 faults_enabled: bool | None = None):
        cfg = config if config is not None else load_config(config_path)
        self.cfg = cfg
        self.seed = int(seed)
        ph = cfg["physics"]
        if faults_enabled is not None:
            ph["faults"]["enabled"] = bool(faults_enabled)
        self.topo = build_topology(cfg)
        self.racks = [r["id"] for r in cfg["facility"]["racks"]]            # instrumented GPU racks (fault targets)
        self.aux = [r["id"] for r in cfg["facility"].get("aux_racks", [])]  # lighter network / storage / CPU racks
        self.all_racks = self.racks + self.aux
        self.rack_zone = {r["id"]: r["zone"] for r in [*cfg["facility"]["racks"], *cfg["facility"].get("aux_racks", [])]}
        self.aux_kw = {r["id"]: float(r["kw"]) for r in cfg["facility"].get("aux_racks", [])}
        self.fluids = {l: Fluid(ph["fluids"][l]["kind"], ph["fluids"][l]["cp_j_kg_k"]) for l in ("tcs", "fws")}
        self.dt_internal = float(ph["dt_internal_s"])
        self.meas_interval = float(ph["measurement_interval_s"])
        self.hyd_cfg = ph["hydraulics"]
        # --- physics components
        self.hydraulics = FacilityHydraulics(self.topo, cfg, self.fluids)
        self.thermal = ThermalNetwork(cfg, self.racks, self.fluids, self.aux)
        self.rng_sensor = Rng(self.seed, 1)
        self.rng_fault = Rng(self.seed, 2)
        self.rng_load = Rng(self.seed, 3)
        self.rng_aux = Rng(self.seed, 4)      # aux-rack sensor noise: separate stream so aux racks never perturb the others
        # --- state
        self.time = 0.0
        self.tick = 0
        pc = ph["hydraulics"]["pumps"]
        self.ctl: Json = {
            "tcs_duty": "pump_t1", "fws_duty": "pump_f1", "tcs_speed": pc["tcs"]["speed"], "fws_speed": pc["fws"]["speed"],
            "valve_cmd": {r: self.hyd_cfg["valve_balanced_opening"] for r in self.racks},
            "load_factor": {r: 1.0 for r in self.racks}, "isolated": {}, "tripped": {}, "chiller_supply_c": ph["chiller"]["supply_c"],
        }
        self.faults = FaultState(pump_health={p: 1.0 for p in PUMP_IDS})
        lengths = {e["id"]: e["length_m"] for e in self.topo["edges"]}
        self.fault_mgr = FaultManager(self.faults, self.rng_fault, ph["faults"], self.racks, list(PUMP_IDS), "pump_t1", lengths)
        self.leak_sim = CoolantLeakSimulator()
        self.power_sim = PowerContingencySimulator()
        self.fire_sim = RackFireHazardSimulator()
        self.hazards = HazardManager(self)      # V12 hazards (CR-02/04/05): physics/hazards.py
        # topology-derived indexes (zones = rack rows)
        fac = cfg["facility"]
        self.zone_hdr = fac.get("zone_headers") or {"a": {"supply": "p_12", "return": "p_22"}, "b": {"supply": "p_17", "return": "p_27"}}
        self.zones = sorted(self.zone_hdr)
        self.edge_zones = {eid: list(zs) for eid, zs in (fac.get("edge_zones") or {"p_10": ["a", "b"], "p_20": ["a", "b"]}).items()}
        for z, h in self.zone_hdr.items():
            self.edge_zones[h["supply"]] = [z]
            self.edge_zones[h["return"]] = [z]
        self.zone_valve_ids = [a["id"] for a in self.topo["assets"] if a["type"] == "valve" and a["id"].startswith("valve_z")]
        self.flow_sensors = {a["id"]: a["edge_id"] for a in self.topo["assets"] if a["type"] == "sensor" and a["id"].startswith("sn_flow_")}
        passable = [e["id"] for e in self.topo["edges"] if e["robot_passable"]]
        fm = self.fault_mgr
        fm.foul_allowed = tuple(passable)
        hs = [self.zone_hdr[z]["supply"] for z in self.zones]
        fm.foul_weights = [(h, 1.0 / len(hs)) for h in hs]
        fm.strainers = tuple(a["id"] for a in self.topo["assets"] if a["type"] == "strainer")
        fm.sensors = tuple(sorted(self.flow_sensors))
        self.load_phase = {r: [self.rng_load.uniform(0, 6.28), self.rng_load.uniform(0, 6.28), self.rng_load.uniform(0, 6.28)]
                           for r in self.racks}
        self.vib = {"pump_t1": 1.6, "pump_t2": 0.2, "pump_f1": 1.9, "pump_f2": 0.2}
        self.open_incidents = 0
        self.fws_in_c = ph["chiller"]["supply_c"]
        # --- hydraulics cache
        self.hyd: HydResult | None = None
        self.ref: HydResult | None = None
        self.kdm: dict[str, float] = {}
        self._last_sig: dict[str, float] | None = None
        self._hard = True
        self._last_solve_t = -1e9
        self._retry_at = 0.0
        self.solve_count = 0
        self.fail: Json | None = None            # last failure {reason, t}
        self.guard: str | None = None
        self.perf = {"hyd_ms_total": 0.0, "hyd_solves": 0, "step_ms_total": 0.0, "steps": 0}
        # --- measurement cache
        self._meas_acc = 0.0
        self._meas: Json = {}
        self._assets: Json = {}
        self._kpis: Json = {}
        self._initialise()

    # ============================================================== init
    def _initialise(self) -> None:
        self._solve_hydraulics(force_ref=True)
        if self.hyd is None or not self.hyd.converged:
            raise RuntimeError(f"initial hydraulic solve failed: {self.fail}")
        h = self.hyd
        rho_t, rho_f = self.rho_loc("tcs"), self.rho_loc("fws")
        self.thermal.initialise_steady({r: self.load_w(r) for r in self.all_racks}, {r: h.rack_q[r] * rho_t for r in self.all_racks},
                                       h.q["fws"] * rho_f, self.fws_in_c)
        self._solve_hydraulics(force_ref=True)   # re-solve at the steady-state fluid temperatures
        h = self.hyd
        # design resistances per edge (healthy twin at design controls) for dP-ratio status
        rho_t, rho_f = self.rho_loc("tcs"), self.rho_loc("fws")
        for e in self.topo["edges"]:
            eid = e["id"]
            if not e["robot_passable"]:
                continue
            q = h.edge_q[eid] * (rho_f if e["loop"] == "fws" else rho_t)
            if q > 0.01:
                self.kdm[eid] = h.edge_dp_pa[eid] / (q * q)
        self.kdm["strainer_01"] = h.strainer_dp_pa["strainer_01"] / (h.q["fws"] * rho_f) ** 2
        self.kdm["strainer_02"] = h.strainer_dp_pa["strainer_02"] / (h.q["tcs"] * rho_t) ** 2
        self._take_measurement()

    # ============================================================== derived quantities
    def rho_loc(self, loop: str) -> float:
        t = self.thermal
        if loop == "tcs":
            return self.fluids["tcs"].rho(0.5 * (t.t_supply + t.t_return))
        return self.fluids["fws"].rho(0.5 * (self.fws_in_c + t.fws.t_c))

    def load_w(self, r: str) -> float:
        """Rack heat load, W (all electrical power is rejected to the coolant). V12: scaled by the rack's powered fraction."""
        return self._load_w_raw(r) * self.hazards.rack_power_factor(r)

    def _load_w_raw(self, r: str) -> float:
        wc, t = self.cfg["physics"]["workload"], self.time
        if r in self.aux_kw:
            # aux racks: slow deterministic variation (hash phase, no RNG); parked when their row or their own valve is isolated for service
            if self.ctl["isolated"].get(f"valve_z{self.rack_zone[r]}") or self.ctl["isolated"].get(f"valve_{r}"):
                return 0.0
            h = 0
            for ch in r:
                h = (h * 31 + ord(ch)) % 997
            ph = h / 997 * 6.28
            wave = 0.6 * math.sin(t / 420 + ph) + 0.4 * math.sin(t / 130 + 2 * ph)
            return self.aux_kw[r] * 1e3 * (0.93 + 0.07 * wave)
        p1, p2, p3 = self.load_phase[r]
        wave = 0.5 * math.sin(t / 310 + p1) + 0.3 * math.sin(t / 97 + p2) + 0.2 * math.sin(t / 41 + p3)
        kw = self.topo["limits"]["nominal_rack_kw"] * (wc["base_fraction"] + wc["wave_amplitude"] * wave)
        sp = self.faults.spike.get(r)
        if sp and sp["until"] > t:
            kw *= 1 + sp["extra"]
        return kw * 1e3 * self.ctl["load_factor"][r]

    def pump_running(self, pid: str) -> bool:
        if hasattr(self, "power_sim") and self.power_sim.outage_active and not self.power_sim.state.primary_pumps_powered:
            return False
        if self.hazards.pump_blocked(pid):       # V12: pump feed lost / TCS suction lost (leak emptied the make-up tank)
            return False
        c = self.ctl
        duty = c["tcs_duty"] == pid or c["fws_duty"] == pid
        health = self.faults.pump_health.get(pid, 1.0)
        return (duty and not c["isolated"].get(pid) and not c["tripped"].get(pid)
                and health > self.hyd_cfg["pumps"]["trip_health"])

    def _head_mult(self, pid: str) -> float:
        fl = self.hyd_cfg["pumps"]["head_health_floor"]
        base = fl + (1 - fl) * min(max(self.faults.pump_health.get(pid, 1.0), 0.0), 1.0)
        if hasattr(self, "leak_sim") and pid.startswith("pump_t"):
            base *= self.leak_sim.pressure_derate_factor
        return base

    def _inputs(self, healthy: bool = False) -> HydInputs:
        f, c = self.faults, self.ctl
        loops = {"tcs": self.rho_loc("tcs"), "fws": self.rho_loc("fws")}
        t = self.thermal
        mus = {"tcs": self.fluids["tcs"].mu(0.5 * (t.t_supply + t.t_return)),
               "fws": self.fluids["fws"].mu(0.5 * (self.fws_in_c + t.fws.t_c))}
        return HydInputs(
            occl={} if healthy else dict(f.occl), occl_s={} if healthy else dict(f.occl_s),
            valve_cmd=dict(c["valve_cmd"]), valve_stuck={} if healthy else dict(f.valve_stuck),
            isolated={k: v for k, v in c["isolated"].items() if v},
            pump_run={pid: (self.pump_running(pid) if not healthy else
                            (c["tcs_duty"] == pid or c["fws_duty"] == pid) and not c["isolated"].get(pid))
                      for pid in PUMP_IDS},
            pump_speed={"tcs": c["tcs_speed"], "fws": c["fws_speed"]},
            pump_head_mult={pid: (1.0 if healthy else self._head_mult(pid)) for pid in PUMP_IDS},
            rho=loops, mu=mus, leaks={} if healthy else self.hazards.leak_inputs())

    # ============================================================== hydraulics scheduling
    _TOL = {"o:": ("abs", 0.01), "theta:": ("abs", 0.01), "h0:": ("rel", 0.01), "rho:": ("rel", None)}

    def _needs_solve(self, sig: dict[str, float]) -> bool:
        if self._last_sig is None or self.hyd is None or self._hard:
            return True
        if sig.keys() != self._last_sig.keys():
            return True
        soft = False
        for k, v in sig.items():
            old = self._last_sig[k]
            if "!" in k:
                if v != old:
                    return True                      # discrete change (pump trip, valve closed...) -> immediate
                continue
            for pref, (mode, tol) in self._TOL.items():
                if k.startswith(pref):
                    tol = self.hyd_cfg["density_resolve_rel"] if tol is None else tol
                    d = abs(v - old) if mode == "abs" else abs(v - old) / max(abs(old), 1e-9)
                    if d > tol:
                        soft = True
                    break
        return soft and (self.time - self._last_solve_t >= self.hyd_cfg["min_resolve_interval_s"])

    def _solve_hydraulics(self, force_ref: bool = False) -> None:
        t0 = _time.perf_counter()
        hard = self._hard or force_ref or self.ref is None
        if hard:  # healthy twin shares the current setpoints; independent of fault progression
            self.hydraulics.configure(self._inputs(healthy=True))
            ref = self.hydraulics.solve()
            if ref.converged:
                self.ref = ref
        sig = self.hydraulics.configure(self._inputs())
        res = self.hydraulics.solve()
        self.perf["hyd_ms_total"] += (_time.perf_counter() - t0) * 1e3
        self.perf["hyd_solves"] += 1
        self.solve_count += 1
        self._last_solve_t = self.time
        if res.converged:
            self.hyd, self._last_sig, self._hard, self.fail = res, sig, False, None
        else:
            self.fail = {"reason": res.reason or "unknown", "t": self.time}
            self._retry_at = self.time + 5.0
            self._last_sig = sig
            if self.hyd is None:
                self.hyd = res

    def _maybe_solve(self) -> None:
        if self.fail and self.time < self._retry_at and not self._hard:
            return
        sig = self.hydraulics.configure(self._inputs())
        if self.fail or self._needs_solve(sig):
            self._solve_hydraulics()

    # ============================================================== stepping
    def step(self, dt_s: float) -> None:
        if not (isinstance(dt_s, (int, float)) and math.isfinite(dt_s) and 0 < dt_s <= 3600):
            raise ValueError("dt_s must be in (0, 3600]")
        t0 = _time.perf_counter()
        remaining = float(dt_s)
        while remaining > 1e-12:
            h = min(remaining, self.dt_internal)
            self._substep(h)
            remaining -= h
        self.tick += 1
        self.perf["step_ms_total"] += (_time.perf_counter() - t0) * 1e3
        self.perf["steps"] += 1

    def _substep(self, h: float) -> None:
        self.fault_mgr.step(self.time, h, self.open_incidents)
        self.time += h
        press_kpa = 240.0
        if self.hyd and getattr(self.hyd, "edge_p_pa", None):
            press_kpa = float(list(self.hyd.edge_p_pa.values())[0]) / 1000.0
        self.leak_sim.step(h, loop_pressure_kpa=press_kpa)
        self.power_sim.step(h)
        self.fire_sim.step(h)
        self.hazards.step(h)
        self._update_vibration(h)
        self._maybe_solve()
        ph = self.cfg["physics"]
        ch = ph["chiller"]
        # L1/V12: + facility_rise_k = supply-temperature rise when the facility plant cannot reject the CDU heat (CR-03)
        self.fws_in_c = (self.ctl["chiller_supply_c"] + ch["wobble_k"] * math.sin(2 * math.pi * self.time / ch["wobble_period_s"])
                         + self.thermal.facility_rise_k)
        loads = {r: self.load_w(r) for r in self.all_racks}
        if self.fire_sim.state.active:
            tr = self.fire_sim.state.target_rack_id
            tr_key = tr[5:] if tr.startswith("rack_") else tr
            if tr_key in loads:
                loads[tr_key] += self.fire_sim.state.heat_kw * 1000.0
        for r in self.hazards.runaways:          # V12 CR-05: runaway heat goes into the rack's coolant path
            if r in loads:
                loads[r] += self.hazards.extra_heat_w(r)
        self.thermal.step(h, loads, self.hyd.rack_q, self.hyd.q["fws"], self.fws_in_c, self.faults.facility)   # L1/V12: facility fault truth
        self.guard = self.thermal.guard_tripped
        self._meas_acc += h
        if self._meas_acc + 1e-9 >= self.meas_interval:
            self._meas_acc = 0.0
            self._take_measurement()

    def _update_vibration(self, h: float) -> None:
        for pid in PUMP_IDS:
            duty = self.ctl["tcs_duty"] == pid or self.ctl["fws_duty"] == pid
            health = self.faults.pump_health.get(pid, 1.0)
            target = 1.6 + (1 - health) * 7.5 if (duty and self.pump_running(pid)) else 0.2
            self.vib[pid] += (target - self.vib[pid]) * min(1.0, h / 12.0)

    def _take_measurement(self) -> None:
        self._meas = measurement.sample(self)
        self._assets, self._kpis = measurement.build_assets(self, self._meas)
        self.hazards.annotate(self._assets)

    # ============================================================== Plant protocol
    def topology(self) -> Json:
        return copy.deepcopy(self.topo)

    def assets(self) -> Json:
        return copy.deepcopy(self._assets)

    def solver_health(self) -> Json:
        h = self.hyd
        converged = self.fail is None and h is not None and h.converged
        degraded = (not converged) or bool(self.guard)
        out: Json = {"converged": bool(converged), "residual": float(h.residual) if converged and h else None,
                     "degraded": bool(degraded),
                     "mass_balance": dict(h.mass_balance) if converged and h else None}
        reasons = []
        if not converged:
            reasons.append(f"hydraulic solve failed: {(self.fail or {}).get('reason', 'unknown')}; holding last valid state")
        if self.guard:
            reasons.append(f"thermal guard: {self.guard}")
        if reasons:
            out["reason"] = "; ".join(reasons)
        return out

    def kpis(self) -> Json:
        return dict(self._kpis)

    def world(self) -> Json:
        sh = self.solver_health()
        return {
            "facility_id": self.topo["facility"]["id"], "version": self.tick, "sim_tick": self.tick, "sim_time_s": self.time,
            "sim_status": "degraded" if sh["degraded"] else "running",
            "assets": copy.deepcopy(self._assets), "kpis": dict(self._kpis),
            "health": {"solver": {"status": "failed" if not sh["converged"] else ("degraded" if sh["degraded"] else "converged"),
                                  "residual": sh["residual"] if sh["residual"] is not None else 0.0},
                       "seed": self.seed, "uptime_s": self.time},
            "hazard_zones": (self.leak_sim.get_hazard_zones() if hasattr(self, "leak_sim") else []) + (self.fire_sim.get_hazard_zones() if hasattr(self, "fire_sim") else [])
            + self.hazards.get_hazard_zones(),
            "power_state": {**(self.power_sim.state.to_dict() if hasattr(self, "power_sim") else {}), **self.hazards.power_state()},
        }

    def apply(self, cmd: Json) -> Json:
        return dispatch(self, cmd)

    def set_open_incident_count(self, n: int) -> None:
        """Engine tells the plant how many incidents are open (random fault arrivals pause at the cap)."""
        self.open_incidents = max(0, int(n))

    # ------------------------------------------------------------- truth helpers (engineering/verification only)
    def truth(self) -> Json:
        """Simulator truth for verification (never sensor-corrupted)."""
        h, t = self.hyd, self.thermal
        rho_t, rho_f = self.rho_loc("tcs"), self.rho_loc("fws")
        return {
            "time_s": self.time,
            "rack_flow_kg_s": {r: h.rack_q[r] * rho_t for r in self.racks},
            "aux_flow_kg_s": {r: h.rack_q[r] * rho_t for r in self.aux},
            "aux_chip_c": {r: t.rack[r].t_chip_c for r in self.aux},
            "tcs_flow_kg_s": h.q["tcs"] * rho_t, "fws_flow_kg_s": h.q["fws"] * rho_f,
            "chip_c": {r: t.rack[r].t_chip_c for r in self.racks},
            "margin_k": {r: self.topo["limits"]["chip_limit_c"] - t.rack[r].t_chip_c for r in self.racks},
            "rack_heat_kw": {r: self.load_w(r) / 1e3 for r in self.racks},
            "tcs_supply_c": t.t_supply, "tcs_return_c": t.t_return, "fws_in_c": self.fws_in_c, "fws_out_c": t.fws.t_c,
            "hx_duty_kw": t.q_hx_w / 1e3,
            "ext_grid_kg_s": dict(h.ext_grid_kg_s), "mass_balance": dict(h.mass_balance),
            "faults": self.faults.to_json(), "hazards": self.hazards.truth(),
            "leak_kg_s": dict(h.leak_kg_s), "tcs_makeup_kg_s": h.makeup_kg_s,
        }

    def energy_balance(self) -> Json:
        t = self.thermal
        q_it = sum(self.load_w(r) for r in self.all_racks) + self.hazards.total_extra_heat_w()
        q_rack = sum(t.rack[r].coolant_heat_w() for r in self.all_racks)
        rho_f = self.rho_loc("fws")
        q_fws = self.hyd.q["fws"] * rho_f * t.cp_f * (t.fws.t_c - self.fws_in_c)
        return {"it_w": q_it, "rack_coolant_w": q_rack, "cdu_w": t.q_hx_w, "fws_w": q_fws}

    def healthy_reference(self) -> Json:
        """Healthy-twin rack flows (kg/s) at the current setpoints (all faults removed)."""
        rho = self.rho_loc("tcs")
        return {"rack_flow_kg_s": {r: self.ref.rack_q[r] * rho for r in self.racks},
                "aux_flow_kg_s": {r: self.ref.rack_q[r] * rho for r in self.aux}, "tcs_flow_kg_s": self.ref.q["tcs"] * rho}

    def predict_steady(self, remove_faults: bool = True, loads_w: dict[str, float] | None = None) -> Json:
        """Steady-state rack flow and chip margin if (all) faults were removed, at current controls, using the
        pandapipes healthy twin and CompOpt's own conductance matrix. Pure: does not change plant state."""
        h = self.ref if remove_faults else self.hyd
        rho = self.rho_loc("tcs")
        loads = loads_w or {r: self.thermal_nominal_w(r) for r in self.racks}
        m_rack = {r: h.rack_q[r] * rho for r in self.all_racks}
        q = sum(loads.values()) + sum(self.load_w(r) for r in self.aux)
        m_tot = max(sum(m_rack.values()), 1e-6)
        rho_f = self.rho_loc("fws")
        _, eff, _ = self.thermal.cdu_duty(100.0, m_tot, self.ctl["chiller_supply_c"], h.q["fws"] * rho_f)
        cmin = min(m_tot * self.thermal.cp_t, h.q["fws"] * rho_f * self.thermal.cp_f)
        t_ret = self.ctl["chiller_supply_c"] + q / max(eff * cmin, 1e-9)
        t_sup = t_ret - q / (m_tot * self.thermal.cp_t)
        out = {}
        for r in self.racks:
            tout = t_sup + loads[r] / max(m_rack[r] * self.thermal.cp_t, 1e-9)
            chip = self.thermal.rack[r].steady_state(loads[r], tout).t_die_max
            out[r] = {"flow_kg_s": m_rack[r], "chip_c": chip, "margin_k": self.topo["limits"]["chip_limit_c"] - chip}
        return {"racks": out, "tcs_supply_c": t_sup, "tcs_return_c": t_ret}

    def thermal_nominal_w(self, r: str) -> float:
        return self.topo["limits"]["nominal_rack_kw"] * self.cfg["physics"]["workload"]["base_fraction"] * 1e3 * self.ctl["load_factor"][r]

    # ============================================================== persistence
    def _hyd_dump(self, h: HydResult | None) -> Json | None:
        if h is None:
            return None
        d = asdict(h)
        d.pop("wall_ms", None)  # wall-clock dependent -> excluded from state/hash
        d.pop("tried", None)
        return d

    @staticmethod
    def _hyd_load(d: Json | None) -> HydResult | None:
        return None if d is None else HydResult(wall_ms=0.0, tried=0, **d)

    def _state(self) -> Json:
        return {
            "schema": SCHEMA_VERSION, "topology_hash": self.topo["facility"]["topology_hash"], "seed": self.seed,
            "time": self.time, "tick": self.tick, "ctl": self.ctl, "faults": self.faults.to_json(),
            "fault_mgr": self.fault_mgr.get_state(), "hazards": self.hazards.get_state(), "load_phase": self.load_phase, "vib": self.vib,
            "open_incidents": self.open_incidents, "fws_in_c": self.fws_in_c,
            "rng": {"sensor": self.rng_sensor.get_state(), "fault": self.rng_fault.get_state(), "load": self.rng_load.get_state(),
                    "aux": self.rng_aux.get_state()},
            "thermal": self.thermal.get_state(), "hyd": self._hyd_dump(self.hyd), "ref": self._hyd_dump(self.ref),
            "kdm": self.kdm, "last_sig": self._last_sig, "hard": self._hard, "last_solve_t": self._last_solve_t,
            "retry_at": self._retry_at, "fail": self.fail, "guard": self.guard, "meas_acc": self._meas_acc,
            "meas": self._meas, "assets": self._assets, "kpis": self._kpis,
        }

    def get_state(self) -> bytes:
        return json.dumps(self._state(), sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")

    def state_hash(self) -> str:
        return hashlib.sha256(self.get_state()).hexdigest()

    def set_state(self, blob: bytes) -> None:
        try:
            s = json.loads(blob.decode("utf-8"))
        except Exception as exc:
            raise ValueError("state blob is not valid plant state") from exc
        if s.get("schema") != SCHEMA_VERSION:
            raise ValueError(f"incompatible plant state schema {s.get('schema')!r} (expected {SCHEMA_VERSION})")
        if s.get("topology_hash") != self.topo["facility"]["topology_hash"]:
            raise ValueError("state belongs to a different facility topology")
        self.seed = int(s["seed"])
        self.time, self.tick = float(s["time"]), int(s["tick"])
        self.ctl = s["ctl"]
        self.faults = FaultState.from_json(s["faults"])
        self.fault_mgr.st = self.faults
        self.fault_mgr.set_state(s["fault_mgr"])
        self.hazards.set_state(s.get("hazards"))
        self.load_phase, self.vib = s["load_phase"], s["vib"]
        self.open_incidents, self.fws_in_c = int(s["open_incidents"]), float(s["fws_in_c"])
        self.rng_sensor.set_state(s["rng"]["sensor"])
        self.rng_fault.set_state(s["rng"]["fault"])
        self.rng_load.set_state(s["rng"]["load"])
        self.rng_aux.set_state(s["rng"]["aux"])
        self.thermal.set_state(s["thermal"])
        self.hyd, self.ref = self._hyd_load(s["hyd"]), self._hyd_load(s["ref"])
        self.kdm, self._last_sig, self._hard = s["kdm"], s["last_sig"], bool(s["hard"])
        self._last_solve_t, self._retry_at = float(s["last_solve_t"]), float(s["retry_at"])
        self.fail, self.guard, self._meas_acc = s["fail"], s["guard"], float(s["meas_acc"])
        self._meas, self._assets, self._kpis = s["meas"], s["assets"], s["kpis"]
