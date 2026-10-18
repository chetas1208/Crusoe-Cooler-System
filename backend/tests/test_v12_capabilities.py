"""V12 DRV-E: truthful, live robot capabilities. Real engine (all 18 robots), real API routes, no mocks. Availability is derived from live
battery / mode / lease / mission / fitted tools, the catalog is identical for every robot of a class, and every blocked reason is plain language."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.api import create_app  # noqa: E402
from loopkeeper.engine import create_engine  # noqa: E402
from loopkeeper.engine.robots.actions import ACTIONS  # noqa: E402
from loopkeeper.engine.robots.capabilities import CATALOG, CATEGORIES, OUTRIG_TOOL_SLOTS, evaluate_fleet, evaluate_robot  # noqa: E402
from loopkeeper.physics import FacilityPlant  # noqa: E402
from loopkeeper.physics.config import load_config  # noqa: E402
from loopkeeper.storage.memory import MemoryStorage  # noqa: E402
from support.fixtures import TOKEN, make_settings  # noqa: E402

NOFAULT = {"physics": {"faults": {"enabled": False}, "workload": {"wave_amplitude": 0.0}}}
H = {"Authorization": f"Bearer {TOKEN}"}
CODE = re.compile(r"[a-z]+_[a-z_]+|[A-Z]{2,}_[A-Z_]+|\b[A-Z]{4,}\b|lease_|\b0x")        # snake_case / SHOUTING internal codes
IN_ARM = {"arm_joint_1", "arm_joint_2", "arm_joint_3", "arm_joint_4", "arm_joint_5", "arm_joint_6", "gripper", "pick", "place"}


@pytest.fixture(scope="module")
def eng():
    cfg = load_config(overrides=NOFAULT)
    return create_engine(plant=FacilityPlant(seed=3, config=cfg), run_id="run_live", seed=3, storage=MemoryStorage())


def view(e, rid: str) -> dict:
    return e.world()["robots"][rid]


def caps(e, rid: str, viewer: str | None = "api", **kw) -> dict:
    return {c["id"]: c for c in evaluate_robot(view(e, rid), viewer=viewer, **kw)["capabilities"]}


def test_all_18_robots_have_a_full_catalog(eng):
    robots = eng.world()["robots"]
    assert len(robots) == 18 and sum(r["class"] == "inpipe" for r in robots.values()) == 10
    for rid, r in robots.items():
        ev = evaluate_robot(r, viewer="api")
        assert ev["robot_id"] == rid and ev["class"] == r["class"]
        assert len(ev["capabilities"]) == len(CATALOG[r["class"]])
        assert ev["counts"]["available"] + ev["counts"]["blocked"] == len(ev["capabilities"])
        for c in ev["capabilities"]:
            assert c["category"] in CATEGORIES and c["label"] and c["how_to_trigger"] and c["command"]
            assert isinstance(c["available"], bool) and isinstance(c["params"], dict)
            assert (c["reason_if_blocked"] is None) == c["available"]


def test_spec_capability_groups_exist_per_class():
    ids = {k: {s.id for s in v} for k, v in CATALOG.items()}
    assert {"drive_pipe", "steer_junction", "camera", "ultrasonic_gauge", "brush_clean", "return_to_dock", "charge", "hold_stop"} <= ids["inpipe"]
    assert {"base_drive", "gripper", "pick", "place", "arm_home", "arm_stow", "valve_actuate", "basket", "pressure_kit", "calibration_kit",
            "return_to_dock", "charge", "hold_stop"} | {f"arm_joint_{i}" for i in range(1, 7)} <= ids["outrig"]


def test_same_class_robots_share_one_identical_catalog(eng):
    robots = eng.world()["robots"]
    by_class: dict[str, set] = {}
    for rid, r in robots.items():
        sig = tuple((c["id"], c["label"], c["category"], c["how_to_trigger"], c["command"]) for c in evaluate_robot(r, viewer="api")["capabilities"])
        by_class.setdefault(r["class"], set()).add(sig)
    assert {k: len(v) for k, v in by_class.items()} == {"inpipe": 1, "outrig": 1}


def test_same_state_same_availability_within_a_class(eng):
    """Two robots in the same live situation answer identically: only the fitted tools / own state may differ."""
    a, b = dict(view(eng, "OR-07")), dict(view(eng, "OR-08"))
    for r, n in ((a, 100.0), (b, 100.0)):
        r["battery_pct"], r["mode"], r["mission_id"] = n, "IDLE", None
    ea, eb = (evaluate_robot(x, viewer="api") for x in (a, b))
    assert [(c["id"], c["available"]) for c in ea["capabilities"]] == [(c["id"], c["available"]) for c in eb["capabilities"]]


def test_fleet_endpoint_shape_and_parity(eng):
    out = evaluate_fleet(eng.world()["robots"], viewer="api")
    assert [r["robot_id"] for r in out["robots"]][:2] == ["IR-01", "IR-02"] and len(out["robots"]) == 18
    assert set(out["catalog"]) == {"inpipe", "outrig"}
    for r in out["robots"]:
        assert [c["id"] for c in r["capabilities"]] == [c["id"] for c in out["catalog"][r["class"]]]
        assert all("params" not in c for c in r["capabilities"])


def test_battery_flips_everything_that_needs_power(eng):
    r = eng.robots["OR-07"]
    saved = (r.battery, r.mode)
    try:
        r.battery, r.mode = 80.0, "IDLE"
        ok = caps(eng, "OR-07")
        assert ok["base_drive"]["available"] and ok["arm_joint_3"]["available"] and ok["gripper"]["available"]
        r.battery = 0.0
        dead = caps(eng, "OR-07")
        for cid in ("base_drive", "arm_joint_1", "pick", "valve_actuate", "autonomous_mission", "hold_stop"):
            assert not dead[cid]["available"] and "battery" in dead[cid]["reason_if_blocked"].lower(), cid
        assert dead["return_to_dock"]["available"]            # an empty rover can still be sent home (recovery crew)
        v = view(eng, "OR-07")
        assert v["control"]["controllable"] is False and "battery" in (v["control"]["uncontrollable_reason"] or "").lower()
        r.battery = 8.0                                        # enough to drive, below the work reserve
        low = caps(eng, "OR-07")
        assert low["base_drive"]["available"] and not low["autonomous_mission"]["available"] and "low" in low["autonomous_mission"]["reason_if_blocked"]
    finally:
        r.battery, r.mode = saved


def test_dock_and_charge_follow_the_mode(eng):
    r = eng.robots["IR-06"]
    saved = (r.battery, r.mode)
    try:
        r.mode, r.battery = "DOCKED", 60.0
        c = caps(eng, "IR-06")
        assert c["charge"]["available"] and not c["return_to_dock"]["available"] and "already at its dock" in c["return_to_dock"]["reason_if_blocked"]
        r.battery = 100.0
        assert not caps(eng, "IR-06")["charge"]["available"]
        r.mode, r.battery = "IDLE", 60.0
        c = caps(eng, "IR-06")
        assert not c["charge"]["available"] and "dock" in c["charge"]["reason_if_blocked"] and c["return_to_dock"]["available"]
    finally:
        r.battery, r.mode = saved


def test_mode_and_mission_gates(eng):
    r = eng.robots["OR-08"]
    saved = (r.battery, r.mode, r.mission_id)
    try:
        r.battery, r.mode, r.mission_id = 90.0, "WORKING", None
        c = caps(eng, "OR-08")
        assert not c["base_drive"]["available"] and "repair" in c["base_drive"]["reason_if_blocked"]
        r.mode, r.mission_id = "TRAVELING", "m_1"
        c = caps(eng, "OR-08")
        assert c["base_drive"]["available"] and c["base_drive"]["params"]["takes_over_mission"] is True
        assert not c["autonomous_mission"]["available"] and "mission" in c["autonomous_mission"]["reason_if_blocked"]
        assert not c["valve_actuate"]["available"]
    finally:
        r.battery, r.mode, r.mission_id = saved


async def test_lease_held_by_someone_else_blocks_manual_not_for_the_holder(eng):
    ack = await eng.submit({"command_id": "acq_cap", "kind": "robot.control.acquire", "target_id": "OR-07",
                            "args": {"expected_world_version": 0, "idempotency_key": "i_cap", "client_id": "t", "topology_revision": "r"},
                            "actor_type": "operator", "principal": "alice"})
    assert ack["accepted"], ack
    await eng.step_ticks(3)
    try:
        theirs = caps(eng, "OR-07", viewer="bob")
        assert not theirs["base_drive"]["available"] and "alice" in theirs["base_drive"]["reason_if_blocked"]
        assert not theirs["autonomous_mission"]["available"] and "alice" in theirs["autonomous_mission"]["reason_if_blocked"]
        mine = caps(eng, "OR-07", viewer="alice")
        assert mine["base_drive"]["available"] and mine["arm_joint_1"]["available"] and mine["hold_stop"]["available"]
        assert evaluate_robot(view(eng, "OR-07"), viewer="bob")["holder"] == "alice"
    finally:
        await eng.submit({"command_id": "rel_cap", "kind": "robot.control.release", "target_id": "OR-07",
                          "args": {"lease_id": ack["lease_id"], "idempotency_key": "r_cap"}, "actor_type": "operator", "principal": "alice"})
        await eng.step_ticks(6)
    assert caps(eng, "OR-07", viewer="bob")["base_drive"]["available"] or view(eng, "OR-07")["control"]["controller_state"] != "AUTONOMOUS"


def test_tool_fit_is_read_from_the_robot_and_matches_the_action_registry(eng):
    west, east = caps(eng, "OR-01"), caps(eng, "OR-08")
    assert west["calibration_kit"]["available"] is not None
    assert "not fitted" in east["calibration_kit"]["reason_if_blocked"] and "not fitted" in west["pipe_clamp"]["reason_if_blocked"]
    for sid, _label, kw in OUTRIG_TOOL_SLOTS:
        steps = east[sid]["params"].get("mission_steps") or west[sid]["params"].get("mission_steps")
        assert steps == [a.command for a in ACTIONS.values() if a.klass == "outrig" and kw in a.tools]
    assert west["valve_actuate"]["params"]["authority"] == "L3" and west["valve_actuate"]["params"]["needs_approval"] is True
    ir_inspect, ir_brush = caps(eng, "IR-02"), caps(eng, "IR-01")      # IR-02 is the inspection-only crawler
    assert "brush" in ir_inspect["brush_clean"]["reason_if_blocked"] and "inspection-only" in ir_inspect["brush_clean"]["reason_if_blocked"]
    assert ir_brush["brush_clean"]["params"]["authority"] == "L1"


def test_arm_limits_and_state_come_from_a_published_manipulator_block(eng):
    r = dict(view(eng, "OR-07"))
    r.update(battery_pct=90.0, mode="IDLE")
    base = {c["id"]: c for c in evaluate_robot(r, viewer="api")["capabilities"]}
    assert base["arm_joint_2"]["params"]["max_rad"] == 2.0 and base["gripper"]["params"]["max_aperture_m"] == 0.07
    r["manipulator"] = {"joints": [{"name": f"j{i}", "min_rad": -1.0 * i, "max_rad": 1.0 * i} for i in range(1, 7)], "held_object_id": "cartridge",
                        "presets": ["home", "stow"], "gripper": {"max_aperture_m": 0.1}}
    live = {c["id"]: c for c in evaluate_robot(r, viewer="api")["capabilities"]}
    assert live["arm_joint_3"]["params"]["max_rad"] == 3.0 and live["gripper"]["params"]["max_aperture_m"] == 0.1
    assert live["arm_home"]["available"] and live["arm_stow"]["available"]
    assert not live["pick"]["available"] and "already holding" in live["pick"]["reason_if_blocked"] and live["place"]["available"]
    r["manipulator"]["held_object_id"] = None
    assert caps_of(r)["pick"]["available"] and "empty" in caps_of(r)["place"]["reason_if_blocked"]
    r["manipulator"].update(available=False, reason="The arm is locked out for service.")
    assert not caps_of(r)["arm_joint_1"]["available"] and caps_of(r)["base_drive"]["available"]


def caps_of(r: dict) -> dict:
    return {c["id"]: c for c in evaluate_robot(r, viewer="api")["capabilities"]}


def test_paused_simulation_blocks_driving_and_work(eng):
    r = dict(view(eng, "IR-06"))
    r.update(battery_pct=90.0, mode="IDLE")
    c = {x["id"]: x for x in evaluate_robot(r, viewer="api", sim_status="paused")["capabilities"]}
    assert not c["drive_pipe"]["available"] and "paused" in c["drive_pipe"]["reason_if_blocked"]
    assert not c["autonomous_mission"]["available"] and "paused" in c["autonomous_mission"]["reason_if_blocked"]


def test_no_internal_codes_in_any_reason_or_label(eng):
    robots = {k: dict(v) for k, v in eng.world()["robots"].items()}
    seen = set()
    states = [dict(battery_pct=0.0, mode="IDLE"), dict(battery_pct=50.0, mode="WORKING"), dict(battery_pct=50.0, mode="FAILED"),
              dict(battery_pct=50.0, mode="VERIFYING"), dict(battery_pct=8.0, mode="NEEDS_CHARGE"), dict(battery_pct=100.0, mode="DOCKED"),
              dict(battery_pct=70.0, mode="TRAVELING", mission_id="m_7"), dict(battery_pct=70.0, mode="SAFE_HOLD")]
    for r in robots.values():
        for s in states:
            for sim in ("running", "paused"):
                x = dict(r, **s)
                x["control"] = dict(r["control"], controller_state="SAFE_HOLD" if s["mode"] == "SAFE_HOLD" else "AUTONOMOUS")
                ev = evaluate_robot(x, viewer="api", sim_status=sim)
                for c in ev["capabilities"]:
                    assert not CODE.search(c["label"]) and not CODE.search(c["how_to_trigger"]), c
                for text in [c["reason_if_blocked"] for c in ev["capabilities"] if c["reason_if_blocked"]] + [ev["drive_blocked_reason"] or "x."]:
                    seen.add(text)
                    assert not CODE.search(text), text
                    assert text[:1].isupper() and text.rstrip()[-1] in ".)", text
    assert len(seen) > 20


def test_api_routes_fleet_and_single_and_unknown(eng):
    app = create_app(eng, settings=make_settings())
    with TestClient(app, headers=H) as c:
        fleet = c.get("/api/v1/robots/capabilities")                      # must not be swallowed by /robots/{robot_id}
        assert fleet.status_code == 200, fleet.text
        f = fleet.json()
        assert len(f["robots"]) == 18 and set(f["catalog"]) == {"inpipe", "outrig"} and f["run_id"]
        one = c.get("/api/v1/robots/OR-07/capabilities")
        assert one.status_code == 200 and one.json()["robot_id"] == "OR-07" and one.json()["class"] == "outrig"
        scoped = c.get("/api/v1/runs/run_live/robots/IR-01/capabilities")
        assert scoped.status_code == 200 and scoped.json()["robot_id"] == "IR-01"
        assert c.get("/api/v1/runs/run_live/robots/capabilities").status_code == 200
        assert c.get("/api/v1/robots/NOPE/capabilities").status_code == 404
        assert c.get("/api/v1/robots/OR-07").status_code == 200           # the existing route is intact
        assert TestClient(app).get("/api/v1/robots/capabilities").status_code == 401   # no token: no read
