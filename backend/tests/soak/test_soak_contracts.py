"""Minimal reproducers found by the soak harness (each is a fast, deterministic, no-model test). Kept as xfail(strict=False) while the owner fixes them:
an XPASS means the defect is gone."""
import pytest

from loopkeeper.engine import create_engine
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage

from soak_lib import VClock


def _engine(clock):
    cfg = load_config(overrides={"physics": {"faults": {"enabled": False}, "workload": {"wave_amplitude": 0.0}}})
    return create_engine(plant=FacilityPlant(seed=3, config=cfg), run_id="soak_contract", seed=3, storage=MemoryStorage(), wall_time=clock)


@pytest.mark.asyncio
async def test_lease_acquire_ack_heartbeat_interval_is_within_deadman():
    """SOAK-02: the acquire ack tells clients to heartbeat every `heartbeat_interval_ms` (ttl/3 = 10 s) but the deadman fires after `deadman_ms` (1.5 s)
    without a heartbeat or drive, so a client that follows the advertised interval loses its lease every time."""
    clock = VClock()
    eng = _engine(clock)
    await eng.step_ticks(4)
    ack = await eng.submit({"command_id": "acq-1", "kind": "control.acquire", "args": {"robot_id": "OR-01"}, "actor_type": "operator"}, principal="op", actor_type="operator")
    assert ack["accepted"], ack
    assert ack["heartbeat_interval_ms"] < ack["deadman_ms"], (ack["heartbeat_interval_ms"], ack["deadman_ms"])


@pytest.mark.asyncio
async def test_deadman_ends_abandoned_lease_and_robot_returns_to_autonomous():
    clock = VClock()
    eng = _engine(clock)
    await eng.step_ticks(4)
    ack = await eng.submit({"command_id": "acq-2", "kind": "control.acquire", "args": {"robot_id": "OR-01"}, "actor_type": "operator"}, principal="op", actor_type="operator")
    assert ack["accepted"]
    clock.t += eng.cfg.deadman_s + 0.5
    eng._wall_monitor()
    assert eng.control.leases[ack["lease_id"]]["ended_reason"] == "deadman_timeout"
    await eng.step_ticks(6)
    assert eng.control.state_of("OR-01") == "AUTONOMOUS"
    assert eng.control.active_lease_ids() == []


@pytest.mark.slow
@pytest.mark.asyncio
async def test_fouling_on_far_zone_header_does_not_crash_the_incident_graph():
    from agent_fakes import FakeModelClient
    from live_harness import Stack
    st = await Stack.create(seed=5, model_client=FakeModelClient())
    try:
        assert (await st.inject("fouling", "p_hs_e"))["accepted"]
        await st.advance(400, 2.0)
        assert st.rt.errors == [], st.rt.errors
        assert all(i["cause"] != "unknown" for i in st.incidents())
    finally:
        await st.stop()


@pytest.mark.slow
@pytest.mark.xfail(strict=False, reason="SOAK-04 (owner M): ctx.suppress[asset]=inf is never released when the incident is escalated by the liveness guard")
@pytest.mark.asyncio
async def test_recurrence_on_an_asset_with_an_escalated_incident_opens_a_new_incident():
    """SOAK-04 liveness: outrig.py:169 `ctx.lock_suppress([target])` suppresses the detector on the repaired asset with until=inf while the repair runs;
    the release is the later `lock_suppress(..., now + settle_grace_s)`. When the incident is cancelled in between (runtime._liveness escalation, graph
    crash) nothing frees it, so `ctx.suppress == {asset: inf}` until the process restarts and a fresh failure of that asset never opens an incident.
    Reproducer: shrink the stuck-stage limit so the guard escalates, repair the strainer physically, inject it again."""
    from agent_fakes import FakeModelClient
    from live_harness import Stack
    from loopkeeper.orchestration import Limits
    st = await Stack.create(seed=3, model_client=FakeModelClient(), limits=Limits(stuck_stage_s=20.0))
    try:
        assert (await st.inject("strainer_blockage", "strainer_02"))["accepted"]
        if not await st.run_until(lambda: any(i["status"] == "escalated" for i in st.incidents()), 900):
            pytest.skip("the first incident did not escalate under the shrunken liveness guard (inconclusive)")
        first = {i["id"] for i in st.incidents()}
        res = st.eng.plant_apply("replace_strainer", "strainer_02", {})            # the operator fixes it physically
        assert res.get("ok"), res
        await st.advance(180, 2.0)
        assert (await st.inject("strainer_blockage", "strainer_02"))["accepted"]
        assert await st.run_until(lambda: {i["id"] for i in st.incidents()} - first, 600), \
            f"no new incident for a fresh strainer_blockage on strainer_02 (suppress={dict(st.rt.ctx.suppress)} open_keys={dict(st.rt.ctx.open_keys)})"
    finally:
        await st.stop()
