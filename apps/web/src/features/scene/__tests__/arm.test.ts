import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARM_DIMS,
  ArmInterp,
  PART,
  armFK,
  armLod,
  clampJoints,
  fingerDisp,
  makePartMatrices,
  readManipulator,
  REST_JOINTS,
} from '../../../../../../packages/scene/src/armKinematics';

/**
 * Golden values come from the backend's own MuJoCo model (ROBOT_XML in robotics/mujoco_runtime.py), joints set directly,
 * base at the origin with yaw 0, pad centre = link_6 + R * (0, 0, 0.06), expressed relative to the arm origin
 * (base + (0.16, 0, 0.12)). Sim frame: x forward, y left, z up. The scene frame is x left, y up, z forward.
 */
const GOLDEN: Array<{ q: number[]; grip: [number, number, number]; rot: number[] }> = [
  { q: [0, 0.2, 0.4, 0, 0, 0], grip: [0.334916, 0.0, 0.810931], rot: [0.825336, 0.0, 0.564642, 0.0, 1.0, 0.0, -0.564642, 0.0, 0.825336] },
  { q: [0, 1.425, 2.0, 0, -1.2, 0], grip: [0.322177, 0.0, -0.285245], rot: [-0.608528, 0.0, 0.793533, 0.0, 1.0, 0.0, -0.793533, 0.0, -0.608528] },
  {
    q: [0.5, 0.35, 0.55, 0.3, -0.2, 0.7],
    grip: [0.432634, 0.186509, 0.711151],
    rot: [0.366048, -0.64154, 0.674119, 0.8501, 0.525231, 0.038242, -0.378602, 0.55907, 0.737632],
  },
  {
    q: [-1.2, -0.8, 1.1, 2.0, 0.9, -2.0],
    grip: [-0.12965, 0.052024, 0.561815],
    rot: [-0.116197, 0.951952, -0.283348, 0.525143, -0.183261, -0.831048, -0.843044, -0.245364, -0.478616],
  },
  {
    q: [3.0, 2.0, -2.0, -1, 1.5, 1],
    grip: [-0.420598, 0.011443, 0.285186],
    rot: [-0.037998, -0.081942, -0.995912, 0.004266, -0.996636, 0.081839, -0.999269, -0.001139, 0.038219],
  },
];

describe('OUTRIG arm forward kinematics', () => {
  const out = makePartMatrices();
  const mount = new THREE.Vector3(...ARM_DIMS.mount);

  for (const g of GOLDEN) {
    it(`matches MuJoCo for q=${JSON.stringify(g.q)}`, () => {
      armFK(g.q, ARM_DIMS.apertureOpen, out);
      const p = new THREE.Vector3().setFromMatrixPosition(out[PART.EE]).sub(mount);
      // sim (x, y, z) -> scene (y, z, x)
      expect(p.x).toBeCloseTo(g.grip[1], 4);
      expect(p.y).toBeCloseTo(g.grip[2], 4);
      expect(p.z).toBeCloseTo(g.grip[0], 4);
      // orientation: the matrix maps sim-axis geometry into the scene, so its 3x3 is P * R
      const e = out[PART.EE].elements;
      const R = g.rot; // row-major sim rotation
      const perm = [1, 2, 0]; // scene row k <- sim row perm[k]
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) expect(e[c * 4 + r]).toBeCloseTo(R[perm[r] * 3 + c], 4);
    });
  }

  it('rest pose reaches forward and up, not sideways', () => {
    armFK(REST_JOINTS, 0.07, out);
    const p = new THREE.Vector3().setFromMatrixPosition(out[PART.EE]);
    expect(p.z).toBeGreaterThan(mount.z + 0.2);
    expect(p.y).toBeGreaterThan(mount.y + 0.5);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
  });

  it('joint_1 swings the arm about the vertical axis (positive = toward chassis-left, +x scene)', () => {
    armFK([Math.PI / 2, 0.6, 0.3, 0, 0, 0], 0.07, out);
    const p = new THREE.Vector3().setFromMatrixPosition(out[PART.EE]).sub(mount);
    expect(p.x).toBeGreaterThan(0.2);
    expect(Math.abs(p.z)).toBeLessThan(1e-6);
  });

  it('finger pads slide inward as the aperture closes and stay symmetric', () => {
    armFK(REST_JOINTS, 0.07, out);
    const open = out[PART.FL].elements.slice();
    const gapOpen = new THREE.Vector3().setFromMatrixPosition(out[PART.FL]).distanceTo(new THREE.Vector3().setFromMatrixPosition(out[PART.FR]));
    armFK(REST_JOINTS, 0.0, out);
    const gapClosed = new THREE.Vector3().setFromMatrixPosition(out[PART.FL]).distanceTo(new THREE.Vector3().setFromMatrixPosition(out[PART.FR]));
    expect(gapOpen).toBeCloseTo(2 * ARM_DIMS.finger.y, 6);
    expect(gapClosed).toBeCloseTo(0, 6);
    expect(out[PART.FL].elements.slice()).not.toEqual(open);
    armFK(REST_JOINTS, 0.04, out);
    const mid = new THREE.Vector3().setFromMatrixPosition(out[PART.FL]).add(new THREE.Vector3().setFromMatrixPosition(out[PART.FR])).multiplyScalar(0.5);
    const ee = new THREE.Vector3().setFromMatrixPosition(out[PART.EE]);
    expect(mid.distanceTo(ee)).toBeLessThan(1e-6);
  });

  it('fingerDisp follows the backend formula', () => {
    expect(fingerDisp(0.07)).toBe(0);
    expect(fingerDisp(0)).toBeCloseTo(0.035, 9);
    expect(fingerDisp(0.03)).toBeCloseTo(0.02, 9);
    expect(fingerDisp(-1)).toBeCloseTo(0.035, 9);
    expect(fingerDisp(1)).toBe(0);
  });

  it('clamps joints to published limits, else to the MuJoCo ranges', () => {
    const o = [0, 0, 0, 0, 0, 0];
    clampJoints([9, 9, 9, 9, 9, 9], undefined, o);
    expect(o[1]).toBeCloseTo(2.09, 6);
    expect(o[4]).toBeCloseTo(1.85, 6);
    clampJoints([9, 9, 9, 9, 9, 9], [[-1, 1], [-1, 0.5], [-1, 1], [-1, 1], [-1, 1], [-1, 1]], o);
    expect(o.slice(0, 2)).toEqual([1, 0.5]);
  });
});

describe('readManipulator', () => {
  it('prefers robot.manipulator and falls back to the flat arm fields', () => {
    expect(readManipulator(undefined)).toBeNull();
    expect(readManipulator({})).toBeNull();
    expect(readManipulator({ arm_qpos_rad: [0, 0, 0] })).toBeNull();
    const flat = readManipulator({ arm_qpos_rad: [0, 1, 2, 3, 4, 5], gripper_aperture_m: 0.02, held_object_id: 'X' });
    expect(flat?.joints_rad[5]).toBe(5);
    expect(flat?.held_object_id).toBe('X');
    const m = readManipulator({ manipulator: { joints_rad: [1, 1, 1, 1, 1, 1], gripper_aperture_m: 0.05, held_object_id: null }, arm_qpos_rad: [0, 0, 0, 0, 0, 0], held_object_id: 'OLD' });
    expect(m?.joints_rad[0]).toBe(1);
    expect(m?.gripper_aperture_m).toBe(0.05);
    expect(m?.held_object_id).toBeNull();
    // NaN / short arrays are not a pose
    expect(readManipulator({ manipulator: { joints_rad: [1, 1, NaN, 1, 1, 1] } })).toBeNull();
  });
});

describe('ArmInterp', () => {
  const q0 = [0, 0, 0, 0, 0, 0];
  const q1 = [1, -1, 0.5, 0, 0, 0];
  const out = new Float64Array(7);

  it('starts at the first sample and holds when nothing changes', () => {
    const a = new ArmInterp();
    a.push(q0, 0.07, 0);
    a.sample(5, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0.07]);
    a.push(q0, 0.07, 6);
    a.sample(7, out);
    expect(out[0]).toBe(0);
  });

  it('moves linearly to a new sample and never overshoots it (no extrapolation)', () => {
    const a = new ArmInterp();
    a.push(q0, 0.07, 0);
    a.push(q1, 0.07, 1);
    let prev = -1;
    for (let t = 1; t <= 3; t += 0.01) {
      a.sample(t, out);
      expect(out[0]).toBeGreaterThanOrEqual(prev);
      expect(out[0]).toBeLessThanOrEqual(1 + 1e-12);
      expect(out[1]).toBeGreaterThanOrEqual(-1 - 1e-12);
      prev = out[0];
    }
    a.sample(100, out);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(out[1]).toBeCloseTo(-1, 9);
    expect(out[2]).toBeCloseTo(0.5, 9);
  });

  it('a mid-flight update starts from the displayed value (no jump)', () => {
    const a = new ArmInterp();
    a.push(q0, 0.07, 0);
    a.push([1, 0, 0, 0, 0, 0], 0.07, 1);
    a.sample(1.1, out);
    const shown = out[0];
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(1);
    a.push([0.2, 0, 0, 0, 0, 0], 0.07, 1.1);
    a.sample(1.1, out);
    expect(out[0]).toBeCloseTo(shown, 9);
    a.sample(50, out);
    expect(out[0]).toBeCloseTo(0.2, 9);
  });

  it('segment length tracks the observed update interval within clamps', () => {
    const a = new ArmInterp();
    a.push(q0, 0.07, 0);
    let x = 0;
    for (let k = 1; k <= 20; k++) {
      x += 0.1;
      a.push([x, 0, 0, 0, 0, 0], 0.07, k * 0.25);
    }
    // 0.25 s between updates: after the last update, at +0.125 s the arm is partway, at +0.3 s it is there
    a.sample(20 * 0.25 + 0.01, out);
    expect(out[0]).toBeLessThan(x);
    a.sample(20 * 0.25 + 0.5, out);
    expect(out[0]).toBeCloseTo(x, 9);
  });

  it('interpolates the gripper aperture too', () => {
    const a = new ArmInterp();
    a.push(q0, 0.07, 0);
    a.push(q0, 0.0, 1);
    a.sample(1.1, out);
    expect(out[6]).toBeLessThan(0.07);
    expect(out[6]).toBeGreaterThan(0);
    a.sample(10, out);
    expect(out[6]).toBeCloseTo(0, 9);
  });
});

describe('armLod', () => {
  it('is full near, stick mid, none far, with hysteresis', () => {
    expect(armLod(2, 'none')).toBe('full');
    expect(armLod(10, 'full')).toBe('stick');
    expect(armLod(30, 'stick')).toBe('none');
    expect(armLod(6.3, 'full')).toBe('full'); // stays full a little past the boundary
    expect(armLod(6.3, 'stick')).toBe('stick'); // does not flip back until clearly inside
    expect(armLod(5.0, 'stick')).toBe('full');
  });
});
