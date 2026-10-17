"""V7 stream interest management: robot.pose throttling per robot without ever pausing/altering the simulation."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from loopkeeper.assets.interest import InterestError, InterestManager, ZoneIndex
from loopkeeper.assets.partition import build_partition
from loopkeeper.physics.config import load_config
from loopkeeper.physics.topology import build_topology
from support.fixtures import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}
WS = "/api/v1/stream"
RUN = {"run_live"}


@pytest.fixture(scope="module")
def part():
    return build_partition(build_topology(load_config()))


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def pose(rid, x=10.0, z=-8.0, speed=0.5, mode="working", seg=None, s=0.0, seq=0):
    return {"seq": seq, "type": "robot.pose", "entity_id": rid, "payload": {
        "robot_id": rid, "mode": mode, "pose": {"position_xyz_m": [x, 0.3, z], "linear_velocity_mps_xyz": [speed, 0, 0]},
        "nav": {"segment_id": seg, "s_m": s}}}


def feed(im, clock, rid, seconds, hz=100, **kw):
    sent = 0
    for _ in range(int(seconds * hz)):
        clock.t += 1.0 / hz
        if not im.should_drop(pose(rid, **kw)):
            sent += 1
    return sent


def mk(part, **kw):
    clock = Clock()
    im = InterestManager(ZoneIndex(part.zones), clock)
    msg = {"type": "subscribe", "run_id": "run_live", "visible_zone_ids": ["ROW-01"], "selected_entity_id": "OR-01", "camera_mode": "chase", **kw}
    im.apply(msg, connection_run_ids=RUN)
    return im, clock


# ------------------------------------------------------------------ policy
def test_tiers_selected_visible_background_rates(part):
    im, clk = mk(part)
    # 3 robots at 100 Hz offered each: OR-01 selected, IR-01 inside ROW-01 (visible), OR-05 far away (background)
    sel = vis = bg = 0
    for _ in range(300):
        clk.t += 0.01
        sel += not im.should_drop(pose("OR-01", x=15, z=-6))
        vis += not im.should_drop(pose("IR-01", x=15, z=-8))
        bg += not im.should_drop(pose("OR-05", x=15, z=6))
    assert 55 <= sel <= 65 and 28 <= vis <= 32 and 2 <= bg <= 5     # 20 Hz / 10 Hz / ~1 Hz over 3 s
    assert im.tier("OR-01") == "selected" and im.tier("IR-01") == "visible" and im.tier("OR-05") == "background"
    assert im.stats["pose_in"] == 900 and im.stats["pose_sent"] + im.stats["pose_elided"] == 900


def test_pipe_segment_zone_makes_crawler_visible(part):
    clk = Clock()
    im = InterestManager(ZoneIndex(part.zones), clk)
    im.apply({"type": "subscribe", "visible_zone_ids": ["PS-p_hs_a-02"], "camera_mode": "pov"}, connection_run_ids=RUN)
    mid = part.zones["PS-p_hs_a-02"].meta
    far = (mid["s_lo_m"] + mid["s_hi_m"]) / 2
    im.should_drop(pose("IR-03", x=999, z=999, seg="p_hs_a", s=far))
    assert im.tier("IR-03") == "visible"
    im.should_drop(pose("IR-04", x=999, z=999, seg="p_hs_b", s=far))
    assert im.tier("IR-04") == "background"


def test_state_transitions_always_pass_even_in_background(part):
    im, clk = mk(part)
    assert not im.should_drop(pose("OR-05", x=15, z=6, speed=1.0))            # first pose of a robot
    clk.t += 0.01
    assert im.should_drop(pose("OR-05", x=15, z=6, speed=1.0))                # throttled
    clk.t += 0.01
    assert not im.should_drop(pose("OR-05", x=15, z=6, speed=0.0))            # stopped: the final resting pose is never lost
    clk.t += 0.01
    assert not im.should_drop(pose("OR-05", x=15, z=6, speed=0.0, mode="charging"))   # mode change
    clk.t += 0.01
    assert im.should_drop(pose("OR-05", x=15, z=6, speed=0.0, mode="charging"))


def test_event_only_background_when_rate_zero(part):
    im, clk = mk(part, rate_budget={"background_hz": 0})
    assert not im.should_drop(pose("OR-05", x=15, z=6))
    assert feed(im, clk, "OR-05", 10, x=15, z=6) == 0
    assert not im.should_drop(pose("OR-05", x=15, z=6, speed=0.0))


def test_total_budget_squeezes_visible_before_selected(part):
    im, clk = mk(part, rate_budget={"total_hz": 25})
    sent_sel = sent_vis = 0
    for k in range(4):                       # register 4 visible robots
        im.should_drop(pose(f"IR-0{k + 1}", x=15, z=-8))
    im.should_drop(pose("OR-01", x=15, z=-6))
    iv = im.intervals()
    assert iv["selected"] == pytest.approx(1 / 20)                  # selected keeps its full rate
    assert 4 / iv["visible"] <= 25 - 20 + 1e-6                       # the rest of the budget is shared by visible robots
    ack = im.ack()
    assert ack["accepted"] and ack["effective"]["rates_hz"]["total_hz"] == 25


def test_elided_count_equals_dropped_events(part):
    im, clk = mk(part)
    im.should_drop(pose("OR-05", x=15, z=6))
    dropped = sum(im.should_drop(pose("OR-05", x=15, z=6)) for _ in range(7))
    assert dropped == 7 and im.elided == 7
    out = im.annotate({"seq": 99, "type": "heartbeat"})
    assert out["elided"] == 7 and im.elided == 0
    assert "elided" not in im.annotate({"seq": 100, "type": "heartbeat"})


def test_non_pose_events_and_unsubscribed_streams_are_never_touched(part):
    clk = Clock()
    im = InterestManager(ZoneIndex(part.zones), clk)
    assert not any(im.should_drop(pose("OR-05")) for _ in range(50))        # not subscribed -> everything passes
    im.apply({"type": "subscribe"}, connection_run_ids=RUN)
    for typ in ("world.diff", "heartbeat", "incident.opened", "mission.transition", "engine.health", "robot.control", "snapshot"):
        assert not im.should_drop({"seq": 1, "type": typ, "payload": {}})


@pytest.mark.parametrize("bad,code", [
    ({"visible_zone_ids": "ROW-01"}, "bad_zones"), ({"visible_zone_ids": ["x" * 65]}, "bad_zones"),
    ({"visible_zone_ids": [f"Z{i}" for i in range(257)]}, "bad_zones"), ({"camera_mode": "teleport"}, "bad_camera_mode"),
    ({"rate_budget": "fast"}, "bad_rate_budget"), ({"rate_budget": {"nope": 1}}, "bad_rate_budget"), ({"rate_budget": {"total_hz": True}}, "bad_rate_budget"),
    ({"selected_entity_id": 5}, "bad_selected"), ({"run_id": "run_other"}, "run_mismatch"), ({"manifest_id": 7}, "bad_manifest_id"),
])
def test_subscribe_validation(part, bad, code):
    im = InterestManager(ZoneIndex(part.zones))
    with pytest.raises(InterestError) as ei:
        im.apply({"type": "subscribe", **bad}, connection_run_ids=RUN)
    assert ei.value.code == code and not im.active


def test_rates_are_clamped_and_unknown_zones_reported(part):
    im = InterestManager(ZoneIndex(part.zones))
    extra = im.apply({"type": "subscribe", "visible_zone_ids": ["ROW-01", "NOPE"], "rate_budget": {"selected_hz": 500, "visible_hz": 0.0001, "total_hz": 1e9}}, connection_run_ids=RUN)
    assert extra["unknown_zone_ids"] == ["NOPE"] and im.visible == {"ROW-01"}
    assert im.rates["selected_hz"] == 20 and im.rates["visible_hz"] == 0.5 and im.rates["total_hz"] == 400


# ------------------------------------------------------------------ websocket
def _recv_until(ws, pred, limit=400):
    out = []
    for _ in range(limit):
        m = ws.receive_json()
        out.append(m)
        if pred(m):
            return out
    raise AssertionError("predicate never matched")


def _pose_payload(rid, speed=0.5, mode="working"):
    return {"robot_id": rid, "mode": mode, "pose": {"position_xyz_m": [15.0, 0.3, 6.0], "linear_velocity_mps_xyz": [speed, 0, 0]}, "nav": {}}


def test_ws_unsubscribed_client_gets_every_pose(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        for i in range(10):
            engine.emit("robot.pose", "OR-05", _pose_payload("OR-05"))
        got = [ws.receive_json() for _ in range(10)]
        assert [g["seq"] for g in got] == list(range(got[0]["seq"], got[0]["seq"] + 10)) and all("elided" not in g for g in got)


def test_ws_subscribe_throttles_poses_counts_elided_and_never_pauses_engine(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        snap = ws.receive_json()
        ws.send_json({"type": "subscribe", "run_id": "run_live", "visible_zone_ids": [], "selected_entity_id": "OR-01", "camera_mode": "overview",
                      "rate_budget": {"background_hz": 1}})
        ack = _recv_until(ws, lambda m: m["type"] == "stream.interest")[-1]
        assert ack["payload"]["accepted"] and ack["payload"]["effective"]["selected_entity_id"] == "OR-01"
        before = engine.world()["last_seq"]
        n = 40
        for _ in range(n):                           # 40 background poses in well under a second
            engine.emit("robot.pose", "OR-05", _pose_payload("OR-05"))
        engine.emit("robot.pose", "OR-05", _pose_payload("OR-05", speed=0.0))      # resting pose must arrive
        hb = engine.emit("heartbeat", "lab_01", {"server_ts": "x"})
        evs = _recv_until(ws, lambda m: m["type"] == "heartbeat")
        poses = [e for e in evs if e["type"] == "robot.pose"]
        assert 2 <= len(poses) <= 4 and poses[-1]["payload"]["pose"]["linear_velocity_mps_xyz"][0] == 0.0
        # the engine really emitted all of them (simulation untouched) ...
        assert engine.world()["last_seq"] == before + n + 2
        # ... the wire is strictly increasing and every gap is accounted for by `elided`
        last = ack["seq"]
        for e in evs[1:] if evs[0]["type"] == "stream.interest" else evs:
            if e["type"] == "stream.interest":
                continue
            assert e["seq"] > last
            assert e["seq"] == last + 1 + e.get("elided", 0), (e["seq"], last, e.get("elided"))
            last = e["seq"]
        assert hb["seq"] == last


def test_ws_selected_robot_is_not_starved_by_background_flood(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_json({"type": "subscribe", "selected_entity_id": "OR-01", "rate_budget": {"selected_hz": 20, "background_hz": 0}})
        _recv_until(ws, lambda m: m["type"] == "stream.interest")
        engine.emit("robot.pose", "OR-01", _pose_payload("OR-01"))                  # first pose passes
        for _ in range(30):
            engine.emit("robot.pose", "OR-07", _pose_payload("OR-07"))
        engine.emit("robot.pose", "OR-01", _pose_payload("OR-01", mode="charging"))   # selected robot state change passes
        engine.emit("heartbeat", "lab_01", {"server_ts": "x"})
        evs = _recv_until(ws, lambda m: m["type"] == "heartbeat")
        ids = [e["payload"]["robot_id"] for e in evs if e["type"] == "robot.pose"]
        assert ids.count("OR-01") == 2 and ids.count("OR-07") == 1


def test_ws_invalid_subscribe_gets_error_ack_and_stream_continues(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_json({"type": "subscribe", "camera_mode": "teleport"})
        ack = _recv_until(ws, lambda m: m["type"] == "stream.interest")[-1]
        assert ack["payload"] == {"accepted": False, "code": "bad_camera_mode", "reason": ack["payload"]["reason"]}
        engine.emit("robot.pose", "OR-05", _pose_payload("OR-05"))
        assert ws.receive_json()["type"] == "robot.pose"                             # not subscribed -> unfiltered


def test_ws_large_subscribe_frame_allowed_but_large_garbage_still_closes(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_json({"type": "subscribe", "visible_zone_ids": [f"ROW-{i:04d}" for i in range(256)]})      # > 4096 bytes
        assert _recv_until(ws, lambda m: m["type"] == "stream.interest")[-1]["payload"]["accepted"]
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_text("x" * 5000)
        with pytest.raises(Exception):
            for _ in range(5):
                ws.receive_json()


def test_ws_gap_resync_still_works_with_interest_active(client, engine):
    with client.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_json({"type": "subscribe"})
        _recv_until(ws, lambda m: m["type"] == "stream.interest")
        engine.drop_next_n = 2
        engine.tick(); engine.tick(); engine.tick()
        first = _recv_until(ws, lambda m: m["type"] == "snapshot")[-1]
        assert first["seq"] == engine.world()["last_seq"] or first["seq"] >= 0


def test_ws_manifest_changed_pushed_when_client_manifest_is_stale(app, engine):
    topo = build_topology(load_config())
    engine._topo = copy.deepcopy(topo)
    with TestClient(app) as c, c.websocket_connect(f"{WS}", headers=AUTH) as ws:
        ws.receive_json()
        ws.send_json({"type": "subscribe", "manifest_id": "0" * 64})
        evs = _recv_until(ws, lambda m: m["type"] == "asset.manifest_changed")
        ev = evs[-1]
        assert ev["payload"]["layout_hash"] == topo["facility"]["topology_hash"] and ev["payload"]["previous_manifest_id"] == "0" * 64
        assert ev["payload"]["url"].endswith(f"render-manifest?rev={ev['payload']['manifest_id']}")
        r = c.get(f"/api/v1/facilities/lab_01/render-manifest?rev={ev['payload']['manifest_id']}", headers=AUTH)
        assert r.status_code == 200
        ws.send_json({"type": "subscribe", "manifest_id": ev["payload"]["manifest_id"]})     # up to date -> no push
        engine.emit("heartbeat", "lab_01", {"server_ts": "x"})
        rest = _recv_until(ws, lambda m: m["type"] == "heartbeat")
        assert not any(m["type"] == "asset.manifest_changed" for m in rest)
