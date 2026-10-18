import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARM_HOME_POSE,
  atLimit,
  clampJog,
  controlActions,
  driveStatus,
  limitFraction,
  plainRefusal,
  readManipulator,
  resetControl,
  setControlApi,
  stepToward,
  takeControlBlocker,
  useControl,
  type ControlApi,
  type DriveIntent,
} from '../src/control';
import { useWorld } from '../src/store';
import type { Robot, Topology } from '../src/contracts';

const ack = (i: DriveIntent) => ({ accepted: true, robot_id: 'OR-03', lease_epoch: 1, applied_seq: i.command_seq, controller_state: 'MANUAL', world_version: 1, pose: { segment_id: 'e', s_m: 0, speed_m_s: 0, velocity_m_s: 0, facing: 1, position_xyz_m: [0, 0, 0] }, odometer_m: 0 });

describe('plainRefusal', () => {
  it('words the backend refusals an operator can hit, and marks the low-battery one dockable', () => {
    expect(plainRefusal('battery_depleted')).toMatchObject({ key: 'battery_depleted', dockable: true });
    expect(plainRefusal('battery_depleted').text).toMatch(/battery/i);
    expect(plainRefusal('lease_conflict: robot is under manual control by another principal').text).toMatch(/another operator/i);
    expect(plainRefusal('robot_busy: a repair action is in progress')).toMatchObject({ retry: true, dockable: false });
    expect(plainRefusal('robot_in_safe_hold: retry after reconciliation').text).toMatch(/safe hold/i);
  });
  it('shows an unknown reason instead of hiding it', () => {
    expect(plainRefusal('some_new_reason_x').text).toBe('some new reason x');
    expect(plainRefusal(undefined).text).toMatch(/refused/);
  });
});

describe('arm model', () => {
  it('reads the V12 manipulator block, falls back to the legacy flat fields, then to nothing', () => {
    const v12 = readManipulator({ manipulator: { joints_rad: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], joint_limits_rad: [[-1, 1], [-1, 1], [-1, 1], [-1, 1], [-1, 1], [-1, 1]], gripper_aperture_m: 0.03, held_object_id: 'cart_1', ee_xyz_m: [1, 2, 3], ee_quat_xyzw: [0, 0, 0, 1], busy: true } });
    expect(v12).toMatchObject({ source: 'manipulator', gripperM: 0.03, heldObjectId: 'cart_1', busy: true, jointKnown: true });
    expect(v12.limits[0]).toEqual([-1, 1]);
    expect(v12.ee?.xyz).toEqual([1, 2, 3]);
    const legacy = readManipulator({ arm_qpos_rad: [0, 0.2, 0.4, 0, 0, 0], gripper_aperture_m: 0.05, held_object_id: null, end_effector_pose: { pos_xyz: [4, 5, 6], quat_xyzw: [0, 0, 0, 1] } });
    expect(legacy).toMatchObject({ source: 'legacy', gripperM: 0.05, heldObjectId: null });
    expect(legacy.limits[1]).toEqual([-2, 2]);
    expect(legacy.ee?.xyz).toEqual([4, 5, 6]);
    const none = readManipulator({ id: 'OR-01' });
    expect(none).toMatchObject({ source: 'none', jointKnown: false, gripperM: null, ee: null });
    expect(none.joints).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('rejects malformed limits and keeps the fallback', () => {
    const v = readManipulator({ manipulator: { joints_rad: [0, 0, 0, 0, 0, 0], joint_limits_rad: [[1, -1], 'x'] } });
    expect(v.limits[0]).toEqual([-3.14, 3.14]);
    expect(v.limits[1]).toEqual([-2, 2]);
  });
  it('limit fraction, at-limit and bounded steps', () => {
    expect(limitFraction(0, [-1, 1])).toBe(0.5);
    expect(limitFraction(5, [-1, 1])).toBe(1);
    expect(atLimit(1, [-1, 1], 1)).toBe(true);
    expect(atLimit(1, [-1, 1], -1)).toBe(false);
    expect(clampJog(5)).toBe(0.35);
    expect(clampJog(Number.NaN)).toBe(0);
    const steps = stepToward([1, 0.2, 0.4, 0, 0, 0], ARM_HOME_POSE);
    expect(steps).toEqual([{ idx: 0, delta: -0.35 }]);
    expect(stepToward(ARM_HOME_POSE, ARM_HOME_POSE)).toEqual([]);
  });
});

describe('drive status and Take Control blockers', () => {
  const base = { state: 'AUTONOMOUS', robotId: null, ackAt: 0, rttMs: null, linkOk: true, stop: null, refusal: null, clientId: 'op_1' } as const;
  const robot = { id: 'OR-03', mode: 'IDLE', battery_pct: 50, control: { authority: 'AUTO', controller_state: 'AUTONOMOUS' } };
  it('names every state the operator can be in', () => {
    expect(driveStatus(base, robot, 0).kind).toBe('idle');
    expect(driveStatus({ ...base, state: 'LEASE_REQUESTED', robotId: 'OR-03' }, robot, 0).kind).toBe('acquiring');
    expect(driveStatus({ ...base, state: 'MANUAL_ARMED', robotId: 'OR-03', ackAt: 1000, rttMs: 80 }, robot, 1100).kind).toBe('manual');
    expect(driveStatus({ ...base, state: 'MANUAL_DRIVING', robotId: 'OR-03', ackAt: 1000, rttMs: 80 }, robot, 1800).kind).toBe('degraded');
    expect(driveStatus({ ...base, state: 'MANUAL_ARMED', robotId: 'OR-03', ackAt: 1000, rttMs: 900 }, robot, 1010).kind).toBe('degraded');
    expect(driveStatus({ ...base, state: 'MANUAL_ARMED', robotId: 'OR-03', ackAt: 1000, rttMs: 10, linkOk: false }, robot, 1010).kind).toBe('degraded');
    expect(driveStatus({ ...base, state: 'SAFE_STOP', robotId: 'OR-03', stop: { reason: 'link_lost', text: 'Link lost.', at: 1 } }, robot, 0)).toMatchObject({ kind: 'stopped', detail: 'Link lost.' });
    expect(driveStatus({ ...base, state: 'SAFE_HOLD', robotId: 'OR-03' }, robot, 0).kind).toBe('safe_hold');
    expect(driveStatus({ ...base, state: 'RELEASE_PENDING', robotId: 'OR-03' }, robot, 0).kind).toBe('releasing');
  });
  it('a refused lease reads as REFUSED with the plain reason, only for that robot', () => {
    const refusal = { robotId: 'OR-03', reason: 'battery_depleted', plain: plainRefusal('battery_depleted'), at: 1 };
    const s = driveStatus({ ...base, refusal }, robot, 0);
    expect(s).toMatchObject({ kind: 'refused', tone: 'bad' });
    expect(s.detail).toMatch(/battery/i);
    expect(driveStatus({ ...base, refusal }, { ...robot, id: 'OR-04' }, 0).kind).toBe('idle');
  });
  it('another operator holding the robot is shown as HELD', () => {
    const held = { ...robot, control: { authority: 'HUMAN', controller_state: 'MANUAL', holder: 'someone_else' } };
    expect(driveStatus(base, held, 0).kind).toBe('foreign');
  });
  it('blockers mirror the server gates', () => {
    expect(takeControlBlocker(robot, true, false)).toBe('');
    expect(takeControlBlocker({ ...robot, battery_pct: 0 }, true, false)).toMatch(/battery/i);
    expect(takeControlBlocker({ ...robot, mode: 'WORKING' }, true, false)).toMatch(/repair/i);
    expect(takeControlBlocker(robot, false, false)).toMatch(/stream/i);
    expect(takeControlBlocker(robot, true, true)).toMatch(/preview/i);
    expect(takeControlBlocker(undefined, true, false)).toMatch(/Select/);
  });
});

describe('drive loop reliability on a fake API', () => {
  const sent: DriveIntent[] = [];
  let api: ControlApi;
  let driveImpl: (i: DriveIntent) => Promise<unknown>;
  let leaseImpl: () => Promise<unknown>;
  let concurrent = 0;
  let maxConcurrent = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    resetControl();
    sent.length = 0;
    concurrent = 0;
    maxConcurrent = 0;
    driveImpl = async (i) => ack(i);
    leaseImpl = async () => ({ accepted: true, robot_id: 'OR-03', lease_id: 'L1', lease_epoch: 1, granted_world_version: 1, expires_in_ms: 5000, heartbeat_interval_ms: 500, deadman_ms: 1500, limits: { max_speed_m_s: 0.4, max_accel_m_s2: 0.6, intent_ttl_ms: [20, 250], max_intent_rate_hz: 20 }, topology_revision: 't', control: {} as never });
    api = {
      label: 'fake',
      live: true,
      lease: (async () => leaseImpl()) as never,
      heartbeat: async () => ({ accepted: true, expires_in_ms: 5000, controller_state: 'MANUAL' }) as never,
      drive: (async (_id: string, i: DriveIntent) => {
        sent.push(i);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          return await driveImpl(i);
        } finally {
          concurrent--;
        }
      }) as never,
      release: async () => ({ accepted: true, robot_id: 'OR-03', controller_state: 'AUTONOMOUS', resumed: 'mission', control: {} as never }) as never,
    };
    setControlApi(api);
    useWorld.setState({
      connection: 'live',
      stale: false,
      version: 5,
      topology: { facility: { topology_hash: 'th' } } as unknown as Topology,
      robots: { 'OR-03': { id: 'OR-03', class: 'outrig', name: 'OR-03' } as unknown as Robot },
    });
  });
  afterEach(() => {
    resetControl();
    vi.useRealTimers();
  });

  it('never has more than one drive request in flight, even when answers take 700 ms', async () => {
    await controlActions.takeControl('OR-03');
    driveImpl = (i) => new Promise((res) => setTimeout(() => res(ack(i)), 700));
    controlActions.setInput('keyboard', { throttle: 1 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(maxConcurrent).toBe(1);
    // slow answers lower the rate instead of queueing: about 4000 / 700 requests, not 4000 / 125
    expect(sent.length).toBeLessThanOrEqual(7);
    expect(useControl.getState().appliedSeq).toBeGreaterThan(0);
    expect(useControl.getState().stop).toBeNull();
  });

  it('every intent carries the newest input, not a queued stale one', async () => {
    await controlActions.takeControl('OR-03');
    driveImpl = (i) => new Promise((res) => setTimeout(() => res(ack(i)), 500));
    controlActions.setInput('keyboard', { throttle: 1 });
    await vi.advanceTimersByTimeAsync(100);
    controlActions.setInput('keyboard', { throttle: -1 });
    controlActions.setInput('keyboard', { throttle: 0.25 });
    await vi.advanceTimersByTimeAsync(1200);
    expect(sent[sent.length - 1].throttle).toBe(0.25);
  });

  it('jog commands coalesce while a request is in flight and none is lost or doubled', async () => {
    await controlActions.takeControl('OR-03');
    await vi.advanceTimersByTimeAsync(200);
    sent.length = 0;
    driveImpl = (i) => new Promise((res) => setTimeout(() => res(ack(i)), 300));
    controlActions.jogJoint(0, 0.05); // goes out now
    controlActions.jogJoint(1, 0.05); // waits
    controlActions.jogJoint(1, 0.05); // coalesces into the one above
    controlActions.jogJoint(1, 0.05);
    controlActions.setGripper(0.01);
    controlActions.setGripper(0.06); // latest wins
    expect(useControl.getState().manipPending).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    const jogs = sent.filter((i) => i.action === 'joint_jog');
    expect(jogs.map((j) => [j.joint_idx, Number(j.delta_rad?.toFixed(2))])).toEqual([[0, 0.05], [1, 0.15]]);
    expect(sent.filter((i) => i.gripper_aperture !== undefined).map((i) => i.gripper_aperture)).toEqual([0.06]);
    expect(useControl.getState().manipPending).toBe(0);
    expect(maxConcurrent).toBe(1);
  });

  it('a manipulation command that met a still-acquiring robot is retried, not lost', async () => {
    await controlActions.takeControl('OR-03');
    let acquiring = true;
    driveImpl = async (i) => (acquiring ? { accepted: false, code: 'not_controllable', reason: 'lease_not_active: robot is still acquiring (retry)' } : ack(i));
    controlActions.pick();
    await vi.advanceTimersByTimeAsync(600);
    expect(useControl.getState().manipPending).toBe(1);
    acquiring = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(sent.some((i) => i.action === 'pick' && i.pick === true)).toBe(true);
    expect(useControl.getState().manipPending).toBe(0);
  });

  it('Pick / Place / clean_deposit go out as the documented intent fields', async () => {
    await controlActions.takeControl('OR-03');
    await vi.advanceTimersByTimeAsync(200);
    controlActions.pick();
    await vi.advanceTimersByTimeAsync(300);
    controlActions.place();
    await vi.advanceTimersByTimeAsync(300);
    controlActions.cleanDeposit();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.find((i) => i.action === 'pick')).toMatchObject({ pick: true });
    expect(sent.find((i) => i.action === 'place')).toMatchObject({ place: true });
    expect(sent.find((i) => i.action === 'clean_deposit')).toBeTruthy();
  });

  it('Home with the legacy arm walks the joints toward the rest pose in bounded jogs', async () => {
    useWorld.setState({ robots: { 'OR-03': { id: 'OR-03', class: 'outrig', name: 'OR-03', arm_qpos_rad: [1.0, 0.2, 0.4, 0, 0, 0] } as unknown as Robot } });
    await controlActions.takeControl('OR-03');
    await vi.advanceTimersByTimeAsync(200);
    sent.length = 0;
    controlActions.armHome();
    await vi.advanceTimersByTimeAsync(300);
    const first = sent.find((i) => i.action === 'joint_jog');
    expect(first).toMatchObject({ joint_idx: 0 });
    expect(first?.delta_rad).toBeCloseTo(-0.35, 5);
  });

  it('Home with the V12 manipulator block asks the server for arm_home', async () => {
    useWorld.setState({ robots: { 'OR-03': { id: 'OR-03', class: 'outrig', name: 'OR-03', manipulator: { joints_rad: [1, 0, 0, 0, 0, 0] } } as unknown as Robot } });
    await controlActions.takeControl('OR-03');
    await vi.advanceTimersByTimeAsync(200);
    controlActions.armStow();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.some((i) => i.action === 'arm_stow')).toBe(true);
  });

  it('a refused lease (battery) is kept with its plain reason and the robot id', async () => {
    leaseImpl = async () => ({ accepted: false, code: 'not_controllable', reason: 'battery_depleted' });
    await controlActions.takeControl('OR-03');
    const s = useControl.getState();
    expect(s.state).toBe('AUTONOMOUS');
    expect(s.refusal).toMatchObject({ robotId: 'OR-03', reason: 'battery_depleted' });
    expect(s.refusal?.plain.dockable).toBe(true);
    expect(s.notice?.text).toMatch(/battery/i);
    expect(s.notice?.text).not.toBe('battery_depleted');
    // the next attempt clears it
    leaseImpl = async () => ({ accepted: true, robot_id: 'OR-03', lease_id: 'L2', lease_epoch: 2, granted_world_version: 1, expires_in_ms: 5000, heartbeat_interval_ms: 500, deadman_ms: 1500, limits: { max_speed_m_s: 0.4, max_accel_m_s2: 0.6, intent_ttl_ms: [20, 250], max_intent_rate_hz: 20 }, topology_revision: 't', control: {} as never });
    await controlActions.takeControl('OR-03');
    expect(useControl.getState().refusal).toBeNull();
  });

  it('brake always goes out even while a drive request is stuck in flight', async () => {
    await controlActions.takeControl('OR-03');
    driveImpl = () => new Promise(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    sent.length = 0;
    controlActions.safeStop('operator_stop');
    await vi.advanceTimersByTimeAsync(10);
    expect(sent[0]).toMatchObject({ throttle: 0, steer: 0, brake: true });
    expect(useControl.getState().stop?.reason).toBe('operator_stop');
    expect(useControl.getState().inputEnabled).toBe(false);
  });

  it('release returns control cleanly and drops waiting arm commands', async () => {
    await controlActions.takeControl('OR-03');
    driveImpl = () => new Promise(() => undefined);
    controlActions.jogJoint(2, 0.05);
    controlActions.jogJoint(3, 0.05);
    controlActions.release('operator_release');
    await vi.advanceTimersByTimeAsync(50);
    expect(useControl.getState().manipPending).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(useControl.getState().state).toBe('AUTONOMOUS');
    expect(useControl.getState().inputEnabled).toBe(false);
  });
});
