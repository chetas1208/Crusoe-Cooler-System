import { describe, expect, it } from 'vitest';
import { normalizeRobots } from '../src/store';
import { buildTimeline } from '../src/runs';
import { samplePose, pushPose, resetPoses } from '../src/store';
import type { Robot, RobotPose, StreamEvent } from '../src/contracts';

const pose = (x: number, q?: [number, number, number, number]): RobotPose => ({ position_xyz_m: [x, 0, 0], yaw_rad: 0, speed_m_s: 0, quaternion_xyzw: q });
const robot = (id: string): Robot => ({ id, class: 'inpipe', name: id, mode: 'DOCKED', battery_pct: 100, home_id: 'p', pose: pose(0), spec: {} });

describe('robots are keyed by their own id', () => {
  it('drops a duplicate id and re-keys a stale key', () => {
    const out = normalizeRobots({ c_01: robot('IR-01'), c_02: robot('IR-02'), x: robot('IR-01') });
    expect(Object.keys(out).sort()).toEqual(['IR-01', 'IR-02']);
  });
});

describe('pose sampling', () => {
  it('interpolates the orientation quaternion between bracketing samples', () => {
    resetPoses();
    pushPose('r', pose(0, [0, 0, 0, 1]), 1000);
    pushPose('r', pose(1, [0, 1, 0, 0]), 1200);
    const s = samplePose('r', 1260, 100); // target = 1160 -> f = 0.8
    expect(s?.quat).toBeDefined();
    const n = Math.hypot(...(s!.quat as number[]));
    expect(n).toBeCloseTo(1, 5);
    expect(s!.pos[0]).toBeCloseTo(0.8, 5);
  });
});

describe('timeline from events only (backend with no recorded frames)', () => {
  it('shows incident, robot and lease markers', () => {
    const ev = [
      { seq: 1, sim_tick: 10, type: 'incident.opened', payload: { incident: { id: 'INC-1', title: 'P-17 dp', severity: 'warning', status: 'open', cause: 'x', opened_tick: 10 } } },
      { seq: 2, sim_tick: 12, type: 'robot.pose', payload: { robot_id: 'IR-01', mode: 'TRAVELING', pose: pose(1) } },
      { seq: 3, sim_tick: 30, type: 'robot.pose', payload: { robot_id: 'IR-01', mode: 'DOCKED', pose: pose(2) } },
      { seq: 4, sim_tick: 31, type: 'robot.control.granted', payload: { robot_id: 'IR-05', lease_id: 'L1' } },
    ] as unknown as StreamEvent[];
    const tl = buildTimeline([], ev, []);
    expect(tl.to).toBe(31);
    expect(tl.markers.map((m) => m.lane).sort()).toEqual(['operator', 'physics', 'robots', 'robots']);
    expect(tl.markers.filter((m) => m.lane === 'robots').map((m) => m.from)).toEqual([12, 30]);
  });
});
