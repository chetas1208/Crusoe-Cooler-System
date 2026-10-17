"""V6 persistence gates: topology versions are never overwritten, old runs replay on the layout they were recorded on, forks create a
new run from a verified checkpoint and leave the parent untouched, and the Postgres migration is idempotent + backfills."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.api.runs_storage import StorageRunManager
from loopkeeper.api.service import RunError
from loopkeeper.engine import create_engine
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage

CONF = Path(__file__).resolve().parents[1] / "configs"
NOFAULT = {"physics": {"faults": {"enabled": False}}}


def _engine(storage, run_id, cfg_name=None, seed=2):
    cfg = load_config(str(CONF / cfg_name) if cfg_name else None, overrides=NOFAULT)
    return create_engine(plant=FacilityPlant(seed=seed, config=cfg), run_id=run_id, seed=seed, storage=storage)


async def _record(eng, ticks=260):
    await eng.step_ticks(ticks)                             # > 2 interval snapshots (60 sim-s = 120 ticks)
    eng.take_snapshot("test")
    await eng.step_ticks(2)


@pytest.mark.asyncio
async def test_topology_versions_are_never_overwritten_and_old_runs_replay_on_their_layout():
    st = MemoryStorage()
    old = _engine(st, "run_old", "facility-small.yaml")                    # the legacy 16-rack hall
    await _record(old)
    old_topo = old.topology()
    old_hash = old_topo["facility"]["topology_hash"]
    assert len([a for a in old_topo["assets"] if a["type"] == "rack"]) == 16

    new = _engine(st, "run_v6")                                           # the V6 hall registers its topology on the SAME facility id
    await _record(new)
    new_topo = new.topology()
    new_hash = new_topo["facility"]["topology_hash"]
    assert new_hash != old_hash
    assert new_topo["facility"]["topology_version"].startswith("facility_layout_v6@1#")
    assert len([a for a in new_topo["assets"] if a["type"] == "rack"]) == 40

    fid = new_topo["facility"]["id"]
    assert fid == old_topo["facility"]["id"]
    assert st.get_facility(fid)["topology_hash"] == new_hash              # `facilities` = current layout
    assert st.get_topology(fid, old_hash)["facility"]["topology_hash"] == old_hash       # old layout still there, byte-for-byte
    assert st.get_topology(fid, old_hash) == old_topo

    mgr = StorageRunManager(new)
    runs = {r["run_id"]: r for r in mgr.list_runs()}
    assert {"run_v6", "run_old"} <= set(runs)
    assert runs["run_v6"]["topology_version"] == new_topo["facility"]["topology_version"]
    assert runs["run_old"]["topology_hash"] == old_hash and runs["run_old"]["state"] == "stopped" and runs["run_old"]["kind"] == "baseline"

    # the old run is served on ITS topology (16 racks, 4 rows' worth of zones), not the live five-row hall
    rec = mgr.engine_for("run_old")
    assert rec is not None
    t = rec.topology()
    assert t["facility"]["topology_hash"] == old_hash
    assert len([a for a in t["assets"] if a["type"] == "rack"]) == 16 and "facility_layout_v6" not in t
    assert len(rec.world()["robots"]) == len(old.world()["robots"])
    win = await mgr.replay("run_old", None, None, 1, False, 100)
    assert win["frames"], "old run produced no replay frames"
    assert all(len([a for a in f["assets"]]) > 0 for f in win["frames"])
    live_win = await mgr.replay("run_v6", None, None, 1, False, 100)
    assert live_win["frames"]
    robots_live = live_win["frames"][-1]["robots"]
    assert sum(1 for r in robots_live.values() if r["class"] == "outrig") == 8 and sum(1 for r in robots_live.values() if r["class"] == "inpipe") == 10


@pytest.mark.asyncio
async def test_fork_creates_new_run_from_verified_checkpoint_and_parent_is_immutable():
    st = MemoryStorage()
    eng = _engine(st, "run_parent")
    await _record(eng)
    mgr = StorageRunManager(eng)
    cps = mgr.checkpoints("run_parent", None)
    assert len(cps) >= 2
    cp = cps[-1]

    def parent_fingerprint():
        snaps = st.list_snapshots("run_parent")
        row = st.get_run("run_parent")
        ev = st.load_events("run_parent", after_seq=0)
        return hashlib.sha256(json.dumps([[s["snapshot_id"], s["content_hash"], s["state_hash"], s["tick"]] for s in snaps] +
                                         [row["last_seq"], len(ev)], sort_keys=True).encode()).hexdigest()

    before = parent_fingerprint()
    with pytest.raises(RunError):                                               # a stale/forged parent hash is refused
        await mgr.fork("run_parent", {"fork_tick": cp["tick"], "expected_parent_hash": "deadbeef", "chosen_snapshot_id": cp["snapshot_id"]}, "op1")
    res = await mgr.fork("run_parent", {"fork_tick": cp["tick"], "expected_parent_hash": cp["hash"], "chosen_snapshot_id": cp["snapshot_id"],
                                        "label": "what if"}, "op1")
    child = res["run"]
    assert child["run_id"] != "run_parent" and child["parent_run_id"] == "run_parent" and child["fork_tick"] == cp["tick"]
    assert child["kind"] == "fork" and child["topology_hash"] == eng.topology()["facility"]["topology_hash"]       # same layout/config hash
    assert child["topology_version"] == eng.topology()["facility"]["topology_version"]
    assert res["parent_hash_before"] == res["parent_hash_after"] == cp["hash"]
    assert res["restored_hash"] == st.get_snapshot("run_parent", cp["snapshot_id"])["state_hash"]       # restored on a scratch engine
    assert parent_fingerprint() == before                                                                # parent rows untouched
    assert child["run_id"] in mgr.get_run("run_parent")["children"]
    # the fork is a real, replayable run with its own checkpoint (the copied one) on the parent's topology
    win = await mgr.replay(child["run_id"], None, None, 1, False, 50)
    assert len(win["frames"]) == 1 and win["frames"][0]["tick"] == cp["tick"]
    assert mgr.engine_for(child["run_id"]).topology()["facility"]["topology_hash"] == child["topology_hash"]
    # live run is not affected and cannot be commanded through a recorded run
    ack = await mgr.engine_for(child["run_id"]).submit({"kind": "pause"})
    assert ack["accepted"] is False


@pytest.mark.asyncio
async def test_fork_refuses_checkpoint_recorded_on_another_layout():
    st = MemoryStorage()
    old = _engine(st, "run_old", "facility-small.yaml")
    await _record(old)
    new = _engine(st, "run_v6")
    mgr = StorageRunManager(new)
    cp = mgr.checkpoints("run_old", None)[-1]
    with pytest.raises(RunError) as e:
        await mgr.fork("run_old", {"fork_tick": cp["tick"], "expected_parent_hash": cp["hash"], "chosen_snapshot_id": cp["snapshot_id"]}, "op1")
    assert e.value.code == "topology_mismatch"                 # honest refusal, not a restore onto the wrong geometry
    assert len(st.list_runs()) == 2


def test_postgres_migration_0002_is_idempotent_and_backfills():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set (gated: needs a scratch Postgres)")
    from loopkeeper.storage.postgres import PostgresStorage
    st = PostgresStorage(url)
    st.migrate()
    st.migrate()                                               # idempotent
    with st.pool.connection() as c:
        assert c.execute("SELECT to_regclass('facility_topologies') AS t").fetchone()["t"]
        assert c.execute("SELECT count(*) AS n FROM simulation_runs WHERE topology_version IS NULL").fetchone()["n"] == 0


@pytest.mark.asyncio
async def test_new_run_marks_previous_baselines_stopped():
    st = MemoryStorage()
    a = _engine(st, "run_a", "facility-small.yaml")
    assert st.get_run("run_a")["phase"] == "running"
    b = _engine(st, "run_b")                                          # a different layout cannot resume run_a: a new run id is used
    assert st.get_run("run_a")["phase"] == "stopped" and st.get_run(b.run_id)["phase"] == "running"
