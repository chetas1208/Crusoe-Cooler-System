"""Policy gates, plain-language rendering and the agent<->engine/plant seams (additive engine edits)."""
import copy
import os

import pytest

from live_harness import Stack
from loopkeeper.orchestration.plain import plain
from loopkeeper.orchestration.policy import Policy


def test_plain_language_never_leaks_validation_text_or_field_names():
    raws = ["invalid args - steps.0.id: Extra inputs are not permitted; steps.1.id: Extra inputs", "policy: whitelist: kind=format_disk",
            "pressure_above_service_threshold: 420 kPa", "racks_not_cordoned", "resource_locked: asset:p_hs_a held by m_03", "approval_required",
            "no_route: target unreachable", "battery_below_reserve", "mission timeout", "ValueError: boom at line 3", "", None]
    for r in raws:
        out = plain(r)
        assert out and out == out.lower()[:1] + out[1:] and not any(t in out for t in ("steps", "id:", "kpa", "asset:", "Error", "line 3", "_", "policy:"))
    assert "safety checks" in plain(raws[0]) and "isolated" in plain(raws[2]) and "workload" in plain(raws[3])


@pytest.fixture
async def stack():
    st = await Stack.create(seed=3, warmup_s=10)
    yield st
    await st.stop()


def mission(robot, kind, target, **kw):
    a = {"robot_id": robot, "mission_id": "m_x", "kind": kind, "target_id": target, "incident_id": "INC-001", **kw}
    return {"command_id": "c1", "kind": "robot.mission.assign", "target_id": target, "args": a, "actor_type": "agent"}


@pytest.mark.asyncio
async def test_policy_whitelist_and_safety_gates(stack):
    pol: Policy = stack.rt.ctx.policy
    w = copy.deepcopy(stack.eng.world())
    ok = lambda cmd: pol.check_command(cmd, w, "INC-001")
    # anything outside the whitelist or aiming at the real plant is refused
    assert not ok({"command_id": "x", "kind": "set_sim_speed", "args": {"speed": 60}}).ok
    assert not ok({"command_id": "x", "kind": "test.inject_fault", "args": {"kind": "fouling"}}).ok
    assert not ok({"command_id": "x", "kind": "approve_action", "target_id": "ap_1"}).ok
    assert not ok({**mission("OR-01", "service", "strainer_02", params={"action": "replace_strainer"}), "simulated": False}).ok
    assert ok(mission("OR-01", "service", "strainer_02", params={"action": "replace_strainer"})).ok
    # unknown action / wrong robot class / unknown target
    assert not ok(mission("OR-01", "service", "strainer_02", params={"action": "weld_everything"})).ok
    assert not ok(mission("OR-01", "clear", "p_hs_a")).ok
    assert not ok(mission("IR-01", "service", "strainer_02", params={"action": "replace_strainer"})).ok
    assert not ok(mission("OR-01", "service", "ghost", params={"action": "replace_strainer"})).ok
    # high-impact needs an approved request id; disassembly needs the zone isolation valve + a cordon + crawler out
    assert any("approval_policy" in r for r in ok(mission("IR-01", "clear", "p_hs_a", params={"s_m": 3.0})).reasons)
    v = ok(mission("OR-01", "service", "p_hs_a", params={"action": "replace_section", "isolate_valve": "valve_za"}, approval_id="ap_1"))
    assert not v.ok and any("racks_cordoned" in r for r in v.reasons)
    assert not ok(mission("OR-01", "service", "p_hs_a", params={"action": "replace_section"}, approval_id="ap_1")).ok          # no isolation valve
    for r in ("rack_a1", "rack_a2"):
        w["assets"][r]["readings"]["power_kw"] = 10.0
    good = mission("OR-01", "service", "p_hs_a", params={"action": "replace_section", "isolate_valve": "valve_za"}, approval_id="ap_1")
    assert ok(good).ok
    w["robots"]["IR-01"]["pose"]["segment_id"], w["robots"]["IR-01"]["mode"] = "p_hr_a", "TRAVELING"
    assert any("crawler_out_of_segment" in r for r in ok(good).reasons)
    w["robots"]["IR-01"]["mode"] = "DOCKED"
    # isolating a zone only redirects flow to the other racks, so their (even critical) margin never blocks the repair
    w["assets"]["rack_b1"]["readings"]["margin_k"] = 2.0
    assert ok(good).ok
    # service on the duty pump is refused (swap first)
    assert any("pump_off_duty" in r for r in ok(mission("OR-01", "service", "pump_t1", params={"action": "service_pump"})).reasons)
    assert ok({"command_id": "s", "kind": "workload.set_load", "target_id": "rack_b1", "args": {"load_factor": 0.1}}).ok
    assert not ok({"command_id": "s", "kind": "workload.set_load", "target_id": "rack_b1", "args": {"load_factor": 0.0}}).ok
    # a robot already reserved by another incident is refused
    pol.locks.try_robot("OR-01", "INC-009")
    assert any("no_robot_conflict" in r for r in pol.check_command(mission("OR-01", "service", "strainer_02", params={"action": "replace_strainer"}), w, "INC-001").reasons)


@pytest.mark.asyncio
async def test_engine_seams_agents_cannot_approve_and_new_commands_work(stack):
    eng = stack.eng
    sub = lambda cid, kind, target=None, args=None, actor="agent": eng.submit({"command_id": cid, "kind": kind, "target_id": target, "args": args or {}, "actor_type": actor},
                                                                       principal=actor, actor_type=actor)
    assert not (await sub("a1", "approve_action", "ap_1"))["accepted"]                 # agents can never approve their own actions
    assert not (await sub("a2", "test.inject_fault", None, {"kind": "fouling"}))["accepted"]
    ack = await sub("a3", "pump.switch_duty", "pump_t2")
    assert ack["accepted"], ack
    await stack.advance(4)
    w = eng.world()
    assert w["assets"]["pump_t2"]["readings"]["speed_pct"] > 0 and w["assets"]["pump_t1"]["readings"]["speed_pct"] == 0
    assert (await sub("a4", "workload.set_load", "rack_a1", {"load_factor": 0.2}))["accepted"]
    await stack.advance(20)
    assert eng.world()["assets"]["rack_a1"]["readings"]["power_kw"] < 40
    assert (await sub("a5", "workload.set_load", "rack_a1", {"load_factor": 9}))["accepted"] is False
    # the engine strictly validates mission args (this is what rejected the old step ids)
    bad = await sub("a6", "robot.mission.assign", "p_hs_a", {"robot_id": "IR-01", "kind": "inspect", "target_id": "p_hs_a",
                                                          "steps": [{"id": "s1", "command": "launch", "args": {}}]})
    assert not bad["accepted"]


@pytest.mark.asyncio
async def test_engine_service_actions_for_pump_and_sensor_and_strainer_need_no_isolation(stack):
    eng = stack.eng
    plant = eng.plant
    plant.faults.sensor_offset["sn_flow_zb"] = 0.5
    plant.faults.pump_health["pump_t2"] = 0.4
    plant.faults.occl["strainer_02"] = 0.5
    plant._hard = True
    eng.locks.excl.clear()
    eng.locks.shared.clear()
    sub = lambda cid, args: eng.submit({"command_id": cid, "kind": "robot.mission.assign", "target_id": args["target_id"], "args": {"robot_id": args.pop("robot"), "kind": "service", **args},
                                        "actor_type": "agent"}, principal="agent", actor_type="agent")
    # each action goes to a unit that carries the right tool (OR-01..04: calibration kit; OR-05..08: pump kit)
    for i, (tgt, act, rob) in enumerate((("strainer_02", "replace_strainer", "OR-01"), ("sn_flow_zb", "recalibrate_sensor", "OR-02"), ("pump_t2", "service_pump", "OR-05"))):
        eng.locks.excl.pop(f"asset:{tgt}", None)
        ack = await sub(f"m{i}", {"mission_id": f"m_s{i}", "target_id": tgt, "params": {"action": act}, "robot": rob})
        assert ack["accepted"], (act, ack)
        for _ in range(100):
            await stack.advance(10)
            m = eng.missions.missions[f"m_s{i}"]
            if m.get("closed_tick") is not None:
                break
        assert m["outcome"] == "completed", (act, [(s["command"], s["status"], s.get("result")) for s in m["steps"]])
    assert plant.faults.occl.get("strainer_02", 0.0) == 0.0 and plant.faults.sensor_offset.get("sn_flow_zb", 0.0) == 0.0 and plant.faults.pump_health["pump_t2"] == 1.0


@pytest.mark.asyncio
async def test_isolated_segment_reads_depressurised_and_brush_maps_to_removed_fraction(stack):
    eng = stack.eng
    assert eng.sensing.pressure_kpa("p_hs_a") > 300
    eng.locks.isolated_edges["p_hs_a"] = "m_x"
    assert eng.sensing.pressure_kpa("p_hs_a") == 0.0 and eng.sensing.pressure_kpa("sn_flow_za") == 0.0
    eng.plant.faults.occl["p_hs_a"] = 0.5
    args = eng.missions._plant_args("brush_clear", "p_hs_a", {"s_m": 3, "max_torque_pct": 60})
    assert set(args) == {"removed_fraction"} and 0.2 <= args["removed_fraction"] <= 0.95
    assert eng.plant.apply({"kind": "brush_clear", "target_id": "p_hs_a", "args": args})["ok"]


@pytest.mark.skipif(not os.environ.get("CRUSOE_API_KEY"), reason="real-model test needs CRUSOE_API_KEY in the environment (never read from .env here)")
@pytest.mark.asyncio
async def test_real_crusoe_probe_and_one_structured_decision():
    from loopkeeper.intelligence.crusoe import IntelligenceConfig, probe_model
    from loopkeeper.intelligence.decisions import DecisionRequest, DecisionService, MemoryDecisionStore
    cfg = IntelligenceConfig.from_env()
    st, client = await probe_model(cfg)
    if st.status != "live":
        pytest.skip(f"model not live: {st.status} ({st.reason})")
    svc = DecisionService(client, st, MemoryDecisionStore(), run_id="real")
    res = await svc.decide(DecisionRequest(kind="verify", key="k", payload={"verdict": "verified", "checks": []}, fallback=lambda: {"summary": "x"}, incident_id="INC-1"))
    assert res.decision["summary"] and res.meta["provider"] in ("crusoe", "deterministic")
    await client.aclose()


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="needs a disposable PostgreSQL (TEST_DATABASE_URL); never the production branch")
@pytest.mark.asyncio
async def test_postgres_checkpointer_roundtrip():
    from contextlib import AsyncExitStack
    from loopkeeper.orchestration.checkpointer import make_checkpointer
    async with AsyncExitStack() as stack_:
        saver, kind, pool = await make_checkpointer(os.environ["TEST_DATABASE_URL"], stack_)
        assert kind == "postgres"
        cfg = {"configurable": {"thread_id": "t-roundtrip", "checkpoint_ns": ""}}
        from langgraph.checkpoint.base import empty_checkpoint
        cp = empty_checkpoint()
        await saver.aput(cfg, cp, {"source": "input", "step": 0, "parents": {}}, {})
        assert (await saver.aget_tuple(cfg)).checkpoint["id"] == cp["id"]
