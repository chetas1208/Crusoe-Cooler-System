"""Agents on the REAL plant/engine with a scripted fake model (no network): bounded recursion, invalid-output rejection,
fallback progress, token budget, idempotent commands, restart/resume from the checkpointer."""
import json

import pytest

from agent_fakes import FakeModelClient
from live_harness import Stack
from loopkeeper.intelligence.decisions import MemoryDecisionStore
from loopkeeper.orchestration import AgentRuntimeImpl, Limits
from loopkeeper.intelligence.crusoe import IntelligenceConfig

TERMINAL = ("resolved", "escalated", "dismissed")


def done(st):
    return lambda: any(i["status"] in TERMINAL for i in st.incidents())


@pytest.mark.asyncio
async def test_model_decisions_drive_the_flow_and_are_frozen():
    cl = FakeModelClient()
    st = await Stack.create(seed=3, model_client=cl)
    try:
        assert st.rt.model_status()["model_state"] == "live" and st.rt.model_status()["status"] == "mock"
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved"
        llm_tasks = [t for t in st.tasks(inc["id"]) if t["kind"] in ("classify", "reconcile", "decide", "verify")]
        assert llm_tasks and all(t["model"]["fallback"] is False and t["model"]["provider"] == "mock" for t in llm_tasks)
        assert all(t["model"]["schema_version"].endswith(".v1") for t in llm_tasks)
        kinds = {k for k, _ in cl.calls}
        assert {"classify", "review", "reconcile", "intervention", "verify"} <= kinds
        recs = await st.rt.ctx.decisions.store.list()           # every accepted decision is frozen (agent_decisions) with its metadata
        assert len(recs) == len([c for c in cl.calls if c[0] != 'probe']) and all(r["meta"]["provider"] == "mock" and r["source"] == "model" for r in recs)
        assert any(c["name"].startswith("model.propose.") and c["status"] == "ok" for t in st.tasks(inc["id"]) for c in t["tool_calls"])
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_invalid_actions_and_malformed_json_are_rejected_flow_still_closes():
    bad_action = {"action": "format_disk", "target_id": "strainer_02", "rationale": "x", "confidence": 1}
    wrong_target = {"action": "replace_strainer", "target_id": "valve_za", "rationale": "x", "confidence": 1}
    wrong_cause = {"action": "brush_clear", "target_id": "strainer_02", "rationale": "x", "confidence": 1}
    cl = FakeModelClient(scripts={"intervention": [bad_action, "}{ not json", wrong_target, wrong_cause],
                                  "reconcile": [{"hypotheses": [{"cause": "valve_stuck", "target_id": "ghost_asset", "confidence": 0.99}], "followups": []}]})
    st = await Stack.create(seed=3, model_client=cl)
    try:
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved"                                       # deterministic policy answered; nothing invalid reached a tool
        calls = [c for t in st.tasks(inc["id"]) for c in t["tool_calls"] if c["name"].startswith("model.propose.")]
        rejected = [c for c in calls if c["status"] == "rejected"]
        assert {c["name"] for c in rejected} >= {"model.propose.intervention", "model.propose.reconcile"}
        assert any("not admissible" in json.dumps(c["output"]) or "does not match" in json.dumps(c["output"]) for c in rejected)
        dec = [t for t in st.tasks(inc["id"]) if t["kind"] == "decide"][0]
        assert dec["model"]["fallback"] is True and dec["model"]["provider"] == "deterministic"
        cmds = [c for c in st.eng.commands.ledger.values() if c["kind"] == "robot.mission.assign"]
        assert all(c["args"]["params"]["action"] == "replace_strainer" for c in cmds if c["args"].get("kind") == "service")
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_hypothesis_contradicting_the_detector_is_capped_until_confirmed():
    contradict = lambda p: {"hypotheses": [{"cause": "sensor_drift", "target_id": "sn_flow_za", "confidence": 0.95},
                                          {"cause": "strainer_blockage", "target_id": "strainer_02", "confidence": 0.05}], "followups": []}
    st = await Stack.create(seed=3, model_client=FakeModelClient(scripts={"reconcile": [contradict]}))
    try:
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved" and inc["cause"] == "strainer_blockage"
        first = [e for e in inc["hypotheses"]]
        assert first[0]["cause"] == "strainer_blockage" and first[0]["status"] == "confirmed"
        assert next(h for h in first if h["cause"] == "sensor_drift")["confidence"] <= 0.5
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_child_tasks_are_bounded_by_depth_and_concurrency():
    targets = ["rack_a1", "rack_a2", "rack_b1", "rack_b2", "cdu_01", "pump_t1", "pump_t2", "strainer_01"]
    fups = [{"tool": "read_telemetry", "target_id": t, "question": f"what is {t} doing?"} for t in targets]
    cl = FakeModelClient(scripts={
        "reconcile": [lambda p: {"hypotheses": p["facts"]["candidate_prior"], "summary": "rank", "followups": fups}],
        "probe": [lambda p: {"summary": "probed", "followups": fups[:3]}]})
    st = await Stack.create(seed=3, model_client=cl)
    live: dict[str, set] = {}
    peak = {"n": 0}
    orig = st.rt.ctx.emit

    def spy(typ, eid, payload):
        if typ == "agent.task":
            t = payload["task"]
            s = live.setdefault(t["incident_id"], set())
            (s.add if t["status"] == "working" else s.discard)(t["id"])
            peak["n"] = max(peak["n"], len(s))
        orig(typ, eid, payload)

    st.rt.ctx.emit = spy
    try:
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved"
        tasks = st.tasks(inc["id"])
        probes = [t for t in tasks if t["kind"].startswith("probe.")]
        assert 4 <= len(probes) <= 4 + 4 * 3                                      # fan-out capped (8 asked -> 4), recursion stops at depth 3
        assert max(t["depth"] for t in tasks) == 3 and not [t for t in tasks if t["depth"] > 3]
        assert peak["n"] <= 4                                                     # never more than 4 live tasks per incident
        assert any(c["name"] == "spawn_subtask" and c["status"] == "rejected" for t in tasks for c in t["tool_calls"])
        assert any(c["name"] == "cap_followups" for t in tasks for c in t["tool_calls"])
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_token_budget_per_incident_degrades_to_labelled_fallback():
    cl = FakeModelClient(tokens=(300, 100))
    st = await Stack.create(seed=3, model_client=cl, limits=Limits(token_budget=1000))
    try:
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved"
        assert len([c for c in cl.calls if c[0] != 'probe']) <= 4                  # 400 tokens per call, budget 1000 (+1 in-flight overshoot)
        tasks = st.tasks(inc["id"])
        assert any(t["model"]["fallback"] is False for t in tasks) and any(t["model"]["fallback"] is True for t in tasks)
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_model_outage_midway_never_stalls_incidents():
    from loopkeeper.intelligence.crusoe import ModelError
    cl = FakeModelClient()
    st = await Stack.create(seed=3, model_client=cl)
    try:
        cl.fail = ModelError("503", 503)                                           # outage begins after a healthy probe
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(done(st), 1500)
        assert st.incidents()[0]["status"] == "resolved"
        ms = st.rt.model_status()
        assert ms["status"] == "unavailable" and ms["model_state"] == "unavailable" and ms["fallback_active"] is True      # truthful: never shows live
        assert all(t["model"]["fallback"] for t in st.tasks("INC-001") if t["kind"] in ("classify", "reconcile"))
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_no_model_configured_still_progresses_and_is_labelled():
    st = await Stack.create(seed=3)
    try:
        ms = st.rt.model_status()
        assert ms["model_state"] == "fallback" and ms["status"] == "unavailable" and ms["provider"] == "deterministic" and ms["checkpointer"] == "memory" and ms["restart_safe"] is False
        await st.inject("valve_stuck", "valve_a2")
        assert await st.run_until(done(st), 1500)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved"
        assert all(t["model"]["fallback"] for t in st.tasks(inc["id"]) if t["kind"] in ("classify", "reconcile", "decide"))
        assert not any(c["name"].startswith("model.propose") for t in st.tasks(inc["id"]) for c in t["tool_calls"])   # no fake model "calls"
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_command_ids_are_idempotent_and_never_double_apply():
    st = await Stack.create(seed=3)
    try:
        await st.inject("fouling", "p_hs_b")
        assert await st.run_until(done(st), 1800)
        ledger = [c for c in st.eng.commands.ledger.values() if c["actor_type"] == "agent"]
        assert ledger and len({c["command_id"] for c in ledger}) == len(ledger)
        first = next(c for c in ledger if c["kind"] == "robot.mission.assign" and c["status"] == "accepted")
        n_missions = len(st.eng.missions.missions)
        n_effects = len(st.eng.missions.applied_effects)
        again = await st.rt.ctx.engine.submit({"command_id": first["command_id"], "kind": "robot.mission.assign", "target_id": first["target_id"],
                                              "args": first["args"], "actor_type": "agent"})
        assert again.get("duplicate") is True and again["accepted"] is True
        assert len(st.eng.missions.missions) == n_missions and len(st.eng.missions.applied_effects) == n_effects
        assert len({e.split(":")[0] + e.split(":")[1] for e in st.eng.missions.applied_effects}) == len(st.eng.missions.applied_effects)
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_resume_from_checkpointer_after_restart_no_double_repair():
    from langgraph.checkpoint.memory import InMemorySaver
    saver, store = InMemorySaver(), MemoryDecisionStore()
    cl = FakeModelClient()
    st = await Stack.create(seed=3, model_client=cl, checkpointer=saver, store=store)
    try:
        await st.inject("fouling", "p_hs_b")
        assert await st.run_until(lambda: any(i["status"] == "mitigating" for i in st.incidents()), 1500)    # mid-repair
        inc_id = st.incidents()[0]["id"]
        calls_before = len(cl.calls)
        await st.rt.stop()                                                      # simulated crash: tasks die, checkpoints survive
        assert (await st.rt.graph.aget_state({"configurable": {"thread_id": f"{st.eng.run_id}:{inc_id}"}})).next      # a node was pending
        rt2 = AgentRuntimeImpl(intelligence=IntelligenceConfig(api_key=""), model_client=cl, checkpointer=saver, database_url="",
                               limits=Limits(), decision_store=store)
        await rt2.start(st.eng.as_actor("agent", "agent"))
        await rt2.resume(st.eng.track.open_incidents())
        st.rt = rt2
        assert await st.run_until(done(st), 1800)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved", inc["summary"]
        service = [m for m in st.eng.missions.missions.values() if m["kind"] == "service" and m["incident_id"] == inc_id]
        assert len(service) == 1 and service[0]["outcome"] == "completed"       # the repair was not applied twice
        keys = list(st.eng.missions.applied_effects)
        assert len(keys) == len(set(keys))
        ids = [t["id"] for t in st.tasks(inc_id)]
        assert len(ids) == len(set(ids))                                        # deterministic ids: re-run nodes upsert, never duplicate
        recs = await store.list()
        assert len({r["key"] for r in recs}) == len(recs)                       # decisions frozen once; old ones not re-asked
        assert rt2.model_status()["checkpointer"] == "memory"
    finally:
        await st.stop()
