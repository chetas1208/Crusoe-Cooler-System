"""Autonomous strainer-cartridge exchange in the MuJoCo service bay.

The same physical sequence a human performs from the Map (V5 vertical slice A), run as a deterministic state machine over engine ticks:
bind the cell -> approach the spare cartridge from above in stages -> friction grasp (measured pad forces) -> lift -> creep the rover to the
fixture (engine-owned pose, nav-grid checked) -> lower with closed-loop alignment on the MEASURED payload pose -> release -> the cartridge is judged
where it physically comes to rest -> retreat. The plant is NOT touched here: the mission's `replace_strainer` effect is only applied by
`MissionManager._finish_step` if `repair_state.cartridge_installed and mechanical_fit_pass` (mechanical completion first, plant recovery second).
Any failed phase fails the step with its reason and leaves the plant untouched. The controller's phase is part of the robot state (`robot.svc`)
so a restart mid-service resumes the sequence instead of hanging."""
from __future__ import annotations

import math
from typing import Any

APPROACH_H = (0.35, 0.25, 0.15, 0.08, 0.012)      # pad-centre heights above the cartridge centre, m
LIFT_Z = 0.50
CREEP_ACCEL = 0.1                                   # m/s^2
CREEP_SPEED = 0.12                                  # m/s, rover creep inside the bay
PHASE_TIMEOUT_TICKS = 80
ARM_TOL_M = 0.012


class StrainerExchange:
    def __init__(self, eng: Any, robot: Any, bay_id: str = "strainer_01") -> None:
        self.eng, self.robot, self.bay_id = eng, robot, bay_id
        if robot.svc is None:
            robot.svc = {"phase": "bind", "i": 0, "wait": 0, "carry_to": None, "stage": None, "want": None, "bias": [0.0, 0.0, 0.0], "cmd": None}
        self.s = robot.svc

    # -------------------------------------------------------------- helpers
    def _fail(self, reason: str) -> tuple[str, str]:
        self.s["phase"] = "failed"
        return "failed", reason

    def _goto(self, phase: str, i: int = 0) -> None:
        self.s.update(phase=phase, i=i, wait=0)

    def _arm_to(self, xyz: list[float], tol: float = ARM_TOL_M) -> bool | None:
        """Put the MEASURED pad centre at `xyz` (cell frame). The joint position actuators sag under gravity by a few cm, so this is a servo loop:
        command = want + accumulated bias; once the arm has settled the remaining error is added to the bias and the IK is solved again, until the
        measured pad centre is within ARM_TOL_M. True when there, False while converging, None if the target is unreachable."""
        mj = self.eng.bays[self.bay_id]
        want = [round(v, 4) for v in xyz]
        if self.s.get("want") != want:
            self.s.update(want=want, bias=[0.0, 0.0, 0.0], cmd=None, wait=0)
        bias = self.s["bias"]
        cmd = [want[i] + bias[i] for i in range(3)]
        if self.s.get("cmd") != [round(v, 4) for v in cmd]:
            q = mj.solve_arm_ik(list(cmd))
            if q is None:
                return None
            mj.set_arm_pose(q)
            self.s["cmd"] = [round(v, 4) for v in cmd]
            return False
        settled = max(abs(a - b) for a, b in zip(mj.arm_qpos, mj.arm_targets)) < 1e-3
        if not settled:
            return False
        if mj._data is not None and float(abs(mj._data.qvel[3:9]).max()) > 0.05:      # still moving: wait for the joints to come to rest
            return False
        gc = mj.grip_center()
        err = [want[i] - gc[i] for i in range(3)]
        if math.sqrt(sum(e * e for e in err)) < tol:
            return True
        self.s["bias"] = [max(-0.09, min(0.09, bias[i] + err[i])) for i in range(3)]
        return False

    def _arm_open_loop(self, xyz: list[float], ticks: int) -> bool | None:
        """Command the pad centre to `xyz` and give the joints a fixed settling time (the rehearsed V5 sequence). Used while the payload is squeezed
        in the pads: servoing on the measured error there makes the corrections jerk the cartridge out of the grasp."""
        mj = self.eng.bays[self.bay_id]
        want = [round(v, 4) for v in xyz]
        if self.s.get("want") != want:
            q = mj.solve_arm_ik(list(want))
            if q is None:
                return None
            mj.set_arm_pose(q)
            self.s.update(want=want, ol=0, wait=0)
            return False
        self.s["ol"] = self.s.get("ol", 0) + 1
        return self.s["ol"] >= ticks

    # -------------------------------------------------------------- one engine tick
    def tick(self) -> tuple[str, str | None]:
        eng, r, mj, s = self.eng, self.robot, self.eng.bays[self.bay_id], self.s
        ph = s["phase"]
        s["wait"] += 1
        if ph in ("done", "failed"):
            return ph, None
        if s["wait"] > PHASE_TIMEOUT_TICKS:
            return self._fail(f"timeout in phase {ph}")
        cart = mj.cartridge_state

        if ph == "bind":
            # face the work first: with the chassis between the arm and the cartridge the arm collides with its own rover
            want_yaw = eng.service_facing(self.bay_id)
            if want_yaw is not None:
                from ..geometry import angle_delta                      # noqa: PLC0415
                dy = angle_delta(r.yaw, want_yaw)
                if abs(dy) > 1e-3:
                    r.yaw += max(-1.6 * eng.dt, min(1.6 * eng.dt, dy))
                    s["wait"] = 0
                    return "running", None
            if mj.repair_state.cartridge_installed and not mj.held_object_id:
                info = mj.restock()                                      # a previous cycle left its cartridge seated: a new cycle starts with a fresh spare
                eng.emit_internal("robot.workcell", r.id, {"robot_id": r.id, "event": "restocked", **info}, actor_type="system")
            ok, why = eng.claim_workcell(r.id, self.bay_id)
            if not ok:
                return self._fail(why)
            mj.set_gripper(0.07)
            self._goto("approach")
        elif ph == "approach":
            if not s.get("stage"):                           # latch the stage target (the resting cartridge jitters at the 1e-5 m level)
                c = cart.pos_xyz
                s["stage"] = [round(c[0], 4), round(c[1], 4), round(c[2] + APPROACH_H[s["i"]], 4)]
            res = self._arm_to(list(s["stage"]), 0.003 if s["i"] >= len(APPROACH_H) - 2 else ARM_TOL_M)   # the last two stages decide the grasp offset
            if res is None:
                return self._fail("spare cartridge is out of the arm's reach from this pose")
            if res:
                s["stage"] = None
                if s["i"] + 1 < len(APPROACH_H):
                    self.s["want"] = None
                    self._goto("approach", s["i"] + 1)
                else:
                    self._goto("grasp")
        elif ph == "grasp":
            ok, msg = mj.pick_cartridge()
            if not ok:
                return self._fail(f"grasp failed: {msg}")
            self.s["want"] = None
            self._goto("lift")
        elif ph == "lift":
            if not s.get("stage"):
                c = cart.pos_xyz
                s["stage"] = [round(c[0], 4), round(c[1], 4), LIFT_Z]
            res = self._arm_to(list(s["stage"]))
            if res is None:
                return self._fail("cannot lift the cartridge")
            if res:
                s["stage"] = None
                if not mj.held_object_id:
                    return self._fail("cartridge slipped out of the gripper while lifting")
                fx, fy, _ = mj.SEAT_XYZ
                # park the rover so the fixture is where the V5 rehearsal put it relative to the base: base start + (1.75, -0.2) in the cell frame
                s["carry_to"] = [round(v, 4) for v in mj.to_facility_point([13.7, 1.8, 0.0])[0::2]]
                self.s["want"] = None
                self._goto("carry")
        elif ph == "carry":
            if not mj.held_object_id:
                return self._fail("cartridge dropped while carrying")
            tx, tz = s["carry_to"]
            dx, dz = tx - r.pos[0], tz - r.pos[2]
            d = math.hypot(dx, dz)
            if d < 0.02:
                self.s["want"] = None
                s["v"] = 0.0
                self._goto("settle")
            else:
                # trapezoid speed profile (0.1 m/s^2): abrupt starts/stops slide the squeezed cartridge along the pads
                v = min(CREEP_SPEED, s.get("v", 0.0) + CREEP_ACCEL * eng.dt, math.sqrt(2.0 * CREEP_ACCEL * d) + 0.01)
                s["v"] = v
                step = min(d, v * eng.dt)
                np_ = [r.pos[0] + dx / d * step, r.pos[1], r.pos[2] + dz / d * step]
                if not eng.nav.is_free(np_[0], np_[2]) or eng.traffic.blocker(r, np_, r.yaw) is not None:
                    return "running", None                           # wait for the bay to clear (bounded by the phase timeout)
                r.pos = np_
                r.speed = CREEP_SPEED
                s["wait"] = 0
        elif ph == "settle":
            v = math.sqrt(sum(x * x for x in cart.vel_xyz))
            s["calm"] = (s.get("calm", 0) + 1) if v < 0.01 else 0
            if not mj.held_object_id:
                return self._fail("cartridge dropped while settling")
            if s["calm"] >= 4:
                s["calm"] = 0
                self._goto("lower")
        elif ph == "lower":
            fx, fy, fz = mj.SEAT_XYZ
            stages = (0.55, 0.45, 0.38, fz + 0.012 + 0.02)
            if not s.get("stage"):                           # closed loop on the MEASURED gripper-to-cartridge offset, latched per stage
                gc, cp = mj.grip_center(), cart.pos_xyz
                s["stage"] = [round(fx + (gc[0] - cp[0]), 4), round(fy + (gc[1] - cp[1]), 4), round(stages[s["i"]], 4)]
            res = self._arm_open_loop(list(s["stage"]), 7 if s["i"] == 0 else 4)
            if res is None:
                return self._fail("fixture is out of the arm's reach")
            if not mj.held_object_id:
                return self._fail("cartridge dropped while lowering")
            if res:
                s["stage"] = None
                if s["i"] + 1 < len(stages):
                    self.s["want"] = None
                    self._goto("lower", s["i"] + 1)
                else:
                    self._goto("release")
        elif ph == "release":
            ok, msg = mj.place_cartridge()
            s["note"] = msg
            if not (mj.repair_state.cartridge_installed and mj.repair_state.mechanical_fit_pass):
                return self._fail(f"mechanical service incomplete: {msg}")
            self.s["want"] = None
            self._goto("retreat")
        elif ph == "retreat":
            res = self._arm_to([mj.SEAT_XYZ[0] - 0.55, mj.SEAT_XYZ[1], 0.55])
            if res is None or res:
                mj.set_arm_pose(list(mj.REST_POSE))
                r.speed = 0.0
                self._goto("done")
        r.speed = r.speed if ph == "carry" else 0.0
        return "running", None
