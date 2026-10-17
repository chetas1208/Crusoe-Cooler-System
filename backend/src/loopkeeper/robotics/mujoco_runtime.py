"""Authoritative MuJoCo physics runtime for LOOPKEEPER robot manipulation.
Simulates articulated mobile manipulation (OUTRIG), contact-grounded gripper,
free rigid payloads (strainer cartridge), and in-pipe crawler micro-tools.
"""
from __future__ import annotations

import math
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

try:
    import mujoco
    HAS_MUJOCO = True
except ImportError:
    HAS_MUJOCO = False
    mujoco = None

log = logging.getLogger("loopkeeper.robotics.mujoco")

ROBOT_XML = """
<mujoco model="loopkeeper_facility_robotics">
  <compiler angle="radian" coordinate="local"/>
  <option timestep="0.002" gravity="0 0 -9.81" integrator="implicitfast" cone="elliptic" impratio="10"/>
  
  <worldbody>
    <!-- Server room floor boundary -->
    <geom name="floor" type="plane" size="50 50 0.1" rgba="0.15 0.18 0.22 1" friction="1.2 0.005 0.0001"/>
    
    <!-- OUTRIG-01 Physical Mobile Manipulator -->
    <body name="outrig_base" pos="12.0 2.0 0.15">
      <joint name="base_x" type="slide" axis="1 0 0" damping="60"/>
      <joint name="base_y" type="slide" axis="0 1 0" damping="60"/>
      <joint name="base_yaw" type="hinge" axis="0 0 1" damping="30"/>
      <geom name="rover_chassis" type="box" size="0.38 0.28 0.12" rgba="0.18 0.22 0.28 1" mass="48"/>
      
      <!-- 6-DOF Articulated Robotic Arm -->
      <body name="arm_link_1" pos="0.16 0 0.12">
        <joint name="joint_1" type="hinge" axis="0 0 1" range="-3.14159 3.14159" damping="12"/>
        <geom name="arm_link1_geom" type="cylinder" size="0.055 0.08" rgba="0.3 0.35 0.42 1" mass="3.5"/>
        
        <body name="arm_link_2" pos="0 0 0.08">
          <joint name="joint_2" type="hinge" axis="0 1 0" range="-2.09 2.09" damping="12"/>
          <geom name="arm_link2_geom" type="capsule" fromto="0 0 0 0 0 0.35" size="0.045" rgba="0.82 0.85 0.9 1" mass="4.2"/>
          
          <body name="arm_link_3" pos="0 0 0.35">
            <joint name="joint_3" type="hinge" axis="0 1 0" range="-2.5 2.5" damping="9"/>
            <geom name="arm_link3_geom" type="capsule" fromto="0 0 0 0 0 0.32" size="0.038" rgba="0.82 0.85 0.9 1" mass="3.2"/>
            
            <body name="arm_link_4" pos="0 0 0.32">
              <joint name="joint_4" type="hinge" axis="1 0 0" range="-3.14159 3.14159" damping="6"/>
              <geom name="arm_link4_geom" type="cylinder" size="0.032 0.05" rgba="0.3 0.35 0.42 1" mass="1.6"/>
              
              <body name="arm_link_5" pos="0 0 0.05">
                <joint name="joint_5" type="hinge" axis="0 1 0" range="-1.85 1.85" damping="5"/>
                <geom name="arm_link5_geom" type="cylinder" size="0.03 0.04" rgba="0.3 0.35 0.42 1" mass="1.3"/>
                
                <body name="arm_link_6" pos="0 0 0.04">
                  <joint name="joint_6" type="hinge" axis="0 0 1" range="-3.14159 3.14159" damping="3"/>
                  <geom name="gripper_palm" type="box" size="0.032 0.045 0.02" rgba="0.2 0.25 0.32 1" mass="0.9"/>
                  
                  <!-- Parallel 2-Finger Mechanical Gripper -->
                  <body name="finger_left" pos="0.0 0.035 0.06">
                    <joint name="finger_left_j" type="slide" axis="0 -1 0" range="0 0.038" damping="25"/>
                    <geom name="finger_l_geom" type="box" size="0.018 0.008 0.032" rgba="0.92 0.94 0.96 1" mass="0.3" friction="3.0 0.01 0.001"/>
                  </body>
                  <body name="finger_right" pos="0.0 -0.035 0.06">
                    <joint name="finger_right_j" type="slide" axis="0 1 0" range="0 0.038" damping="25"/>
                    <geom name="finger_r_geom" type="box" size="0.018 0.008 0.032" rgba="0.92 0.94 0.96 1" mass="0.3" friction="3.0 0.01 0.001"/>
                  </body>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>
    </body>

    <!-- Spare Strainer Filter Cartridge (Rigid Free Object) -->
    <body name="strainer_cartridge" pos="12.45 2.0 0.06">
      <freejoint name="cartridge_free"/>
      <geom name="cartridge_geom" type="cylinder" size="0.022 0.045" rgba="0.12 0.75 0.92 1" mass="0.45" friction="3.0 0.01 0.001"/>
    </body>

    <!-- Service Bay Strainer Housing Receptacle: mounting block with two guide rails (x = +/-29 mm) forming a cradle -->
    <body name="strainer_fixture" pos="14.2 1.8 0.15">
      <geom name="fixture_mount" type="box" size="0.1 0.1 0.12" rgba="0.25 0.28 0.35 1" mass="80"/>
      <geom name="fixture_rail_a" type="box" size="0.004 0.05 0.02" pos="0.030 0 0.14" rgba="0.08 0.12 0.18 1" mass="2"/>
      <geom name="fixture_rail_b" type="box" size="0.004 0.05 0.02" pos="-0.030 0 0.14" rgba="0.08 0.12 0.18 1" mass="2"/>
    </body>
  </worldbody>

  <contact>
    <exclude body1="arm_link_5" body2="finger_left"/>
    <exclude body1="arm_link_5" body2="finger_right"/>
    <exclude body1="arm_link_4" body2="finger_left"/>
    <exclude body1="arm_link_4" body2="finger_right"/>
    <exclude body1="arm_link_5" body2="arm_link_6"/>
    <exclude body1="arm_link_3" body2="arm_link_5"/>
  </contact>

  <actuator>
    <motor name="act_base_x" joint="base_x" gear="160"/>
    <motor name="act_base_y" joint="base_y" gear="160"/>
    <motor name="act_base_yaw" joint="base_yaw" gear="90"/>
    <position name="act_j1" joint="joint_1" kp="300" kv="40"/>
    <position name="act_j2" joint="joint_2" kp="900" kv="90"/>
    <position name="act_j3" joint="joint_3" kp="700" kv="70"/>
    <position name="act_j4" joint="joint_4" kp="150" kv="15"/>
    <position name="act_j5" joint="joint_5" kp="300" kv="30"/>
    <position name="act_j6" joint="joint_6" kp="100" kv="10"/>
    <position name="act_finger_l" joint="finger_left_j" kp="2500" kv="100"/>
    <position name="act_finger_r" joint="finger_right_j" kp="2500" kv="100"/>
  </actuator>
</mujoco>
"""

@dataclass
class RigidObjectState:
    id: str
    name: str
    mass_kg: float
    pos_xyz: List[float]
    quat_xyzw: List[float]
    vel_xyz: List[float]
    held_by_robot_id: Optional[str] = None
    seated_in_fixture_id: Optional[str] = None
    contact_count: int = 0

@dataclass
class MechanicalRepairState:
    fixture_id: str = "FIXTURE-STRAINER-01"
    target_component_id: str = "STRAINER-01"
    is_isolated: bool = True
    cartridge_installed: bool = False
    mechanical_fit_pass: bool = False
    position_error_m: float = 999.0
    orientation_error_rad: float = 999.0
    pressure_drop_cleared: bool = False

class MuJoCoRuntime:
    """Authoritative physical physics worker running real contact dynamics,
    articulated robot joints, contact-based grasping, and tool actions.
    """
    ARM_JOINT_NAMES = ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"]
    
    # Pre-calculated canonical arm poses
    REST_POSE = [0.0, 0.2, 0.4, 0.0, 0.0, 0.0]
    REACH_DOWN_POSE = [0.0, 1.425, 2.0, 0.0, -1.2, 0.0]
    CARRY_POSE = [0.0, 0.35, 0.55, 0.0, -0.2, 0.0]

    def __init__(self, run_id: str = "run_01", bay_id: str = "strainer_01"):
        self.run_id = run_id
        self.bay_id = bay_id                       # the facility service bay this cell models (one cell per mechanically modelled strainer)
        self.owner: Optional[str] = None           # the OUTRIG that currently holds the cell
        self.tick = 0
        self.dt = 0.02  # Outer physics tick (50 Hz), inner substeps = 10 x 0.002s
        
        # State tracking
        self.base_pos = [12.0, 2.0, 0.15]
        self.base_yaw = 0.0
        self._ext_target = None
        self.set_anchor(*self.CELL_ORIGIN, math.pi / 2.0)          # identity anchor until the engine places the cell in the facility
        self.base_vel = [0.0, 0.0]
        self._omega_cmd = 0.0
        self._base_wvel = [0.0, 0.0, 0.0]
        self.arm_qpos = list(self.REST_POSE)
        self.arm_targets = list(self.REST_POSE)
        self.gripper_aperture = 0.07  # meters (open)
        self.gripper_target = 0.07
        self.held_object_id: Optional[str] = None
        self.active_tool_id: Optional[str] = "TOOL-PARALLEL-GRIPPER-2F"
        
        # In-pipe crawler deposit modeling (Vertical slice B)
        self.deposit_fouling_pct: float = 85.0  # initial severe fouling (85%)
        self.crawler_tool_active: bool = False
        
        # Mechanical repair state (Vertical slice A)
        nn = bay_id[-2:] if bay_id[-2:].isdigit() else "01"
        self.repair_state = MechanicalRepairState(fixture_id=f"FIXTURE-STRAINER-{nn}", target_component_id=f"STRAINER-{nn}")
        
        self.cartridge_state = RigidObjectState(
            id=f"STRAINER-CARTRIDGE-{nn}",
            name="Replacement 50-micron Strainer Cartridge",
            mass_kg=0.45,
            pos_xyz=[12.45, 2.0, 0.045],
            quat_xyzw=[0.0, 0.0, 0.0, 1.0],
            vel_xyz=[0.0, 0.0, 0.0],
        )

        # Grasp model: friction grasp between two MuJoCo finger pads (elliptic friction cone); there is no weld/attach
        # constraint. `held` is set on measured pad contact and cleared when contact is lost.
        self.grasp_model = "friction_contact_two_finger"
        self._lost_ticks = 0
        self.finger_force_N = {"left": 0.0, "right": 0.0}
        self.contact_geoms: List[str] = []
        self._model = None
        self._data = None
        self._cartridge_bid = -1
        self._link6_bid = -1
        
        if HAS_MUJOCO:
            self._init_mujoco()
        else:
            log.warning("MuJoCo library not loaded; running deterministic numeric kinematics fallback.")

    def _init_mujoco(self):
        try:
            self._model = mujoco.MjModel.from_xml_string(ROBOT_XML)
            self._data = mujoco.MjData(self._model)
            self._cartridge_bid = mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_BODY, "strainer_cartridge")
            self._link6_bid = mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_BODY, "arm_link_6")
            
            # Initial forward step
            mujoco.mj_forward(self._model, self._data)
            log.info("MuJoCo physical runtime initialized successfully.")
        except Exception as e:
            log.error(f"Failed to initialize MuJoCo model: {e}")
            self._model = None
            self._data = None

    # ------------------------------------------------------------------ facility <-> work-cell frame
    # The cell is MuJoCo-native (x, y, z-up, base start at CELL_ORIGIN). It is anchored in the facility at a service bay: a point
    # (mx, my, mz) of the cell is at facility (X, Y, Z) = Rxz(phi) . (mx - 12, mz, -(my - 2)) + (X0, 0, Z0), a pure axis permutation
    # (det +1: x east, y up, z south stays right-handed) plus a yaw by phi = pi/2 - psi0 so the cell's +x axis points along the bay heading psi0.
    CELL_ORIGIN = (12.0, 2.0)

    def set_anchor(self, x: float, z: float, heading_yaw_rad: float) -> None:
        self.anchor_xz = (float(x), float(z))
        self.anchor_yaw = float(heading_yaw_rad)
        self._phi = math.pi / 2.0 - self.anchor_yaw
        c, s = math.cos(self._phi), math.sin(self._phi)
        rxz = np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]])
        perm = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])       # (mx, my, mz) -> (X, Y, Z) = (mx, mz, -my)
        self._A = rxz @ perm

    def to_facility_point(self, local_xyz) -> List[float]:
        d = np.array([local_xyz[0] - self.CELL_ORIGIN[0], local_xyz[1] - self.CELL_ORIGIN[1], local_xyz[2]], dtype=float)
        f = self._A @ d
        return [float(f[0] + self.anchor_xz[0]), float(f[1]), float(f[2] + self.anchor_xz[1])]

    def to_local_planar(self, X: float, Z: float) -> Tuple[float, float]:
        d = self._A.T @ np.array([X - self.anchor_xz[0], 0.0, Z - self.anchor_xz[1]])
        return float(d[0] + self.CELL_ORIGIN[0]), float(d[1] + self.CELL_ORIGIN[1])

    def to_facility_quat(self, q_xyzw) -> List[float]:
        x, y, z, w = (float(v) for v in q_xyzw)
        rl = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                       [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                       [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m = self._A @ rl @ self._A.T
        tr = m[0, 0] + m[1, 1] + m[2, 2]
        if tr > 0:
            sq = math.sqrt(tr + 1.0) * 2
            qw, qx, qy, qz = 0.25 * sq, (m[2, 1] - m[1, 2]) / sq, (m[0, 2] - m[2, 0]) / sq, (m[1, 0] - m[0, 1]) / sq
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            sq = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
            qw, qx, qy, qz = (m[2, 1] - m[1, 2]) / sq, 0.25 * sq, (m[0, 1] + m[1, 0]) / sq, (m[0, 2] + m[2, 0]) / sq
        elif m[1, 1] > m[2, 2]:
            sq = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
            qw, qx, qy, qz = (m[0, 2] - m[2, 0]) / sq, (m[0, 1] + m[1, 0]) / sq, 0.25 * sq, (m[1, 2] + m[2, 1]) / sq
        else:
            sq = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
            qw, qx, qy, qz = (m[1, 0] - m[0, 1]) / sq, (m[0, 2] + m[2, 0]) / sq, (m[1, 2] + m[2, 1]) / sq, 0.25 * sq
        return [round(qx, 5), round(qy, 5), round(qz, 5), round(qw, 5)]

    def bind_base_to_facility_pose(self, X: float, Z: float, yaw_rad: float) -> None:
        """Jump the cell base onto a facility pose (binding / re-binding to a robot; no velocity)."""
        mx, my = self.to_local_planar(X, Z)
        self.base_pos[0], self.base_pos[1] = mx, my
        self.base_yaw = float((yaw_rad - self.anchor_yaw) % (2 * math.pi))
        self._base_wvel = [0.0, 0.0, 0.0]
        self.base_vel = [0.0, 0.0]
        self._ext_target = None

    def advance_with_base(self, duration_s: float, X: float, Z: float, yaw_rad: float) -> None:
        """Advance physics by `duration_s` while the base is moved (prescribed, linearly) from where it is to the facility pose the ENGINE
        computed for the robot. The engine owns the base pose; MuJoCo only follows it, so payload and arm feel a smooth velocity."""
        n = max(1, int(round(duration_s / self.dt)))
        tx, ty = self.to_local_planar(X, Z)
        tyaw = float((yaw_rad - self.anchor_yaw) % (2 * math.pi))
        dyaw = (tyaw - self.base_yaw + math.pi) % (2 * math.pi) - math.pi
        sx, sy, syaw = self.base_pos[0], self.base_pos[1], self.base_yaw
        for i in range(n):
            f = (i + 1) / n
            self._ext_target = (sx + (tx - sx) * f, sy + (ty - sy) * f, syaw + dyaw * f)
            self.step()
        self._ext_target = None

    def drive_base(self, vx: float, vy: float, omega: float):
        """Velocity intent for the mobile base (body-frame vx, vy; yaw rate) with physical limits. The base is integrated
        in step() as a prescribed-velocity joint motion so the arm and payload feel a smooth acceleration, not a jump."""
        vx = float(np.clip(vx, -0.6, 0.6))
        vy = float(np.clip(vy, -0.4, 0.4))
        omega = float(np.clip(omega, -1.2, 1.2))
        self.base_vel = [vx, vy]
        self._omega_cmd = omega

    def _integrate_base(self, dt: float) -> None:
        vx, vy = self.base_vel
        c, s = math.cos(self.base_yaw), math.sin(self.base_yaw)
        wx, wy = vx * c - vy * s, vx * s + vy * c
        # facility corridor collision bounds of the work cell [8..32 m in x, 0.5..15.5 m in y]
        nx = float(np.clip(self.base_pos[0] + wx * dt, 8.0, 32.0))
        ny = float(np.clip(self.base_pos[1] + wy * dt, 0.5, 15.5))
        self._base_wvel = [(nx - self.base_pos[0]) / dt, (ny - self.base_pos[1]) / dt, self._omega_cmd]
        self.base_pos[0], self.base_pos[1] = nx, ny
        self.base_yaw = float((self.base_yaw + self._omega_cmd * dt) % (2 * math.pi))

    def jog_joint(self, joint_idx: int, delta_rad: float):
        """Jog a single articulated joint (1..6) within physical limits."""
        if not 0 <= joint_idx < 6:
            return
        limits = [
            (-3.14, 3.14),
            (-2.0, 2.0),
            (-2.5, 2.5),
            (-3.14, 3.14),
            (-1.8, 1.8),
            (-3.14, 3.14),
        ]
        low, high = limits[joint_idx]
        new_q = np.clip(self.arm_targets[joint_idx] + delta_rad, low, high)
        self.arm_targets[joint_idx] = float(new_q)

    def set_arm_pose(self, qpos: List[float]):
        """Set all 6 joint targets at once."""
        if len(qpos) == 6:
            self.arm_targets = [float(x) for x in qpos]

    def set_gripper(self, aperture_m: float):
        """Set parallel gripper finger aperture (0.00m closed to 0.07m fully open)."""
        self.gripper_target = float(np.clip(aperture_m, 0.0, 0.07))
        if aperture_m >= 0.05 and self.held_object_id is not None:
            # Gripper opened: the pads release and the object falls under MuJoCo gravity
            self.held_object_id = None
            self.cartridge_state.held_by_robot_id = None

    GRIP_CENTER_LOCAL = (0.0, 0.0, 0.06)   # between the finger pads, in the arm_link_6 frame
    PICK_HORIZ_M = 0.02
    PICK_DZ_MAX_M = 0.03
    SEAT_XYZ = (14.2, 1.8, 0.315)           # cartridge rest pose in the fixture cradle (block top 0.27 m + half height 0.045)

    def _sync_base(self) -> None:
        """base_pos / base_yaw are the commanded base state; mirror them into the MuJoCo slide/hinge joints."""
        if self._data is None:
            return
        self._data.qpos[0] = self.base_pos[0] - 12.0
        self._data.qpos[1] = self.base_pos[1] - 2.0
        self._data.qpos[2] = self.base_yaw
        self._data.qvel[0:3] = self._base_wvel

    def grip_center(self) -> List[float]:
        """Finger-pad centre in the facility frame: from MuJoCo kinematics when available, else analytic FK."""
        if self._data is None:
            return self.get_end_effector_pose()[:3]
        self._sync_base()
        mujoco.mj_kinematics(self._model, self._data)
        r = self._data.xmat[self._link6_bid].reshape(3, 3)
        c = self._data.xpos[self._link6_bid] + r @ np.array(self.GRIP_CENTER_LOCAL)
        return [float(c[0]), float(c[1]), float(c[2])]

    def solve_arm_ik(self, target_xyz: List[float], iters: int = 200) -> Optional[List[float]]:
        """Damped-least-squares IK on a scratch MjData: pad centre -> target with the gripper axis pointing down.
        Uses the current base pose. Returns 6 joint angles (j1,j2,j3,j5 solved; j4=j6=0) or None if not reached (<8 mm)."""
        if self._model is None:
            return None
        d = mujoco.MjData(self._model)
        d.qpos[:] = self._data.qpos
        d.qpos[0] = self.base_pos[0] - 12.0
        d.qpos[1] = self.base_pos[1] - 2.0
        d.qpos[2] = self.base_yaw
        lo = self._model.jnt_range[3:9, 0]
        hi = self._model.jnt_range[3:9, 1]
        q = np.array([0.0, 0.9, 1.6, 0.0, 0.0, 0.0])
        free = [0, 1, 2, 4]
        tgt = np.array(target_xyz, dtype=float)
        # seed the base yaw joint toward the target (the rover may face any way when it stops at the bay)
        rx, ry = tgt[0] - self.base_pos[0], tgt[1] - self.base_pos[1]
        c, s_ = math.cos(-self.base_yaw), math.sin(-self.base_yaw)
        q[0] = float(np.clip(math.atan2(s_ * rx + c * ry, c * rx - s_ * ry), lo[0], hi[0]))
        for _ in range(iters):
            d.qpos[3:9] = q
            mujoco.mj_kinematics(self._model, d)
            mujoco.mj_comPos(self._model, d)
            r = d.xmat[self._link6_bid].reshape(3, 3)
            pt = d.xpos[self._link6_bid] + r @ np.array(self.GRIP_CENTER_LOCAL)
            err = np.concatenate([tgt - pt, -0.15 * np.array([r[0, 2], r[1, 2]])])        # axis z -> world -z
            if np.linalg.norm(err[:3]) < 0.004 and np.linalg.norm(err[3:]) < 0.01:
                break
            jp = np.zeros((3, self._model.nv))
            jr = np.zeros((3, self._model.nv))
            mujoco.mj_jac(self._model, d, jp, jr, pt, self._link6_bid)
            # orientation rows: d(z axis)/dq = jr x z ; keep horizontal components
            z = r[:, 2]
            jz = np.stack([np.cross(jr[:, i + 3], z) for i in range(6)], axis=1)
            J = np.vstack([jp[:, 3:9], 0.15 * jz[:2, :]])
            Jf = J[:, free]
            dq = Jf.T @ np.linalg.solve(Jf @ Jf.T + 1e-4 * np.eye(5), err)
            q[free] = np.clip(q[free] + 0.6 * dq, lo[free], hi[free])
        d.qpos[3:9] = q
        mujoco.mj_kinematics(self._model, d)
        r = d.xmat[self._link6_bid].reshape(3, 3)
        pt = d.xpos[self._link6_bid] + r @ np.array(self.GRIP_CENTER_LOCAL)
        if np.linalg.norm(tgt - pt) > 0.008:
            return None
        return [float(x) for x in q]

    def pick_cartridge(self) -> Tuple[bool, str]:
        """Close the two finger pads on the cartridge. Succeeds only if the pads are in the grasp envelope AND both press
        on it (measured contact force) after closing; `held_object_id` is then set from that contact, not from a flag."""
        gc = self.grip_center()
        c_pos = self.cartridge_state.pos_xyz
        dist = math.sqrt(sum((a - b) ** 2 for a, b in zip(gc, c_pos)))
        horiz = math.hypot(gc[0] - c_pos[0], gc[1] - c_pos[1])
        dz = gc[2] - c_pos[2]
        if horiz > self.PICK_HORIZ_M or not (-0.01 <= dz <= self.PICK_DZ_MAX_M):
            return False, (f"Gripper is too far from cartridge (distance {dist:.3f} m: {horiz * 1000:.0f} mm in plan, "
                           f"{dz * 1000:.0f} mm vertical; grasp envelope is {self.PICK_HORIZ_M * 1000:.0f} mm / 0..{self.PICK_DZ_MAX_M * 1000:.0f} mm)")
        if c_pos[2] < 0.035:
            return False, "Cartridge is not upright (lying on its side); grasp refused"
        self.gripper_target = 0.0
        if self._data is None:
            self.held_object_id = self.cartridge_state.id
            self.cartridge_state.held_by_robot_id = "OR-01"
            return True, "Grasp assumed (MuJoCo unavailable: kinematic fallback)"
        for _ in range(100):                       # up to 2 s for the pads to close and the force to build
            self.step()
            if self.contact_grounded and self.finger_force_N["left"] > 1.0 and self.finger_force_N["right"] > 1.0:
                self.held_object_id = self.cartridge_state.id
                self.cartridge_state.held_by_robot_id = "OR-01"
                f = self.finger_force_N
                return True, f"Grasped by finger-pad friction (measured pad forces {f['left']:.1f} N / {f['right']:.1f} N)"
        return False, "Pads closed without gripping the cartridge (no measured contact force)"

    def place_cartridge(self) -> Tuple[bool, str]:
        """Release the gripper; the cartridge then falls/rests under MuJoCo physics and is judged where it ended up."""
        if not self.held_object_id:
            return False, "No object held in gripper"
        self.gripper_target = 0.07
        self.gripper_aperture = 0.07
        self.held_object_id = None
        self.cartridge_state.held_by_robot_id = None
        if self._data is not None:
            for _ in range(75):                      # 1.5 s to settle under gravity
                self.step()
            end = self.cartridge_state.pos_xyz
            speed = float(np.linalg.norm(self.cartridge_state.vel_xyz))
        else:
            end, speed = self.get_end_effector_pose()[:3], 0.0
        sx, sy, sz = self.SEAT_XYZ
        horiz = math.hypot(end[0] - sx, end[1] - sy)
        vert = abs(end[2] - sz)
        self.repair_state.position_error_m = float(math.sqrt(horiz ** 2 + vert ** 2))
        if horiz < 0.035 and vert < 0.03 and speed < 0.05:
            self.repair_state.cartridge_installed = True
            self.repair_state.mechanical_fit_pass = True
            self.cartridge_state.seated_in_fixture_id = self.repair_state.fixture_id
            return True, f"Cartridge rests on the fixture seat (offset {horiz * 1000:.1f} mm horizontal, {vert * 1000:.1f} mm vertical)"
        return True, (f"Cartridge released but NOT seated: ended at ({end[0]:.2f}, {end[1]:.2f}, {end[2]:.2f}); "
                      f"{horiz * 1000:.0f} mm horizontal from the fixture seat")

    def clean_inpipe_deposit(self, dt: float = 0.5, work_effort: float = 0.5) -> Tuple[float, bool]:
        """Perform physical deposit clearing tool action for INPIPE crawler.
        Gradually removes deposit mass proportional to tool contact time.
        """
        effort = max(dt, work_effort)
        if self.deposit_fouling_pct <= 0.0:
            return 0.0, True
        
        # Material removal rate: rapid clearing under active mechanical brushing
        cleared_delta = 30.0 * effort
        self.deposit_fouling_pct = max(0.0, self.deposit_fouling_pct - cleared_delta)
        is_done = self.deposit_fouling_pct <= 5.0
        return self.deposit_fouling_pct, is_done

    def step(self):
        """Advance authoritative physics by one tick (dt = 0.02s)."""
        self.tick += 1
        
        # Smooth joint easing toward targets
        for i in range(6):
            diff = self.arm_targets[i] - self.arm_qpos[i]
            step_lim = 1.8 * self.dt  # 1.8 rad/s max joint speed
            self.arm_qpos[i] += np.clip(diff, -step_lim, step_lim)
            
        # Gripper easing
        g_diff = self.gripper_target - self.gripper_aperture
        self.gripper_aperture += np.clip(g_diff, -0.08 * self.dt, 0.08 * self.dt)
        
        if self._data is not None and self._model is not None:
            # Map arm positions to actuators
            # Actuator indices: 0..2 base, 3..8 arm joints, 9..10 fingers
            for i in range(6):
                self._data.ctrl[3 + i] = self.arm_qpos[i]
            
            finger_disp = float(np.clip((0.07 - self.gripper_aperture) / 2.0, 0.0, 0.035))
            self._data.ctrl[9] = finger_disp
            self._data.ctrl[10] = finger_disp
            
            # Execute 10 substeps of 0.002s (total 0.02s); base_pos/base_yaw are the commanded base state
            bx0, by0, bw0 = self.base_pos[0], self.base_pos[1], self.base_yaw
            if self._ext_target is not None:
                tx, ty, tw = self._ext_target
                self._base_wvel = [(tx - bx0) / self.dt, (ty - by0) / self.dt, (tw - bw0) / self.dt]
                self.base_pos[0], self.base_pos[1], self.base_yaw = tx, ty, tw
            else:
                self._integrate_base(self.dt)
            h = self.dt / 10.0
            wv = self._base_wvel
            # The base is PRESCRIBED (position and velocity are overwritten every substep). Its joint damping then acts as a spurious drag force
            # (60 N per m/s) that tears a held payload out of the pads at ~0.2 m/s, but the same damping is what stiffens the parked base against
            # the arm's reaction when it is NOT moving (measured: payload kept at 0.2 m/s with 0, lost at the fixture with 0). So: damped when parked.
            ext = self._ext_target is not None                  # only for the engine-coupled base; the stand-alone cell keeps its tuned damping
            moving = ext and abs(wv[0]) + abs(wv[1]) > 1e-6
            self._model.dof_damping[0:2] = 0.0 if moving else 60.0
            self._model.dof_damping[2] = 0.0 if ext and abs(wv[2]) > 1e-6 else 30.0
            for k in range(10):
                # prescribed base motion, advanced smoothly through the sub-steps (the arm/payload see a velocity, not a jump)
                self._data.qpos[0] = bx0 + wv[0] * h * (k + 1) - 12.0
                self._data.qpos[1] = by0 + wv[1] * h * (k + 1) - 2.0
                self._data.qpos[2] = bw0 + wv[2] * h * (k + 1)
                self._data.qvel[0:3] = wv
                mujoco.mj_step(self._model, self._data)

            # Extract cartridge state (position + velocity are MuJoCo's, not integrated here)
            c_pos = self._data.xpos[self._cartridge_bid]
            self.cartridge_state.pos_xyz = [float(c_pos[0]), float(c_pos[1]), float(c_pos[2])]
            cq = self._data.xquat[self._cartridge_bid]                 # MuJoCo (w, x, y, z)
            self.cartridge_state.quat_xyzw = [float(cq[1]), float(cq[2]), float(cq[3]), float(cq[0])]
            dofadr = int(self._model.body_dofadr[self._cartridge_bid])
            self.cartridge_state.vel_xyz = [float(v) for v in self._data.qvel[dofadr:dofadr + 3]]
            self._measure_contacts()
            if self.held_object_id and not self.contact_grounded:
                self._lost_ticks += 1
                if self._lost_ticks >= 5:                  # contact lost for 0.1 s: the payload slipped / was dropped
                    self.held_object_id = None
                    self.cartridge_state.held_by_robot_id = None
            else:
                self._lost_ticks = 0
        else:
            # Fallback kinematics
            if self.held_object_id:
                ee = self.get_end_effector_pose()
                self.cartridge_state.pos_xyz = [ee[0], ee[1], ee[2] - 0.03]
            elif not self.repair_state.cartridge_installed and self.cartridge_state.pos_xyz[2] > 0.045:
                # Gravity drop
                self.cartridge_state.pos_xyz[2] = max(0.045, self.cartridge_state.pos_xyz[2] - 9.81 * (self.dt ** 2) * 50)

    def _measure_contacts(self) -> None:
        """Real contact data: normal force of each finger pad on the cartridge, geoms touching it."""
        m, d = self._model, self._data
        names = {"left": mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "finger_l_geom"),
                 "right": mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "finger_r_geom")}
        cg = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "cartridge_geom")
        forces = {"left": 0.0, "right": 0.0}
        touching: List[str] = []
        f6 = np.zeros(6)
        n = 0
        for k in range(d.ncon):
            con = d.contact[k]
            if cg not in (con.geom1, con.geom2):
                continue
            n += 1
            other = con.geom2 if con.geom1 == cg else con.geom1
            nm = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, other) or str(other)
            if nm not in touching:
                touching.append(nm)
            for side, gid in names.items():
                if other == gid:
                    mujoco.mj_contactForce(m, d, k, f6)
                    forces[side] += abs(float(f6[0]))
        self.finger_force_N = {k: round(v, 3) for k, v in forces.items()}
        self.contact_geoms = touching
        self.cartridge_state.contact_count = n

    @property
    def contact_grounded(self) -> bool:
        """True only if BOTH finger pads currently press on the cartridge (measured, > 0.2 N each)."""
        return self.finger_force_N["left"] > 0.2 and self.finger_force_N["right"] > 0.2

    def get_end_effector_pose(self) -> List[float]:
        """Compute end-effector [x, y, z, roll, pitch, yaw] in facility world frame (pad centre from MuJoCo when loaded)."""
        if self._data is not None and self.grip_center is not None:
            gc = self.grip_center()
            j = self.arm_qpos
            return [gc[0], gc[1], gc[2], float(j[3]), float(j[1] + j[2] + j[4]), float(j[5])]
        # Base translation & rotation
        bx, by, bz = self.base_pos
        yaw = self.base_yaw
        
        j1, j2, j3, j4, j5, j6 = self.arm_qpos
        # Forward kinematics for 2-link planar arm projection
        L1, L2, L3 = 0.35, 0.32, 0.11
        r = L1 * math.sin(j2) + L2 * math.sin(j2 + j3) + L3 * math.sin(j2 + j3 + j5)
        z = bz + 0.20 + L1 * math.cos(j2) + L2 * math.cos(j2 + j3) + L3 * math.cos(j2 + j3 + j5)
        
        total_yaw = yaw + j1
        x = bx + r * math.cos(total_yaw)
        y = by + r * math.sin(total_yaw)
        return [float(x), float(y), float(z), float(j4), float(j2 + j3 + j5), float(j6)]

    @property
    def end_effector_pose(self) -> Dict[str, Any]:
        """Provides pose dict with pos_xyz and quat_xyzw."""
        pos = self.get_end_effector_pose()
        return {"pos_xyz": pos[:3], "quat_xyzw": [0.0, 0.0, 0.0, 1.0]}

    # ------------------------------------------------------------------ snapshot / restore (replay, fork, restart)
    def get_state(self) -> Dict[str, Any]:
        """Everything needed to continue the cell bit-for-bit on the same MuJoCo build: full qpos/qvel/act of the model plus the command-side
        state (eased joint targets, gripper, hold bookkeeping, mechanical-repair flags). JSON-serialisable (floats via repr-exact lists)."""
        import dataclasses
        d = self._data
        return {
            "v": 1, "tick": self.tick, "mujoco": bool(d is not None),
            "qpos": [float(x) for x in d.qpos] if d is not None else None,
            "qvel": [float(x) for x in d.qvel] if d is not None else None,
            "act": [float(x) for x in d.act] if d is not None and self._model.na else [],
            "ctrl": [float(x) for x in d.ctrl] if d is not None else None,
            "base_pos": list(map(float, self.base_pos)), "base_yaw": float(self.base_yaw), "base_vel": list(map(float, self.base_vel)),
            "omega_cmd": float(self._omega_cmd), "base_wvel": list(map(float, self._base_wvel)),
            "arm_qpos": list(map(float, self.arm_qpos)), "arm_targets": list(map(float, self.arm_targets)),
            "gripper_aperture": float(self.gripper_aperture), "gripper_target": float(self.gripper_target),
            "held_object_id": self.held_object_id, "lost_ticks": int(self._lost_ticks),
            "deposit_fouling_pct": float(self.deposit_fouling_pct),
            "finger_force_N": dict(self.finger_force_N), "contact_geoms": list(self.contact_geoms),
            "cartridge": dataclasses.asdict(self.cartridge_state), "repair": dataclasses.asdict(self.repair_state),
            "anchor": {"x": self.anchor_xz[0], "z": self.anchor_xz[1], "yaw": self.anchor_yaw}, "spares_used": getattr(self, "spares_used", 0),
        }

    def set_state(self, st: Dict[str, Any]) -> None:
        if st.get("v") != 1:
            raise ValueError("unsupported workcell state version")
        self.tick = int(st["tick"])
        self.base_pos, self.base_yaw = list(st["base_pos"]), float(st["base_yaw"])
        self.base_vel, self._omega_cmd, self._base_wvel = list(st["base_vel"]), float(st["omega_cmd"]), list(st["base_wvel"])
        self.arm_qpos, self.arm_targets = list(st["arm_qpos"]), list(st["arm_targets"])
        self.gripper_aperture, self.gripper_target = float(st["gripper_aperture"]), float(st["gripper_target"])
        self.held_object_id, self._lost_ticks = st["held_object_id"], int(st["lost_ticks"])
        self.deposit_fouling_pct = float(st["deposit_fouling_pct"])
        self.finger_force_N, self.contact_geoms = dict(st["finger_force_N"]), list(st["contact_geoms"])
        for k, v in st["cartridge"].items():
            setattr(self.cartridge_state, k, v)
        for k, v in st["repair"].items():
            setattr(self.repair_state, k, v)
        self.set_anchor(st["anchor"]["x"], st["anchor"]["z"], st["anchor"]["yaw"])
        self.spares_used = int(st.get("spares_used", 0))
        self._ext_target = None
        if self._data is not None and st.get("qpos") is not None:
            self._data.qpos[:] = st["qpos"]
            self._data.qvel[:] = st["qvel"]
            if st.get("act"):
                self._data.act[:] = st["act"]
            self._data.ctrl[:] = st["ctrl"]
            mujoco.mj_forward(self._model, self._data)

    def restock(self) -> Dict[str, Any]:
        """Start of a NEW service cycle on this fixture: logistics (outside the simulation) swap the used cartridge for a fresh spare. The old part is
        removed from the fixture and a new spare is placed on the cradle at its original pose; mechanical flags are cleared. Counted and reported,
        never a repair by itself (the plant is not touched)."""
        self.spares_used = getattr(self, "spares_used", 0) + 1
        self.held_object_id = None
        self.cartridge_state.held_by_robot_id = None
        self.cartridge_state.seated_in_fixture_id = None
        self.repair_state.cartridge_installed = False
        self.repair_state.mechanical_fit_pass = False
        self.repair_state.position_error_m = 999.0
        home = [12.45, 2.0, 0.0449]
        self.cartridge_state.pos_xyz = list(home)
        self.cartridge_state.quat_xyzw = [0.0, 0.0, 0.0, 1.0]
        self.cartridge_state.vel_xyz = [0.0, 0.0, 0.0]
        if self._data is not None:
            adr = int(self._model.jnt_qposadr[mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_JOINT, "cartridge_free")])
            self._data.qpos[adr:adr + 7] = [home[0], home[1], 0.06, 1.0, 0.0, 0.0, 0.0]
            vadr = int(self._model.jnt_dofadr[mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_JOINT, "cartridge_free")])
            self._data.qvel[vadr:vadr + 6] = 0.0
            mujoco.mj_forward(self._model, self._data)
        return {"bay_id": self.bay_id, "spares_used": self.spares_used, "cartridge_id": self.cartridge_state.id}

    def to_robot_state_dict(self, robot_id: str = "OR-01") -> Dict[str, Any]:
        """Produces strict live server-owned robot state contract per Section 3."""
        ee = self.get_end_effector_pose()
        ee_f = self.to_facility_point(ee[:3])
        return {
            "frame_id": "facility_world",
            "bay_id": self.bay_id, "cell_anchor": {"x_m": self.anchor_xz[0], "z_m": self.anchor_xz[1], "heading_yaw_rad": self.anchor_yaw},
            "robot_id": robot_id,
            "run_id": self.run_id,
            "robot_class": "OUTRIG",
            "rig_type": "mobile_manipulator_6dof",
            "authority_owner": "autonomous",
            "world_pose_xyz_m": [round(x, 4) for x in self.to_facility_point([self.base_pos[0], self.base_pos[1], self.base_pos[2]])],
            "quat_xyzw": [0.0, round(math.sin((self.base_yaw + self.anchor_yaw) / 2), 4), 0.0, round(math.cos((self.base_yaw + self.anchor_yaw) / 2), 4)],
            "linear_vel_mps": [round(x, 4) for x in self.base_vel],
            "angular_vel_radps": 0.0,
            "arm_joint_names": self.ARM_JOINT_NAMES,
            "arm_qpos_rad": [round(x, 4) for x in self.arm_qpos],          # eased command sent to the position actuators
            "arm_qpos_measured_rad": ([round(float(x), 4) for x in self._data.qpos[3:9]] if self._data is not None else None),
            "end_effector_pose": {"pos_xyz": [round(x, 4) for x in ee_f], "quat_xyzw": (0.0, 0.0, 0.0, 1.0)},
            "gripper_aperture_m": round(self.gripper_aperture, 4),
            "grip_force_N": round(self.finger_force_N["left"] + self.finger_force_N["right"], 3),
            "finger_force_N": self.finger_force_N,
            "contact_grounded": self.contact_grounded,
            "grasp_model": self.grasp_model,
            "held_object_id": self.held_object_id,
            "active_tool_id": self.active_tool_id,
            "contact_list": list(self.contact_geoms),
            "payload_mass_kg": self.cartridge_state.mass_kg if self.held_object_id else 0.0,
            "battery_Wh": 420.0,
            "energy_used_Wh": float(self.tick * 0.05),
            "mode": "MANIPULATING" if self.held_object_id else "BASE_DRIVE",
            "deposit_fouling_pct": round(self.deposit_fouling_pct, 1),
            "mechanical_service_completed": self.repair_state.cartridge_installed,
            "spares_used": getattr(self, "spares_used", 0),
            "last_physics_tick": self.tick,
        }
