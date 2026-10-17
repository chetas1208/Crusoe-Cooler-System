"""REST wire contract: shapes the frontend (packages/core/src/client/live.ts) relies on, plus API hardening."""
import json

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from loopkeeper.api import create_app
from loopkeeper.api import models as M
from loopkeeper.api.scrub import contains_secret
from support.fixtures import OTHER, TOKEN, VIEWER, make_settings

P = "/api/v1"


def validated(model, payload):
    return TypeAdapter(model).validate_python(payload)


# ── every endpoint the frontend uses ───────────────────────────────────────
def test_topology_world_shapes_and_unset_fields_omitted(client):
    topo = client.get(f"{P}/topology").json()
    validated(M.Topology, topo)
    assert "from" in topo["edges"][0] and "from_" not in topo["edges"][0]          # alias kept
    world = client.get(f"{P}/world").json()
    validated(M.WorldSnapshot, world)
    r = next(iter(world["robots"].values()))
    assert "class" in r and "class_" not in r
    # optional TS fields are omitted (undefined), never null
    for a in world["assets"].values():
        assert "suspect" not in a or a["suspect"] is not None
    assert world["last_seq"] == client.get(f"{P}/replay?from_seq=0&limit=2000").json()["events"][-1]["seq"]


def test_incidents_trace_telemetry_replay_robots_assets(client, engine):
    incs = client.get(f"{P}/incidents").json()
    validated(list[M.Incident], incs)
    assert client.get(f"{P}/incidents?status=open").json() == [i for i in incs if not i.get("closed_tick")]
    tr = client.get(f"{P}/incidents/INC-009/trace").json()
    validated(M.IncidentTrace, tr)
    assert tr["incident_id"] == "INC-009" and tr["tasks"] and all(t["tool_calls"] for t in tr["tasks"][:1])
    assert client.get(f"{P}/incidents/NOPE/trace").status_code == 404

    engine.tick()
    ts = client.get(f"{P}/telemetry", params={"asset_id": "rack_a1", "metric": "t_chip_c", "window_s": 600}).json()
    validated(M.TelemetrySeries, ts)
    assert ts["unit"] == "°C" and ts["points"]
    assert client.get(f"{P}/telemetry?asset_id=rack_a1&metric=nope").status_code == 404

    page = client.get(f"{P}/replay?from_seq=1&limit=5").json()
    validated(M.ReplayPage, page)
    assert [e["seq"] for e in page["events"]] == [1, 2, 3, 4, 5] and page["next_seq"] == 6
    last = client.get(f"{P}/replay?from_seq=1&limit=5000").json()
    assert last["next_seq"] is None
    validated(list[M.StreamEvent], page["events"])

    validated(list[M.Robot], client.get(f"{P}/robots").json())
    validated(M.Robot, client.get(f"{P}/robots/c_01").json())
    assert client.get(f"{P}/robots/zz").status_code == 404
    a = client.get(f"{P}/assets/rack_a1").json()
    assert a["asset"]["id"] == "rack_a1" and a["state"]["status"]
    assert client.get(f"{P}/assets/p_17").json()["asset"]["label"] == "P-17"
    assert client.get(f"{P}/assets/nope").status_code == 404


def test_commands_ack_shape(client, engine):
    r = client.post(f"{P}/commands", json={"command_id": "ui_1", "kind": "set_sim_speed", "args": {"speed": 12}})
    assert r.status_code == 200 and r.json() == {"command_id": "ui_1", "accepted": True}
    validated(M.CommandAck, r.json())
    r = client.post(f"{P}/commands", json={"command_id": "ui_2", "kind": "set_sim_speed", "args": {"speed": 999}})
    assert r.json()["accepted"] is False and r.json()["reason"]
    # the exact body LiveTransport sends when target/args are undefined
    assert client.post(f"{P}/commands", json={"command_id": "ui_3", "kind": "pause"}).json()["accepted"] is True
    # idempotent by command_id: engine sees it twice, applies once (fake caches by id)
    a = client.post(f"{P}/commands", json={"command_id": "ui_3", "kind": "pause"}).json()
    assert a["accepted"] is True


def test_command_validation_errors_are_ack_shaped(client, engine):
    n = len(engine.submitted)
    for body in (
        {"command_id": "x", "kind": "launch_missiles"},
        {"command_id": "x", "kind": "approve_action"},                    # missing target
        {"command_id": "x", "kind": "set_sim_speed", "args": {"speed": "fast"}},
        {"command_id": "x", "kind": "pause", "role": "admin"},            # mass assignment
        {"command_id": "bad id!", "kind": "pause"},
        {"kind": "pause"},
    ):
        r = client.post(f"{P}/commands", json=body)
        assert r.status_code == 422, body
        j = r.json()
        assert j["accepted"] is False and j["reason"] and "command_id" in j
    assert len(engine.submitted) == n          # nothing invalid reached the engine


def test_test_commands_can_be_disabled(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings(enable_test_commands=False))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        r = c.post(f"{P}/commands", json={"command_id": "t", "kind": "test.inject_fault", "args": {"kind": "fouling"}}).json()
        assert r["accepted"] is False and "disabled" in r["reason"]


def test_errors_use_error_key_and_no_stack(client, engine, monkeypatch):
    j = client.get(f"{P}/robots/zz").json()
    err_msg = j["error"]["message"] if isinstance(j.get("error"), dict) else j.get("error")
    assert err_msg == "unknown robot"

    def boom():
        raise RuntimeError("secret internal path /srv/x password=hunter2")

    monkeypatch.setattr(engine, "topology", boom)
    from fastapi.testclient import TestClient as TC
    with TC(client.app, headers=client.headers, raise_server_exceptions=False) as c2:
        r = c2.get(f"{P}/topology")
    assert r.status_code == 500
    assert r.json()["detail"] == "internal error"
    assert "hunter2" not in r.text


# ── API never mutates ──────────────────────────────────────────────────────
def test_reads_never_submit(client, engine):
    for path in ("/topology", "/world", "/incidents", "/robots", "/runs", "/models/status", "/health/ready",
                 "/runs/run_live/world", "/runs/run_live/agents/graph", "/runs/run_live/replay", "/runs/run_live/checkpoints"):
        assert client.get(P + path).status_code == 200, path
    assert engine.submitted == []


# ── health & models truthfulness ───────────────────────────────────────────
def test_health_live_is_public_and_ready_minimal_without_auth(anon):
    assert anon.get(f"{P}/health/live").json() == {"status": "ok"}
    r = anon.get(f"{P}/health/ready")
    assert r.status_code == 200 and r.json() == {"status": "ready"}


def test_ready_with_auth_has_details_and_503_when_db_down(client, engine):
    assert client.get(f"{P}/health/ready").json()["backend"] == "mock"
    engine.set_health(database="unavailable")
    r = client.get(f"{P}/health/ready")
    assert r.status_code == 503 and "database unavailable" in r.json()["reasons"]
    engine.set_health(database="n/a", solver={"status": "failed", "residual": 1.0})
    assert client.get(f"{P}/health/ready").status_code == 503


@pytest.mark.parametrize("rt_status,eng_status,expect,online", [
    ("live", "live", "live", True),
    ("unavailable", "live", "unavailable", False),   # runtime says down -> never "online"
    ("live", "unavailable", "unavailable", False),   # engine says down -> never "online"
    ("live", "mock", "mock", False),
])
def test_models_status_is_truthful(client, engine, runtime, rt_status, eng_status, expect, online):
    runtime.status = rt_status
    engine.set_intelligence(eng_status)
    j = client.get(f"{P}/models/status").json()
    assert j["status"] == expect and j["online"] is online
    assert j["fallback_active"] is (not online)
    assert not contains_secret(j) and "api_key" not in json.dumps(j) and "sk-" not in json.dumps(j)


def test_models_status_probe_failure_is_not_online(client, engine, runtime):
    engine.set_intelligence("live")
    runtime.raises = True
    j = client.get(f"{P}/models/status").json()
    assert j["status"] == "unavailable" and j["online"] is False and "sk-" not in json.dumps(j)


# ── auth, authz, hardening ─────────────────────────────────────────────────
@pytest.mark.parametrize("path", ["/topology", "/world", "/incidents", "/robots", "/runs", "/models/status", "/replay", "/runs/run_live/world"])
def test_auth_required_on_every_non_health_route(anon, path):
    r = anon.get(P + path)
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    assert anon.post(f"{P}/commands", json={"command_id": "a", "kind": "pause"}).status_code == 401
    assert anon.get(P + path, headers={"Authorization": "Bearer wrong-token-0000000000"}).status_code == 401


def test_no_tokens_configured_fails_closed(engine):
    app = create_app(engine, settings=make_settings(api_auth_token="", api_tokens=""))
    with TestClient(app) as c:
        assert c.get(f"{P}/world").status_code == 401
        assert c.get(f"{P}/health/live").status_code == 200


def test_auth_disabled_dev_mode(engine):
    app = create_app(engine, settings=make_settings(auth_disabled=True))
    with TestClient(app) as c:                    # what the stock frontends do: no Authorization header
        assert c.get(f"{P}/world").status_code == 200


def test_viewer_cannot_command_but_can_read(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings())
    with TestClient(app, headers={"Authorization": f"Bearer {VIEWER}"}) as c:
        assert c.get(f"{P}/world").status_code == 200
        assert c.post(f"{P}/commands", json={"command_id": "v1", "kind": "pause"}).status_code == 403
    assert engine.submitted == []


def test_foreign_run_is_404_not_403(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings())
    with TestClient(app, headers={"Authorization": f"Bearer {OTHER}"}) as c:
        for path in ("/world", "/runs/run_live", "/runs/run_live/world", "/runs/run_live/robots", "/runs/run_live/replay",
                     "/runs/run_live/checkpoints", "/runs/run_live/agents/graph", "/incidents", "/robots"):
            assert c.get(P + path).status_code == 404, path
        assert c.get(f"{P}/runs").json() == []        # not even listed
        assert c.post(f"{P}/runs/run_live/robots/c_01/control/lease", json={"idempotency_key": "k" * 12}).status_code == 404
        assert c.post(f"{P}/runs/run_live/fork", json={"fork_tick": 1}).status_code == 404
    assert engine.submitted == []


def test_security_headers_and_cors(client):
    r = client.get(f"{P}/world")
    h = r.headers
    assert h["x-content-type-options"] == "nosniff" and h["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in h["content-security-policy"] and h["x-frame-options"] == "DENY"
    ok = client.options(f"{P}/world", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-credentials" not in ok.headers
    bad = client.options(f"{P}/world", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers
    assert client.get(f"{P}/world", headers={"Origin": "https://evil.example"}).headers.get("access-control-allow-origin") is None


def test_prod_cors_is_explicit_allowlist_only(engine):
    s = make_settings(env="prod", cors_origins=("https://app.example",), cors_origin_regex=None)
    with TestClient(create_app(engine, settings=s)) as c:
        h = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"}
        assert "access-control-allow-origin" not in c.options(f"{P}/world", headers=h).headers
        h["Origin"] = "https://app.example"
        assert c.options(f"{P}/world", headers=h).headers["access-control-allow-origin"] == "https://app.example"


def test_request_size_cap(client):
    big = {"command_id": "a", "kind": "pause", "args": {"x": "y" * 70_000}}
    assert client.post(f"{P}/commands", json=big).status_code == 413


def test_commands_rate_limited(engine, runtime):
    app = create_app(engine, agent_runtime=runtime, settings=make_settings(command_burst=3, command_rate_per_s=0.001))
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        codes = [c.post(f"{P}/commands", json={"command_id": f"r{i}", "kind": "pause"}).status_code for i in range(6)]
        assert codes[:3] == [200, 200, 200] and codes[3:] == [429, 429, 429]
        r = c.post(f"{P}/commands", json={"command_id": "r9", "kind": "pause"})
        assert r.headers["retry-after"]


def test_scrub_removes_secrets_and_hidden_reasoning():
    from loopkeeper.api.scrub import scrub
    ev = {"payload": {"task": {"summary": "ok", "api_key": "x", "model": {"reasoning": "cot", "tokens_in": 5},
                               "tool_calls": [{"input": {"Authorization": "Bearer abcdefghijklmnop", "note": "key sk-abcdefghijklmnopqrstuv"}}]}}}
    out = scrub(ev)
    s = json.dumps(out)
    assert "api_key" not in s and "reasoning" not in s and "abcdefghijklmnop" not in s and "sk-abcdef" not in s
    assert out["payload"]["task"]["model"]["tokens_in"] == 5
    assert not contains_secret(out)
