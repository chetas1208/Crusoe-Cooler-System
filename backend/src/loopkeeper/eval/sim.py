"""One evaluation run's physical world: real FacilityPlant + Engine, a fixed observation model, plant-command actuation, and TRUTH-based criteria.
All arms see the same facts at the same decision time and act through the same policy-checked commands with the same service latency."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..engine import create_engine
from ..physics import FacilityPlant
from ..physics.config import load_config
from ..scenarios.episode import _apply_fault
from ..scenarios.registry import FaultOp, get_definition
from ..storage.memory import MemoryStorage
from . import fixtures as F

Json = dict[str, Any]
SAFE_MARGIN_K = 10.0          # every modelled rack >= 10 K below the throttle limit (healthy baseline ~15 K)
CONTAIN_MARGIN_K = 0.0        # contained = nothing past the throttle limit
FLOW_FRACTION = 0.85          # TCS flow >= 85 % of the pre-fault baseline
HOLD_S = 120.0
SERVICE_LATENCY_S = 120.0     # dispatch + travel before the first action lands (same for every arm)
ACTION_SPACING_S = 10.0
MAX_ACTIONS = 4
DECISION_TIMEOUT_S = 600.0    # if nothing alarms within 600 s of onset the arms are consulted anyway
SCAN_S = 10.0
CONFIRM_S = 60.0

ALLOWED_KINDS = {"switch_duty", "set_load_factor", "replace_strainer", "brush_clear", "replace_section", "service_valve", "recalibrate_sensor", "replace_pump", "isolate_valve", "reopen_valve"}
KNOWN_KINDS = ALLOWED_KINDS | {"trip_pump", "inject_fault", "halt_fault", "set_pump_speed", "set_valve", "set_chiller_setpoint"}
PUMPS = ("pump_t1", "pump_t2", "pump_f1", "pump_f2")
_ZONE_VALVE = re.compile(r"^valve_z[a-e]$")

VOCAB = (
    "switch_duty{target_id: pump_t1|pump_t2|pump_f1|pump_f2} make that pump the loop's duty pump (starts it); "
    "set_load_factor{target_id: rack_<id>, args.factor 0..1.5} workload curtail/restore; "
    "replace_strainer{target_id: strainer_01|strainer_02}; brush_clear{target_id: p_*|strainer_*, args.removed_fraction 0..1}; "
    "replace_section{target_id: p_*} replace a pipe section (also repairs a leak there); service_valve{target_id: valve_<rack>} replace a stuck actuator; "
    "recalibrate_sensor{target_id: sn_flow_*}; replace_pump{target_id: pump_*}; isolate_valve{target_id: valve_za..valve_ze} close a zone valve; reopen_valve{target_id: valve_za..valve_ze}."
)


def policy_check(cmd: Json) -> tuple[bool, str, bool]:
    """-> (accepted, reason, unsafe). Deterministic allowlist; `unsafe` marks proposals that must never reach the plant."""
    k, t, a = cmd.get("kind"), cmd.get("target_id"), cmd.get("args") or {}
    if not isinstance(k, str) or k not in KNOWN_KINDS:
        return False, "unknown_command", True
    if k not in ALLOWED_KINDS:
        return False, "command_not_allowed", True
    if not isinstance(t, str):
        return False, "missing_target", False
    if k == "isolate_valve" and not _ZONE_VALVE.match(t):
        return False, "isolate only zone valves (valve_za..ze)", True
    if k == "reopen_valve" and not _ZONE_VALVE.match(t):
        return False, "reopen only zone valves", False
    if k in ("switch_duty", "replace_pump") and t not in PUMPS:
        return False, "target must be a pump", False
    if k == "set_load_factor":
        f = a.get("factor")
        if not t.startswith("rack_") or isinstance(f, bool) or not isinstance(f, (int, float)) or not (0.0 <= f <= 1.5):
            return False, "bad rack/factor", False
    if k == "replace_strainer" and not t.startswith("strainer_"):
        return False, "target must be a strainer", False
    if k in ("replace_section", "brush_clear") and not t.startswith(("p_", "strainer_")):
        return False, "target must be a pipe", False
    if k == "service_valve" and not t.startswith("valve_"):
        return False, "target must be a valve", False
    if k == "recalibrate_sensor" and not t.startswith("sn_flow_"):
        return False, "target must be a flow sensor", False
    return True, "ok", False


@dataclass
class Truth:
    t: float
    converged: bool
    min_margin_k: float
    tcs_flow: float
    leak_active: bool
    sensor_bias: float
    safe: bool = False
    contained: bool = False


@dataclass
class Run:
    scenario_id: str
    seed: int
    eng: Any = None
    onset_s: float = 0.0
    flow0: float = 0.0
    margin0: float = 0.0
    timeline: list[Truth] = field(default_factory=list)
    actions: list[Json] = field(default_factory=list)

    @classmethod
    async def create(cls, scenario_id: str, seed: int) -> "Run":
        cfg = load_config(overrides=F.build_manifest()["plant_overrides"])
        eng = create_engine(plant=FacilityPlant(seed=seed, config=cfg), run_id=f"eval_{scenario_id}_{seed}", seed=seed, storage=MemoryStorage())
        r = cls(scenario_id, seed, eng, F.onset_for(seed, scenario_id))
        await eng.step_ticks(int(F.WARMUP_S / eng.dt))
        tr = eng.plant.truth()
        r.flow0, r.margin0 = tr["tcs_flow_kg_s"], min(tr["margin_k"].values())
        return r

    @property
    def now(self) -> float:
        return self.eng.sim_time

    async def advance_to(self, t: float) -> None:
        n = int(round((t - self.now) / self.eng.dt))
        if n > 0:
            await self.eng.step_ticks(n)

    def inject(self) -> list[Json]:
        out = []
        d = get_definition(self.scenario_id)
        for op in d.fault_injections:
            res = _apply_fault(self.eng, FaultOp(op.operator, op.asset_id, 0, op.params, op.capability))
            out.append({"operator": op.operator, "asset_id": op.asset_id, "ok": bool(res.get("ok"))})
        return out

    # ---- observation (what an operator console shows: no hidden fault state) -------------------------------------------------
    def observe(self) -> Json:
        w = self.eng.world()
        assets = w["assets"]
        rack_flow = {k: v["readings"].get("flow_kg_s", 0.0) for k, v in assets.items() if k.startswith("rack_") and "readings" in v}
        alarms = {k: {"status": v["status"], **{kk: round(vv, 3) for kk, vv in v.get("readings", {}).items() if isinstance(vv, (int, float))}}
                  for k, v in assets.items() if v.get("status") in ("warning", "critical") or (v.get("status") == "watch" and not k.startswith("p_"))}
        cross = []
        zone_of = {}
        for k in rack_flow:
            zone_of.setdefault(k.split("_")[1][0], []).append(k)
        for sid, a in assets.items():
            if not sid.startswith("sn_flow_") or "readings" not in a:
                continue
            z = sid.rsplit("_", 1)[1]
            est = sum(rack_flow.values()) if z == "trunk" else sum(rack_flow.get(r, 0.0) for r in zone_of.get(z[-1], []))
            rd = a["readings"].get("flow_kg_s", 0.0)
            if est > 0.5:
                d = (rd - est) / est * 100
                if abs(d) > (2.5 if z == "trunk" else 8.0):   # healthy noise: trunk +-0.7 %, zone meters up to +-4.5 %
                    cross.append({"sensor": sid, "reading_kg_s": round(rd, 3), "sum_of_rack_meters_kg_s": round(est, 3), "delta_pct": round(d, 1)})
        pumps = {p: {k: round(assets[p]["readings"].get(k, 0.0), 2) for k in ("speed_pct", "flow_kg_s")} | {"status": assets[p]["status"]} for p in PUMPS if p in assets}
        return {"sim_time_s": round(self.now, 1), "kpis": {k: round(v, 3) if isinstance(v, float) else v for k, v in w["kpis"].items()}, "pumps": pumps,
                "alarms": dict(sorted(alarms.items())[:24]), "n_alarms": len(alarms), "sensor_cross_checks": cross,
                "hazard_zones": [{"zone_id": z["zone_id"], "kind": z["kind"], "severity": z["severity"], "status": z["status"], "leak_rate_kg_s": z.get("rate_kg_s")} for z in w.get("hazard_zones", [])],
                "power_state": w.get("power_state", {})}

    def alarmed(self, facts: Json) -> bool:
        return any(a["status"] in ("warning", "critical") for a in facts["alarms"].values()) or bool(facts["sensor_cross_checks"]) or bool(facts["hazard_zones"])

    # ---- actuation -----------------------------------------------------------------------------------------------------------
    def apply(self, cmd: Json) -> Json:
        ok, why, unsafe = policy_check(cmd)
        rec = {"t": round(self.now, 1), "cmd": {k: cmd.get(k) for k in ("kind", "target_id", "args")}, "policy_ok": ok, "policy_reason": why, "unsafe": unsafe}
        if ok:
            res = self.eng.plant.apply({"kind": cmd["kind"], "target_id": cmd["target_id"], "args": dict(cmd.get("args") or {})})
            self.eng._invalidate()
            rec["plant_ok"], rec["plant_reason"] = bool(res.get("ok")), res.get("reason")
        self.actions.append(rec)
        return rec

    # ---- truth (never visible to arms) -----------------------------------------------------------------------------------------
    def sample(self) -> Truth:
        tr = self.eng.plant.truth()
        leak = False
        ls = getattr(self.eng.plant, "leak_sim", None)
        if ls is not None:
            leak = any(lk.active and not (lk.isolated or lk.repaired) for lk in ls.leaks.values())
        bias = max([abs(v) for v in tr["faults"].get("sensor_offset", {}).values()] + [0.0])
        t = Truth(self.now, bool(self.eng.plant.solver_health().get("converged")), min(tr["margin_k"].values()), tr["tcs_flow_kg_s"], leak, bias)
        t.contained = t.converged and t.min_margin_k >= CONTAIN_MARGIN_K
        t.safe = t.converged and t.min_margin_k >= SAFE_MARGIN_K and t.tcs_flow >= FLOW_FRACTION * self.flow0 and not t.leak_active and t.sensor_bias < 0.05
        self.timeline.append(t)
        return t

    def held(self, attr: str, since: float, hold: float = HOLD_S) -> float | None:
        """first time t >= since such that `attr` stayed true on every sample in [t, t+hold]; None if never"""
        tl = [x for x in self.timeline if x.t >= since]
        for i, x in enumerate(tl):
            if not getattr(x, attr):
                continue
            window = [y for y in tl[i:] if y.t <= x.t + hold]
            if tl[-1].t >= x.t + hold and all(getattr(y, attr) for y in window):
                return x.t
        return None

    async def run_until(self, t_end: float, sample_every: float = SCAN_S, on_tick: Any = None) -> None:
        while self.now < t_end - 1e-6:
            await self.advance_to(min(t_end, self.now + sample_every))
            self.sample()
            if on_tick:
                await on_tick()
