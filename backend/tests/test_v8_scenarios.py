from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.api import create_app
from loopkeeper.engine import create_engine
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.scenarios import DURATION_SIM_S, ORDER, list_definitions
from loopkeeper.storage.memory import MemoryStorage
from support.fixtures import TOKEN, make_settings

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def make_client(seed: int = 11) -> TestClient:
    cfg = load_config(overrides={"physics": {"faults": {"enabled": False}}})
    eng = create_engine(plant=FacilityPlant(seed=seed, config=cfg), run_id=f"run_v8_live_{seed}", seed=seed, storage=MemoryStorage())
    app = create_app(eng, settings=make_settings())
    return TestClient(app)


def test_v8_registry_has_exact_nine_and_truthful_readiness():
    defs = list_definitions()
    assert [d.scenario_id for d in defs] == list(ORDER)
    assert sum(1 for d in defs if d.severity == "SEVERE") == 7
    assert sum(1 for d in defs if d.severity == "MODERATE") == 2
    assert all(d.duration_sim_s == DURATION_SIM_S for d in defs)
    statuses = {d.scenario_id: d.supported_status for d in defs}
    assert statuses["CR-01"] == "READY"
    assert statuses["CR-02"] == "READY"
    assert statuses["CR-04"] == "READY"
    assert statuses["CR-05"] == "READY"
    assert statuses["CR-07"] == "READY"
    for d in defs:
        assert d.required_assets
        assert d.fault_injections
        assert "safe_state_rules_passed" in d.verification_metrics


def test_scenarios_api_returns_ordered_nine_and_validates_ready():
    with make_client(31) as c:
        res = c.get("/api/v1/scenarios", headers=AUTH)
        assert res.status_code == 200, res.text
        data = res.json()["scenarios"]
        assert [s["scenario_id"] for s in data] == list(ORDER)
        cr02 = next(s for s in data if s["scenario_id"] == "CR-02")
        assert cr02["readiness"]["status"] == "READY"
        assert not cr02["readiness"]["unsupported_faults"]
        val = c.post("/api/v1/scenarios/CR-07/validate", headers=AUTH)
        assert val.status_code == 200
        assert val.json()["duration_sim_s"] == 1800


def test_start_v8_episode_records_exact_30_minutes_clock_and_replay():
    with make_client(41) as c:
        req = {"scenario_id": "MD-02", "seed": 22002, "duration_sim_s": 1800, "mode": "LIVE",
               "simulation_speed": 3, "idempotency_key": "pytest-md02"}
        res = c.post("/api/v1/runs", json=req, headers=AUTH)
        assert res.status_code == 202, res.text
        run = res.json()
        assert run["scenario_id"] == "MD-02"
        assert run["kind"] == "scenario"
        assert run["state"] == "stopped"
        assert run["current_tick"] == 3600
        assert run["current_time_s"] == 1800.0
        clock = c.get(f"/api/v1/runs/{run['run_id']}/clock", headers=AUTH).json()
        assert clock["sim_elapsed_ns"] == 1_800_000_000_000
        assert clock["sim_duration_ns"] == 1_800_000_000_000
        assert clock["speed_target"] == 3
        rep = c.get(f"/api/v1/runs/{run['run_id']}/replay?start_tick=0&end_tick=3600&events=1", headers=AUTH)
        assert rep.status_code == 200, rep.text
        replay = rep.json()
        assert replay["frozen_agent_decisions"] is True
        assert replay["recorded_to_tick"] == 3600
        assert any(e["type"] == "scenario.fault_injected" for e in replay["events"])
        assert any(e["type"] == "verification.result" for e in replay["events"])


def test_cr02_manifold_rupture_leak_physics_and_recovery():
    with make_client(51) as c:
        req = {"scenario_id": "CR-02", "seed": 12002, "duration_sim_s": 1800, "mode": "LIVE",
               "simulation_speed": 3, "idempotency_key": "pytest-cr02-leak"}
        res = c.post("/api/v1/runs", json=req, headers=AUTH)
        assert res.status_code == 202, res.text
        run = res.json()
        assert run["scenario_id"] == "CR-02"
        assert run["current_tick"] == 3600
        clock = c.get(f"/api/v1/runs/{run['run_id']}/clock", headers=AUTH).json()
        assert clock["sim_elapsed_ns"] == 1_800_000_000_000

        v_res = c.get(f"/api/v1/runs/{run['run_id']}/verdict", headers=AUTH)
        assert v_res.status_code == 200, v_res.text
        verdict = v_res.json()["verdict"]
        assert verdict["outcome"] in ("VERIFIED_RECOVERY", "CONTAINED")
        assert any(chk["id"] == "solver_converged" and chk["passed"] for chk in verdict["checks"])
        assert any(chk["id"] == "thirty_minute_horizon" and chk["passed"] for chk in verdict["checks"])

        rpt = c.get(f"/api/v1/runs/{run['run_id']}/incident-report", headers=AUTH).json()
        assert rpt["duration_sim_s"] == 1800
        assert rpt["scenario_id"] == "CR-02"

        exp = c.post(f"/api/v1/runs/{run['run_id']}/exports", headers=AUTH).json()
        assert exp["scenario_id"] == "CR-02"
        assert exp["summary"]["ticks"] == 3600


def test_v8_playback_controls_and_endpoints():
    with make_client(61) as c:
        req = {"scenario_id": "MD-01", "seed": 22001, "duration_sim_s": 1800, "mode": "LIVE",
               "simulation_speed": 1, "idempotency_key": "pytest-playback-controls"}
        res = c.post("/api/v1/runs", json=req, headers=AUTH)
        assert res.status_code == 202
        run_id = res.json()["run_id"]

        sp_res = c.post(f"/api/v1/runs/{run_id}/speed", json={"speed": 2}, headers=AUTH)
        assert sp_res.status_code == 200
        assert sp_res.json()["speed"] == 2

        p_res = c.post(f"/api/v1/runs/{run_id}/pause", headers=AUTH)
        assert p_res.status_code == 200
        assert p_res.json()["state"] == "paused"

        pl_res = c.post(f"/api/v1/runs/{run_id}/play", headers=AUTH)
        assert pl_res.status_code == 200
        assert pl_res.json()["state"] == "running"

        evs = c.get(f"/api/v1/runs/{run_id}/events", headers=AUTH).json()
        assert "events" in evs

        snaps = c.get(f"/api/v1/runs/{run_id}/snapshots", headers=AUTH).json()
        assert "snapshots" in snaps


