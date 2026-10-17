"""Plant-level command vocabulary for Plant.apply(cmd).

cmd = {"kind": str, "target_id": str?, "args": {...}?, "command_id": str?}   (same shape as contracts.CommandRequest)
Result = {"ok": bool, "reason"?: str, "effects": {...}}.  Never raises, never leaks internals: every input is
validated server-side (kind whitelist, id whitelist, numeric type/range, unknown arg keys rejected).

kind                 target_id             args                                   effect
-------------------  --------------------  -------------------------------------  ---------------------------------
set_valve            valve_<rack>          opening 0.02..1                        commanded balancing-valve opening
isolate_valve        valve_* | pump_*      -                                      close valve / take pump into service
reopen_valve         valve_* | pump_*      -                                      reverse of isolate_valve
set_pump_speed       pump_*                speed 0.3..1.0                         loop pump speed fraction
switch_duty          pump_*                -                                      make this pump the loop's duty pump
trip_pump            pump_*                -                                      hard failure (no head)
brush_clear          p_* | strainer_*      removed_fraction 0..1                  occlusion *= (1 - removed_fraction)
replace_section      p_*                   -                                      occlusion -> 0 (hard scale removed)
replace_strainer     strainer_*            -                                      basket exchanged, occlusion -> 0
service_valve        valve_<rack>          -                                      stuck actuator replaced
replace_pump         pump_*                -                                      health -> 1, trip cleared
recalibrate_sensor   sn_flow_*             -                                      drift offset -> 0
set_load_factor      rack_<rack>           factor 0..1.5                          workload cordon/migration
set_chiller_setpoint -                     supply_c 15..40                        FWS supply temperature setpoint
inject_fault         optional              kind, target?, params?                 engineering test control
halt_fault           target                -                                      stop a progressing fault process
(alias test.inject_fault == inject_fault). Fault kind `leak` -> {ok:false, reason:"not_supported_yet"}.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Callable

from .faults import NOT_SUPPORTED_KINDS

if TYPE_CHECKING:  # pragma: no cover
    from .plant import FacilityPlant

Json = dict[str, Any]


class _Reject(Exception):
    pass


def _num(args: Json, key: str, lo: float, hi: float, required: bool = True, default: float | None = None) -> float:
    if key not in args:
        if required:
            raise _Reject(f"missing arg {key!r}")
        return float(default)  # type: ignore[arg-type]
    v = args[key]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not (lo <= v <= hi):
        raise _Reject(f"arg {key!r} must be a number in [{lo}, {hi}]")
    return float(v)


def _only(args: Json, allowed: set[str]) -> None:
    extra = set(args) - allowed
    if extra:
        raise _Reject(f"unexpected args: {sorted(extra)}")


def _pump(p: "FacilityPlant", tid: str | None) -> str:
    if tid not in ("pump_t1", "pump_t2", "pump_f1", "pump_f2"):
        raise _Reject("target_id must be a pump id")
    return tid


def _loop_of(pid: str) -> str:
    return "tcs" if pid.startswith("pump_t") else "fws"


def _rack_valve(p: "FacilityPlant", tid: str | None) -> str:
    if not isinstance(tid, str) or not tid.startswith("valve_") or tid[6:] not in p.all_racks:       # all 40 racks have a modelled balancing valve
        raise _Reject("target_id must be a rack balancing valve (valve_<rack>)")
    return tid[6:]


def _hard(p: "FacilityPlant") -> None:
    p._hard = True


def _set_valve(p, tid, a):
    _only(a, {"opening"})
    r = _rack_valve(p, tid)
    v = _num(a, "opening", 0.02, 1.0)
    p.ctl["valve_cmd"][r] = v
    _hard(p)
    return {"valve": tid, "commanded_opening": v}


def _closable(p, tid):
    if tid in p.zone_valve_ids or (isinstance(tid, str) and tid.startswith("valve_") and tid[6:] in p.all_racks) \
            or tid in ("pump_t1", "pump_t2", "pump_f1", "pump_f2"):
        return tid
    raise _Reject("target_id must be a valve or pump id")


def _isolate(p, tid, a):
    _only(a, set())
    tgt = _closable(p, tid)
    p.ctl["isolated"][tgt] = True
    if hasattr(p, "leak_sim"):
        for lk in p.leak_sim.leaks.values():
            if tid in ("valve_zc", "valve_za", "valve_zb") or lk.target_edge_id == tid:
                p.leak_sim.isolate(lk.leak_id)
    _hard(p)
    return {"isolated": tid}


def _reopen(p, tid, a):
    _only(a, set())
    p.ctl["isolated"].pop(_closable(p, tid), None)
    _hard(p)
    return {"reopened": tid}


def _speed(p, tid, a):
    _only(a, {"speed"})
    pid = _pump(p, tid)
    v = _num(a, "speed", 0.3, 1.0)
    p.ctl[f"{_loop_of(pid)}_speed"] = v
    _hard(p)
    return {"loop": _loop_of(pid), "speed": v}


def _duty(p, tid, a):
    _only(a, set())
    pid = _pump(p, tid)
    loop = _loop_of(pid)
    p.ctl[f"{loop}_duty"] = pid
    if loop == "tcs":
        p.fault_mgr.tcs_duty = pid
    _hard(p)
    return {"loop": loop, "duty": pid}


def _trip(p, tid, a):
    _only(a, set())
    pid = _pump(p, tid)
    p.ctl["tripped"][pid] = True
    _hard(p)
    return {"tripped": pid}


def _clear_edge(p, tid, a):
    _only(a, {"removed_fraction"})
    if tid not in p.faults.occl and tid not in {e["id"] for e in p.topo["edges"] if e["robot_passable"]} | {"strainer_01", "strainer_02"}:
        raise _Reject("target_id must be a serviceable pipe or strainer")
    phi = _num(a, "removed_fraction", 0.0, 1.0)
    before = p.faults.occl.get(tid, 0.0)
    after = before * (1 - phi)
    if after < 0.005:
        after = 0.0
    p.faults.occl[tid] = after
    if after == 0.0:
        p.faults.occl_s.pop(tid, None)
        p.fault_mgr.halt(tid, p.time)
    _hard(p)
    return {"target": tid, "occlusion_before": before, "occlusion_after": after}


def _replace_section(p, tid, a):
    _only(a, set())
    if tid not in {e["id"] for e in p.topo["edges"] if e["robot_passable"]}:
        raise _Reject("target_id must be a serviceable pipe")
    before = p.faults.occl.get(tid, 0.0)
    p.faults.occl[tid] = 0.0
    p.faults.occl_s.pop(tid, None)
    if hasattr(p, "leak_sim"):
        for lk in p.leak_sim.leaks.values():
            if lk.target_edge_id == tid:
                p.leak_sim.repair(lk.leak_id)
    p.fault_mgr.halt(tid, p.time)
    _hard(p)
    return {"target": tid, "occlusion_before": before, "occlusion_after": 0.0}


def _replace_strainer(p, tid, a):
    _only(a, set())
    if tid not in ("strainer_01", "strainer_02"):
        raise _Reject("target_id must be a strainer")
    before = p.faults.occl.get(tid, 0.0)
    p.faults.occl[tid] = 0.0
    p.fault_mgr.halt(tid, p.time)
    _hard(p)
    return {"target": tid, "occlusion_before": before, "occlusion_after": 0.0}


def _service_valve(p, tid, a):
    _only(a, set())
    r = _rack_valve(p, tid)
    had = r in p.faults.valve_stuck
    p.faults.valve_stuck.pop(r, None)
    p.fault_mgr.halt(tid, p.time)
    _hard(p)
    return {"target": tid, "was_stuck": had}


def _replace_pump(p, tid, a):
    _only(a, set())
    pid = _pump(p, tid)
    before = p.faults.pump_health.get(pid, 1.0)
    p.faults.pump_health[pid] = 1.0
    p.ctl["tripped"].pop(pid, None)
    p.fault_mgr.halt(pid, p.time)
    _hard(p)
    return {"target": pid, "health_before": before, "health_after": 1.0}


def _recal(p, tid, a):
    _only(a, set())
    if tid not in ("sn_flow_trunk", "sn_flow_za", "sn_flow_zb"):
        raise _Reject("target_id must be a flow meter")
    off = p.faults.sensor_offset.get(tid, 0.0)
    p.faults.sensor_offset[tid] = 0.0
    p.faults.sensor_drift_rate[tid] = 0.0
    p.fault_mgr.halt(tid, p.time)
    return {"target": tid, "offset_removed": off}


def _load(p, tid, a):
    _only(a, {"factor"})
    if not isinstance(tid, str) or not tid.startswith("rack_") or tid[5:] not in p.racks:
        raise _Reject("target_id must be a rack (rack_<id>)")
    v = _num(a, "factor", 0.0, 1.5)
    p.ctl["load_factor"][tid[5:]] = v
    return {"rack": tid, "load_factor": v}


def _chiller(p, tid, a):
    _only(a, {"supply_c"})
    v = _num(a, "supply_c", 15.0, 40.0)
    p.ctl["chiller_supply_c"] = v
    _hard(p)
    return {"supply_c": v}


def _inject_leak(p, tid, a):
    target = tid or a.get("target", "p_12")
    orifice_m2 = _num(a, "orifice_m2", 1e-6, 1e-2, required=False, default=2.8e-5)
    loc = a.get("location") or (-12.0, 0.0, -6.0)
    lk_id = a.get("leak_id", f"leak_{target}")
    if hasattr(p, "leak_sim"):
        st = p.leak_sim.inject_leak(lk_id, target, orifice_m2=orifice_m2, location_xyz=tuple(loc))
        _hard(p)
        return {"leak_id": st.leak_id, "target": st.target_edge_id, "rate_kg_s": st.rate_kg_s}
    return {"status": "no_leak_sim"}


def _isolate_leak(p, tid, a):
    lk_id = tid or a.get("leak_id", "leak_p_12")
    if hasattr(p, "leak_sim"):
        ok = p.leak_sim.isolate(lk_id)
        _hard(p)
        return {"leak_id": lk_id, "isolated": ok}
    return {"status": "no_leak_sim"}


def _repair_leak(p, tid, a):
    lk_id = tid or a.get("leak_id", "leak_p_12")
    if hasattr(p, "leak_sim"):
        ok = p.leak_sim.repair(lk_id)
        _hard(p)
        return {"leak_id": lk_id, "repaired": ok}
    return {"status": "no_leak_sim"}


def _trigger_power_outage(p, tid, a):
    if hasattr(p, "power_sim"):
        p.power_sim.trigger_outage()
        _hard(p)
        return {"power_outage": True, "ups_runtime_remaining_s": p.power_sim.state.ups_runtime_remaining_s}
    return {"status": "no_power_sim"}


def _trigger_rack_fire(p, tid, a):
    rack = tid or a.get("rack_id", "rack_a1")
    kw = _num(a, "heat_kw", 10.0, 500.0, required=False, default=48.0)
    if hasattr(p, "fire_sim"):
        p.fire_sim.trigger_fire(initial_heat_kw=kw)
        _hard(p)
        return {"rack_fire": True, "target_rack": rack, "heat_kw": kw}
    return {"status": "no_fire_sim"}


def _emergency_trip_rack(p, tid, a):
    rack = tid or a.get("rack_id", "rack_a1")
    if hasattr(p, "fire_sim"):
        p.fire_sim.emergency_trip()
    r_key = rack[5:] if rack.startswith("rack_") else rack
    if r_key in p.ctl["load_factor"]:
        p.ctl["load_factor"][r_key] = 0.0
    _hard(p)
    return {"emergency_trip": rack, "load_factor": 0.0}


def _inject(p, tid, a):
    _only(a, {"kind", "target", "params"})
    kind = a.get("kind")
    if not isinstance(kind, str):
        raise _Reject("missing fault kind")
    if kind == "leak":
        target = a.get("target", tid) or "p_12"
        params = a.get("params") or {}
        orifice_m2 = params.get("orifice_m2", 2.8e-5)
        lk = p.leak_sim.inject_leak(f"leak_{target}", target, orifice_m2=orifice_m2)
        _hard(p)
        return {"fault": "leak", "target": target, "leak_id": lk.leak_id}
    if kind == "power_outage":
        p.power_sim.trigger_outage()
        _hard(p)
        return {"fault": "power_outage", "target": "plant_power"}
    if kind == "rack_fire":
        target = a.get("target", tid) or "rack_a1"
        p.fire_sim.trigger_fire()
        _hard(p)
        return {"fault": "rack_fire", "target": target}
    if kind in NOT_SUPPORTED_KINDS:
        raise _Reject(NOT_SUPPORTED_KINDS[kind])
    target = a.get("target", tid)
    if target is not None and not isinstance(target, str):
        raise _Reject("target must be a string")
    params = a.get("params") or {}
    if not isinstance(params, dict):
        raise _Reject("params must be an object")
    try:
        got = p.fault_mgr.begin(kind, p.time, target, params)
    except ValueError as exc:
        raise _Reject(str(exc))
    if not got:
        raise _Reject("no free target for that fault")
    _hard(p)
    return {"fault": kind, "target": got}


def _halt(p, tid, a):
    _only(a, set())
    if not isinstance(tid, str) or len(tid) > 64:
        raise _Reject("target_id required")
    p.fault_mgr.halt(tid, p.time)
    return {"halted": tid}


_TABLE: dict[str, Callable[..., Json]] = {
    "set_valve": _set_valve, "isolate_valve": _isolate, "reopen_valve": _reopen, "set_pump_speed": _speed,
    "switch_duty": _duty, "trip_pump": _trip, "brush_clear": _clear_edge, "replace_section": _replace_section,
    "replace_strainer": _replace_strainer, "service_valve": _service_valve, "replace_pump": _replace_pump,
    "recalibrate_sensor": _recal, "set_load_factor": _load, "set_chiller_setpoint": _chiller,
    "inject_fault": _inject, "test.inject_fault": _inject, "halt_fault": _halt,
    "inject_leak": _inject_leak, "isolate_leak": _isolate_leak, "repair_leak": _repair_leak,
    "trigger_power_outage": _trigger_power_outage, "trigger_rack_fire": _trigger_rack_fire,
    "emergency_trip_rack": _emergency_trip_rack,
}
COMMAND_KINDS = tuple(_TABLE)


def dispatch(p: "FacilityPlant", cmd: Json) -> Json:
    try:
        if not isinstance(cmd, dict):
            raise _Reject("command must be an object")
        kind = cmd.get("kind")
        fn = _TABLE.get(kind) if isinstance(kind, str) else None
        if fn is None:
            raise _Reject("unknown command kind")
        tid = cmd.get("target_id")
        if tid is not None and (not isinstance(tid, str) or len(tid) > 64):
            raise _Reject("target_id must be a short string")
        args = cmd.get("args") or {}
        if not isinstance(args, dict):
            raise _Reject("args must be an object")
        # solver must not be left mid-edit: effects are applied atomically (validation precedes mutation)
        return {"ok": True, "effects": fn(p, tid, args)}
    except _Reject as exc:
        return {"ok": False, "reason": str(exc), "effects": {}}
    except Exception:  # fail closed, no internals to the caller
        return {"ok": False, "reason": "command failed", "effects": {}}
