"""The MuJoCo manipulation cell is a real service bay of the facility: anchored at the strainer service pose, bound to ONE leased OUTRIG at a time,
driven by the ENGINE's rover pose, and published in the facility frame. No test here sets a pose directly except to compare."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.engine import create_engine
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage

CART = "STRAINER-CARTRIDGE-01"


def _engine(seed=3):
    c = load_config(overrides={"physics": {"faults": {"enabled": False}}})
    return create_engine(plant=FacilityPlant(seed=seed, config=c), run_id="run_workcell", seed=seed, storage=MemoryStorage())


class Op:
    """A tiny operator: lease + drive intents through the real command bus."""
    def __init__(self, eng, rid):
        self.eng, self.rid, self.seq, self.lease = eng, rid, 0, None

    async def acquire(self):
        w = self.eng.world()
        ack = await self.eng.submit({"command_id": f"acq_{self.rid}", "kind": "robot.control.acquire", "target_id": self.rid,
                                     "args": {"expected_world_version": w["version"], "idempotency_key": f"idem_acq_{self.rid}", "client_id": "t",
                                              "topology_revision": "r1"}, "actor_type": "operator", "principal": "op1"})
        assert ack["accepted"], ack
        self.lease = ack
        await self.eng.step_ticks(4)

    async def cmd(self, **args):
        self.seq += 1
        base = {"lease_id": self.lease["lease_id"], "lease_epoch": self.lease["lease_epoch"], "command_seq": self.seq, "throttle": 0.0, "steer": 0.0,
                "brake": False, "duration_ms": 250, "idempotency_key": f"idem_{self.rid}_{self.seq}", "topology_revision": self.lease["topology_revision"]}
        base.update(args)
        ack = await self.eng.submit({"command_id": f"c_{self.rid}_{self.seq}", "kind": "robot.drive", "target_id": self.rid, "args": base,
                                     "actor_type": "operator", "principal": "op1"})
        assert ack["accepted"], ack
        return ack.get("manipulation", {})


async def _goto_bay(eng, rid):
    ack = await eng.submit({"command_id": f"go_{rid}", "kind": "robot.mission.assign", "target_id": rid,
                            "args": {"robot_id": rid, "kind": "service", "target_id": "strainer_01", "title": "go to the strainer bay",
                                     "steps": [{"command": "navigate", "args": {"target_id": "strainer_01"}}]},
                            "actor_type": "operator", "principal": "op1"})
    assert ack["accepted"], ack
    for _ in range(900):
        await eng.step_ticks(1)
        if eng.robots[rid].active is None and eng.missions.active_mission(rid) is None:
            break
    await eng.step_ticks(8)                                                       # turn in place to face the work
    r = eng.robots[rid]
    svc = eng.asset_index["strainer_01"]["service_xyz_m"]
    assert math.hypot(r.pos[0] - svc[0], r.pos[2] - svc[2]) < 0.5, f"{rid} did not reach the strainer bay: {r.pos} vs {svc}"


async def _arm_to(eng, local_xyz, ticks=6):
    rt = eng.mujoco_runtime
    q = rt.solve_arm_ik(list(local_xyz))
    assert q is not None, f"IK cannot reach {local_xyz} from base {rt.base_pos}"
    rt.set_arm_pose(q)
    await eng.step_ticks(ticks)


def test_cell_frame_is_a_rigid_facility_transform():
    eng = _engine()
    rt = eng.mujoco_runtime
    bay = eng.asset_index["strainer_01"]["service_xyz_m"]
    p0 = rt.to_facility_point([12.0, 2.0, 0.15])                                  # the cell's base start sits next to the strainer service pose
    assert math.dist((p0[0], p0[2]), (bay[0], bay[2])) < 0.3 and abs(p0[1] - 0.15) < 1e-9
    a, b = rt.to_facility_point([12.0, 2.0, 0.0]), rt.to_facility_point([13.0, 2.0, 0.0])
    assert abs(math.dist(a, b) - 1.0) < 1e-9 and b[0] > a[0] and abs(b[2] - a[2]) < 1e-9      # local x -> facility +x
    c = rt.to_facility_point([12.0, 3.0, 0.0])
    assert c[2] < a[2] and abs(math.dist(a, c) - 1.0) < 1e-9                                  # local y -> facility -z (right-handed)
    assert rt.to_facility_point([12.0, 2.0, 1.0])[1] == 1.0                                   # local z (up) -> facility y (up)
    mx, my = rt.to_local_planar(a[0] + 0.3, a[2] - 0.2)
    assert abs(mx - 12.3) < 1e-9 and abs(my - 2.2) < 1e-9                                      # round trip
    rt.set_anchor(5.0, -3.0, 0.7)
    p, q = rt.to_facility_point([12.5, 2.5, 0.2]), rt.to_facility_point([13.5, 2.5, 0.2])
    assert abs(math.dist(p, q) - 1.0) < 1e-9
    qy = rt.to_facility_quat([0.0, 0.0, math.sin(0.3), math.cos(0.3)])                        # a yaw about the cell's up axis = about facility +y
    assert abs(qy[0]) < 1e-6 and abs(qy[2]) < 1e-6 and abs(math.hypot(qy[1], qy[3]) - 1.0) < 1e-4


@pytest.mark.asyncio
async def test_workcell_is_a_facility_bay_followed_by_the_engine_rover_and_one_owner_at_a_time():
    eng = _engine()
    await eng.step_ticks(6)
    rt = eng.mujoco_runtime
    ax, az = rt.anchor_xz

    # published objects are in the facility frame, at the bay
    w = eng.world()
    cart = w["rigid_objects"][CART]
    assert cart["frame_id"] == "facility_world" and math.hypot(cart["pos_xyz"][0] - (ax + 0.45), cart["pos_xyz"][2] - az) < 0.05
    assert cart["pos_xyz"][1] < 0.08
    fx = next(iter(w["mechanical_fixtures"].values()))
    assert math.hypot(fx["pos_xyz"][0] - (ax + 2.2), fx["pos_xyz"][2] - (az + 0.2)) < 0.05
    assert not any("arm_qpos_rad" in r for r in w["robots"].values())            # nobody owns an arm yet: no arm data is invented

    # crawlers have no arm
    ir = Op(eng, "IR-01")
    await ir.acquire()
    ack = await ir.cmd(joint_idx=1, delta_rad=0.1)
    assert "no_manipulator" in ack["rejected"]["reason"] and eng.workcell_owner is None

    # OR-03 drives itself to the bay by the real nav/traffic code, then an operator takes the lease
    await _goto_bay(eng, "OR-03")
    op = Op(eng, "OR-03")
    await op.acquire()

    # 1. out of reach (arm at rest): refused by contact physics
    ack = await op.cmd(action="pick")
    assert eng.workcell_owner == "OR-03"
    assert ack["pick"]["ok"] is False and "too far" in ack["pick"]["message"].lower() and rt.held_object_id is None
    r3 = eng.world()["robots"]["OR-03"]
    assert "arm_qpos_rad" in r3 and len(r3["arm_qpos_rad"]) == 6

    # 2. approach in stages and grasp: held comes from measured pad forces
    c_loc = list(rt.cartridge_state.pos_xyz)
    await op.cmd(gripper_aperture=0.07)
    for h in (0.35, 0.25, 0.15, 0.08, 0.012):
        await _arm_to(eng, [c_loc[0], c_loc[1], c_loc[2] + h], ticks=5)
    ack = await op.cmd(action="pick")
    assert ack["pick"]["ok"] is True, ack
    assert rt.held_object_id == CART and rt.finger_force_N["left"] > 1.0 and rt.finger_force_N["right"] > 1.0
    w = eng.world()
    ee = w["robots"]["OR-03"]["end_effector_pose"]["pos_xyz"]
    obj = w["rigid_objects"][CART]["pos_xyz"]
    rover = eng.robots["OR-03"].pos
    assert math.dist(ee, obj) < 0.08, f"end effector {ee} and payload {obj} disagree in the facility frame"
    assert math.dist((ee[0], ee[2]), (rover[0], rover[2])) < 1.3                  # the arm is on the rover

    # 3. a second rover gets the OTHER bay (two mechanical bays exist) and never takes the cell whose gripper is holding a payload
    op4 = Op(eng, "OR-04")
    await op4.acquire()
    ack4 = await op4.cmd(gripper_aperture=0.0)
    assert "rejected" not in ack4
    assert eng.bays["strainer_01"].owner == "OR-03" and eng.bays["strainer_02"].owner == "OR-04"
    assert eng.bays["strainer_01"].held_object_id == CART                          # OR-03's payload is untouched
    # a third rover finds no free bay with an empty gripper only if both are held: a rover already holding a payload is refused a second bay
    ok, why = eng.claim_workcell("OR-03", "strainer_02")
    assert not ok and ("hands_full" in why or "workcell_busy" in why)

    # 4. lift, then drive the rover (engine kinematics): the payload travels with it by pad friction
    c = list(rt.cartridge_state.pos_xyz)
    await _arm_to(eng, [c[0], c[1], 0.50], ticks=8)
    assert rt.held_object_id == CART and rt.cartridge_state.pos_xyz[2] > 0.35
    start_obj = list(eng.world()["rigid_objects"][CART]["pos_xyz"])
    start_rover = list(eng.robots["OR-03"].pos)
    for _ in range(12):
        await op.cmd(throttle=-0.5)
        await eng.step_ticks(2)
    r = eng.robots["OR-03"]
    moved = math.dist((r.pos[0], r.pos[2]), (start_rover[0], start_rover[2]))
    assert moved > 0.10, "the rover did not move under manual drive"
    now_obj = eng.world()["rigid_objects"][CART]["pos_xyz"]
    obj_move = math.dist((now_obj[0], now_obj[2]), (start_obj[0], start_obj[2]))
    assert rt.held_object_id == CART, "payload was lost while driving"
    assert abs(obj_move - moved) < 0.15, f"payload moved {obj_move:.2f} m but the rover moved {moved:.2f} m"
    assert eng.nav.in_obstacle(r.pos[0], r.pos[2]) is None

    # 5. releasing early drops it under gravity; it is not on the fixture seat, so no plant repair is committed
    occ = eng.plant.faults.occl.get("strainer_01", 0.0)
    ack = await op.cmd(action="place")
    assert ack["place"]["ok"] is True and ack["place"]["cartridge_seated"] is False
    await eng.step_ticks(4)
    end = eng.world()["rigid_objects"][CART]["pos_xyz"]
    assert end[1] < 0.07 and rt.held_object_id is None
    assert "plant_effect" not in ack and eng.plant.faults.occl.get("strainer_01", 0.0) == occ


@pytest.mark.asyncio
async def test_crawler_cleaning_targets_its_own_segment_and_reports_the_plant_result():
    eng = _engine()
    await eng.step_ticks(4)
    ir = Op(eng, "IR-01")
    await ir.acquire()
    seg = eng.robots["IR-01"].segment_id
    assert seg in eng.graph.edges
    ack = await ir.cmd(action="clean_deposit")
    assert ack["deposit_cleaning"]["segment_id"] == seg                            # not a hard-coded p_trunk (which does not exist in V6)
    for _ in range(8):
        ack = await ir.cmd(action="clean_deposit")
    assert ack["plant_effect"]["ok"] is True
    op = Op(eng, "OR-05")
    await op.acquire()
    assert "no_brush" in (await op.cmd(action="clean_deposit"))["rejected"]["reason"]


@pytest.mark.asyncio
async def test_workcell_state_survives_snapshot_restore_mid_grasp():
    """Restart/fork mid-grasp: the snapshot carries the MuJoCo state (qpos/qvel, gripper, held payload), the restored engine holds the same payload,
    has the same state hash, and continues identically (same cartridge pose after more ticks)."""
    import json
    eng = _engine()
    await eng.step_ticks(6)
    await _goto_bay(eng, "OR-03")
    op = Op(eng, "OR-03")
    await op.acquire()
    rt = eng.mujoco_runtime
    await op.cmd(action="pick")                                                    # binds the cell to OR-03
    c = list(rt.cartridge_state.pos_xyz)
    await op.cmd(gripper_aperture=0.07)
    for h in (0.35, 0.25, 0.15, 0.08, 0.012):
        await _arm_to(eng, [c[0], c[1], c[2] + h], ticks=5)
    assert (await op.cmd(action="pick"))["pick"]["ok"] is True
    c = list(rt.cartridge_state.pos_xyz)
    await _arm_to(eng, [c[0], c[1], 0.5], ticks=8)
    assert rt.held_object_id == CART

    doc = json.loads(json.dumps(eng.state_doc()))                                  # what a snapshot stores
    assert doc["workcells"]["strainer_01"]["owner"] == "OR-03" and doc["workcells"]["strainer_01"]["state"]["held_object_id"] == CART

    twin = _engine()
    twin.load_state_doc(doc)
    assert twin.workcell_owner == "OR-03" and twin.mujoco_runtime.held_object_id == CART
    assert twin.state_hash() == eng.state_hash()
    a, b = eng.world()["rigid_objects"][CART]["pos_xyz"], twin.world()["rigid_objects"][CART]["pos_xyz"]
    assert math.dist(a, b) < 1e-9
    await eng.step_ticks(6)
    await twin.step_ticks(6)
    a, b = eng.world()["rigid_objects"][CART]["pos_xyz"], twin.world()["rigid_objects"][CART]["pos_xyz"]
    assert math.dist(a, b) < 1e-6 and twin.mujoco_runtime.held_object_id == CART, f"restored cell diverged: {a} vs {b}"


async def _strainer_mission(eng, rid, tag):
    ack = await eng.submit({"command_id": f"svc_{tag}", "kind": "robot.mission.assign", "target_id": rid,
                            "args": {"robot_id": rid, "kind": "service", "target_id": "strainer_01", "title": "replace the FWS strainer cartridge",
                                     "steps": [{"command": "navigate", "args": {"target_id": "strainer_01"}},
                                               {"command": "replace_strainer", "args": {"target_id": "strainer_01"}}]},
                            "actor_type": "operator", "principal": "op1"})
    assert ack["accepted"], ack
    return ack["mission_id"]


@pytest.mark.asyncio
async def test_autonomous_strainer_exchange_is_mechanical_first_then_plant_recovery():
    """The agent-style mission (no human): navigate to the bay, pick the spare cartridge with the pads, carry it, seat it on the fixture, THEN the plant
    resistance changes and the solver recovers. The plant is untouched until the mechanical gate passes."""
    eng = _engine()
    plant = eng.plant
    plant.faults.occl["strainer_01"] = 0.85
    plant._hard = True
    await eng.step_ticks(20)
    dp_before = float(plant.assets()["strainer_01"]["readings"]["strainer_dp_kpa"])
    assert dp_before > 30.0
    mid = await _strainer_mission(eng, "OR-01", "ok")
    seen_held = False
    occl_when_held = None
    for _ in range(900):
        await eng.step_ticks(1)
        if eng.mujoco_runtime.held_object_id:
            seen_held = True
            occl_when_held = plant.faults.occl.get("strainer_01", 0.0)
        m = eng.missions.missions[mid]
        if m["steps"][-1]["status"] in ("done", "failed"):
            break
    m = eng.missions.missions[mid]
    assert [s["status"] for s in m["steps"]] == ["done", "done"], [(s["command"], s["status"], s.get("result")) for s in m["steps"]]
    rs = eng.mujoco_runtime.repair_state
    assert seen_held and occl_when_held == 0.85, "the payload must be carried while the plant is still faulty"
    assert rs.cartridge_installed and rs.mechanical_fit_pass and rs.position_error_m < 0.035
    assert eng.world()["rigid_objects"][CART]["seated_in_fixture_id"]
    await eng.step_ticks(30)
    assert plant.faults.occl.get("strainer_01", 0.0) == 0.0
    dp_after = float(plant.assets()["strainer_01"]["readings"]["strainer_dp_kpa"])
    assert dp_after < 0.3 * dp_before, f"strainer dP {dp_before:.1f} -> {dp_after:.1f} kPa"
    assert plant.solver_health()["converged"]


@pytest.mark.asyncio
async def test_autonomous_strainer_exchange_fails_closed_without_mechanical_completion():
    """Something moved the spare cartridge out of the arm's reach: the exchange fails with the reason and the plant is NOT healed."""
    eng = _engine()
    plant = eng.plant
    plant.faults.occl["strainer_01"] = 0.85
    plant._hard = True
    mj = eng.mujoco_runtime
    mj._data.qpos[11:14] = [mj._data.qpos[11] + 3.0, mj._data.qpos[12], 0.06]          # free joint of the cartridge: 3 m away
    import mujoco
    mujoco.mj_forward(mj._model, mj._data)
    await eng.step_ticks(10)
    mid = await _strainer_mission(eng, "OR-01", "gone")
    for _ in range(400):
        await eng.step_ticks(1)
        m = eng.missions.missions[mid]
        if m["steps"][-1]["status"] in ("done", "failed") or m["status"] in ("FAILED", "ABORTED"):
            break
    m = eng.missions.missions[mid]
    assert m["steps"][-1]["status"] == "failed", [(s["command"], s["status"], s.get("result")) for s in m["steps"]]
    assert "out of the arm's reach" in str(m["steps"][-1].get("result")) + str(m.get("failure_reason"))
    assert plant.faults.occl.get("strainer_01", 0.0) == 0.85                            # nothing healed
    assert not mj.repair_state.cartridge_installed


def test_two_bays_are_distinct_free_facility_cells():
    eng = _engine()
    assert set(eng.bays) == {"strainer_01", "strainer_02"}
    a, b = eng.bays["strainer_01"], eng.bays["strainer_02"]
    assert a.cartridge_state.id != b.cartridge_state.id and a.repair_state.fixture_id != b.repair_state.fixture_id
    w = eng.world()
    assert set(w["rigid_objects"]) == {"STRAINER-CARTRIDGE-01", "STRAINER-CARTRIDGE-02"} and len(w["mechanical_fixtures"]) == 2
    for bay in (a, b):                                                           # cartridge, fixture and carry path are on free floor
        hx, hz = math.sin(bay.anchor_yaw), math.cos(bay.anchor_yaw)
        for d in (0.0, 0.5, 1.2, 1.8, 2.25):
            assert eng.nav.is_free(bay.anchor_xz[0] + hx * d, bay.anchor_xz[1] + hz * d), (bay.bay_id, d)
    assert math.dist(a.anchor_xz, b.anchor_xz) > 3.0


@pytest.mark.asyncio
async def test_autonomous_exchange_on_the_second_strainer():
    eng = _engine()
    plant = eng.plant
    plant.faults.occl["strainer_02"] = 0.8
    plant._hard = True
    await eng.step_ticks(20)
    dp_before = float(plant.assets()["strainer_02"]["readings"]["strainer_dp_kpa"])
    ack = await eng.submit({"command_id": "svc_s2", "kind": "robot.mission.assign", "target_id": "OR-02",
                            "args": {"robot_id": "OR-02", "kind": "service", "target_id": "strainer_02", "title": "replace the TCS strainer cartridge",
                                     "steps": [{"command": "navigate", "args": {"target_id": "strainer_02"}},
                                               {"command": "replace_strainer", "args": {"target_id": "strainer_02"}}]},
                            "actor_type": "operator", "principal": "op1"})
    assert ack["accepted"], ack
    mid = ack["mission_id"]
    for _ in range(1100):
        await eng.step_ticks(1)
        if eng.missions.missions[mid]["steps"][-1]["status"] in ("done", "failed"):
            break
    m = eng.missions.missions[mid]
    assert [s["status"] for s in m["steps"]] == ["done", "done"], [(s["command"], s["status"], s.get("result")) for s in m["steps"]]
    rs = eng.bays["strainer_02"].repair_state
    assert rs.cartridge_installed and rs.mechanical_fit_pass
    assert not eng.bays["strainer_01"].repair_state.cartridge_installed             # the other bay is untouched
    await eng.step_ticks(30)
    assert plant.faults.occl.get("strainer_02", 0.0) == 0.0
    assert float(plant.assets()["strainer_02"]["readings"]["strainer_dp_kpa"]) < 0.5 * dp_before


@pytest.mark.asyncio
async def test_repeated_faults_get_repeated_mechanical_exchanges_with_a_fresh_spare_each_cycle():
    eng = _engine()
    plant = eng.plant
    for cycle in (1, 2):
        plant.faults.occl["strainer_01"] = 0.8
        plant._hard = True
        await eng.step_ticks(20)
        mid = await _strainer_mission(eng, "OR-01", f"cyc{cycle}")
        for _ in range(1200):
            await eng.step_ticks(1)
            if eng.missions.missions[mid]["steps"][-1]["status"] in ("done", "failed"):
                break
        m = eng.missions.missions[mid]
        assert [s["status"] for s in m["steps"]] == ["done", "done"], (cycle, [(s["command"], s["status"], s.get("result")) for s in m["steps"]])
        await eng.step_ticks(30)
        assert plant.faults.occl.get("strainer_01", 0.0) == 0.0
        # let the rover go home so the second cycle starts like a real dispatch
        eng.robots["OR-01"].battery = 100.0
    assert eng.bays["strainer_01"].spares_used == 1                                    # cycle 2 began with a restock, cycle 1 used the factory spare


@pytest.mark.asyncio
async def test_a_failed_rover_with_charge_returns_to_its_dock_instead_of_staying_stranded():
    eng = _engine()
    mj = eng.bays["strainer_01"]
    import mujoco
    mj._data.qpos[11:14] = [mj._data.qpos[11] + 3.0, mj._data.qpos[12], 0.06]          # the spare is out of reach: the exchange will fail
    mujoco.mj_forward(mj._model, mj._data)
    await eng.step_ticks(10)
    mid = await _strainer_mission(eng, "OR-02", "strand")
    for _ in range(700):
        await eng.step_ticks(1)
        if eng.missions.missions[mid]["status"] in ("FAILED", "ABORTED") or eng.missions.missions[mid]["steps"][-1]["status"] == "failed":
            break
    r = eng.robots["OR-02"]
    assert eng.missions.missions[mid]["steps"][-1]["status"] == "failed"
    for _ in range(900):
        await eng.step_ticks(1)
        if r.mode == "DOCKED":
            break
    assert r.mode == "DOCKED" and eng.missions._at_home(r), (r.mode, r.pos)


@pytest.mark.asyncio
async def test_a_rover_with_an_empty_battery_is_towed_home_after_the_stranding_window_and_it_is_logged():
    from loopkeeper.engine.robots.missions import TOW_AFTER_S
    eng = _engine()
    r = eng.robots["OR-02"]
    home = eng.asset_index[r.home_id]["position_xyz_m"]
    r.pos = [home[0] + 6.0, 0.0, home[2]]; r.mode = "FAILED"; r.battery = 0.0
    await eng.step_ticks(int(TOW_AFTER_S / eng.dt * 0.5))
    assert r.mode == "FAILED" and eng.missions._at_home(r) is False                # not before the window
    await eng.step_ticks(int(TOW_AFTER_S / eng.dt * 0.6))
    assert r.mode == "DOCKED" and eng.missions._at_home(r)
    ev = [e for e in eng.events_since(0, 5000) if e["type"] == "robot.towed"]
    assert len(ev) == 1 and ev[0]["entity_id"] == "OR-02" and ev[0]["payload"]["reason"] == "battery_empty_away_from_dock"
