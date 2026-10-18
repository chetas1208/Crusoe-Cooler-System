"""Regression: the REAL physics plant + engine + agent runtime (deterministic fallback, no model) must run every fault
type through observe -> reviewers -> inspect -> intervene -> independent verify -> closed(verified), reject ineffective
repairs and replan, and only escalate after the retry caps - with plain-language operator text throughout."""
import os
import re

import pytest

from live_harness import Stack

SEEDS = [int(x) for x in os.environ.get("AGENT_SOAK_SEEDS", "3,8").split(",")]
CASES = [
    ("fouling", "p_hs_b", "resolved"), ("strainer_blockage", "strainer_02", "resolved"), ("valve_stuck", "valve_b1", "resolved"),
    ("pump_degradation", "pump_t1", "resolved"), ("sensor_drift", "sn_flow_zb", "resolved"), ("workload_spike", "rack_b1", "dismissed"),
]
TERMINAL = ("resolved", "escalated", "dismissed")
RAW = re.compile(r"invalid args|extra inputs|steps\.\d|traceback|pydantic|validationerror|_kpa|kg_s|\bNone\b|Exception|\{'|\[\'", re.I)


def operator_text(inc: dict) -> list[str]:
    return [inc.get("summary", ""), inc.get("close_reason") or "", inc.get("title", "")]


@pytest.mark.asyncio
@pytest.mark.parametrize("seed", SEEDS)
@pytest.mark.parametrize("kind,target,final", CASES)
async def test_each_fault_kind_closes_verified(kind, target, final, seed):
    st = await Stack.create(seed=seed)
    try:
        assert (await st.inject(kind, target))["accepted"]
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1600)
        inc = st.incidents()[0]
        assert inc["status"] == final, inc["summary"]
        assert inc["cause"] == kind
        if final == "resolved":
            assert [x["stage"] for x in inc["stage_log"]][:3] == ["observed", "hypothesized", "investigated"]
            assert inc["stage_log"][-1] == {**inc["stage_log"][-1], "stage": "verified", "outcome": "ok"}
            # no model client here: the measured recovery is real, but with no independent (model) review it is never recorded as "verified" (V12 review #1)
            assert inc["verification"]["status"] == "rejected" and inc["verification"]["dod"]["layer_a"] == "PASS" and inc["verification"]["checks"]
            assert "not counted as verified" in inc["verification"]["failed_reason"]
            tasks = st.tasks(inc["id"])
            kinds = {t["kind"] for t in tasks}
            assert {"classify", "review.hydraulics", "review.thermal", "review.accessibility", "reconcile", "verify"} <= kinds
            assert max(t["depth"] for t in tasks) <= 3
            assert all(t["model"]["fallback"] is True for t in tasks if t["kind"] in ("classify", "reconcile"))   # no model: labelled, never claimed
        assert not any(RAW.search(x) for x in operator_text(inc)), operator_text(inc)
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_ineffective_repair_is_rejected_then_replanned():
    st = await Stack.create(seed=3)
    try:
        await st.inject("fouling", "p_hs_b")
        await st.advance(4)
        st.eng.plant.faults.occl["p_hs_b"] = 0.62          # moderate deposit: the crawler brush is tried first
        st.eng.plant._hard = True
        st.eng.plant.fault_mgr.halt("p_hs_b", st.eng.plant.time)
        st.eng.missions._plant_args = lambda effect, target, args: ({"removed_fraction": 0.1} if effect == "brush_clear" else {})   # brush barely helps
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved" and inc["attempts"] == 1
        log = [(x["stage"], x.get("outcome")) for x in inc["stage_log"]]
        assert ("verified", "rejected") in log and log[-1] == ("verified", "ok")
        vers = sorted((v for v in st.eng.track.verifications.values()), key=lambda v: v["attempt"])
        assert [v["status"] for v in vers] == ["rejected", "rejected"] and vers[0]["failed_reason"]          # 2nd: recovered, but no independent review -> not "verified"
        assert vers[1]["dod"]["layer_a"] == "PASS" and vers[1]["dod"]["independently_reviewed"] is False
        kinds = [t["kind"] for t in st.tasks(inc["id"])]
        assert "clear" in kinds and "replan" in kinds and kinds.count("verify") == 2
        # the physics really recovered (independent of the verifier's own words)
        assert st.eng.plant.faults.occl.get("p_hs_b", 0.0) < 0.05
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_declined_plan_is_replanned_not_escalated_forever():
    """The engine rejects the first service mission (e.g. schema/step mismatch): that is a failed ATTEMPT, SENTINEL retries."""
    st = await Stack.create(seed=3)
    try:
        real = st.eng.missions.create
        calls = {"n": 0}

        def flaky(args, issuer, cid):
            if args.get("kind") == "service":
                calls["n"] += 1
                if calls["n"] == 1:
                    return False, "invalid args - steps.0.id: Extra inputs are not permitted", None
            return real(args, issuer, cid)

        st.eng.missions.create = flaky
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
        inc = st.incidents()[0]
        assert inc["status"] == "resolved" and inc["attempts"] == 1 and calls["n"] == 2
        assert not any(RAW.search(x) for x in operator_text(inc))
        raws = [c for t in st.tasks(inc["id"]) for c in t["tool_calls"] if c["name"] == "dispatch_mission" and c["status"] == "rejected"]
        assert raws and "Extra inputs" in str(raws[0]["output"])      # raw detail is kept in the trace only
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_escalates_only_after_caps_with_plain_language():
    st = await Stack.create(seed=3)
    try:
        real = st.eng.missions.create
        st.eng.missions.create = lambda args, issuer, cid: (False, "invalid args - steps.0.id: Extra inputs are not permitted", None) if args.get("kind") == "service" else real(args, issuer, cid)
        await st.inject("strainer_blockage", "strainer_02")
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 2400)
        inc = st.incidents()[0]
        assert inc["status"] == "escalated" and inc["attempts"] == 3          # 1 try + 2 replans = the cap, then a human
        assert not RAW.search(inc["summary"]) and "operator" in inc["summary"].lower()
        assert inc.get("closed_tick") is None                                       # stays open for the operator, monitoring continues
        replans = [t for t in st.tasks(inc["id"]) if t["kind"] == "replan"]
        assert [t["status"] for t in sorted(replans, key=lambda t: t["id"])] == ["completed", "completed", "blocked"]   # 2 real retries, then the cap blocks
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_isolation_cordons_then_restores_workload():
    st = await Stack.create(seed=3)
    try:
        await st.inject("fouling", "p_hs_b")
        loads: list[float] = []

        def sample() -> bool:
            loads.append(min(st.eng.world()["assets"][r]["readings"]["power_kw"] for r in ("rack_b1", "rack_b2")))
            return any(i["status"] in TERMINAL for i in st.incidents())

        assert await st.run_until(sample, 1800)
        assert st.incidents()[0]["status"] == "resolved"
        assert min(loads) < 40            # zone B was really drained before isolation
        await st.advance(60)
        w = st.eng.world()
        assert all(w["assets"][r]["readings"]["power_kw"] > 90 for r in ("rack_b1", "rack_b2"))      # and restored afterwards
        assert w["assets"]["valve_zb"]["status"] != "isolated"
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_concurrent_faults_do_not_deadlock_or_escalate():
    st = await Stack.create(seed=8)
    try:
        await st.inject("fouling", "p_hs_b")
        await st.inject("pump_degradation", "pump_t1")
        await st.inject("sensor_drift", "sn_flow_za")
        assert await st.run_until(lambda: len(st.incidents()) >= 3 and all(i["status"] in TERMINAL for i in st.incidents()), 3000)
        assert all(i["status"] == "resolved" for i in st.incidents()), [(i["id"], i["status"], i["summary"]) for i in st.incidents()]
        assert not st.rt.errors
    finally:
        await st.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("seed,every_s", [(3, 2.0), (3, 12.0), (8, 12.0)])   # 12 s = the live API's agent cadence at 12x sim speed
async def test_all_six_faults_injected_at_once_like_the_live_demo(seed, every_s):
    st = await Stack.create(seed=seed)
    try:
        for kind, target, _ in [("fouling", "p_hs_b", 0), ("strainer_blockage", "strainer_02", 0), ("valve_stuck", "valve_a2", 0),
                                ("pump_degradation", "pump_t1", 0), ("sensor_drift", "sn_flow_za", 0), ("workload_spike", "rack_b2", 0)]:
            assert (await st.inject(kind, target))["accepted"]
        assert await st.run_until(lambda: len(st.incidents()) >= 6 and all(i["status"] in TERMINAL for i in st.incidents()), 6000, every_s)
        bad = [(i["id"], i["cause"], i["status"], i["summary"]) for i in st.incidents() if i["status"] == "escalated"]
        assert not bad, bad
        assert all(not RAW.search(x) for i in st.incidents() for x in operator_text(i))
    finally:
        await st.stop()
