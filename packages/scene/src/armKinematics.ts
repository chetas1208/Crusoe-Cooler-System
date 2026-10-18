import * as THREE from 'three';

/**
 * OUTRIG 6-DOF arm: forward kinematics + joint smoothing. Pure (no React, no store) so it is unit-testable.
 *
 * The link lengths, joint axes and finger layout are copied from the backend's MuJoCo model
 * (backend/src/loopkeeper/robotics/mujoco_runtime.py, ROBOT_XML). That model is z-up with +x chassis-forward; the scene is y-up
 * with +z chassis-forward, so every sim frame is re-expressed by one proper axis permutation (sim x,y,z -> scene z,x,y).
 * Joint angles keep their sign under that permutation (it has determinant +1).
 *
 *   arm origin = chassis top (backend: base body + (0.16, 0, 0.12))
 *   joint_1 z   body 0       cylinder r .055, h .16 (centred on the joint)
 *   joint_2 y   +0.08        capsule 0..0.35, r .045
 *   joint_3 y   +0.35        capsule 0..0.32, r .038
 *   joint_4 x   +0.32        cylinder r .032, h .10 (centred)
 *   joint_5 y   +0.05        cylinder r .030, h .08 (centred)
 *   joint_6 z   +0.04        palm box .064 x .090 x .040 (centred); finger pads at (0, +-0.035, 0.06) sliding inward
 *   grip centre (end effector) = link_6 + (0, 0, 0.06)
 */

export const ARM_DIMS = {
  /** chassis-local mount of the arm origin (scene axes: x left, y up, z forward) */
  mount: [0, 0.27, 0.16] as const,
  l1: { r: 0.055, h: 0.16 },
  d12: 0.08,
  l2: { r: 0.045, len: 0.35 },
  l3: { r: 0.038, len: 0.32 },
  l4: { r: 0.032, h: 0.1 },
  d45: 0.05,
  l5: { r: 0.03, h: 0.08 },
  d56: 0.04,
  palm: [0.064, 0.09, 0.04] as const,
  finger: { half: [0.018, 0.008, 0.032] as const, y: 0.035, z: 0.06 },
  grip: 0.06,
  apertureOpen: 0.07,
  fingerMax: 0.035,
} as const;

/** MuJoCo joint ranges (rad); used only when the server does not publish its own limits */
export const DEFAULT_JOINT_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [-3.14159, 3.14159],
  [-2.09, 2.09],
  [-2.5, 2.5],
  [-3.14159, 3.14159],
  [-1.85, 1.85],
  [-3.14159, 3.14159],
];

/** the backend's stowed pose (MuJoCoRuntime.REST_POSE) */
export const REST_JOINTS: ReadonlyArray<number> = [0, 0.2, 0.4, 0, 0, 0];

export interface ManipulatorState {
  joints_rad: number[];
  joint_limits_rad?: number[][];
  gripper_aperture_m?: number;
  held_object_id?: string | null;
  ee_xyz_m?: [number, number, number];
  ee_quat_xyzw?: [number, number, number, number];
  busy?: boolean;
}

interface RobotArmFields {
  manipulator?: Partial<ManipulatorState> | null;
  arm_qpos_rad?: number[];
  gripper_aperture_m?: number;
  held_object_id?: string | null;
}

const isNums = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length >= n && a.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The robot's manipulator state: `robot.manipulator` (V12 arm contract) when present, else the older flat
 * arm_qpos_rad / gripper_aperture_m / held_object_id fields. null = no joint data at all (the arm is drawn stowed).
 */
export function readManipulator(r: RobotArmFields | undefined | null): ManipulatorState | null {
  if (!r) return null;
  const m = r.manipulator;
  if (m && isNums(m.joints_rad, 6)) {
    return {
      joints_rad: m.joints_rad,
      joint_limits_rad: m.joint_limits_rad,
      gripper_aperture_m: typeof m.gripper_aperture_m === 'number' ? m.gripper_aperture_m : r.gripper_aperture_m,
      held_object_id: m.held_object_id !== undefined ? m.held_object_id : r.held_object_id,
      ee_xyz_m: m.ee_xyz_m,
      ee_quat_xyzw: m.ee_quat_xyzw,
      busy: m.busy,
    };
  }
  if (isNums(r.arm_qpos_rad, 6)) return { joints_rad: r.arm_qpos_rad, gripper_aperture_m: r.gripper_aperture_m, held_object_id: r.held_object_id };
  return null;
}

/* ───────────────────────────── smoothing ───────────────────────────── */

export const MIN_SEG_S = 0.06;
export const MAX_SEG_S = 0.5;

/**
 * Joint/gripper smoothing between server updates. Each distinct server sample starts a linear segment from whatever is
 * currently displayed to the new value, lasting about one observed update interval; the value then holds. It never
 * extrapolates past the last sample, so a stalled stream freezes the arm instead of inventing motion.
 * 7 channels: joints 1..6 then gripper aperture. No allocation after construction.
 */
export class ArmInterp {
  readonly from = new Float64Array(7);
  readonly to = new Float64Array(7);
  private t0 = 0;
  private dur = 0.25;
  private lastChange = -1;
  private inited = false;

  /** the newest server sample (any time base, seconds). Identical repeats are ignored. */
  push(q: ArrayLike<number>, aperture: number, now: number): void {
    if (!this.inited) {
      for (let i = 0; i < 6; i++) this.to[i] = this.from[i] = q[i];
      this.to[6] = this.from[6] = aperture;
      this.inited = true;
      this.t0 = now;
      return;
    }
    let changed = Math.abs(aperture - this.to[6]) > 1e-6;
    for (let i = 0; i < 6 && !changed; i++) if (Math.abs(q[i] - this.to[i]) > 1e-6) changed = true;
    if (!changed) return;
    this.sample(now, this.from); // what is on screen right now becomes the segment start
    if (this.lastChange >= 0) this.dur = Math.min(MAX_SEG_S, Math.max(MIN_SEG_S, 0.6 * this.dur + 0.4 * (now - this.lastChange)));
    this.lastChange = now;
    this.t0 = now;
    for (let i = 0; i < 6; i++) this.to[i] = q[i];
    this.to[6] = aperture;
  }

  get ready(): boolean {
    return this.inited;
  }

  /** value at `now`, written to out[0..6]; always between `from` and `to` */
  sample(now: number, out: Float64Array | number[]): void {
    const f = this.dur > 0 ? Math.min(1, Math.max(0, (now - this.t0) / this.dur)) : 1;
    for (let i = 0; i < 7; i++) out[i] = this.from[i] + (this.to[i] - this.from[i]) * f;
  }
}

/* ───────────────────────────── forward kinematics ───────────────────────────── */

export const PART = { L1: 0, L2: 1, L3: 2, L4: 3, L5: 4, PALM: 5, FL: 6, FR: 7, EE: 8 } as const;
export const PART_COUNT = 9;

/** sim (x fwd, y left, z up) -> scene (x left, y up, z fwd) */
const P = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);
const BASE = new THREE.Matrix4().makeTranslation(ARM_DIMS.mount[0], ARM_DIMS.mount[1], ARM_DIMS.mount[2]).multiply(P);

const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _s = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];

export function makePartMatrices(): THREE.Matrix4[] {
  return Array.from({ length: PART_COUNT }, () => new THREE.Matrix4());
}

/** finger slide from aperture (backend: disp = clip((0.07 - aperture) / 2, 0, 0.035)) */
export function fingerDisp(aperture: number): number {
  return Math.min(ARM_DIMS.fingerMax, Math.max(0, (ARM_DIMS.apertureOpen - aperture) / 2));
}

export function clampJoints(q: ArrayLike<number>, limits: ReadonlyArray<ArrayLike<number>> | undefined, out: number[]): void {
  for (let i = 0; i < 6; i++) {
    const lim = limits && limits[i] && limits[i].length >= 2 && Number.isFinite(limits[i][0]) && Number.isFinite(limits[i][1]) ? limits[i] : DEFAULT_JOINT_LIMITS[i];
    out[i] = Math.min(lim[1], Math.max(lim[0], q[i]));
  }
}

/**
 * Link frames in the chassis frame (scene axes, origin on the floor under the chassis centre) for joints q[0..5] and gripper
 * aperture. Geometry is authored in sim axes (link along local +z), so these matrices already carry the sim->scene permutation.
 */
export function armFK(q: ArrayLike<number>, aperture: number, out: THREE.Matrix4[]): void {
  const D = ARM_DIMS;
  const M1 = _s[0].copy(BASE).multiply(_t.makeRotationZ(q[0]));
  out[PART.L1].copy(M1);
  const M2 = _s[1].copy(M1).multiply(_t.makeTranslation(0, 0, D.d12)).multiply(_m.makeRotationY(q[1]));
  out[PART.L2].copy(M2);
  const M3 = _s[2].copy(M2).multiply(_t.makeTranslation(0, 0, D.l2.len)).multiply(_m.makeRotationY(q[2]));
  out[PART.L3].copy(M3);
  const M4 = _s[3].copy(M3).multiply(_t.makeTranslation(0, 0, D.l3.len)).multiply(_m.makeRotationX(q[3]));
  out[PART.L4].copy(M4);
  const M5 = _s[4].copy(M4).multiply(_t.makeTranslation(0, 0, D.d45)).multiply(_m.makeRotationY(q[4]));
  out[PART.L5].copy(M5);
  const M6 = _s[5].copy(M5).multiply(_t.makeTranslation(0, 0, D.d56)).multiply(_m.makeRotationZ(q[5]));
  out[PART.PALM].copy(M6);
  const d = fingerDisp(aperture);
  out[PART.FL].copy(M6).multiply(_t.makeTranslation(0, D.finger.y - d, D.finger.z));
  out[PART.FR].copy(M6).multiply(_t.makeTranslation(0, -D.finger.y + d, D.finger.z));
  out[PART.EE].copy(M6).multiply(_t.makeTranslation(0, 0, D.grip));
}

/** end-effector position in the chassis frame */
export function eeChassis(q: ArrayLike<number>, aperture: number, out: THREE.Vector3, scratch: THREE.Matrix4[] = SCRATCH): THREE.Vector3 {
  armFK(q, aperture, scratch);
  return out.setFromMatrixPosition(scratch[PART.EE]);
}
const SCRATCH = makePartMatrices();

/** per-robot end-effector world position, written by the fleet each frame and read by the arm close-up camera */
export const armRig = {
  ee: {} as Record<string, { pos: THREE.Vector3; valid: boolean }>,
};
export function armRigFor(id: string) {
  return (armRig.ee[id] ??= { pos: new THREE.Vector3(), valid: false });
}

/* ───────────────────────────── level of detail ───────────────────────────── */

export type ArmLod = 'full' | 'stick' | 'none';
export const LOD_FULL_M = 6;
export const LOD_STICK_M = 16;
/** hysteresis keeps an arm near a boundary from flickering between levels */
export function armLod(distM: number, prev: ArmLod): ArmLod {
  const h = 0.6;
  const full = prev === 'full' ? LOD_FULL_M + h : LOD_FULL_M - h;
  const stick = prev === 'none' ? LOD_STICK_M - h : LOD_STICK_M + h;
  return distM < full ? 'full' : distM < stick ? 'stick' : 'none';
}
