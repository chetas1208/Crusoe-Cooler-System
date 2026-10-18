/**
 * OUTRIG manipulator model for the operator UI: one place that turns whatever the backend publishes about the arm into a single
 * shape, so the panel renders the same for every OUTRIG robot. Pure functions, no store access.
 *
 * Sources, best first:
 *   robot.manipulator  = { joints_rad[6], joint_limits_rad[6][2], gripper_aperture_m, held_object_id, ee_xyz_m, ee_quat_xyzw, busy }  (V12 arm contract)
 *   legacy flat fields = arm_qpos_rad, gripper_aperture_m, held_object_id, end_effector_pose  (V5 MuJoCo)
 * Anything missing falls back to the backend's documented joint limits; nothing is invented about the arm's pose.
 */

export const ARM_JOINT_COUNT = 6;
/** the sandbox's physical joint limits (rad), used only until the server publishes its own */
export const ARM_FALLBACK_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [-3.14, 3.14],
  [-2.0, 2.0],
  [-2.5, 2.5],
  [-3.14, 3.14],
  [-1.8, 1.8],
  [-3.14, 3.14],
];
export const GRIPPER_RANGE_M: readonly [number, number] = [0, 0.07];
/** The sandbox's rest pose (MuJoCo REST_POSE): where "Home" and "Stow" lead when the server has no named pose action (client-stepped jogs). Stow also closes the gripper. */
export const ARM_HOME_POSE: ReadonlyArray<number> = [0, 0.2, 0.4, 0, 0, 0];
export const ARM_STOW_POSE: ReadonlyArray<number> = ARM_HOME_POSE;
export const JOG_STEP_RAD = 0.05;
/** largest single jog the UI will ask for (the server clips to joint limits anyway) */
export const JOG_MAX_RAD = 0.35;

export interface ManipulatorView {
  /** true when the server published the V12 `manipulator` block, false when read from legacy fields, null-like when nothing at all */
  source: 'manipulator' | 'legacy' | 'none';
  joints: number[];
  limits: Array<[number, number]>;
  jointKnown: boolean;
  gripperM: number | null;
  heldObjectId: string | null;
  gripForceN: number | null;
  ee: { xyz: [number, number, number]; quat: [number, number, number, number] | null } | null;
  busy: boolean;
}

type Loose = Record<string, unknown> | undefined | null;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const arr6 = (x: unknown): number[] | null => (Array.isArray(x) && x.length >= ARM_JOINT_COUNT && x.slice(0, ARM_JOINT_COUNT).every(num) ? (x.slice(0, ARM_JOINT_COUNT) as number[]) : null);

export function readManipulator(robot: unknown): ManipulatorView {
  const r = (robot ?? {}) as Record<string, unknown>;
  const m = r.manipulator as Loose;
  const legacyJ = arr6(r.arm_qpos_rad);
  const mj = m ? arr6(m.joints_rad) : null;
  const joints = mj ?? legacyJ ?? new Array(ARM_JOINT_COUNT).fill(0);
  const limRaw = m?.joint_limits_rad;
  const limits: Array<[number, number]> = ARM_FALLBACK_LIMITS.map((l, i) => {
    const x = Array.isArray(limRaw) ? (limRaw[i] as unknown) : null;
    return Array.isArray(x) && num(x[0]) && num(x[1]) && x[1] > x[0] ? [x[0], x[1]] : [l[0], l[1]];
  });
  const gM = m && num(m.gripper_aperture_m) ? m.gripper_aperture_m : num(r.gripper_aperture_m) ? r.gripper_aperture_m : null;
  const held = m && 'held_object_id' in m ? (m.held_object_id as string | null | undefined) ?? null : ((r.held_object_id as string | null | undefined) ?? null);
  const eeXyz = m ? (m.ee_xyz_m as unknown) : (r.end_effector_pose as Loose)?.pos_xyz;
  const eeQ = m ? (m.ee_quat_xyzw as unknown) : (r.end_effector_pose as Loose)?.quat_xyzw;
  const xyz = Array.isArray(eeXyz) && eeXyz.length >= 3 && eeXyz.slice(0, 3).every(num) ? ([eeXyz[0], eeXyz[1], eeXyz[2]] as [number, number, number]) : null;
  const q = Array.isArray(eeQ) && eeQ.length >= 4 && eeQ.slice(0, 4).every(num) ? ([eeQ[0], eeQ[1], eeQ[2], eeQ[3]] as [number, number, number, number]) : null;
  return {
    source: m ? 'manipulator' : legacyJ ? 'legacy' : 'none',
    joints,
    limits,
    jointKnown: !!(mj ?? legacyJ),
    gripperM: gM,
    heldObjectId: held,
    gripForceN: num(r.grip_force_N) ? r.grip_force_N : null,
    ee: xyz ? { xyz, quat: q } : null,
    busy: !!(m && m.busy),
  };
}

export const clampRad = (x: number, lim: readonly [number, number]) => Math.max(lim[0], Math.min(lim[1], x));
export const clampJog = (d: number) => (Number.isFinite(d) ? Math.max(-JOG_MAX_RAD, Math.min(JOG_MAX_RAD, d)) : 0);

/** 0..1 position of a joint inside its limits, for the limit bar */
export function limitFraction(q: number, lim: readonly [number, number]): number {
  const span = lim[1] - lim[0];
  return span > 0 ? Math.max(0, Math.min(1, (q - lim[0]) / span)) : 0.5;
}

/** true when a jog in `dir` (+1/-1) would only push into the limit the joint is already at */
export function atLimit(q: number, lim: readonly [number, number], dir: 1 | -1, eps = 0.01): boolean {
  return dir > 0 ? q >= lim[1] - eps : q <= lim[0] + eps;
}

/** Per-joint jog deltas that move `from` toward `to` by at most `maxStep` each; joints within `tol` are left out. */
export function stepToward(from: ReadonlyArray<number>, to: ReadonlyArray<number>, maxStep = JOG_MAX_RAD, tol = 0.02): Array<{ idx: number; delta: number }> {
  const out: Array<{ idx: number; delta: number }> = [];
  for (let i = 0; i < ARM_JOINT_COUNT; i++) {
    const e = (to[i] ?? 0) - (from[i] ?? 0);
    if (Math.abs(e) > tol) out.push({ idx: i, delta: Math.max(-maxStep, Math.min(maxStep, e)) });
  }
  return out;
}

export const degrees = (rad: number) => (rad * 180) / Math.PI;
