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


@pytest.mark.xfail(strict=False, reason="SOAK-02 (owner K): advertised heartbeat interval 10 s > deadman 1.5 s")
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
@pytest.mark.xfail(strict=False, reason="SOAK-03 (owner M): classify crashes on an empty rack scope for plant zone c/d/e headers")
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
