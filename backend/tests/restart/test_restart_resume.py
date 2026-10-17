"""Restart/resume + Execution data (checkpoints, replay window). Regression for the live defect: after an API restart the
engine reused run 'run_live' with a durable command ledger, so every agent command was answered as an idempotent
duplicate ('accepted', no mission) and 16 robots sat docked while incidents stayed open."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "agents"), str(ROOT)]

from live_harness import Stack  # noqa: E402
from loopkeeper.engine import create_engine  # noqa: E402
from loopkeeper.physics import FacilityPlant  # noqa: E402
from loopkeeper.physics.config import load_config  # noqa: E402
from loopkeeper.storage.memory import MemoryStorage  # noqa: E402
from loopkeeper.api.runs_storage import StorageRunManager  # noqa: E402
from support.artifacts import write_artifact  # noqa: E402

CFG = dict(overrides={"physics": {"faults": {"enabled": False}, "workload": {"wave_amplitude": 0.0}}})


def new_engine(storage, seed=3, run_id="run_live"):
    return create_engine(plant=FacilityPlant(seed, config=load_config(**CFG)), run_id=run_id, seed=seed, storage=storage)


@pytest.mark.asyncio
async def test_resume_continues_state_and_ledger():
    st = MemoryStorage()
    e1 = new_engine(st)
    await e1.step_ticks(60)
    e1.take_snapshot("test")
    await e1.commit()
    seq1, tick1 = e1.seq, e1.tick
    e2 = new_engine(st)
    assert e2.run_id == "run_live" and e2.recovery_info["restored"] is True
    assert e2.tick == tick1 and e2.seq >= seq1
    assert e2.world()["last_seq"] >= seq1                   # stream cursors stay monotonic across the restart
    await e2.step_ticks(10)
    ids = sorted(e2.world()["robots"])
    assert len(ids) == len(set(ids)) == 18
    seqs = [e["seq"] for e in st.load_events("run_live")]
    assert seqs == sorted(set(seqs))                        # append-only, no collisions


@pytest.mark.asyncio
async def test_history_without_snapshot_starts_new_run_not_duplicate_commands():
    st = MemoryStorage()
    e1 = new_engine(st)
    ack = await e1.submit({"command_id": "INC-001:t_001_07:inspect0", "kind": "workload.set_load", "target_id": "rack_a1", "args": {"factor": 0.9}},
                          principal="t", actor_type="operator")
    await e1.step_ticks(5)
    e1.snapshots_dropped = True
    st.snapshots.clear()                                    # history exists but cannot be restored
    e2 = new_engine(st)
    assert e2.run_id == "run_live_2", "an unrestorable run must not be reused (old command ids would answer as duplicates)"
    a2 = await e2.submit({"command_id": "INC-001:t_001_07:inspect0", "kind": "workload.set_load", "target_id": "rack_a1", "args": {"factor": 0.9}},
                         principal="t", actor_type="operator")
    assert not a2.get("duplicate")
    assert st.get_run("run_live") is not None               # old history untouched


@pytest.mark.asyncio
async def test_commands_after_snapshot_are_reissuable_after_restore():
    st = MemoryStorage()
    e1 = new_engine(st)
    await e1.step_ticks(10)
    e1.take_snapshot("test")
    await e1.commit()
    cmd = {"command_id": "after-snap-1", "kind": "workload.set_load", "target_id": "rack_a1", "args": {"load_factor": 0.5}}
    assert (await e1.submit(dict(cmd), principal="t", actor_type="operator"))["accepted"]
    e2 = new_engine(st)                                     # crash before the next snapshot: that command's effect is lost
    assert e2.recovery_info["restored"]
    again = await e2.submit(dict(cmd), principal="t", actor_type="operator")
    assert again["accepted"] and not again.get("duplicate")


@pytest.mark.asyncio
async def test_agents_dispatch_after_restart_and_incident_closes():
    """The live defect end-to-end: a restarted process on a populated store must still dispatch and close an incident."""
    st = MemoryStorage()
    s1 = await Stack.create(seed=3, storage=st, run_id="run_live")
    await s1.inject("strainer_blockage", "strainer_02")
    assert await s1.run_until(lambda: any(m["kind"] == "service" for m in s1.eng.missions.missions.values()), 900)
    await s1.eng.commit()
    st.snapshots.clear()                                    # simulate a process whose snapshots are unusable
    await s1.stop()
    s2 = await Stack.create(seed=3, storage=st, run_id="run_live")        # same store, same run id requested, colliding INC/task ids
    try:
        assert s2.eng.run_id != "run_live"
        await s2.inject("strainer_blockage", "strainer_02")
        assert await s2.run_until(lambda: any(i["status"] == "resolved" for i in s2.incidents()), 1600)
        ms = list(s2.eng.missions.missions.values())
        assert ms and all(m["robot_id"][:3] in ("IR-", "OR-") for m in ms)
        assert any(r.mode != "DOCKED" or r.done_count for r in s2.eng.robots.values()), "no robot ever left its dock"
    finally:
        await s2.stop()


@pytest.mark.asyncio
async def test_checkpoints_and_replay_window_for_live_run():
    st = MemoryStorage()
    eng = new_engine(st)
    eng.cfg.snapshot_interval_s = 20.0
    eng._next_snap_s = 20.0
    for _ in range(8):
        await eng.step_ticks(30)
    mgr = StorageRunManager(eng)
    cps = mgr.checkpoints("run_live", None)
    assert len(cps) >= 3 and all(c["hash"] and c["compatible"] for c in cps)
    assert [c["tick"] for c in cps] == sorted(c["tick"] for c in cps)
    win = await mgr.replay("run_live", None, None, 1, True, 5000)
    assert len(win["frames"]) >= 3 and win["recorded_to_tick"] == eng.tick
    f = win["frames"][-1]
    assert len(f["robots"]) == 18 and f["assets"] and "kpis" in f
    seqs = [e["seq"] for e in win["events"]]
    assert seqs and seqs == sorted(seqs) and not any(e["type"] in ("world.diff", "heartbeat") for e in win["events"])
    part = await mgr.replay("run_live", cps[1]["tick"], cps[2]["tick"], 1, True, 5000)
    assert all(cps[1]["tick"] <= fr["tick"] <= cps[2]["tick"] for fr in part["frames"]) and part["frames"]
    write_artifact("execution_data_checkpoints_replay", {"test": "REPLAY data for the live run", "checkpoints": len(cps),
                                                         "frames": len(win["frames"]), "events": len(win["events"]),
                                                         "first_ticks": [c["tick"] for c in cps[:5]]})
