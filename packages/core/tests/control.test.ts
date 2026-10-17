import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import type { DriveIntent, LeaseGrant, LeaseRequest, ReleaseRequest } from '../src/contracts.control';

/** A clock the test controls, so the deadman is deterministic. */
function setup(opts: { faults?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const eng = new Engine({ seed: 8, faultsEnabled: opts.faults ?? false, clock: () => clock.t, control: { deadmanMs: 1500, leaseTtlMs: 5000, safeHoldResumeMs: 8000 } });
  const topology_revision = eng.topology.facility.topology_hash;
  let n = 0;
  const key = () => `key-${++n}-xxxxxxxx`;
  const lease = (client = 'op_a', id = 'c_01', over: Partial<LeaseRequest> = {}) =>
    eng.control.lease(id, { expected_world_version: eng.tick, idempotency_key: key(), client_id: client, topology_revision, ...over });
  const grant = (client = 'op_a', id = 'c_01') => {
    const r = lease(client, id);
    if (!r.accepted) throw new Error(`lease refused: ${r.reason}`);
    return r as LeaseGrant;
  };
  let seq = 0;
  const intent = (g: LeaseGrant, over: Partial<DriveIntent> = {}): DriveIntent => ({
    lease_id: g.lease_id,
    lease_epoch: g.lease_epoch,
    command_seq: ++seq,
    idempotency_key: key(),
    topology_revision,
    throttle: 0,
    steer: 0,
    brake: false,
    duration_ms: 200,
    ...over,
  });
  /** advance wall time in 50 ms engine ticks while re-sending the same intent every 66 ms like the UI does */
  const run = (ms: number, g?: LeaseGrant, over: Partial<DriveIntent> = {}) => {
    for (let t = 0; t < ms; t += 50) {
      if (g) eng.control.drive('c_01', intent(g, over));
      clock.t += 50;
      eng.advance(50);
    }
  };
  const release = (g: LeaseGrant, over: Partial<ReleaseRequest> = {}) =>
    eng.control.release('c_01', { lease_id: g.lease_id, lease_epoch: g.lease_epoch, idempotency_key: key(), ...over });
  return { eng, clock, lease, grant, intent, run, release, topology_revision, key, robot: eng.robots.c_01 };
}

describe('manual control · lease', () => {
  it('is exclusive: a second operator is refused while the first holds the lease', () => {
    const s = setup();
    const g = s.grant('op_a');
    expect(g.control.authority).toBe('HUMAN');
    const second = s.lease('op_b');
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.code).toBe('lease_held');
    // the same operator in another session is refused too
    const again = s.lease('op_a');
    expect(again.accepted).toBe(false);
    // releasing frees it for someone else, with a new epoch
    expect(s.release(g).accepted).toBe(true);
    const g2 = s.grant('op_b');
    expect(g2.lease_epoch).toBeGreaterThan(g.lease_epoch);
  });

  it('is idempotent: repeating the key returns the original grant, not a second lease', () => {
    const s = setup();
    const req: LeaseRequest = { expected_world_version: s.eng.tick, idempotency_key: 'same-key-12345678', client_id: 'op_a', topology_revision: s.topology_revision };
    const a = s.eng.control.lease('c_01', req);
    const b = s.eng.control.lease('c_01', req);
    expect(b).toEqual(a);
    expect(s.eng.robots.c_01.toContract().control?.lease_epoch).toBe(1);
  });

  it('refuses a stale world version and changed topology, and grants manual lease for both inpipe and outrig', () => {
    const s = setup();
    for (let i = 0; i < 500; i++) s.eng.step();
    const stale = s.lease('op_a', 'c_01', { expected_world_version: 1 });
    expect(stale.accepted === false && stale.code).toBe('stale_world_version');
    const topo = s.lease('op_a', 'c_01', { topology_revision: 'other' });
    expect(topo.accepted === false && topo.code).toBe('topology_changed');
    const out = s.lease('op_a', 'o_01');
    expect(out.accepted).toBe(true);
    if (out.accepted) {
      expect(out.robot_id).toBe('o_01');
      expect(out.control.authority).toBe('HUMAN');
    }
  });

  it('refuses a robot that is brush-working and says why', () => {
    const s = setup();
    s.robot.mode = 'WORKING';
    const r = s.lease();
    expect(r.accepted === false && r.code).toBe('not_controllable');
    if (!r.accepted) expect(r.reason).toMatch(/brush/i);
    expect(s.robot.toContract().control?.controllable).toBe(false);
  });
});

describe('manual control · drive validation', () => {
  it('rejects drive without a lease, with a stale epoch, a stale sequence and bad ranges', () => {
    const s = setup();
    const dummy = { lease_id: 'nope', lease_epoch: 1 } as LeaseGrant;
    const none = s.eng.control.drive('c_01', s.intent(dummy));
    expect(none.accepted === false && none.code).toBe('no_lease');

    const g = s.grant();
    const stale = s.eng.control.drive('c_01', s.intent({ ...g, lease_epoch: g.lease_epoch + 1 }));
    expect(stale.accepted === false && stale.code).toBe('stale_epoch');

    const ok = s.eng.control.drive('c_01', s.intent(g, { throttle: 0.5 }));
    expect(ok.accepted).toBe(true);
    const replayed = s.intent(g, { throttle: 0.5 });
    replayed.command_seq = 1;
    const old = s.eng.control.drive('c_01', replayed);
    expect(old.accepted === false && old.code).toBe('stale_seq');

    const wild = s.eng.control.drive('c_01', s.intent(g, { throttle: 7 }));
    expect(wild.accepted === false && wild.code).toBe('bad_request');
    const ttl = s.eng.control.drive('c_01', s.intent(g, { duration_ms: 5000 }));
    expect(ttl.accepted === false && ttl.code).toBe('bad_request');
    expect(s.eng.control.stats.rejected).toBeGreaterThanOrEqual(5);
    expect(s.eng.control.stats.accepted).toBe(1);
  });

  it('replays an identical (seq, key) with the same ack and no second effect', () => {
    const s = setup();
    const g = s.grant();
    const i = s.intent(g, { throttle: 0.5 });
    const a = s.eng.control.drive('c_01', i);
    const b = s.eng.control.drive('c_01', i);
    expect(b).toEqual(a);
    expect(s.eng.control.stats.accepted).toBe(1);
  });

  it('rejects drive while the robot sits on a non-passable edge, and an exit onto a non-passable branch', () => {
    const s = setup();
    const g = s.grant();
    const notAdjacent = s.eng.control.drive('c_01', s.intent(g, { selected_exit_segment_id: 'p_13' }));
    expect(notAdjacent.accepted === false && notAdjacent.code).toBe('not_passable');
    // p_17 branches off p_10 at the T-junction; mark it closed and the server must quote the real reason
    const p17 = s.eng.topology.edges.find((e) => e.id === 'p_17')!;
    p17.robot_passable = false;
    p17.not_passable_reason = 'Bore ≤ 40 mm — test';
    const bad = s.eng.control.drive('c_01', s.intent(g, { selected_exit_segment_id: 'p_17' }));
    expect(bad.accepted === false && bad.code).toBe('not_passable');
    if (!bad.accepted) expect(bad.reason).toMatch(/Bore ≤ 40 mm — test/);
    p17.robot_passable = true;
    // force the robot onto a rack drop (cannot happen via drive, but the server must still refuse)
    s.robot.setManualPose('p_13', 0.2, 1, 0);
    const r = s.eng.control.drive('c_01', s.intent(g, { throttle: 0.4 }));
    expect(r.accepted === false && r.code).toBe('not_passable');
  });
});

describe('manual control · motion is server-integrated', () => {
  it('moves along the centerline at a capped speed and brakes to a stop when intents stop (TTL)', () => {
    const s = setup();
    const g = s.grant();
    const s0 = s.robot.s_m!;
    s.run(2000, g, { throttle: 1 });
    expect(s.robot.s_m!).toBeGreaterThan(s0 + 0.2);
    expect(s.robot.speed).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(s.robot.segment_id).toBe('p_10');
    // stop sending: after the 200 ms TTL the robot brakes by itself
    s.run(800);
    expect(s.robot.speed).toBe(0);
    const stopped = s.robot.s_m!;
    s.run(500);
    expect(s.robot.s_m).toBeCloseTo(stopped, 6);
  });

  it('reverses without turning the nose around', () => {
    const s = setup();
    const g = s.grant();
    s.run(2000, g, { throttle: 1 });
    const h0 = [...s.robot.heading];
    const s1 = s.robot.s_m!;
    s.run(1500, g, { throttle: -1 });
    expect(s.robot.s_m!).toBeLessThan(s1);
    expect(s.robot.heading[2]).toBeCloseTo(h0[2], 6);
  });

  it('stops at an unresolved junction until a legal exit is chosen, then takes exactly that exit', () => {
    const s = setup();
    s.robot.s_m = 4.4; // p_10 is 5.3 m: the T-junction n_js is just ahead
    const g = s.grant();
    s.run(5000, g, { throttle: 1 });
    expect(s.robot.segment_id).toBe('p_10');
    expect(s.robot.s_m!).toBeCloseTo(5.3, 0);
    expect(s.robot.speed).toBe(0);
    const j = s.robot.toContract().control!.junction!;
    expect(j.exits.map((e) => e.segment_id).sort()).toEqual(['p_12', 'p_17']);
    s.run(3000, g, { throttle: 1, selected_exit_segment_id: 'p_17' });
    expect(s.robot.segment_id).toBe('p_17');
    expect(s.robot.s_m!).toBeGreaterThan(0.2);
  });

  it('withdraws control (SAFE_HOLD) when the isolation valve of the zone it is in closes', () => {
    const s = setup();
    s.robot.segment_id = 'p_12';
    s.robot.s_m = 3;
    const g = s.grant();
    s.run(500, g, { throttle: 0.5 });
    s.eng.plant.controls.isolated['valve_za'] = true;
    s.run(200, g, { throttle: 0.5 });
    expect(s.robot.toContract().control!.controller_state).toBe('SAFE_HOLD');
    expect(s.robot.toContract().control!.last_reason).toBe('safety_interlock');
  });
});

describe('manual control · deadman and handoff', () => {
  it('a missed heartbeat zeroes velocity and enters SAFE_HOLD with a reason; stale leases are refused', () => {
    const s = setup();
    const g = s.grant();
    s.run(1000, g, { throttle: 1 });
    expect(s.robot.speed).toBeGreaterThan(0.05);
    // the client goes silent
    const events: string[] = [];
    s.eng.subscribe((e) => e.type === 'robot.control' && events.push(e.payload.event));
    s.run(2200);
    expect(s.robot.toContract().control!.controller_state).toBe('SAFE_HOLD');
    expect(s.robot.toContract().control!.authority).toBe('STOP');
    expect(s.robot.toContract().control!.last_reason).toBe('deadman_timeout');
    expect(s.robot.speed).toBe(0);
    expect(s.robot.mode).toBe('SAFE_HOLD');
    expect(events).toContain('safe_hold');
    const late = s.eng.control.drive('c_01', s.intent(g, { throttle: 1 }));
    expect(late.accepted === false && late.code).toBe('lease_revoked');
    const hb = s.eng.control.heartbeat('c_01', { lease_id: g.lease_id, lease_epoch: g.lease_epoch });
    expect(hb.accepted).toBe(false);
  });

  it('a heartbeat alone keeps the lease alive; the agent resumes by itself after a long SAFE_HOLD', () => {
    const s = setup();
    const g = s.grant();
    for (let i = 0; i < 20; i++) {
      s.clock.t += 500;
      s.eng.advance(50);
      expect(s.eng.control.heartbeat('c_01', { lease_id: g.lease_id, lease_epoch: g.lease_epoch }).accepted).toBe(true);
    }
    expect(s.robot.toContract().control!.controller_state).toBe('MANUAL');
    s.run(2000); // silent → hold
    expect(s.robot.toContract().control!.controller_state).toBe('SAFE_HOLD');
    s.run(9000);
    expect(s.robot.toContract().control!.controller_state).toBe('AUTONOMOUS');
  });

  it('release hands the motors back: the interrupted move resumes from where the operator left the robot', () => {
    const s = setup();
    const { eng, robot } = s;
    const route = eng.graph.route({ edge_id: 'p_10', s: 0.5 }, { edge_id: 'p_17', s: 4 })!;
    robot.mode = 'ASSIGNED';
    robot.start({ kind: 'move_inpipe', route, label: 'test move' });
    s.run(1000);
    const g = s.grant();
    const before = robot.s_m!;
    s.run(1500, g, { throttle: -1 }); // the operator backs the crawler up
    expect(robot.s_m!).toBeLessThan(before);
    const events: Array<{ event: string; resumed?: unknown }> = [];
    eng.subscribe((e) => e.type === 'robot.control' && events.push({ event: e.payload.event, resumed: e.payload.data?.resumed }));
    const r = s.release(g);
    expect(r.accepted && r.controller_state).toBe('AUTONOMOUS');
    expect(r.accepted && r.resumed).toBe('mission');
    expect(events[0]).toEqual({ event: 'agent.resumed', resumed: 'mission' });
    expect(robot.toContract().control!.authority).toBe('AUTO');
    expect(robot.busy).toBe(true);
    s.run(120_000);
    expect(robot.busy).toBe(false);
    expect(robot.segment_id).toBe('p_17');
    expect(robot.s_m!).toBeCloseTo(4, 1);
  });

  it('an idle crawler driven out of its port drives itself home after release', () => {
    const s = setup();
    const g = s.grant();
    s.run(4000, g, { throttle: 1 });
    expect(s.robot.s_m!).toBeGreaterThan(1.2);
    const r = s.release(g);
    expect(r.accepted && r.resumed).toBe('return_to_port');
    s.run(60_000);
    expect(s.robot.mode).toBe('DOCKED');
  });

  it('release is idempotent and never leaves the operator stuck', () => {
    const s = setup();
    const g = s.grant();
    const req: ReleaseRequest = { lease_id: g.lease_id, lease_epoch: g.lease_epoch, idempotency_key: 'release-key-123456' };
    const a = s.eng.control.release('c_01', req);
    const b = s.eng.control.release('c_01', req);
    expect(b).toEqual(a);
    const c = s.release(g);
    expect(c.accepted && c.already_released).toBe(true);
  });

  it('records human.override at takeover and agent.resumed at release for the feed', () => {
    const s = setup();
    const seen: string[] = [];
    s.eng.subscribe((e) => e.type === 'robot.control' && seen.push(e.payload.event));
    const g = s.grant();
    s.release(g);
    expect(seen).toEqual(['human.override', 'agent.resumed']);
  });
});

describe('manual control · agents are unaffected when nobody drives', () => {
  it('every robot reports AUTO authority and the orchestrator still completes incidents', () => {
    const eng = new Engine({ seed: 8, faultsEnabled: false });
    eng.faults.begin('fouling', 'p_12');
    for (const r of Object.values(eng.robots)) expect(r.toContract().control?.authority).toBe('AUTO');
    eng.fastForward(2400);
    const closed = [...eng.orch.incidents.values()].filter((i) => i.closed_tick);
    expect(closed.length).toBeGreaterThan(0);
    expect(eng.control.stats.accepted).toBe(0);
  });

  it('the orchestrator does not dispatch a robot an operator is holding', () => {
    const eng = new Engine({ seed: 8, faultsEnabled: false });
    const topology_revision = eng.topology.facility.topology_hash;
    for (const id of ['c_01', 'c_02']) eng.control.lease(id, { expected_world_version: 0, idempotency_key: `hold-${id}-12345678`, client_id: 'op', topology_revision });
    eng.faults.begin('fouling', 'p_12');
    eng.fastForward(400);
    for (const id of ['c_01', 'c_02']) {
      expect(eng.robots[id].controlled).toBe(true);
      expect(eng.robots[id].busy).toBe(false);
    }
  });
});
