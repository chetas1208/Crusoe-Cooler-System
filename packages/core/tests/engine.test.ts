import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import type { StreamEvent } from '../src/contracts';
import { applyEvent, useWorld } from '../src/store';
import { pushPose, samplePose, resetPoses } from '../src/store/poses';

function run(seed: number, secs: number) {
  const e = new Engine({ seed, speed: 6 });
  const events: StreamEvent[] = [];
  e.subscribe((x) => events.push(x));
  e.fastForward(secs);
  return { e, events };
}

describe('engine', () => {
  it('is deterministic for a given seed', () => {
    const a = run(8, 1200).e.incidents().map((i) => [i.id, i.title, i.status]);
    const b = run(8, 1200).e.incidents().map((i) => [i.id, i.title, i.status]);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('opens incidents without any injected fault (unscripted)', () => {
    const { e } = run(8, 600);
    expect(e.incidents().length).toBeGreaterThan(0);
  });

  it('seed 8: a rejected repair is replanned and then verified', () => {
    const { e, events } = run(8, 1400);
    const inc = e.incidents().find((i) => i.id === 'INC-009')!;
    const verdicts = events.filter((x) => x.type === 'verification.result' && x.payload.verification.incident_id === 'INC-009' && x.payload.verification.status !== 'pending').map((x) => (x as Extract<StreamEvent, { type: 'verification.result' }>).payload.verification.status);
    expect(verdicts[0]).toBe('rejected');
    expect(verdicts.at(-1)).toBe('verified');
    expect(inc.status).toBe('resolved');
    expect(inc.attempts).toBeGreaterThanOrEqual(1);
  });

  it('never double-assigns the single exterior robot', () => {
    const { e } = run(5, 6000);
    const open = [...e.orch.missions.values()].filter((m) => m.robot_id === 'o_01' && !m.closed_tick);
    expect(open.length).toBeLessThanOrEqual(1);
  });

  it('seq is strictly increasing across every event type', () => {
    const { events } = run(8, 400);
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBe(events[i - 1].seq + 1);
  });

  it('a workload surge is dismissed without dispatching a robot', () => {
    const e = new Engine({ seed: 3, speed: 6, faultsEnabled: false });
    e.faults.begin('workload_spike', 'rack_a2');
    e.fastForward(900);
    const inc = e.incidents().find((i) => i.cause === 'workload_spike')!;
    expect(inc.status).toBe('dismissed');
    expect(inc.mission_ids.length).toBe(0);
  });
});

describe('client store', () => {
  it('ignores duplicate events (reconnect overlap)', () => {
    const { events, e } = run(8, 200);
    useWorld.setState({ ...useWorld.getState() });
    const snap = e.snapshot();
    applyEvent({ event_id: 'snap', seq: snap.last_seq, sim_tick: snap.sim_tick, sim_time_s: snap.sim_time_s, world_version: snap.version, type: 'snapshot', entity_id: 'lab_01', facility_id: 'lab_01', ts: '', payload: snap });
    const opened = events.find((x) => x.type === 'incident.opened');
    if (opened) {
      applyEvent(opened);
      const n = Object.keys(useWorld.getState().incidents).length;
      applyEvent(opened);
      expect(Object.keys(useWorld.getState().incidents).length).toBe(n);
    }
  });

  it('pose interpolation never extrapolates past the newest server sample', () => {
    resetPoses();
    const pose = (x: number) => ({ position_xyz_m: [x, 0, 0] as [number, number, number], yaw_rad: 0, speed_m_s: 1 });
    pushPose('r', pose(0), 1000);
    pushPose('r', pose(1), 1100);
    expect(samplePose('r', 1130, 100)!.pos[0]).toBeGreaterThan(0);
    expect(samplePose('r', 5000, 100)!.pos[0]).toBe(1); // stream stalled → robot stops, no invented motion
    expect(samplePose('r', 5000, 100)!.speed).toBe(0);
  });
});
