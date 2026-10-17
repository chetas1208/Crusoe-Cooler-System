import json
import pytest
from pathlib import Path
from loopkeeper.engine.config import EngineConfig
from loopkeeper.engine.core import Engine
from loopkeeper.storage.memory import MemoryStorage
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config


@pytest.fixture
def fixtures_dir():
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def topo(fixtures_dir):
    with open(fixtures_dir / "topology.json") as f:
        return json.load(f)


@pytest.fixture
def plant():
    cfg = load_config(Path(__file__).resolve().parents[2] / "configs" / "facility-small.yaml", overrides={"physics": {"faults": {"enabled": False}, "workload": {"wave_amplitude": 0.0}}})
    return FacilityPlant(seed=1, config=cfg)


@pytest.fixture
def engine(topo, plant):
    storage = MemoryStorage()
    storage.create_run({
        "run_id": "run_test",
        "facility_id": "lab_01",
        "phase": "running",
        "seed": 1,
        "topology_hash": "h1",
    })
    cfg = EngineConfig(facility_id="lab_01", snapshot_interval_s=60.0)
    eng = Engine(
        run_id="run_test",
        cfg=cfg,
        plant=plant,
        topology=topo,
        storage=storage,
        seed=1,
    )
    return eng


def test_engine_world_and_topology(engine, topo):
    t = engine.topology()
    assert t["facility"]["id"] == topo["facility"]["id"]
    assert len(t["edges"]) == len(topo["edges"])

    w = engine.world()
    assert w["facility_id"] == topo["facility"]["id"]
    assert w["sim_status"] in ("running", "paused")
    assert "robots" in w
    assert len(w["robots"]) > 0


@pytest.mark.asyncio
async def test_engine_commands(engine):
    # Set speed
    ack = await engine.submit({
        "command_id": "cmd_speed_1",
        "kind": "set_sim_speed",
        "target_id": None,
        "args": {"speed": 2.0},
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack["accepted"] is True
    assert engine.world()["sim_speed"] == 2.0

    # Pause
    ack_p = await engine.submit({
        "command_id": "cmd_pause_1",
        "kind": "pause",
        "target_id": None,
        "args": {},
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack_p["accepted"] is True
    assert engine.world()["sim_status"] == "paused"

    # Resume
    ack_r = await engine.submit({
        "command_id": "cmd_resume_1",
        "kind": "resume",
        "target_id": None,
        "args": {},
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack_r["accepted"] is True
    assert engine.world()["sim_status"] == "running"


@pytest.mark.asyncio
async def test_engine_robot_lease_lifecycle(engine):
    w = engine.world()
    robots = w["robots"]
    crawler_id = next(rid for rid, r in robots.items() if r["class"] == "inpipe")

    # Acquire control lease
    ack = await engine.submit({
        "command_id": "cmd_lease_1",
        "kind": "robot.control.acquire",
        "target_id": crawler_id,
        "args": {
            "expected_world_version": w["version"],
            "idempotency_key": "idem_123456",
            "client_id": "op_client_1",
            "topology_revision": "r1"
        },
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack["accepted"] is True
    lease_id = ack["lease_id"]
    lease_epoch = ack["lease_epoch"]

    # Heartbeat
    ack_hb = await engine.submit({
        "command_id": "cmd_hb_1",
        "kind": "robot.control.heartbeat",
        "target_id": crawler_id,
        "args": {
            "lease_id": lease_id,
            "lease_epoch": lease_epoch
        },
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack_hb["accepted"] is True

    # Release lease
    ack_rel = await engine.submit({
        "command_id": "cmd_rel_1",
        "kind": "robot.control.release",
        "target_id": crawler_id,
        "args": {
            "lease_id": lease_id,
            "lease_epoch": lease_epoch,
            "reason": "operator_release"
        },
        "actor_type": "operator",
        "principal": "op1"
    })
    assert ack_rel["accepted"] is True
