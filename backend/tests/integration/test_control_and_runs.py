"""Run-scoped routes: control lease (happy path + deadman), drive, replay read-only, fork, scenarios, authz."""
import uuid

import pytest
from fastapi.testclient import TestClient

from loopkeeper.api import create_app
from support.fixtures import OTHER, TOKEN, VIEWER, make_settings

P = "/api/v1"
R = f"{P}/runs/run_live"
ROBOT = "c_01"


def key() -> str:
    return uuid.uuid4().hex


def lease(client, robot=ROBOT, **kw):
    body = {"idempotency_key": key(), "expected_world_version": 1800, "client_id": "test_client", "topology_revision": "r1"}
    body.update(kw)
    return client.post(f"{R}/robots/{robot}/control/lease", json=body)


def drive_body(lease_id, seq=1, lease_epoch=1, **kw):
    body = {"lease_id": lease_id, "lease_epoch": lease_epoch, "command_seq": seq, "idempotency_key": key(), "topology_revision": "r1",
            "throttle": 0.5, "steer": 0.0, "brake": False, "duration_ms": 100}
    body.update(kw)
    return body


def test_lease_happy_path_drive_heartbeat_release(client, engine):
    g = lease(client)
    assert g.status_code == 200, g.text
    grant = g.json()
    assert grant["accepted"] is True and uuid.UUID(grant["lease_id"]).version == 4
    assert grant["robot_id"] == ROBOT and grant["heartbeat_interval_ms"] > 0
    assert "principal" not in grant
    cmd = engine.submitted[-1]
    assert cmd["kind"] == "robot.control.acquire" and cmd["actor_type"] == "operator" and cmd["run_id"] == "run_live"
    assert uuid.UUID(cmd["command_id"]).version == 4                      # server-minted UUIDv4

    before = engine.world()["robots"][ROBOT]["pose"]["s_m"]
    d = client.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(grant["lease_id"], seq=1, lease_epoch=grant["lease_epoch"]))
    assert d.status_code == 200 and d.json()["accepted"] is True
    assert engine.world()["robots"][ROBOT]["pose"]["s_m"] > before          # only the engine moved the robot
    hb = client.post(f"{R}/robots/{ROBOT}/control/heartbeat", json={"lease_id": grant["lease_id"], "lease_epoch": grant["lease_epoch"]})
    assert hb.status_code == 200 and hb.json()["accepted"]
    rel = client.post(f"{R}/robots/{ROBOT}/control/release", json={"lease_id": grant["lease_id"], "lease_epoch": grant["lease_epoch"], "idempotency_key": key(), "reason": "operator_release"})
    assert rel.status_code == 200 and rel.json()["accepted"] is True
    # after release the lease is dead
    assert client.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(grant["lease_id"], seq=2, lease_epoch=grant["lease_epoch"])).status_code == 403


def test_lease_idempotency_key_reuses_server_command_id(client, engine):
    k = key()
    a = lease(client, idempotency_key=k).json()
    b = lease(client, idempotency_key=k).json()
    assert a["command_id"] == b["command_id"] and a["lease_id"] == b["lease_id"]       # engine dedupes by command_id


def test_deadman_expires_lease_and_safe_holds(client, engine):
    grant = lease(client).json()
    ok = client.post(f"{R}/robots/{ROBOT}/control/heartbeat", json={"lease_id": grant["lease_id"], "lease_epoch": grant["lease_epoch"]})
    assert ok.status_code == 200
    engine.advance(grant["deadman_ms"] / 1000 + 0.1)                                    # missed heartbeats
    assert engine.world()["robots"][ROBOT]["mode"] == "SAFE_HOLD"
    d = client.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(grant["lease_id"], seq=2, lease_epoch=grant["lease_epoch"]))
    assert d.status_code == 403 and d.json()["accepted"] is False
    ev = [e for e in engine.events_since(0) if e["type"] == "robot.control"]
    assert ev[-1]["payload"]["reason"] == "deadman_timeout"


def test_deadman_event_reaches_ws_subscribers(client, engine):
    grant = lease(client).json()
    with client.websocket_connect("/api/v1/stream?facility_id=lab_01&since_seq=0", headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
        ws.receive_json()
        engine.advance(grant["deadman_ms"] / 1000 + 0.1)
        got = [ws.receive_json(), ws.receive_json()]
        assert got[0]["type"] == "robot.control" and got[0]["payload"]["reason"] == "deadman_timeout"
        assert got[1]["type"] == "robot.pose" and got[1]["payload"]["mode"] == "SAFE_HOLD"


def test_conflicting_lease_is_refused_with_reason(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings(api_tokens=f"{OTHER}:other:operator,{VIEWER}:v:viewer"))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as a, TestClient(app, headers={"Authorization": f"Bearer {OTHER}"}) as b:
        assert lease(a).status_code == 200
        r = lease(b)
        assert r.status_code == 409 and r.json()["accepted"] is False and "manual control" in r.json()["reason"]


def test_other_principal_cannot_drive_or_release_a_lease(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings(api_tokens=f"{OTHER}:other:operator"))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as a, TestClient(app, headers={"Authorization": f"Bearer {OTHER}"}) as b:
        grant = lease(b).json()
        # TOKEN is the admin; a plain operator that is not the holder must be blocked
    app2 = create_app(engine, agent_runtime=runtime, settings=make_settings(api_auth_token="", api_tokens=f"{TOKEN}:op1:operator,{OTHER}:op2:operator"))
    with TestClient(app2, headers={"Authorization": f"Bearer {TOKEN}"}) as a, TestClient(app2, headers={"Authorization": f"Bearer {OTHER}"}) as b:
        engine._leases.clear()
        g = lease(a).json()
        assert b.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(g["lease_id"], lease_epoch=g["lease_epoch"])).status_code == 403
        assert b.post(f"{R}/robots/{ROBOT}/control/release", json={"lease_id": g["lease_id"], "lease_epoch": g["lease_epoch"], "idempotency_key": key()}).status_code == 403


def test_non_crawler_and_unknown_robot_refused(client):
    r = lease(client, robot="o_01")
    assert r.status_code == 409 and "not drivable" in r.json()["reason"]
    assert lease(client, robot="zz").status_code == 404


def test_drive_body_validation_is_shape_only_and_strict(client, engine):
    grant = lease(client).json()
    ep = grant["lease_epoch"]
    n = len(engine.submitted)
    bad = [drive_body(grant["lease_id"], lease_epoch=ep, throttle=2), drive_body(grant["lease_id"], lease_epoch=ep, duration_ms=5),
           drive_body(grant["lease_id"], lease_epoch=ep, duration_ms=900), drive_body(grant["lease_id"], lease_epoch=ep, seq=0),
           {**drive_body(grant["lease_id"], lease_epoch=ep), "speed_override": 9}, {**drive_body(grant["lease_id"], lease_epoch=ep), "lease_id": "x"}]
    for b in bad:
        assert client.post(f"{R}/robots/{ROBOT}/drive", json=b).status_code == 422
    assert len(engine.submitted) == n


def test_viewer_cannot_take_control(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings())
    with TestClient(app, headers={"Authorization": f"Bearer {VIEWER}"}) as c:
        assert lease(c).status_code == 403
    assert engine.submitted == []


def test_drive_is_rate_limited(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings(drive_burst=2, drive_rate_per_s=0.001))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        g = lease(c).json()       # consumes 1
        assert c.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(g["lease_id"], seq=1, lease_epoch=g["lease_epoch"])).status_code == 200   # 2
        assert c.post(f"{R}/robots/{ROBOT}/drive", json=drive_body(g["lease_id"], seq=2, lease_epoch=g["lease_epoch"])).status_code == 429


# ── runs / replay / fork / scenarios ────────────────────────────────────────
def test_runs_list_get_and_legacy_alias_equivalence(client):
    runs = client.get(f"{P}/runs").json()
    assert [r["run_id"] for r in runs] == ["run_live"] and runs[0]["mode"] == "LIVE"
    assert client.get(f"{R}").json()["run_id"] == "run_live"
    assert client.get(f"{R}/world").json() == client.get(f"{P}/world").json()
    assert client.get(f"{R}/robots").json() == client.get(f"{P}/robots").json()
    assert client.get(f"{R}/incidents/INC-009/trace").json() == client.get(f"{P}/incidents/INC-009/trace").json()
    assert client.get(f"{P}/runs/nope/world").status_code == 404


def test_agents_graph_dag(client):
    g = client.get(f"{R}/agents/graph").json()
    ids = {n["id"] for n in g["nodes"]}
    assert {"agent:sentinel", "agent:inpipe", "agent:outrig"} <= ids and g["task_count"] > 0
    assert all(e["from"] in ids and e["to"] in ids for e in g["edges"])
    assert any(e["type"] == "parent" for e in g["edges"])


def test_run_replay_is_read_only_window(client, engine):
    n = len(engine.submitted)
    ticks = sorted({e["sim_tick"] for e in engine.events_since(0)})
    lo, hi = ticks[1], ticks[3]
    r = client.get(f"{R}/replay", params={"start_tick": lo, "end_tick": hi, "limit": 1000}).json()
    assert r["run_id"] == "run_live" and r["frozen_agent_decisions"] is True and r["events"]
    assert all(lo <= e["sim_tick"] <= hi for e in r["events"])
    seqs = [e["seq"] for e in r["events"]]
    assert seqs == sorted(seqs)
    assert len(engine.submitted) == n


def test_checkpoints_honest_when_engine_has_none(client):
    j = client.get(f"{R}/checkpoints?to_tick=100").json()
    assert j["checkpoints"] == [] and j["schema_version"] == "lk.runs.v1"


def test_fork_and_create_run_unsupported_by_live_only_engine(client, engine):
    fork_body = {"fork_tick": 10, "expected_parent_hash": "hash123", "chosen_snapshot_id": "snap_1"}
    r = client.post(f"{R}/fork", json=fork_body)
    assert r.status_code == 501 and "fork" in r.json()["error"]["message"]
    spec = valid_spec(scenario_id="sc_unsupp", title="t", faults=[])
    assert client.post(f"{P}/runs", json=spec).status_code == 501
    assert client.post(f"{R}/fork", json={**fork_body, "evil": 1}).status_code == 422
    assert engine.submitted == []


def valid_spec(**kw):
    s = {
        "scenario_id": "sc_01",
        "title": "fouling drill",
        "faults": [{"kind": "fouling", "target_id": "p_17", "onset_tick": 60, "severity": 0.5, "progression_s": 10}],
        "seed": 7,
        "workload_factor": 1.0,
        "sim_speed": 1.0,
        "agent_policy": "autonomous",
        "approval_window_s": 60.0,
        "background_faults": False,
    }
    s.update(kw)
    return s


def test_scenario_validate_never_touches_world(client, engine):
    spec = valid_spec()
    j = client.post(f"{P}/scenarios/validate", json={"spec": spec}).json()
    assert j["valid"] is True and j["spec"]["seed"] == 7
    bad = dict(spec, faults=[{"kind": "fouling", "target_id": "p_17", "onset_tick": 5_000_000, "severity": 0.5, "progression_s": 10}])
    j = client.post(f"{P}/scenarios/validate", json={"spec": bad}).json()
    assert j["valid"] is False and any("less than or equal to" in e["message"] for e in j["issues"])
    j_invalid = client.post(f"{P}/scenarios/validate", json={"spec": {**spec, "faults": [{"kind": "meteor", "target_id": "p_17", "onset_tick": 1, "severity": 0.5, "progression_s": 10}]}}).json()
    assert j_invalid["valid"] is False and any("faults.0.kind" in i["path"] for i in j_invalid["issues"])
    assert client.post(f"{P}/scenarios/validate", json={"spec": spec, "text": "x"}).status_code == 422
    assert client.post(f"{P}/scenarios/validate", json={}).status_code == 422
    assert client.post(f"{P}/scenarios/validate", json={"text": "kill pump"}).json()["valid"] is False
    assert engine.submitted == []


def make_run_summary(rid: str, mode: str = "LIVE", state: str = "running", parent: str | None = None, fork_tick: float | None = None):
    return {
        "run_id": rid,
        "label": f"Run {rid}",
        "kind": "baseline" if not parent else "fork",
        "mode": mode,
        "state": state,
        "parent_run_id": parent,
        "fork_tick": fork_tick,
        "fork_snapshot_id": None,
        "scenario_id": None,
        "facility_id": "lab_01",
        "seed": 42,
        "topology_hash": "topohash",
        "schema_version": "lk.runs.v1",
        "engine": {"backend": "mock", "build": "test"},
        "created_at": "2026-10-16T00:00:00Z",
        "current_tick": 100,
        "current_time_s": 50.0,
        "first_tick": 0,
        "recording": {"frames": 0, "checkpoints": 0, "events": 0, "commands": 0, "approx_bytes": 0},
        "incidents": {"opened": 0, "resolved": 0},
        "children": [],
        "head_hash": None,
    }


class FakeRuns:
    """RunManager double with a REPLAY run and fork support (what package B will provide)."""
    active_run_id = "run_live"

    def __init__(self, engine):
        self.e = engine

    def list_runs(self):
        return [make_run_summary("run_live", "LIVE", "running"),
                make_run_summary("run_past", "FORK", "stopped")]

    def get_run(self, rid):
        return next((r for r in self.list_runs() if r["run_id"] == rid), None)

    def engine_for(self, rid):
        return self.e if rid in ("run_live", "run_past") else None

    def checkpoints(self, rid, to_tick):
        return [{
            "snapshot_id": "cp_1",
            "run_id": rid,
            "tick": 100,
            "sim_time_s": 50.0,
            "hash": "h_1",
            "hash_algo": "sha256",
            "schema_version": "lk.runs.v1",
            "compatible": True,
        }]

    async def replay(self, rid, start_tick=None, end_tick=None, stride=1, include_events=True, limit=1000):
        return {
            "run_id": rid,
            "schema_version": "lk.runs.v1",
            "start_tick": start_tick or 0,
            "end_tick": end_tick or 100,
            "stride": stride,
            "recorded_from_tick": 0,
            "recorded_to_tick": 100,
            "frames": [],
            "events": [],
            "commands": [],
            "checkpoints": [],
            "gaps": [],
            "frozen_agent_decisions": True,
        }

    async def create_run(self, spec, principal):
        return make_run_summary("run_new", "LIVE", "running")

    async def fork(self, rid, req, principal):
        return {
            "run": make_run_summary("run_fork", "FORK", "running", parent=rid, fork_tick=req["fork_tick"]),
            "parent_run_id": rid,
            "fork_tick": req["fork_tick"],
            "parent_hash_before": "hash_before",
            "parent_hash_after": "hash_after",
            "restored_hash": "hash_restored",
            "rng": {"stream": "new", "note": "seeded"},
        }


def test_replay_run_is_read_only_but_forkable(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, run_manager=FakeRuns(engine), settings=make_settings())
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        past = f"{P}/runs/run_past"
        assert c.get(f"{past}/world").status_code == 200
        r = c.post(f"{past}/commands", json={"command_id": "z1", "kind": "pause"})
        assert r.status_code == 409 and "fork" in r.json()["error"]["message"]
        r = c.post(f"{past}/robots/{ROBOT}/control/lease", json={"idempotency_key": key(), "expected_world_version": 1800, "client_id": "test_client", "topology_revision": "r1"})
        assert r.status_code == 403 and r.json()["code"] == "replay_readonly"
        assert engine.submitted == []
        f = c.post(f"{past}/fork", json={"fork_tick": 100, "expected_parent_hash": "abc", "chosen_snapshot_id": "cp_1"})
        assert f.status_code == 201 and f.json()["parent_run_id"] == "run_past" and f.json()["run"]["mode"] == "FORK"
        assert c.post(f"{P}/runs", json=valid_spec()).status_code == 202
        assert c.get(f"{past}/checkpoints").json()["checkpoints"][0]["snapshot_id"] == "cp_1"


def test_only_admin_creates_runs(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, run_manager=FakeRuns(engine),
                     settings=make_settings(api_tokens=f"{OTHER}:op:operator"))
    with TestClient(app, headers={"Authorization": f"Bearer {OTHER}"}) as c:
        assert c.post(f"{P}/runs", json=valid_spec()).status_code == 403
