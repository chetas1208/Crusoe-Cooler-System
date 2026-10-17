"""WebSocket /api/v1/stream: snapshot-first, ordered events, since_seq resume, gap -> snapshot, auth, no secrets."""
import json
import threading

import pytest
from starlette.websockets import WebSocketDisconnect

from loopkeeper.api import create_app
from support.fixtures import TOKEN, make_settings
from loopkeeper.api.models import WorldSnapshot
from loopkeeper.api.scrub import contains_secret
from fastapi.testclient import TestClient

WS = "/api/v1/stream"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def recv(ws, n):
    return [ws.receive_json() for _ in range(n)]


def test_snapshot_first_then_ordered_monotonic_events(client, engine):
    with client.websocket_connect(f"{WS}?facility_id=lab_01&since_seq=0", headers=AUTH) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["seq"] == snap["payload"]["last_seq"] == engine.world()["last_seq"]
        WorldSnapshot.model_validate(snap["payload"])
        assert snap["run_id"] == "run_live" and snap["facility_id"] == "lab_01"
        evs = []
        for _ in range(3):
            engine.tick()
            engine.emit("heartbeat", "lab_01", {"server_ts": "x"})
        evs = recv(ws, 6)
        seqs = [e["seq"] for e in evs]
        assert seqs == list(range(snap["seq"] + 1, snap["seq"] + 7))
        assert [e["type"] for e in evs] == ["world.diff", "heartbeat"] * 3
        assert all(e["run_id"] == "run_live" for e in evs)


def test_resume_from_since_seq_replays_missed_without_snapshot(client, engine):
    head = engine.world()["last_seq"]
    for _ in range(4):
        engine.tick()
    with client.websocket_connect(f"{WS}?facility_id=lab_01&since_seq={head}", headers=AUTH) as ws:
        got = recv(ws, 4)
        assert [e["seq"] for e in got] == [head + 1, head + 2, head + 3, head + 4]
        assert all(e["type"] == "world.diff" for e in got)
        engine.tick()                                   # then live continues, contiguous
        assert ws.receive_json()["seq"] == head + 5


def test_resume_at_head_goes_straight_to_live(client, engine):
    head = engine.world()["last_seq"]
    with client.websocket_connect(f"{WS}?since_seq={head}", headers=AUTH) as ws:
        engine.tick()
        assert ws.receive_json()["seq"] == head + 1


def test_gap_when_engine_log_truncated_falls_back_to_snapshot(app, engine):
    engine.retention = 5
    engine.tick(); engine.tick(); engine.tick(); engine.tick(); engine.tick(); engine.tick()
    with TestClient(app) as c, c.websocket_connect(f"{WS}?since_seq=3", headers=AUTH) as ws:
        first = ws.receive_json()
        assert first["type"] == "snapshot" and first["seq"] == engine.world()["last_seq"]


def test_since_seq_ahead_of_head_gets_snapshot(client, engine):
    with client.websocket_connect(f"{WS}?since_seq=999999", headers=AUTH) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_snapshot_always_override(client, engine):
    head = engine.world()["last_seq"]
    with client.websocket_connect(f"{WS}?since_seq={head - 1}&snapshot=always", headers=AUTH) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_live_subscription_gap_triggers_resync_snapshot(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        engine.drop_next_n = 2                       # the engine's subscriber buffer overflowed
        engine.tick(); engine.tick()                 # seq+1, seq+2 never delivered
        engine.tick()                                # seq+3 arrives -> API detects skip
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["seq"] == engine.world()["last_seq"]
        engine.tick()
        assert ws.receive_json()["seq"] == snap["seq"] + 1


def test_unknown_facility_run_and_bad_since_are_rejected(client):
    for q, code in (("facility_id=nope", 4404), ("run_id=nope", 4404), ("since_seq=abc", 4400), ("since_seq=-1", 4400)):
        with client.websocket_connect(f"{WS}?{q}", headers=AUTH) as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == code, q


def test_stream_never_leaks_secrets_or_hidden_reasoning(client, engine):
    with client.websocket_connect(WS, headers=AUTH) as ws:
        ws.receive_json()
        engine.emit("agent.task", "t_x", {"task": {"id": "t_x", "api_key": "sk-abcdefghijklmnopqrstuvwxyz", "reasoning": "private cot",
                                                    "summary": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"}})
        ev = ws.receive_json()
        s = json.dumps(ev)
        assert "api_key" not in s and "private cot" not in s and "abcdefghijklmnopqrstuvwxyz" not in s
        assert not contains_secret(ev)


# ── auth for the handshake: never via URL ───────────────────────────────────
def test_ws_requires_auth(app):
    with TestClient(app) as c:
        with c.websocket_connect(WS) as ws:
            ws.send_json({"type": "auth", "token": "wrong-wrong-wrong-0000"})
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4401
        with c.websocket_connect(f"{WS}?token={TOKEN}") as ws:         # URL tokens are NOT honoured
            ws.send_json({"type": "noop"})
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4401


def test_ws_auth_via_first_message_and_subprotocol_and_header(app):
    with TestClient(app) as c:
        with c.websocket_connect(WS) as ws:
            ws.send_json({"type": "auth", "token": TOKEN})
            assert ws.receive_json()["type"] == "snapshot"
        with c.websocket_connect(WS, subprotocols=["loopkeeper.v1", f"bearer.{TOKEN}"]) as ws:
            assert ws.accepted_subprotocol == "loopkeeper.v1"
            assert ws.receive_json()["type"] == "snapshot"
        with c.websocket_connect(WS, headers=AUTH) as ws:
            assert ws.receive_json()["type"] == "snapshot"


def test_ws_frame_size_cap(client):
    with client.websocket_connect(WS, headers=AUTH) as ws:
        ws.receive_json()
        ws.send_text("x" * 10_000)
        with pytest.raises(WebSocketDisconnect) as e:
            while True:
                ws.receive_json()
        assert e.value.code == 1009


def test_ws_auth_disabled_dev_mode_matches_stock_frontend(engine):
    app = create_app(engine, settings=make_settings(auth_disabled=True))
    with TestClient(app) as c, c.websocket_connect(f"{WS}?facility_id=lab_01&since_seq=0") as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_two_clients_see_same_order(client, engine):
    with client.websocket_connect(WS, headers=AUTH) as a, client.websocket_connect(WS, headers=AUTH) as b:
        a.receive_json(); b.receive_json()
        for _ in range(5):
            engine.tick()
        assert [e["seq"] for e in recv(a, 5)] == [e["seq"] for e in recv(b, 5)]
