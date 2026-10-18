"""Fault state + seeded stochastic arrival/progression (port of engine/faults.ts semantics).

Faults are wear/process driven, never decided by an AI. All randomness comes from the plant's fault RNG stream.
Only *truth* lives here; sensor drift is stored as a measurement offset and never touches physical state.

Supported kinds (contracts.FaultKind): fouling, strainer_blockage, valve_stuck, pump_degradation,
sensor_drift, workload_spike; V12 hazards A (HAZARD_KINDS_A): cdu_pump_backup_failure, facility_heat_rejection_loss. `leak` -> NOT_SUPPORTED (see README note in plant.py): a leak in a closed,
expansion-tank-pressurised loop needs a pressure-dependent orifice source/sink plus make-up flow through the
reference node; the current pandapipes formulation (fixed-pressure reference, fixed sinks) cannot do that
honestly, so no fictional pressure numbers are produced.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .rng import Rng

NOT_SUPPORTED_KINDS = {"leak": "not_supported_yet"}
SUPPORTED_KINDS = ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike")
# V12 hazards (agent L1). Kept apart from SUPPORTED_KINDS (the six random-arrival kinds scenario_live maps) on purpose.
#   cdu_pump_backup_failure     CR-01: duty TCS pump degrades/fails AND the standby is dead/weak/trips on start
#   facility_heat_rejection_loss CR-03: facility chiller capacity (+ primary-side flow) collapses; local repairs cannot fix it
HAZARD_KINDS_A = ("cdu_pump_backup_failure", "facility_heat_rejection_loss")
FACILITY_TARGETS = ("chiller_01", "facility_heat_rejection")
STANDBY_MODES = ("failed", "degraded", "fails_on_start")
FOUL_TARGETS = ("p_12", "p_17")           # weighted draw targets (random arrivals)
FOUL_ALLOWED = ("p_01", "p_02", "p_03", "p_10", "p_12", "p_17", "p_20", "p_22", "p_27")
STRAINERS = ("strainer_01", "strainer_02")
SENSORS = ("sn_flow_trunk", "sn_flow_za", "sn_flow_zb")


@dataclass
class FaultState:
    occl: dict[str, float] = field(default_factory=dict)
    occl_s: dict[str, float] = field(default_factory=dict)
    valve_stuck: dict[str, float] = field(default_factory=dict)      # rack key -> effective opening
    pump_health: dict[str, float] = field(default_factory=dict)
    spike: dict[str, dict[str, float]] = field(default_factory=dict)  # rack -> {extra, until}
    sensor_offset: dict[str, float] = field(default_factory=dict)
    sensor_drift_rate: dict[str, float] = field(default_factory=dict)
    # V12 hazards A. repair_gate: pump -> {fail_remaining, attempts, cause}; latent: pump -> standby-trips-on-start record;
    # facility: {} when healthy, else the facility heat-rejection fault truth (cap_frac, buffer, rise cap, ...)
    repair_gate: dict[str, dict[str, Any]] = field(default_factory=dict)
    latent: dict[str, dict[str, Any]] = field(default_factory=dict)
    facility: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {k: _copy(getattr(self, k)) for k in self.__dataclass_fields__}

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "FaultState":
        # keys added after a state was saved fall back to their (empty) default: old blobs stay loadable
        return cls(**{k: _copy(d[k]) for k in cls.__dataclass_fields__ if k in d})


def _copy(x):
    if isinstance(x, dict):
        return {k: _copy(v) for k, v in x.items()}
    return [_copy(v) for v in x] if isinstance(x, list) else x


class FaultManager:
    def __init__(self, st: FaultState, rng: Rng, cfg: dict[str, Any], racks: list[str], pump_ids: list[str],
                 tcs_duty: str, lengths: dict[str, float]):
        self.st, self.rng, self.cfg, self.racks, self.pump_ids = st, rng, cfg, racks, pump_ids
        self.lengths = lengths
        self.enabled = bool(cfg["enabled"])
        self.procs: list[dict[str, Any]] = []
        self.seq = 0
        self.cool: dict[str, float] = {}
        self.onsets: list[dict[str, Any]] = []
        lo, hi = cfg["first_fault_s"]
        self.next_at = rng.uniform(lo, hi)
        self.tcs_duty = tcs_duty
        # topology-derived target sets (plant overrides these; the module constants are the legacy two-zone defaults)
        self.foul_allowed: tuple = FOUL_ALLOWED
        self.foul_weights: list = [("p_17", 0.6), ("p_12", 0.4)]
        self.strainers: tuple = STRAINERS
        self.sensors: tuple = SENSORS
        self.strainer_weights: list = [("strainer_02", 0.55), ("strainer_01", 0.45)]

    # ------------------------------------------------------------------ queries
    def busy(self, now: float) -> set[str]:
        b = {p["target"] for p in self.procs if p["active"]}
        b |= {t for t, until in self.cool.items() if until > now}
        return b

    def halt(self, target: str, now: float) -> None:
        if target in FACILITY_TARGETS:
            self.clear_facility()
        for p in self.procs:
            if p["target"] == target:
                p["active"] = False
        self.cool[target] = now + self.cfg["cooldown_s"]

    # --------------------------------------------------------------------- step
    def step(self, now: float, dt: float, open_incidents: int) -> None:
        st = self.st
        if self.enabled and now >= self.next_at and open_incidents < self.cfg["max_open"]:
            kind = self._draw_kind()
            tgt = self.begin(kind, now)
            gap = -math.log(1 - self.rng.random()) * self.cfg["mean_gap_s"]
            self.next_at = now + max(self.cfg["min_gap_s"], gap) if tgt else now + 60.0
        for p in self.procs:
            if not p["active"]:
                continue
            k, t, pr = p["kind"], p["target"], p["p"]
            if k in ("fouling", "strainer_blockage"):
                cur = st.occl.get(t, 0.0)
                rate = (pr["omax"] / pr["tau"]) * (1 - cur / pr["omax"])
                st.occl[t] = min(cur + max(rate, 0.0) * dt, pr["omax"])
            elif k in ("pump_degradation", "cdu_pump_backup_failure"):
                cur = st.pump_health.get(t, 1.0)
                st.pump_health[t] = max(pr["hend"], cur - ((1 - pr["hend"]) / pr["duration"]) * dt)
            elif k == "facility_heat_rejection_loss":
                self._facility_progress(p, now + dt)
            elif k == "sensor_drift":
                st.sensor_offset[t] = st.sensor_offset.get(t, 0.0) + st.sensor_drift_rate.get(t, 0.0) * dt
                if abs(st.sensor_offset[t]) >= pr["cap"]:
                    st.sensor_drift_rate[t] = 0.0
        self._latent_standby(now, dt)
        # expired load spikes are removed so state does not grow
        for r in [r for r, s in st.spike.items() if s["until"] <= now]:
            del st.spike[r]

    def _draw_kind(self) -> str:
        w = self.cfg["weights"]
        total = sum(w.values())
        r = self.rng.random() * total
        for k, v in w.items():
            r -= v
            if r <= 0:
                return k
        return "fouling"

    # -------------------------------------------------------------------- begin
    def begin(self, kind: str, now: float, target: str | None = None, params: dict[str, float] | None = None) -> str:
        """Start a fault. Returns the target id, '' when nothing could be started. Raises ValueError for bad input."""
        if kind in NOT_SUPPORTED_KINDS:
            raise NotImplementedError(NOT_SUPPORTED_KINDS[kind])
        if kind not in SUPPORTED_KINDS and kind not in HAZARD_KINDS_A:
            raise ValueError(f"unknown fault kind {kind!r}")
        params = params or {}
        st, rng = self.st, self.rng
        busy = self.busy(now)

        def num(name: str, default: Any, lo: float, hi: float) -> float:
            if name in params:
                v = params[name]
            else:
                v = default() if callable(default) else default
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v != v or not (lo <= v <= hi):
                raise ValueError(f"param {name!r} must be a number in [{lo}, {hi}]")
            return float(v)

        def weighted(xs):
            arr = [(x, w) for x, w in xs if x not in busy]
            if not arr:
                return None
            r = rng.random() * sum(w for _, w in arr)
            for x, w in arr:
                r -= w
                if r <= 0:
                    return x
            return arr[0][0]

        if kind in HAZARD_KINDS_A:
            return self._begin_hazard(kind, now, target, params, num)
        if kind == "fouling":
            e = target or weighted(self.foul_weights)
            if not e:
                return ""
            if e not in self.foul_allowed:
                raise ValueError(f"fouling target must be one of {self.foul_allowed}")
            omax = num("omax", lambda: rng.uniform(0.6, 0.78), 0.05, 0.9)
            tau = num("tau_s", lambda: rng.uniform(70, 115), 1.0, 5000.0)
            loc = params.get("location_s_m")
            st.occl[e] = max(st.occl.get(e, 0.0), 0.01)
            st.occl_s[e] = float(loc) if isinstance(loc, (int, float)) else self.lengths.get(e, 6.0) * rng.uniform(0.38, 0.68)
            self._proc(kind, e, now, omax=omax, tau=tau)
            return e
        if kind == "strainer_blockage":
            s = target or weighted(self.strainer_weights)
            if not s:
                return ""
            if s not in self.strainers:
                raise ValueError(f"strainer target must be one of {self.strainers}")
            omax = num("omax", lambda: rng.uniform(0.65, 0.82), 0.05, 0.9)
            tau = num("tau_s", lambda: rng.uniform(170, 240), 1.0, 5000.0)
            st.occl[s] = max(st.occl.get(s, 0.0), 0.01)
            self._proc(kind, s, now, omax=omax, tau=tau)
            return s
        if kind == "valve_stuck":
            tid = target
            free = [f"valve_{r}" for r in self.racks if f"valve_{r}" not in busy]
            tid = tid or (rng.pick(free) if free else None)
            if not tid:
                return ""
            r = tid.replace("valve_", "")
            if r not in self.racks:
                raise ValueError("valve_stuck target must be a rack balancing valve")
            st.valve_stuck[r] = num("opening", lambda: rng.uniform(0.12, 0.3), 0.0, 1.0)
            self._proc(kind, f"valve_{r}", now)
            return f"valve_{r}"
        if kind == "pump_degradation":
            pump = target or self.tcs_duty
            if pump not in self.pump_ids:
                raise ValueError("pump target must be a pump id")
            hend = num("health_end", lambda: rng.uniform(0.2, 0.4), 0.0, 0.95)
            dur = num("duration_s", lambda: rng.uniform(110, 160), 1.0, 86400.0)
            self._proc(kind, pump, now, hend=hend, duration=dur)
            return pump
        if kind == "sensor_drift":
            free = [s for s in self.sensors if s not in busy]
            s = target or (rng.pick(free) if free else None)
            if not s:
                return ""
            if s not in self.sensors:
                raise ValueError(f"sensor target must be one of {self.sensors}")
            if "rate" in params:
                st.sensor_drift_rate[s] = num("rate", 0.005, 0.0, 1.0)
            else:
                sign = -1.0 if rng.random() < 0.5 else 1.0
                st.sensor_drift_rate[s] = sign * rng.uniform(0.0045, 0.0075)
            self._proc(kind, s, now, cap=num("cap", lambda: rng.uniform(0.5, 0.75), 0.0, 10.0))
            return s
        # workload_spike
        free = [f"rack_{r}" for r in self.racks if f"rack_{r}" not in busy]
        tid = target or (rng.pick(free) if free else None)
        if not tid:
            return ""
        r = tid.replace("rack_", "")
        if r not in self.racks:
            raise ValueError("workload_spike target must be a rack")
        st.spike[r] = {"extra": num("extra", lambda: rng.uniform(0.17, 0.24), 0.0, 1.0),
                       "until": now + num("duration_s", lambda: rng.uniform(200, 280), 1.0, 86400.0)}
        self._proc(kind, f"rack_{r}", now, active=False)
        return f"rack_{r}"

    # ------------------------------------------------------------------ V12 hazards A
    def _tcs_pumps(self) -> list[str]:
        return [p for p in self.pump_ids if p.startswith("pump_t")]

    def _fws_pumps(self) -> list[str]:
        return [p for p in self.pump_ids if p.startswith("pump_f")]

    def _begin_hazard(self, kind: str, now: float, target: str | None, params: dict[str, Any], num) -> str:
        st = self.st
        if kind == "cdu_pump_backup_failure":
            tcs = self._tcs_pumps()
            primary = target or self.tcs_duty
            if primary not in tcs:
                raise ValueError(f"primary pump must be one of {tuple(tcs)}")
            others = [p for p in tcs if p != primary]
            standby = params.get("standby", others[0] if others else None)
            if standby not in tcs or standby == primary:
                raise ValueError(f"standby pump must be a different TCS pump from {tuple(tcs)}")
            mode = params.get("standby_mode", "failed")
            if isinstance(mode, (int, float)) and not isinstance(mode, bool) and mode == mode and mode in (0, 1, 2):
                mode = STANDBY_MODES[int(mode)]       # numeric form for the engine command bus (params are floats there)
            if mode not in STANDBY_MODES:
                raise ValueError(f"standby_mode must be one of {STANDBY_MODES}")
            hend = num("primary_health_end", 0.0, 0.0, 0.95)
            dur = num("duration_s", 60.0, 1.0, 86400.0)
            fails = num("repair_failures", 1, 0, 5)
            if fails != int(fails):
                raise ValueError("param 'repair_failures' must be an integer")
            sb_health = num("standby_health", 0.3, 0.05, 0.9)
            start_fail = num("start_fail_s", 20.0, 1.0, 3600.0)
            self._proc(kind, primary, now, hend=hend, duration=dur)
            self.onsets[-1]["standby"] = standby
            if mode == "failed":
                st.pump_health[standby] = 0.0
            elif mode == "degraded":
                st.pump_health[standby] = min(st.pump_health.get(standby, 1.0), sb_health)
            else:   # fails_on_start: looks healthy until it takes duty, then trips after start_fail_s
                st.latent[standby] = {"mode": mode, "start_fail_s": start_fail, "started_at": None}
            if fails > 0:
                for pid in (primary, standby):
                    st.repair_gate[pid] = {"fail_remaining": int(fails), "attempts": 0,
                                           "cause": "replacement unit failed commissioning (bearing seizure on spin-up)"}
            return primary
        # facility_heat_rejection_loss
        if target is not None and target not in FACILITY_TARGETS:
            raise ValueError(f"facility fault target must be one of {FACILITY_TARGETS}")
        cap_end = num("capacity_frac_end", 0.4, 0.0, 0.95)
        dur = num("duration_s", 90.0, 1.0, 86400.0)
        fh_end = num("flow_health_end", 0.5, 0.05, 1.0)
        st.facility = {"active": True, "cap_frac": 1.0, "rated_margin": num("rated_margin", 1.10, 1.0, 1.5),
                       "buffer_j_per_k": num("buffer_mj_per_k", 8.0, 0.5, 500.0) * 1e6,
                       "rise_max_k": num("rise_max_k", 35.0, 1.0, 60.0), "cap_end": cap_end, "t0": now, "duration": dur,
                       "flow_health_end": fh_end}
        self._proc("facility_heat_rejection_loss", "chiller_01", now, cap_end=cap_end, duration=dur, fh_end=fh_end)
        return "chiller_01"

    def _facility_progress(self, proc: dict[str, Any], t: float) -> None:
        f, pr = self.st.facility, proc["p"]
        if not f.get("active"):
            return
        x = min(max((t - proc["t0"]) / pr["duration"], 0.0), 1.0)
        f["cap_frac"] = 1.0 - (1.0 - pr["cap_end"]) * x
        for pid in self._fws_pumps():      # primary-side flow loss: real head loss in the pandapipes FWS loop
            self.st.pump_health[pid] = min(self.st.pump_health.get(pid, 1.0), 1.0 - (1.0 - pr["fh_end"]) * x)

    def _latent_standby(self, now: float, dt: float) -> None:
        """A standby that trips on start: once it is the duty pump its health collapses over start_fail_s (deterministic)."""
        for pid, lt in self.st.latent.items():
            if lt.get("mode") != "fails_on_start" or self.tcs_duty != pid:
                continue
            if lt["started_at"] is None:
                lt["started_at"] = now
            x = min(max((now + dt - lt["started_at"]) / lt["start_fail_s"], 0.0), 1.0)
            self.st.pump_health[pid] = min(self.st.pump_health.get(pid, 1.0), 1.0 - x)

    def repair_pump(self, pid: str, now: float) -> dict[str, Any] | None:
        """Gate for replace_pump. None -> the repair proceeds (and the latent/gate records of this pump are cleared);
        a dict -> the repair did NOT take effect and the dict is returned as the command effects (state untouched)."""
        st = self.st
        f = st.facility
        if f.get("active") and pid in self._fws_pumps():
            return {"target": pid, "repair_outcome": "not_applicable", "health_after": st.pump_health.get(pid, 1.0),
                    "cause": "fault is upstream (facility heat rejection / primary-side supply); a local pump swap does not restore it"}
        g = st.repair_gate.get(pid)
        if g and g["fail_remaining"] > 0:
            g["fail_remaining"] -= 1
            g["attempts"] += 1
            return {"target": pid, "repair_outcome": "failed", "attempt": g["attempts"], "cause": g["cause"],
                    "health_after": st.pump_health.get(pid, 1.0), "retry_possible": True}
        st.repair_gate.pop(pid, None)
        st.latent.pop(pid, None)
        return None

    def clear_facility(self) -> bool:
        """Engineering/facility-operator restore (halt_fault chiller_01): capacity and primary-side flow return."""
        had = bool(self.st.facility.get("active"))
        self.st.facility = {}
        for pid in self._fws_pumps():
            self.st.pump_health[pid] = 1.0
        for p in self.procs:
            if p["kind"] == "facility_heat_rejection_loss":
                p["active"] = False
        return had

    def _proc(self, kind: str, target: str, now: float, active: bool = True, **p: float) -> None:
        self.seq += 1
        self.procs.append({"id": f"f_{self.seq}", "kind": kind, "target": target, "t0": now, "active": active, "p": p})
        self.onsets.append({"kind": kind, "target": target, "at": now})

    # -------------------------------------------------------------- persistence
    def get_state(self) -> dict[str, Any]:
        return {"procs": [dict(p, p=dict(p["p"])) for p in self.procs], "seq": self.seq, "cool": dict(self.cool),
                "next_at": self.next_at, "onsets": [dict(o) for o in self.onsets[-200:]], "tcs_duty": self.tcs_duty}

    def set_state(self, s: dict[str, Any]) -> None:
        self.procs = [dict(p, p=dict(p["p"])) for p in s["procs"]]
        self.seq, self.cool, self.next_at = int(s["seq"]), dict(s["cool"]), float(s["next_at"])
        self.onsets = [dict(o) for o in s["onsets"]]
        self.tcs_duty = s["tcs_duty"]
