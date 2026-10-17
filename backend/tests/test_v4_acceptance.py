"""LOOPKEEPER V4 Comprehensive Acceptance Verification Test Suite.
Verifies all formal test requirements (FLEET-01..02, FAC-01..03, POSE-01..03,
CTRL-01..02, POLICY-01..03, AGENT-01, REPLAY-01..02, REL-01) against the live
engine, topology, and API.
Also writes artifacts/tests/v4_acceptance_results.json with test evidence.
"""
from __future__ import annotations

import pytest

pytest.skip("superseded by V6: 8 OUTRIG (2 per road) and the five-row hall replace the V4 6-OUTRIG / two-hall fleet; see tests/test_v6_acceptance.py", allow_module_level=True)

import json
import os
import sys
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure backend/src is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.api import create_app
from loopkeeper.api.projections import agent_graph
from loopkeeper.engine.control import ControlManager
from loopkeeper.engine.core import Engine
from loopkeeper.engine.robots.actions import ACTIONS
from loopkeeper.engine.robots.actor import RobotActor
from loopkeeper.engine.robots.fleet import build_fleet, CRAWLER_SPECS, OUTRIG_SPECS
from loopkeeper.engine.robots.graphs import PipeGraph
from loopkeeper.physics.config import load_config
from loopkeeper.physics.topology import build_topology
from loopkeeper.physics.validation import validate_topology

LARGE_CFG_PATH = Path(__file__).resolve().parents[1] / "configs" / "facility-large.yaml"
ARTIFACTS_DIR = Path(__file__).resolve().parents[2] / "artifacts" / "tests"


@pytest.fixture(scope="module")
def cfg():
    return load_config(LARGE_CFG_PATH)


@pytest.fixture(scope="module")
def topo(cfg):
    return build_topology(cfg)


@pytest.fixture(scope="module")
def graph(topo):
    return PipeGraph(topo)


def test_fleet_01_default_counts(topo, graph):
    """FLEET-01: Exactly 10 IR robots, 6 OR robots, 5 virtual SEN instances by default; no physical mesh for SEN."""
    os.environ["EXTERNAL_ROBOT_COUNT"] = "6"
    fleet = build_fleet(topo, graph)
    inpipe = [r for r in fleet if r.klass == "inpipe"]
    outrig = [r for r in fleet if r.klass == "outrig"]

    assert len(inpipe) == 10, f"Expected 10 inpipe robots, got {len(inpipe)}"
    assert len(outrig) == 6, f"Expected 6 outrig robots, got {len(outrig)}"
    assert [r.id for r in inpipe] == [f"IR-{i:02d}" for i in range(1, 11)]
    assert [r.id for r in outrig] == [f"OR-{i:02d}" for i in range(1, 7)]

    # Check 5 virtual supervisors in agent_graph
    g = agent_graph("run_live", tasks=[])
    sen_nodes = [n for n in g.get("nodes", []) if n.get("id", "").startswith("SEN-")]
    assert len(sen_nodes) == 5, f"Expected 5 SEN supervisors, got {len(sen_nodes)}"
    sen_ids = {n["id"] for n in sen_nodes}
    assert sen_ids == {"SEN-01", "SEN-02", "SEN-03", "SEN-04", "SEN-05"}

    # Prove supervisors have NO physical 3D mesh or pose
    for n in sen_nodes:
        assert "pose" not in n or n["pose"] is None, f"Supervisor {n['id']} must not have a physical pose"


def test_fleet_02_configurable_external_count(topo, graph):
    """FLEET-02: Set external robot count to 4, 5, 6: stable IDs, valid dock placements, correct counts."""
    for count in (4, 5, 6):
        os.environ["EXTERNAL_ROBOT_COUNT"] = str(count)
        fleet = build_fleet(topo, graph)
        outrig = [r for r in fleet if r.klass == "outrig"]
        assert len(outrig) == count
        expected_ids = [f"OR-{i:02d}" for i in range(1, count + 1)]
        assert [r.id for r in outrig] == expected_ids
        # Docks are valid assets
        asset_ids = {a["id"] for a in topo["assets"]}
        for r in outrig:
            assert r.home_id in asset_ids, f"Dock {r.home_id} must exist in topology assets"


def test_fac_01_bounds_and_site_structure(topo):
    """FAC-01: Facility bounds ~60m x 42m, structural rooms, partitions, and penetrations exist."""
    site = topo.get("site", {})
    assert "rooms" in site and len(site["rooms"]) >= 5
    room_kinds = {r.get("kind") for r in site["rooms"]}
    assert "hall" in room_kinds and "mechanical" in room_kinds and "cdu" in room_kinds

    # Interior operational bounds
    fac = topo.get("facility", {})
    imin = fac.get("interior_min", [-30, 0, -21])
    imax = fac.get("interior_max", [30, 6, 21])
    width = imax[0] - imin[0]
    depth = imax[2] - imin[2]
    assert 55.0 <= width <= 65.0, f"Expected operational width ~60m, got {width}"
    assert 38.0 <= depth <= 46.0, f"Expected operational depth ~42m, got {depth}"

    # Architectural context cabinets
    ctx_cabs = topo.get("context_cabinets", [])
    assert len(ctx_cabs) == 80, f"Expected 80 architectural context cabinets, got {len(ctx_cabs)}"
    for c in ctx_cabs:
        assert c.get("fidelity") == "architectural_context"
        assert c.get("telemetry") == "none"


def test_fac_02_cooled_racks_closed_circuits(topo):
    """FAC-02: Every modeled cooled rack has supply and return through CDU, no orphan pipe ends."""
    from loopkeeper.physics.validation import check_rack_branches, check_no_orphans
    res = check_rack_branches(topo)
    assert res["passed"] is True, f"Rack branches check failed: {res.get('problems')}"
    orphans = check_no_orphans(topo)
    assert orphans["passed"] is True, f"Orphan pipes found: {orphans.get('problems')}"


def test_fac_03_pipe_network_graph_validation(topo, cfg):
    """FAC-03: FWS/TCS separate mass circuits, valid continuous paths, zero validation errors."""
    from loopkeeper.physics.plant import FacilityPlant
    plant = FacilityPlant(seed=1, config=cfg)
    report = validate_topology(topo, plant=plant)
    assert report["ok"] is True, f"Topology validation failed: {report}"
    # Mass circuits are separate across CDU
    fws_edges = [e for e in topo["edges"] if "fws" in e.get("circuit_id", "")]
    tcs_edges = [e for e in topo["edges"] if "tcs" in e.get("circuit_id", "")]
    assert len(fws_edges) > 0 and len(tcs_edges) > 0


def test_pose_01_crawler_centerline_and_quaternion(topo, graph):
    """POSE-01: Crawler pose resolves accurate 3D xyz, quaternion, segment_id, and s_m inside pipe."""
    fleet = build_fleet(topo, graph)
    crawler = next(r for r in fleet if r.klass == "inpipe")
    contract = crawler.to_contract()
    pose = contract["pose"]

    assert "position_m_xyz" in pose and len(pose["position_m_xyz"]) == 3
    assert "quaternion_xyzw" in pose and len(pose["quaternion_xyzw"]) == 4
    # Quaternion norm must be approx 1.0
    q = pose["quaternion_xyzw"]
    norm = sum(x * x for x in q) ** 0.5
    assert abs(norm - 1.0) < 1e-3, f"Quaternion must be unit length, got norm={norm}"

    nav = contract["nav"]
    assert nav["segment_id"] == crawler.segment_id
    assert abs(nav["s_m"] - crawler.s_m) < 1e-4


def test_pose_02_outrig_navigation_bounds(topo, graph):
    """POSE-02: Exterior robot navigates on floor (y=0) within facility footprint."""
    fleet = build_fleet(topo, graph)
    outrig = next(r for r in fleet if r.klass == "outrig")
    contract = outrig.to_contract()
    pos = contract["pose"]["position_m_xyz"]

    assert abs(pos[1]) < 0.1, f"Floor robot must have y~0, got {pos[1]}"
    # Check within site bounds
    assert -32.0 <= pos[0] <= 32.0, f"X coordinate {pos[0]} out of operational bounds"
    assert -30.0 <= pos[2] <= 25.0, f"Z coordinate {pos[2]} out of operational bounds"


@pytest.fixture()
def api_client():
    """In-process API over a real engine (never the supervised :8787 server: these tests move robots)."""
    from support.fixtures import TOKEN, make_settings
    from loopkeeper.engine import create_engine
    from loopkeeper.physics import FacilityPlant
    from loopkeeper.storage.memory import MemoryStorage
    cfg = load_config(overrides={"physics": {"faults": {"enabled": False}}})
    eng = create_engine(plant=FacilityPlant(1, config=cfg), run_id="run_live", seed=1, storage=MemoryStorage())
    app = create_app(eng, settings=make_settings(api_tokens="second-operator-token-0123456789:op2:operator"))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        yield c, eng


def _post(c, path, body):
    r = c.post(path, json=body)
    return r.status_code, r.json()


def test_ctrl_01_lease_acquire_and_drive(topo, api_client):
    """CTRL-01: Human acquires an exclusive lease on IR-05, drives it; the server owns the pose; other robots are unaffected."""
    c, eng = api_client
    base, rid, rev = "/api/v1/runs/run_live", "IR-05", eng.topology()["facility"]["topology_hash"]
    others_before = {k: list(r.pos) for k, r in eng.robots.items() if k != rid}
    code, res = _post(c, f"{base}/robots/{rid}/control/lease", {"client_id": "test_ctrl", "idempotency_key": f"k_{uuid.uuid4().hex[:8]}",
                                                               "expected_world_version": 100, "topology_revision": rev})
    assert code == 200 and res.get("accepted") is True, res
    lid, epoch = res["lease_id"], res["lease_epoch"]
    # a second operator cannot take the same robot
    r2 = c.post(f"{base}/robots/{rid}/control/lease", headers={"Authorization": "Bearer second-operator-token-0123456789"},
                json={"client_id": "other", "idempotency_key": f"k_{uuid.uuid4().hex[:8]}", "expected_world_version": 100, "topology_revision": rev})
    assert not (r2.status_code == 200 and r2.json().get("accepted") is True), "a second operator must not take a leased robot"
    p0 = list(eng.robots[rid].pos)
    for _ in range(6):                                  # the lease arms on the next engine tick(s)
        for _t in range(3):
            eng.tick_once()
        code3, res3 = _post(c, f"{base}/robots/{rid}/drive", {"lease_id": lid, "lease_epoch": epoch, "command_seq": 1, "throttle": 0.8, "steer": 0.0,
                                                              "brake": False, "duration_ms": 250, "idempotency_key": f"k_{uuid.uuid4().hex[:8]}",
                                                              "topology_revision": rev})
        if code3 == 200:
            break
    assert code3 == 200 and res3.get("accepted") is True and res3.get("controller_state") == "MANUAL", res3
    code4, res4 = _post(c, f"{base}/robots/{rid}/control/release", {"lease_id": lid, "lease_epoch": epoch, "idempotency_key": f"k_{uuid.uuid4().hex[:8]}",
                                                                   "reason": "operator_release"})
    assert code4 == 200 and res4.get("accepted") is True, res4
    assert {k: list(r.pos) for k, r in eng.robots.items() if k != rid} == others_before     # nobody else moved


def test_ctrl_02_deadman_safe_stop(topo, api_client):
    """CTRL-02: a lease whose client goes silent is ended by the server (deadman), and later drives are refused."""
    c, eng = api_client
    base, rid, rev = "/api/v1/runs/run_live", "IR-06", eng.topology()["facility"]["topology_hash"]
    code, res = _post(c, f"{base}/robots/{rid}/control/lease", {"client_id": "test_deadman", "idempotency_key": f"k_{uuid.uuid4().hex[:8]}",
                                                               "expected_world_version": 100, "topology_revision": rev})
    assert code == 200 and res.get("accepted") is True, res
    lid, epoch = res["lease_id"], res["lease_epoch"]
    time.sleep(2.2)                                  # beyond the 1.5 s lease TTL; the engine's wall monitor ends it
    code2, res2 = _post(c, f"{base}/robots/{rid}/drive", {"lease_id": lid, "lease_epoch": epoch, "command_seq": 1, "throttle": 0.5, "steer": 0.0,
                                                          "brake": False, "duration_ms": 100, "idempotency_key": f"k_{uuid.uuid4().hex[:8]}",
                                                          "topology_revision": rev})
    assert code2 >= 400 or res2.get("accepted") is False, res2
    assert eng.control.state_of(rid) in ("SAFE_HOLD", "AUTONOMOUS"), eng.control.state_of(rid)


def test_agent_01_supervisors_graph():
    """AGENT-01: Five distinct SENTINEL supervisors (SEN-01..SEN-05) coordinate without mesh."""
    g = agent_graph("run_live", tasks=[])
    nodes = {n["id"]: n for n in g.get("nodes", [])}
    for sid in ("SEN-01", "SEN-02", "SEN-03", "SEN-04", "SEN-05"):
        assert sid in nodes, f"Supervisor {sid} missing from agent graph"
        assert any(e.get("from") == "agent:sentinel" and e.get("to") == sid for e in g.get("edges", []))


def test_rel_01_backend_autonomy_verification(topo):
    """REL-01: Backend simulation advances deterministically without frontend open."""
    from loopkeeper.engine.config import EngineConfig
    from loopkeeper.physics.plant import FacilityPlant
    from loopkeeper.storage.memory import MemoryStorage

    cfg = load_config(LARGE_CFG_PATH, overrides={"physics": {"faults": {"enabled": False}}})
    plant = FacilityPlant(seed=1, config=cfg)
    storage = MemoryStorage()
    eng_cfg = EngineConfig(facility_id="lab_01", snapshot_interval_s=60.0)
    eng = Engine(
        run_id="run_test",
        cfg=eng_cfg,
        plant=plant,
        topology=topo,
        storage=storage,
        seed=1,
    )
    t0 = eng.tick
    advanced = eng.tick_once()
    assert advanced is True
    assert eng.tick == t0 + 1, "Engine tick must advance deterministically"


NOT_COVERED_HERE = {
    "POSE-03": "restart/resume: tests/restart/test_restart_resume.py + tests/engine/test_fleet_registry.py",
    "POLICY-01": "pending (authority milestone)", "POLICY-02": "pending (authority milestone)", "POLICY-03": "pending (authority milestone)",
    "REPLAY-01": "data only: tests/restart/test_restart_resume.py::test_checkpoints_and_replay_window_for_live_run",
    "REPLAY-02": "fork not implemented (501)",
}


@pytest.fixture(scope="module", autouse=True)
def _export_results(request):
    """Write artifacts/tests/v4_acceptance_results.json from the REAL outcomes of this module (no constants)."""
    yield
    outcomes = getattr(request.config, "_v4_outcomes", {})
    tests = [{"id": k, "status": v} for k, v in sorted(outcomes.items())]
    tests += [{"id": k, "status": "NOT_COVERED_BY_THIS_FILE", "detail": v} for k, v in sorted(NOT_COVERED_HERE.items())]
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS_DIR / "v4_acceptance_results.json").write_text(json.dumps(
        {"suite": "LOOPKEEPER V4 acceptance (module-level checks)", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tests": tests}, indent=2))
