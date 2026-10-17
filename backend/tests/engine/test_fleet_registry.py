"""Fleet registry is the only source of robot ids: exactly 10 IR / 8 OR (+5 SEN in the agents graph), unique, in
world snapshot, /robots and the stream's first snapshot, also after a restart from a persisted snapshot that still
carries legacy c_01/c_02/o_01 rows (regression: live run showed IR-01 twice and 19 robots)."""
import copy
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.api import create_app
from loopkeeper.engine import create_engine
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage
from support.fixtures import TOKEN, make_settings

AUTH = {"Authorization": f"Bearer {TOKEN}"}
IR = [f"IR-{i:02d}" for i in range(1, 11)]
OR = [f"OR-{i:02d}" for i in range(1, 9)]


def make(storage=None, run_id="run_live"):
    cfg = load_config(overrides={"physics": {"faults": {"enabled": False}}})
    return create_engine(plant=FacilityPlant(seed=2, config=cfg), run_id=run_id, seed=2, storage=storage or MemoryStorage())


def check_ids(ids):
    ids = list(ids)
    assert len(ids) == len(set(ids)) == 18
    assert sorted(i for i in ids if i.startswith("IR-")) == IR
    assert sorted(i for i in ids if i.startswith("OR-")) == OR


def test_world_robots_exact_and_unique():
    eng = make()
    w = eng.world()
    check_ids(w["robots"])
    assert all(r["id"] == k for k, r in w["robots"].items())      # a key never maps to another robot's record
    assert not {"c_01", "c_02", "o_01"} & set(w["robots"])


def test_rest_and_stream_expose_same_18_and_5_supervisors():
    eng = make()
    app = create_app(eng, settings=make_settings())
    with TestClient(app, headers=AUTH) as c:
        rows = c.get("/api/v1/robots").json()
        check_ids(r["id"] for r in rows)
        check_ids(c.get("/api/v1/world").json()["robots"])
        with c.websocket_connect("/api/v1/stream?facility_id=lab_01&since_seq=0", headers=AUTH) as ws:
            snap = ws.receive_json()
        assert snap["type"] == "snapshot"
        check_ids(snap["payload"]["robots"])
        g = c.get("/api/v1/runs/run_live/agents/graph").json()
        sen = [n["id"] for n in g.get("nodes", []) if str(n.get("id", "")).startswith("SEN-")] or \
              [n["id"] for n in g.get("sentinels", []) if str(n.get("id", "")).startswith("SEN-")]
        assert sorted(set(sen)) == [f"SEN-0{i}" for i in range(1, 6)] and len(sen) == 5


@pytest.mark.asyncio
async def test_restart_from_snapshot_with_legacy_and_stale_rows_never_duplicates():
    st = MemoryStorage()
    eng = make(st)
    await eng.step_ticks(4)
    doc = copy.deepcopy(eng.state_doc())
    # simulate an OLD persisted run: legacy ids + a stale unknown row + a legacy-keyed control row, queue and lease
    doc["robots"]["c_01"] = {**doc["robots"].pop("IR-01"), "id": "c_01"}
    doc["robots"]["o_01"] = {**doc["robots"].pop("OR-01"), "id": "o_01"}
    doc["robots"]["ghost_9"] = copy.deepcopy(doc["robots"]["IR-02"])
    doc["control"]["ctl"]["c_01"] = doc["control"]["ctl"].pop("IR-01")
    doc["control"]["ctl"]["ghost_9"] = copy.deepcopy(doc["control"]["ctl"]["IR-02"])
    doc["missions"]["queues"]["c_01"] = []
    doc["missions"]["queues"]["ghost_9"] = []
    eng2 = make(MemoryStorage(), run_id="run_restore")
    eng2.load_state_doc(doc)
    check_ids(eng2.world()["robots"])
    check_ids(eng2.control.ctl.keys())
    assert "ghost_9" not in eng2.missions.queues and "c_01" not in eng2.missions.queues
    # the migrated robots kept their persisted battery/pose (state migrated, not reset)
    assert eng2.robots["IR-01"].battery == pytest.approx(eng.robots["IR-01"].battery)
    await eng2.step_ticks(2)
    check_ids(eng2.world()["robots"])
