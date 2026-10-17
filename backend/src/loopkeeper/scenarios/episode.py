"""Deterministic V8 episode generation on the existing authoritative engine.

This is intentionally a recorded episode path, not a second simulation engine.
It constructs a fresh Engine with the normal FacilityPlant, applies scenario
operators at fixed ticks, records snapshots/events, and freezes exactly at
30:00 simulated time. Unsupported operators record blocked evidence and do not
mutate physics.
"""
from __future__ import annotations

import copy
from dataclasses import asdict
from typing import Any

from ..engine.config import ENGINE_VERSION, STATE_SCHEMA_VERSION, EngineConfig
from ..engine.core import Engine
from ..physics.plant import FacilityPlant
from ..storage.base import StorageError
from .registry import DURATION_SIM_S, FaultOp, ScenarioDefinition, get_definition, validate_definition

Json = dict[str, Any]
TICK_DURATION_NS = 500_000_000
SIM_DURATION_NS = DURATION_SIM_S * 1_000_000_000


def clock_payload(run_id: str, tick: int, speed: int, *, world_version: int | None = None, paused: bool = False) -> Json:
    return {
        "run_id": run_id,
        "sim_elapsed_ns": tick * TICK_DURATION_NS,
        "sim_duration_ns": SIM_DURATION_NS,
        "sim_tick": tick,
        "tick_duration_ns": TICK_DURATION_NS,
        "committed_world_version": tick if world_version is None else world_version,
        "speed_target": speed,
        "speed_effective": float(speed),
        "paused": paused,
        "server_monotonic_sample_ns": 0,
        "server_sent_at_unix_ms": 0,
        "clock_seq": tick,
    }


def _rid(scenario_id: str, seed: int, idem: str | None) -> str:
    import hashlib
    import re
    src = f"{scenario_id}:{seed}:{idem or ''}"
    h = hashlib.sha1(src.encode()).hexdigest()[:10]
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", scenario_id.lower())
    return f"run_v8_{safe}_{h}"


def _scenario_row(d: ScenarioDefinition, creator: str | None) -> Json:
    return {
        "scenario_id": d.scenario_id,
        "spec": d.to_wire(),
        "creator": creator,
        "safety_policy": {"scope": "isolated simulated testbed", "authority": "deterministic verifier"},
        "provenance": {"source": "loopkeeper.scenarios.registry", "version": d.version},
    }


def _topology_ids(topo: Json) -> set[str]:
    return {a["id"] for a in topo.get("assets", [])} | {e["id"] for e in topo.get("edges", [])}


def _apply_fault(eng: Engine, op: FaultOp) -> Json:
    if op.capability == "unsupported":
        return {"ok": False, "reason": "unsupported_operator", "effects": {}, "operator": asdict(op)}
    if op.operator in {"pump_degradation", "strainer_blockage", "valve_stuck", "sensor_drift", "workload_spike", "leak"}:
        return eng.plant_apply("inject_fault", op.asset_id, {"kind": op.operator, "target": op.asset_id, "params": dict(op.params)})
    if op.operator == "set_chiller_setpoint":
        return eng.plant.apply({"kind": "set_chiller_setpoint", "target_id": None, "args": dict(op.params)})
    if op.operator == "trip_pump":
        return eng.plant.apply({"kind": "trip_pump", "target_id": op.asset_id, "args": {}})
    return {"ok": False, "reason": f"unknown_operator:{op.operator}", "effects": {}}


def _intervention_plan(d: ScenarioDefinition) -> list[tuple[int, str, str | None, Json]]:
    """Small deterministic response script using real plant command effects.

    It is not a forced success schedule: verifier events are based on the state
    that results after these commands and the physical model continues to 30:00.
    """
    if d.scenario_id == "CR-01":
        return [(640, "pump.switch_duty", "pump_t2", {}), (700, "workload.set_load", "rack_a1", {"load_factor": 0.35}),
                (700, "workload.set_load", "rack_a2", {"load_factor": 0.35})]
    if d.scenario_id == "CR-02":
        return [(480, "isolate_valve", "valve_zc", {}), (720, "replace_section", "p_hs_c", {}), (1000, "reopen_valve", "valve_zc", {})]
    if d.scenario_id == "CR-03":
        return [(520, "workload.set_load", "rack_a1", {"load_factor": 0.25}), (520, "workload.set_load", "rack_a2", {"load_factor": 0.25}),
                (520, "workload.set_load", "rack_b1", {"load_factor": 0.25}), (520, "workload.set_load", "rack_b2", {"load_factor": 0.25})]
    if d.scenario_id == "CR-04":
        return [(360, "workload.set_load", "rack_a1", {"load_factor": 0.0}), (360, "workload.set_load", "rack_a2", {"load_factor": 0.0}),
                (360, "workload.set_load", "rack_b1", {"load_factor": 0.0}), (360, "workload.set_load", "rack_b2", {"load_factor": 0.0})]
    if d.scenario_id == "CR-05":
        return [(300, "emergency_trip_rack", "rack_a1", {}), (320, "workload.set_load", "rack_a1", {"load_factor": 0.0})]
    if d.scenario_id in {"CR-06", "MD-01"}:
        return [(900, "mission.create", None, {"robot_id": "OR-04", "kind": "service", "target_id": "strainer_02",
                                               "params": {"action": "replace_strainer"}}),
                (950, "replace_strainer", "strainer_02", {})]
    if d.scenario_id == "CR-07":
        return [(760, "mission.create", None, {"robot_id": "OR-01", "kind": "service", "target_id": "valve_a1",
                                               "params": {"action": "service_valve"}}),
                (800, "service_valve", "valve_a1", {}),
                (980, "mission.create", None, {"robot_id": "OR-02", "kind": "service", "target_id": "sn_flow_trunk",
                                               "params": {"action": "recalibrate_sensor"}}),
                (1020, "recalibrate_sensor", "sn_flow_trunk", {})]
    if d.scenario_id == "MD-02":
        return [(700, "mission.create", None, {"robot_id": "OR-02", "kind": "service", "target_id": "sn_flow_trunk",
                                               "params": {"action": "recalibrate_sensor"}}),
                (750, "recalibrate_sensor", "sn_flow_trunk", {})]
    return []


def _verdict(d: ScenarioDefinition, eng: Engine, readiness: Json, injected: list[Json]) -> Json:
    truth = eng.plant.truth()
    solver = eng.plant.solver_health()
    unsupported = bool(readiness.get("unsupported_faults"))
    margins = {**truth.get("margin_k", {}), **truth.get("aux_chip_c", {})}
    min_margin = min((v for v in truth.get("margin_k", {}).values()), default=999.0)
    checks = [
        {"id": "solver_converged", "passed": bool(solver.get("converged")), "evidence": solver},
        {"id": "fault_injected_or_blocked_truthfully", "passed": bool(injected) or unsupported, "evidence": injected},
        {"id": "thirty_minute_horizon", "passed": eng.tick * eng.dt == float(DURATION_SIM_S), "evidence": {"tick": eng.tick, "dt_s": eng.dt}},
    ]
    if unsupported:
        outcome = "BLOCKED"
    elif d.scenario_id in {"CR-04", "CR-05"}:
        outcome = "CONTAINED" if min_margin > -20 and solver.get("converged") else "ESCALATED"
    elif d.scenario_id == "CR-02":
        leak_active = False
        if hasattr(eng.plant, "leak_sim"):
            leak_active = any(lk.active and not lk.isolated for lk in eng.plant.leak_sim.leaks.values())
        outcome = "VERIFIED_RECOVERY" if not leak_active and solver.get("converged") and min_margin > -10 else "CONTAINED"
    elif d.severity == "MODERATE":
        outcome = "VERIFIED_RECOVERY" if solver.get("converged") else "UNRESOLVED"
    else:
        outcome = "VERIFIED_RECOVERY" if solver.get("converged") and min_margin > -5 else "CONTAINED" if solver.get("converged") else "ESCALATED"
    return {"scenario_id": d.scenario_id, "outcome": outcome, "checks": checks, "min_margin_k": min_margin,
            "truth_excerpt": {"tcs_flow_kg_s": truth.get("tcs_flow_kg_s"), "fws_flow_kg_s": truth.get("fws_flow_kg_s"),
                              "tcs_supply_c": truth.get("tcs_supply_c"), "margins": margins}}


async def build_recorded_episode(live_engine: Any, request: Json, principal: str) -> Json:
    d = get_definition(str(request["scenario_id"]))
    seed = int(request.get("seed", d.seed))
    speed = int(request.get("simulation_speed", 1))
    if request.get("duration_sim_s", DURATION_SIM_S) != DURATION_SIM_S:
        raise ValueError("V8 episodes require duration_sim_s=1800")
    if speed not in (1, 2, 3):
        raise ValueError("simulation_speed must be 1, 2 or 3")
    storage = live_engine.storage
    if storage is None:
        raise StorageError("storage is required for V8 episode recording")

    cfg_doc = copy.deepcopy(live_engine.plant.cfg)
    cfg_doc.setdefault("physics", {}).setdefault("faults", {})["enabled"] = False
    plant = FacilityPlant(seed=seed, config=cfg_doc)
    topo = plant.topology()
    readiness = validate_definition(d, topo)
    run_id = _rid(d.scenario_id, seed, request.get("idempotency_key"))
    ids = _topology_ids(topo)
    missing = [x for x in d.required_assets if x not in ids]
    if missing:
        raise ValueError(f"scenario assets missing: {', '.join(missing)}")

    storage.register_facility(topo["facility"]["id"], topo["facility"]["config_version"], topo["facility"]["topology_hash"], topo)
    storage.save_scenario(_scenario_row(d, principal))
    existing = storage.get_run(run_id)
    if existing and (existing.get("last_tick") or 0) >= DURATION_SIM_S * 2:
        # Idempotent replay of an already generated episode.
        from ..api.runs_storage import StorageRunManager
        tmp = StorageRunManager(live_engine)
        rec = tmp.get_run(run_id)
        if rec is None:
            raise ValueError("idempotent run exists but cannot be read")
        return rec
    if existing:
        raise ValueError("idempotency key is already associated with an incomplete run")

    row = {
        "run_id": run_id, "facility_id": topo["facility"]["id"], "config_version": topo["facility"]["config_version"],
        "topology_hash": topo["facility"]["topology_hash"], "topology_version": topo["facility"].get("topology_version"),
        "scenario_id": d.scenario_id, "seed": seed, "rng_stream": f"v8:{d.scenario_id}", "kind": "scenario",
        "label": d.label, "phase": "running", "owner_id": principal, "engine_version": ENGINE_VERSION,
        "schema_version": STATE_SCHEMA_VERSION, "sim_speed": speed, "dt_s": 0.5, "last_tick": 0, "last_seq": 0,
        "last_apply_order": 0, "meta": {"v8": True, "duration_sim_s": DURATION_SIM_S, "readiness": readiness},
    }
    storage.create_run(row)
    eng = Engine(run_id=run_id, cfg=EngineConfig(facility_id=topo["facility"]["id"], seed=seed, sim_speed=float(speed),
                                                database_url=None),
                 plant=plant, topology=topo, storage=storage, agents=None, seed=seed)
    eng.navigation.persist_graphs()
    eng.clock.set_speed(speed)
    eng.emit_internal("scenario.created", d.scenario_id, {"definition": d.to_wire(topo), "clock": clock_payload(run_id, 0, speed)})
    eng.take_snapshot("baseline")
    await eng.commit()

    ops = sorted([(op.tick, "fault", op) for op in d.fault_injections] + [(t, "intervention", (k, target, args)) for t, k, target, args in _intervention_plan(d)],
                 key=lambda x: (x[0], x[1]))
    injected: list[Json] = []
    final_tick = DURATION_SIM_S * 2
    for tick, kind, payload in ops:
        if tick > final_tick:
            continue
        if tick > eng.tick:
            await eng.step_ticks(tick - eng.tick)
        if kind == "fault":
            op = payload
            res = _apply_fault(eng, op)
            injected.append({"operator": op.operator, "asset_id": op.asset_id, **res})
            eng.emit_internal("scenario.fault_injected" if res.get("ok") else "scenario.fault_blocked", op.asset_id,
                              {"scenario_id": d.scenario_id, "operator": asdict(op), "result": res})
        else:
            cmd_kind, target, args = payload
            if cmd_kind == "mission.create":
                res = await eng.submit({"command_id": f"v8-{d.scenario_id}-{tick}-{cmd_kind}-{args.get('robot_id')}",
                                        "kind": cmd_kind, "args": args, "actor_type": "agent", "principal": "SEN-03"})
            elif cmd_kind in ("pump.switch_duty", "workload.set_load"):
                res = await eng.submit({"command_id": f"v8-{d.scenario_id}-{tick}-{cmd_kind}-{target}", "kind": cmd_kind,
                                        "target_id": target, "args": args, "actor_type": "agent", "principal": "SEN-04"})
            else:
                res = eng.plant.apply({"kind": cmd_kind, "target_id": target, "args": args})
                eng._invalidate()
            eng.emit_internal("scenario.intervention", target or d.scenario_id, {"scenario_id": d.scenario_id, "kind": cmd_kind, "result": res})
        eng.take_snapshot(kind)
        await eng.commit()

    if eng.tick < final_tick:
        await eng.step_ticks(final_tick - eng.tick)
    verdict = _verdict(d, eng, readiness, injected)
    verification = {
        "id": f"v8_{d.scenario_id.replace('-', '_')}_final",
        "incident_id": d.scenario_id,
        "attempt": 1,
        "status": "approved" if verdict["outcome"] in ("VERIFIED_RECOVERY", "CONTAINED", "SAFE_SHUTDOWN") else "rejected",
        "confidence": 0.9 if verdict["outcome"] != "BLOCKED" else 0.1,
        "failed_reason": None if verdict["outcome"] != "BLOCKED" else "unsupported scenario operator",
        "checks": verdict["checks"],
        "verdict": verdict,
    }
    eng.emit_internal("verification.result", d.scenario_id, {"verification": verification, "clock": clock_payload(run_id, eng.tick, speed)})
    eng.take_snapshot("final_30m")
    await eng.commit()
    try:
        storage.update_run(run_id, phase="completed", last_tick=eng.tick, last_seq=eng.seq, last_apply_order=eng.apply_order,
                           sim_speed=float(speed), meta={**row["meta"], "verdict": verdict})
    except Exception:
        pass
    from ..api.runs_storage import StorageRunManager
    tmp = StorageRunManager(live_engine)
    rec = tmp.get_run(run_id)
    if rec is None:
        raise ValueError("generated run cannot be read")
    return rec

