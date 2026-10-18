"""Per-robot OUTRIG manipulator: 6 joints + parallel gripper, one independent arm state per rover.

Design
- `Manipulator` is a pure, deterministic kinematic model of ONE arm (joint targets and eased joint angles with limits and rate limits, gripper
  aperture, held object). No state is shared between robots. The link geometry is the MuJoCo cell arm (robotics/mujoco_runtime.py ROBOT_XML), so
  the analytic forward kinematics here and the MuJoCo kinematics agree (tests compare them).
- `ManipulatorBank` is the engine integration. Commands (from ControlManager.drive) only set targets / queue a pick or place; the arm moves on the
  engine tick (single writer), never instantly. The end-effector pose is computed by forward kinematics from the robot's CURRENT base pose.
- Graspable objects are the strainer cartridges of the service bays (MuJoCo cells). A pick needs the pad centre inside the grasp envelope of an
  object; a carried object follows the end effector (prescribed in the cell), a release drops it and the cell physics judges where it came to rest.
- While the autonomous service sequence owns a bay cell (robot holds the cell and is not under manual control) the manipulator mirrors that
  cell's arm so the published state is always the real arm of THAT robot.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np

from ..util import Json

if TYPE_CHECKING:  # pragma: no cover
    from ..core import Engine

JOINT_NAMES = ("joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6")
JOINT_LIMITS = ((-3.14159, 3.14159), (-2.09, 2.09), (-2.5, 2.5), (-3.14159, 3.14159), (-1.85, 1.85), (-3.14159, 3.14159))   # = MuJoCo joint ranges
JOINT_RATE = (1.0, 1.0, 1.2, 1.8, 1.8, 2.4)         # rad/s at speed scale 1.0
HOME_POSE = (0.0, 0.2, 0.4, 0.0, 0.0, 0.0)          # = MuJoCoRuntime.REST_POSE
STOW_POSE = (0.0, -1.8, 2.5, 0.0, 0.95, 0.0)        # folded back over the chassis (checked by test: above the floor, inside the footprint)
GRIPPER_MAX_M = 0.07
GRIPPER_RATE_M_S = 0.08
GRIPPER_OPEN_MIN_M = 0.05                           # "open" for pick / release purposes
OBJECT_WIDTH_M = 0.044                              # strainer cartridge diameter: the pads stop on it
GRASP_HORIZ_M = 0.05                                # operator grasp envelope: pad centre within 50 mm in plan ...
GRASP_DZ_M = (-0.02, 0.08)                          # ... and 20 mm below .. 80 mm above the object centre
MIN_LINK_HEIGHT_M = 0.02                            # no joint / link end below this (floor), pad centre not below MIN_PAD_HEIGHT_M
MIN_PAD_HEIGHT_M = 0.03
SPEED_SCALE_RANGE = (0.1, 1.0)
PENDING_TIMEOUT_S = 20.0
SETTLE_TOL_RAD = 1e-3
BASE_Z_M = 0.15                                     # chassis body origin height (MuJoCo cell)

# (offset from the parent frame, joint axis) per link, in the rover frame: x forward, y left, z up
_CHAIN = (((0.16, 0.0, 0.12), "z"), ((0.0, 0.0, 0.08), "y"), ((0.0, 0.0, 0.35), "y"), ((0.0, 0.0, 0.32), "x"), ((0.0, 0.0, 0.05), "y"), ((0.0, 0.0, 0.04), "z"))
_GRIP_LOCAL = (0.0, 0.0, 0.06)

ARM_ACTIONS = ("joint_jog", "joint_targets", "gripper_open", "gripper_close", "pick", "place", "arm_home", "arm_stow", "arm_stop")
NO_ARM_MSG = "no_manipulator: IN-PIPE crawlers have no arm or gripper; their tool is the brush (action clean_deposit)"


def _rot(axis: str, q: float) -> np.ndarray:
    c, s = math.cos(q), math.sin(q)
    if axis == "z":
        return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    if axis == "y":
        return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def fk_rover(q: list[float] | tuple[float, ...]) -> tuple[list[np.ndarray], np.ndarray, np.ndarray]:
    """Forward kinematics in the rover frame (origin = chassis centre on the floor, x forward, y left, z up).
    Returns (joint origins, EE rotation, pad centre)."""
    t = np.array([0.0, 0.0, BASE_Z_M])
    r = np.eye(3)
    pts: list[np.ndarray] = []
    for (off, ax), qi in zip(_CHAIN, q):
        t = t + r @ np.array(off)
        r = r @ _rot(ax, float(qi))
        pts.append(t.copy())
    return pts, r, t + r @ np.array(_GRIP_LOCAL)


def _world_basis(yaw: float) -> np.ndarray:
    """Columns = rover forward, left, up in facility axes (X east, Y up, Z south). Heading of a rover is (sin yaw, 0, cos yaw)."""
    s, c = math.sin(yaw), math.cos(yaw)
    return np.array([[s, c, 0.0], [0.0, 0.0, 1.0], [c, -s, 0.0]])


def _quat_xyzw(m: np.ndarray) -> list[float]:
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        sq = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * sq, (m[2, 1] - m[1, 2]) / sq, (m[0, 2] - m[2, 0]) / sq, (m[1, 0] - m[0, 1]) / sq
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        sq = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w, x, y, z = (m[2, 1] - m[1, 2]) / sq, 0.25 * sq, (m[0, 1] + m[1, 0]) / sq, (m[0, 2] + m[2, 0]) / sq
    elif m[1, 1] > m[2, 2]:
        sq = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w, x, y, z = (m[0, 2] - m[2, 0]) / sq, (m[0, 1] + m[1, 0]) / sq, 0.25 * sq, (m[1, 2] + m[2, 1]) / sq
    else:
        sq = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w, x, y, z = (m[1, 0] - m[0, 1]) / sq, (m[0, 2] + m[2, 0]) / sq, (m[1, 2] + m[2, 1]) / sq, 0.25 * sq
    return [float(x), float(y), float(z), float(w)]


def ee_world(base_x: float, base_z: float, yaw: float, q) -> tuple[list[float], list[float]]:
    """Pad centre (facility metres) and EE orientation (xyzw, facility frame) for a rover standing at (base_x, base_z) heading `yaw`."""
    _, r, pad = fk_rover(q)
    m = _world_basis(yaw)
    p = m @ pad
    return [float(base_x + p[0]), float(p[1]), float(base_z + p[2])], _quat_xyzw(m @ r)


def _clip(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


class Manipulator:
    """One arm. Pure state + kinematics; the bank applies it to the world."""

    def __init__(self) -> None:
        self.qpos = list(HOME_POSE)
        self.targets = list(HOME_POSE)
        self.gripper = GRIPPER_MAX_M
        self.gripper_target = GRIPPER_MAX_M
        self.speed_scale = 1.0
        self.held_object_id: str | None = None
        self.held_source: str | None = None        # "operator" (carried kinematically) | "bay" (held by the autonomous service sequence)
        self.held_bay: str | None = None
        self.pending: Json | None = None           # queued pick / place waiting for the arm to settle
        self.last_result: Json | None = None
        self.source = "operator"                   # who drives the joints right now: "operator" | "service_bay"

    # ------------------------------------------------------------ state
    def to_state(self) -> Json:
        return {"q": list(self.qpos), "t": list(self.targets), "g": self.gripper, "gt": self.gripper_target, "ss": self.speed_scale,
                "held": self.held_object_id, "hs": self.held_source, "hb": self.held_bay, "pending": self.pending, "last": self.last_result,
                "src": self.source}

    def load_state(self, st: Json) -> None:
        self.qpos = [float(x) for x in st["q"]]
        self.targets = [float(x) for x in st["t"]]
        self.gripper, self.gripper_target = float(st["g"]), float(st["gt"])
        self.speed_scale = float(st.get("ss", 1.0))
        self.held_object_id, self.held_source, self.held_bay = st.get("held"), st.get("hs"), st.get("hb")
        self.pending = dict(st["pending"]) if st.get("pending") else None
        self.last_result = dict(st["last"]) if st.get("last") else None
        self.source = st.get("src", "operator")

    # ------------------------------------------------------------ motion
    @property
    def settled(self) -> bool:
        return (max(abs(a - b) for a, b in zip(self.qpos, self.targets)) < SETTLE_TOL_RAD
                and abs(self.gripper - self.gripper_target) < 1e-4)

    def step(self, dt: float) -> None:
        sc = self.speed_scale
        for i in range(6):
            lim = JOINT_RATE[i] * sc * dt
            self.qpos[i] += _clip(self.targets[i] - self.qpos[i], -lim, lim)
        g = GRIPPER_RATE_M_S * dt
        self.gripper += _clip(self.gripper_target - self.gripper, -g, g)

    @staticmethod
    def clamp_targets(q) -> tuple[list[float], bool]:
        out, clamped = [], False
        for v, (lo, hi) in zip(q, JOINT_LIMITS):
            c = _clip(float(v), lo, hi)
            clamped = clamped or c != float(v)
            out.append(c)
        return out, clamped

    @staticmethod
    def floor_violation(q) -> str | None:
        """Joint / pad positions of a joint set (rover frame, z up) that would put the arm into the floor."""
        pts, _, pad = fk_rover(q)
        for i, p in enumerate(pts):
            if float(p[2]) < MIN_LINK_HEIGHT_M:
                return f"joint {i + 1} origin would be {float(p[2]) * 1000:.0f} mm above the floor (minimum {MIN_LINK_HEIGHT_M * 1000:.0f} mm)"
        if float(pad[2]) < MIN_PAD_HEIGHT_M:
            return f"gripper pads would be {float(pad[2]) * 1000:.0f} mm above the floor (minimum {MIN_PAD_HEIGHT_M * 1000:.0f} mm)"
        return None

    def set_targets(self, q) -> tuple[bool, str, bool]:
        q2, clamped = self.clamp_targets(q)
        bad = self.floor_violation(q2)
        if bad:
            return False, f"arm_would_hit_floor: {bad}", clamped
        self.targets = q2
        return True, "", clamped

    def jog(self, idx: int, delta: float) -> tuple[bool, str, bool]:
        q = list(self.targets)
        q[idx] = q[idx] + delta
        return self.set_targets(q)

    def stop(self) -> None:
        self.targets = list(self.qpos)
        self.gripper_target = self.gripper

    def ee(self, base_x: float, base_z: float, yaw: float) -> tuple[list[float], list[float]]:
        return ee_world(base_x, base_z, yaw, self.qpos)


class ManipulatorBank:
    """All arms of the fleet (OUTRIG only) + the world interaction (objects, bays, events)."""

    def __init__(self, eng: "Engine") -> None:
        self.eng = eng
        self.arms: dict[str, Manipulator] = {rid: Manipulator() for rid, r in sorted(eng.robots.items()) if r.klass == "outrig"}

    def has_arm(self, rid: str) -> bool:
        return rid in self.arms

    # ------------------------------------------------------------ state
    def to_state(self) -> Json:
        return {rid: a.to_state() for rid, a in sorted(self.arms.items())}

    def load_state(self, st: Json) -> None:
        for rid in self.arms:
            self.arms[rid] = Manipulator()
        for rid, s in (st or {}).items():
            if rid in self.arms:
                self.arms[rid].load_state(s)

    # ------------------------------------------------------------ geometry / objects
    def ee_pose(self, rid: str) -> tuple[list[float], list[float]]:
        r = self.eng.robots[rid]
        return self.arms[rid].ee(r.pos[0], r.pos[2], r.yaw)

    def graspables(self) -> list[Json]:
        out = []
        for bid, bay in sorted(self.eng.bays.items()):
            cs = bay.cartridge_state
            out.append({"id": cs.id, "bay_id": bid, "pos": bay.to_facility_point(cs.pos_xyz), "held_by": cs.held_by_robot_id,
                        "seated": bool(cs.seated_in_fixture_id), "upright": cs.pos_xyz[2] >= 0.035})
        return out

    def _nearest(self, rid: str) -> Json | None:
        pad = self.ee_pose(rid)[0]
        best = None
        for o in self.graspables():
            if o["held_by"] is not None or o["seated"]:
                continue
            horiz = math.hypot(pad[0] - o["pos"][0], pad[2] - o["pos"][2])
            dz = pad[1] - o["pos"][1]
            d = math.sqrt(horiz ** 2 + dz ** 2)
            if best is None or d < best["distance_m"]:
                best = {"id": o["id"], "bay_id": o["bay_id"], "distance_m": d, "horizontal_m": horiz, "dz_m": dz, "upright": o["upright"],
                        "in_envelope": horiz <= GRASP_HORIZ_M and GRASP_DZ_M[0] <= dz <= GRASP_DZ_M[1]}
        return best

    # ------------------------------------------------------------ published view
    def view(self, rid: str) -> Json | None:
        a = self.arms.get(rid)
        if a is None:
            return None
        pos, quat = self.ee_pose(rid)
        near = self._nearest(rid)
        return {
            "joint_names": list(JOINT_NAMES),
            "joints_rad": [round(x, 5) for x in a.qpos],
            "joint_targets_rad": [round(x, 5) for x in a.targets],
            "joint_limits_rad": [[lo, hi] for lo, hi in JOINT_LIMITS],
            "gripper_aperture_m": round(a.gripper, 5),
            "gripper_target_m": round(a.gripper_target, 5),
            "gripper_limits_m": [0.0, GRIPPER_MAX_M],
            "held_object_id": a.held_object_id,
            "ee_xyz_m": [round(x, 4) for x in pos],
            "ee_quat_xyzw": [round(x, 5) for x in quat],
            "busy": bool((not a.settled) or a.pending),
            "speed_scale": a.speed_scale,
            "source": a.source,
            "pending_action": (a.pending or {}).get("action"),
            "last_result": a.last_result,
            "nearest_object": ({"id": near["id"], "distance_m": round(near["distance_m"], 4), "in_envelope": near["in_envelope"]} if near else None),
        }

    def decorate(self, rid: str, c: Json) -> None:
        """Add `manipulator` to a robot payload and make the legacy flat arm fields describe THIS robot's arm."""
        v = self.view(rid)
        if v is None:
            return
        c["manipulator"] = v
        c["arm_joint_names"] = v["joint_names"]
        c["arm_qpos_rad"] = v["joints_rad"]
        c["gripper_aperture_m"] = v["gripper_aperture_m"]
        c["held_object_id"] = v["held_object_id"]
        c["end_effector_pose"] = {"pos_xyz": v["ee_xyz_m"], "quat_xyzw": tuple(v["ee_quat_xyzw"])}

    # ------------------------------------------------------------ commands (called from ControlManager.drive; single writer)
    @staticmethod
    def requested(a: Json) -> bool:
        return bool(a.get("action") in ARM_ACTIONS or "joint_idx" in a or a.get("joint_targets_rad") is not None or "gripper_aperture" in a
                    or a.get("pick") or a.get("place") or "arm_speed_scale" in a)

    def apply(self, rid: str, a: Json, principal: str) -> Json:
        eng = self.eng
        ack: Json = {}
        if not self.requested(a):
            return ack
        robot = eng.robots[rid]
        if robot.klass != "outrig" or rid not in self.arms:
            ack["rejected"] = {"reason": NO_ARM_MSG}
            return ack
        arm = self.arms[rid]
        act = a.get("action")
        reasons: list[str] = []
        motion = False
        if arm.held_source == "bay" and not (act == "place" or a.get("place")):
            ack["rejected"] = {"reason": f"arm_busy: {arm.held_object_id} is held by the automatic service sequence; only place is accepted"}
            return ack
        # an operator takes the arm: the service-bay cell must not keep a second arm posed over the same objects
        bay = eng.bay_of(rid)
        if bay is not None and not bay.held_object_id:
            bay.owner = None
            arm.source = "operator"

        if "arm_speed_scale" in a:
            arm.speed_scale = _clip(float(a["arm_speed_scale"]), *SPEED_SCALE_RANGE)
            ack["arm_speed_scale"] = arm.speed_scale

        if act == "arm_stop":
            arm.stop()
            arm.pending = None
            ack["arm_stop"] = {"ok": True}
            motion = True
        if act in ("arm_home", "arm_stow"):
            ok, why, _ = arm.set_targets(list(HOME_POSE if act == "arm_home" else STOW_POSE))
            ack[act] = {"ok": ok, "message": why or ("moving to " + ("home" if act == "arm_home" else "stow") + " pose")}
            motion = True
            if not ok:
                reasons.append(why)
        if a.get("joint_targets_rad") is not None:
            ok, why, clamped = arm.set_targets(list(a["joint_targets_rad"]))
            ack["joint_targets"] = {"ok": ok, "clamped": clamped, "targets_rad": [round(x, 5) for x in arm.targets], **({"message": why} if why else {})}
            motion = True
            if not ok:
                reasons.append(why)
        if act == "joint_jog" or "joint_idx" in a:
            if "joint_idx" not in a or "delta_rad" not in a:
                reasons.append("bad_request: joint_jog needs joint_idx (0..5) and delta_rad")
            else:
                j = int(a["joint_idx"])
                ok, why, clamped = arm.jog(j, float(a["delta_rad"]))
                ack["joint_jog"] = {"ok": ok, "joint": j, "clamped": clamped, "target_rad": round(arm.targets[j], 5), "qpos": [round(x, 5) for x in arm.qpos],
                                    **({"message": why} if why else {})}
                motion = True
                if not ok:
                    reasons.append(why)
        want_g = None
        if "gripper_aperture" in a:
            want_g = float(a["gripper_aperture"])
        elif act == "gripper_open":
            want_g = GRIPPER_MAX_M
        elif act == "gripper_close":
            want_g = 0.0
        if want_g is not None:
            want_g = _clip(want_g, 0.0, GRIPPER_MAX_M)
            motion = True
            if arm.held_object_id and want_g >= GRIPPER_OPEN_MIN_M:
                ok, msg, extra = self._release(rid, principal)
                ack["gripper"] = {"aperture_m": want_g, "released": ok, "message": msg, **extra}
                arm.gripper_target = want_g
            else:
                if arm.held_object_id and want_g < OBJECT_WIDTH_M:
                    want_g = OBJECT_WIDTH_M            # the pads stop on the object
                arm.gripper_target = want_g
                ack["gripper"] = {"aperture_m": want_g}
        if motion and arm.pending is not None and not (a.get("pick") or a.get("place") or act in ("pick", "place")):
            arm.pending = None
            ack["cancelled_pending"] = True
        if act == "pick" or a.get("pick"):
            self._request(rid, "pick", principal, ack)
        if act == "place" or a.get("place"):
            self._request(rid, "place", principal, ack)
        if reasons:
            ack["rejected"] = {"reason": "; ".join(reasons)}
        ack["manipulator"] = self.view(rid)
        return ack

    def _request(self, rid: str, kind: str, principal: str, ack: Json) -> None:
        arm = self.arms[rid]
        if arm.pending is not None:
            ack[kind] = {"ok": False, "message": f"arm_busy: a {arm.pending['action']} is already waiting for the arm to stop"}
            return
        if not arm.settled:
            arm.pending = {"action": kind, "principal": principal, "age_s": 0.0}
            ack[kind] = {"ok": None, "queued": True, "message": f"{kind} queued: runs when the arm has stopped moving"}
            return
        ack[kind] = self._execute(rid, kind, principal)

    def _execute(self, rid: str, kind: str, principal: str) -> Json:
        ok, msg, extra = (self._pick(rid, principal) if kind == "pick" else self._place(rid, principal))
        arm = self.arms[rid]
        arm.last_result = {"action": kind, "ok": ok, "message": msg, "tick": self.eng.tick}
        return {"ok": ok, "message": msg, "held_object": arm.held_object_id, **extra}

    # ------------------------------------------------------------ pick / place / release
    def _pick(self, rid: str, principal: str) -> tuple[bool, str, Json]:
        eng, arm = self.eng, self.arms[rid]
        if arm.held_object_id:
            return False, f"hands_full: already holding {arm.held_object_id}", {}
        if arm.gripper < GRIPPER_OPEN_MIN_M or arm.gripper_target < GRIPPER_OPEN_MIN_M:
            return False, f"gripper_not_open: open the gripper (>= {GRIPPER_OPEN_MIN_M * 1000:.0f} mm) before picking", {}
        near = self._nearest(rid)
        if near is None:
            return False, "no_graspable_object: nothing free to pick (all cartridges are held or already seated)", {}
        if not near["in_envelope"]:
            return False, (f"Gripper is too far from {near['id']} (distance {near['distance_m']:.3f} m: {near['horizontal_m'] * 1000:.0f} mm in plan, "
                           f"{near['dz_m'] * 1000:.0f} mm vertical; grasp envelope is {GRASP_HORIZ_M * 1000:.0f} mm in plan, "
                           f"{GRASP_DZ_M[0] * 1000:.0f}..{GRASP_DZ_M[1] * 1000:.0f} mm vertical). Drive the rover to the bay and lower the arm."), {}
        if not near["upright"]:
            return False, f"{near['id']} is not upright (lying on its side); grasp refused", {}
        bay = eng.bays[near["bay_id"]]
        bay.cartridge_state.held_by_robot_id = rid
        arm.held_object_id, arm.held_source, arm.held_bay = near["id"], "operator", near["bay_id"]
        arm.gripper_target = OBJECT_WIDTH_M
        self._hold_in_cell(rid)
        eng.emit_internal("robot.manipulation.pick", rid, {"robot_id": rid, "held_object_id": near["id"], "verified_contact": False,
                                                           "grasp_model": "kinematic_envelope"}, actor_type="operator", actor_id=principal)
        return True, f"Grasped {near['id']} ({near['distance_m'] * 1000:.0f} mm from the pad centre)", {}

    def _place(self, rid: str, principal: str) -> tuple[bool, str, Json]:
        arm = self.arms[rid]
        if not arm.held_object_id:
            return False, "nothing_held: no object in the gripper", {}
        if arm.held_source == "bay":
            bay = self.eng.bay_of(rid)
            if bay is None:
                return False, "nothing_held: the service cell is no longer bound to this robot", {}
            ok, msg = bay.place_cartridge()
            arm.held_object_id, arm.held_source, arm.held_bay = None, None, None
            extra = self._after_place(rid, bay, principal)
            return ok, msg, extra
        return self._release(rid, principal)

    def _release(self, rid: str, principal: str) -> tuple[bool, str, Json]:
        eng, arm = self.eng, self.arms[rid]
        bay = eng.bays[arm.held_bay] if arm.held_bay in eng.bays else None
        if bay is None:
            arm.held_object_id = arm.held_source = arm.held_bay = None
            return False, "nothing_held: the held object's cell is gone", {}
        pad = self.ee_pose(rid)[0]
        local = bay.from_facility_point(pad)
        ok, msg = bay.drop_external(local)
        arm.held_object_id = arm.held_source = arm.held_bay = None
        arm.gripper_target = GRIPPER_MAX_M
        return ok, msg, self._after_place(rid, bay, principal)

    def _after_place(self, rid: str, bay: Any, principal: str) -> Json:
        eng = self.eng
        rs = bay.repair_state
        extra: Json = {"cartridge_seated": rs.cartridge_installed, "mechanical_fit": rs.mechanical_fit_pass, "error_mm": rs.position_error_m * 1000.0}
        eng.emit_internal("robot.manipulation.place", rid, {"robot_id": rid, "cartridge_installed": rs.cartridge_installed,
                                                            "mechanical_fit": rs.mechanical_fit_pass}, actor_type="operator", actor_id=principal)
        if rs.cartridge_installed:
            res = eng.plant.apply({"kind": "replace_strainer", "target_id": bay.bay_id, "args": {}})
            extra["plant_effect"] = {"ok": bool(res.get("ok")), "reason": res.get("reason")}
            if res.get("ok"):
                eng.emit_internal("repair.strainer_replaced", bay.bay_id, {
                    "robot_id": rid, "target_id": bay.bay_id, "cartridge_id": bay.cartridge_state.id,
                    "causal_effect": "occlusion_cleared_to_zero", "stabilization_window_s": 30.0}, actor_type="operator", actor_id=principal)
        return extra

    def _hold_in_cell(self, rid: str) -> None:
        arm = self.arms[rid]
        bay = self.eng.bays.get(arm.held_bay or "")
        if bay is not None:
            pad = self.ee_pose(rid)[0]
            bay.ext_hold_local = bay.from_facility_point(pad)

    # ------------------------------------------------------------ engine tick (single writer)
    def on_tick(self) -> None:
        eng = self.eng
        for bay in eng.bays.values():
            bay.ext_hold_local = None
        for rid in sorted(self.arms):
            arm = self.arms[rid]
            state = eng.control.state_of(rid) if rid in eng.control.ctl else "AUTONOMOUS"
            bay = eng.bay_of(rid)
            if bay is not None and (state != "MANUAL" or bay.held_object_id):
                # the autonomous service sequence drives this robot's arm in its cell: mirror it
                arm.source = "service_bay"
                arm.qpos = [float(x) for x in bay.arm_qpos]
                arm.targets = [float(x) for x in bay.arm_targets]
                arm.gripper, arm.gripper_target = float(bay.gripper_aperture), float(bay.gripper_target)
                arm.held_object_id = bay.held_object_id
                arm.held_source = "bay" if bay.held_object_id else None
                arm.held_bay = bay.bay_id if bay.held_object_id else None
                arm.pending = None
                continue
            arm.source = "operator"
            if arm.held_source == "bay":                      # the cell let go of it (service finished / bay unbound)
                arm.held_object_id = arm.held_source = arm.held_bay = None
            if state != "MANUAL":
                if arm.pending is not None or not arm.settled:
                    arm.stop()                                 # lease gone: the arm stops where it is
                    arm.pending = None
            arm.step(eng.dt)
            if arm.pending is not None:
                arm.pending["age_s"] = float(arm.pending["age_s"]) + eng.dt
                if arm.settled:
                    p = arm.pending
                    arm.pending = None
                    self._execute(rid, p["action"], p["principal"])
                elif arm.pending["age_s"] > PENDING_TIMEOUT_S:
                    p = arm.pending
                    arm.pending = None
                    arm.last_result = {"action": p["action"], "ok": False, "message": "timeout: the arm did not settle", "tick": eng.tick}
            if arm.held_object_id and arm.held_source == "operator":
                self._hold_in_cell(rid)
