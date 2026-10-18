import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpControlApi,
  HttpNavApi,
  applyNavEvent,
  controlActions,
  navActions,
  resetControl,
  resetNav,
  setControlApi,
  setNavApi,
  useControl,
  useNav,
  type ControlApi,
  type DriveIntent,
} from '../src/control';
import { useWorld } from '../src/store';
import type { Robot, Topology } from '../src/contracts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PLAN = { accepted: true, plan_id: 'rp_OR-03_0001', robot_id: 'OR-03', kind: 'exterior', target: 'SV:ROAD-04:15.30', waypoints: [[7.4, 0, -1.4], [15.3, 0, 6]], length_m: 21.6, eta_s: 53.4, wait_s: 0, depart_t: 10, arrive_t: 63, valid_until: 100, graph_revision: 'g1.c1', traffic_revision: 8 };

describe('HttpNavApi', () => {
  it('plans against the run-scoped URL and returns the server plan', async () => {
    const f = vi.fn(async () => json(200, PLAN));
    const api = new HttpNavApi('http://x:1/', 'current', f);
    const r = await api.plan('OR-03', 'SV:ROAD-04:15.30');
    expect(r.ok && r.value.plan_id).toBe('rp_OR-03_0001');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x:1/api/v1/runs/current/robots/OR-03/route/plan');
    expect(JSON.parse(String(init.body))).toEqual({ target: 'SV:ROAD-04:15.30' });
  });

  it.each(['NO_ACCESS', 'TURN_RADIUS', 'EQUIPMENT_BLOCK', 'RESERVATION_CONFLICT', 'PRESSURE_UNSAFE', 'BATTERY', 'PIPE_CLEARANCE'])('keeps the refusal %s and its detail verbatim', async (reason) => {
    const detail = `exact constraint for ${reason}: 0.62 m < 0.90 m`;
    const api = new HttpNavApi('http://x', 'current', async () => json(409, { accepted: false, ok: false, reason, detail, graph_revision: 'g', traffic_revision: 3, blocked_by: 'OR-02' }));
    const r = await api.plan('OR-03', 'n1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatchObject({ reason, detail, http_status: 409, graph_revision: 'g', traffic_revision: 3, blocked_by: 'OR-02' });
  });

  it('maps an HTTP-error body without a reason code and a network failure to different reasons', async () => {
    const a = await new HttpNavApi('http://x', 'current', async () => json(404, { detail: 'unknown run' })).graphs('exterior');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.refusal.reason).toBe('NOT_FOUND');
    const b = await new HttpNavApi('http://x', 'current', async () => Promise.reject(new TypeError('fetch failed'))).plan('OR-03', 'n');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.refusal).toMatchObject({ reason: 'NETWORK', detail: 'fetch failed' });
  });

  it('commit carries the revisions it was planned against, and the lease id only when given', async () => {
    const f = vi.fn(async () => json(200, { accepted: true, plan_id: 'p', robot_id: 'OR-03', graph_revision: 'g1.c1', traffic_revision: 9 }));
    const api = new HttpNavApi('http://x', 'run_a', f);
    await api.commit('OR-03', { plan_id: 'p', graph_revision: 'g1.c1', traffic_revision: 8, lease_id: 'L1', idempotency_key: 'k' });
    await api.commit('OR-03', { plan_id: 'p', graph_revision: 'g1.c1', traffic_revision: 8 });
    const bodies = f.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0]).toEqual({ plan_id: 'p', graph_revision: 'g1.c1', traffic_revision: 8, lease_id: 'L1', idempotency_key: 'k' });
    expect(bodies[1]).toEqual({ plan_id: 'p', graph_revision: 'g1.c1', traffic_revision: 8 });
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain('/runs/run_a/robots/OR-03/route/commit');
  });
});

describe('route session (destination mode)', () => {
  beforeEach(() => {
    resetNav();
    resetControl();
    useWorld.setState({ robots: { 'OR-03': { id: 'OR-03', class: 'outrig', name: 'OUTRIG OR-03' } as unknown as Robot } });
  });

  const fake = (over: Partial<Record<'plan' | 'commit' | 'cancel', unknown>> = {}) => {
    const api = {
      plan: vi.fn(async () => ({ ok: true, value: PLAN })),
      commit: vi.fn(async () => ({ ok: true, value: { plan_id: PLAN.plan_id, robot_id: 'OR-03', graph_revision: 'g1.c1', traffic_revision: 9 } })),
      cancel: vi.fn(async () => ({ ok: true, value: { cancelled: true } })),
      graphs: vi.fn(async () => ({ ok: false, refusal: { reason: 'NETWORK', detail: 'x' } })),
      ...over,
    };
    setNavApi(api as unknown as HttpNavApi);
    return api;
  };

  it('plan -> preview -> commit -> following; the preview is not "following" until the server accepted', async () => {
    const api = fake();
    useNav.setState({ robotId: 'OR-03', phase: 'selecting' });
    await navActions.planTo('SV:ROAD-04:15.30');
    expect(useNav.getState().phase).toBe('planned');
    expect(useNav.getState().plan?.eta_s).toBe(53.4);
    await navActions.commit();
    expect(api.commit).toHaveBeenCalledWith('OR-03', expect.objectContaining({ plan_id: PLAN.plan_id, graph_revision: 'g1.c1', traffic_revision: 8, lease_id: null }));
    expect(useNav.getState().phase).toBe('following');
    expect(useNav.getState().trafficRevision).toBe(9);
  });

  it('a refused plan shows the server reason and detail, and leaves no plan to commit', async () => {
    fake({ plan: vi.fn(async () => ({ ok: false, refusal: { reason: 'PIPE_CLEARANCE', detail: 'bore 80 mm < 90 mm', http_status: 409 } })) });
    useNav.setState({ robotId: 'OR-03', phase: 'selecting' });
    await navActions.planTo('n_x');
    const s = useNav.getState();
    expect(s.phase).toBe('refused');
    expect(s.refusal).toMatchObject({ reason: 'PIPE_CLEARANCE', detail: 'bore 80 mm < 90 mm' });
    expect(s.plan).toBeNull();
    await navActions.commit(); // nothing planned: must not call the server
  });

  it('a refused commit is shown verbatim and the robot is not marked as following', async () => {
    fake({ commit: vi.fn(async () => ({ ok: false, refusal: { reason: 'RESERVATION_CONFLICT', detail: 'E:XA-W:05 is held by OR-01', owner: 'OR-01' } })) });
    useNav.setState({ robotId: 'OR-03', phase: 'selecting' });
    await navActions.planTo('t');
    await navActions.commit();
    expect(useNav.getState().phase).toBe('refused');
    expect(useNav.getState().refusal?.reason).toBe('RESERVATION_CONFLICT');
    expect(useNav.getState().committed).toBeNull();
  });

  it('a network failure while planning is reported as NETWORK, not as a route', async () => {
    fake({ plan: vi.fn(async () => ({ ok: false, refusal: { reason: 'NETWORK', detail: 'fetch failed' } })) });
    useNav.setState({ robotId: 'OR-03', phase: 'selecting' });
    await navActions.planTo('t');
    expect(useNav.getState()).toMatchObject({ phase: 'refused', plan: null });
  });

  it('events: committed -> paused -> arrived, and traffic yield / blocked / released', () => {
    useNav.setState({ robotId: 'OR-03', phase: 'following', plan: PLAN as never, committed: { plan_id: PLAN.plan_id } as never });
    applyNavEvent({ type: 'robot.route_paused', entity_id: 'OR-03', payload: { robot_id: 'OR-03', plan_id: PLAN.plan_id, reason: 'manual_override', graph_revision: 'g2.c1' } });
    expect(useNav.getState().phase).toBe('paused');
    expect(useNav.getState().graphRevision).toBe('g2.c1');
    applyNavEvent({ type: 'traffic.yield', entity_id: 'OR-03', payload: { robot_id: 'OR-03', to: 'OR-01', strategy: 'retreat_to_port' } });
    expect(useNav.getState().traffic['OR-03']).toMatchObject({ kind: 'yield', to: 'OR-01' });
    applyNavEvent({ type: 'traffic.blocked', entity_id: 'OR-03', payload: { robot_id: 'OR-03', reason: 'DEADLOCK', cycle: ['OR-03', 'OR-01'], action: 'resolving' } });
    expect(useNav.getState().traffic['OR-03']).toMatchObject({ kind: 'blocked', reason: 'DEADLOCK', to: 'OR-03 > OR-01' });
    applyNavEvent({ type: 'traffic.reservation', entity_id: 'OR-03', payload: { robot_id: 'OR-03', action: 'released' } });
    expect(useNav.getState().traffic['OR-03']).toBeUndefined();
    applyNavEvent({ type: 'robot.arrived', entity_id: 'OR-03', payload: { robot_id: 'OR-03', plan_id: PLAN.plan_id, eta_s: 53.4, actual_s: 55.1 } });
    expect(useNav.getState().phase).toBe('arrived');
    expect(useNav.getState().arrived).toMatchObject({ eta_s: 53.4, actual_s: 55.1 });
  });

  it('a graph change marks the loaded graphs stale', () => {
    useNav.setState({ graphs: { exterior: { kind: 'exterior', graph_revision: 'a', closed_edges: [], nodes: [], edges: [] } } });
    applyNavEvent({ type: 'nav.graph_changed', payload: { graph_revision: 'b' } });
    expect(useNav.getState()).toMatchObject({ graphStale: true, graphRevision: 'b', graphs: {} });
  });
});

describe('lease / drive client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the drive envelope as given and resolves protocol refusals (never throws them)', async () => {
    const f = vi.fn(async () => json(409, { accepted: false, code: 'lease_revoked', reason: 'Control was withdrawn: the lease expired', revoked_reason: 'lease_expired' }));
    vi.stubGlobal('fetch', f);
    const api = new HttpControlApi('http://x', 'current');
    const intent: DriveIntent = { lease_id: 'L1', lease_epoch: 3, command_seq: 7, idempotency_key: 'k', topology_revision: 't', throttle: 1, steer: 0, brake: false, graph_revision: 'g1.c1', branch: 'left', duration_ms: 200 };
    const r = await api.drive('OR-03', intent);
    expect(r).toMatchObject({ accepted: false, code: 'lease_revoked', revoked_reason: 'lease_expired' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x/api/v1/runs/current/robots/OR-03/drive');
    expect(JSON.parse(String(init.body))).toMatchObject({ lease_id: 'L1', command_seq: 7, graph_revision: 'g1.c1', branch: 'left' });
  });

  it('rejects with ControlNetworkError when there is no answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(new HttpControlApi('http://x').heartbeat('OR-03', { lease_id: 'L', lease_epoch: 1 })).rejects.toThrow(/offline/);
  });
});

describe('control session on a fake API', () => {
  const sent: DriveIntent[] = [];
  let released = 0;
  let api: ControlApi;
  let driveReply: (i: DriveIntent) => unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    resetControl();
    resetNav();
    sent.length = 0;
    released = 0;
    driveReply = (i) => ({ accepted: true, robot_id: 'OR-03', lease_epoch: 1, applied_seq: i.command_seq, controller_state: 'MANUAL', world_version: 1, pose: { segment_id: 'e', s_m: 0, speed_m_s: 0, velocity_m_s: 0, facing: 1, position_xyz_m: [0, 0, 0] }, odometer_m: 0 });
    api = {
      label: 'fake',
      live: true,
      lease: async () => ({ accepted: true, robot_id: 'OR-03', lease_id: 'L1', lease_epoch: 1, granted_world_version: 1, expires_in_ms: 5000, heartbeat_interval_ms: 500, deadman_ms: 1500, limits: { max_speed_m_s: 0.4, max_accel_m_s2: 0.6, intent_ttl_ms: [20, 250], max_intent_rate_hz: 20 }, topology_revision: 't', control: {} as never }),
      heartbeat: async () => ({ accepted: true, expires_in_ms: 5000, controller_state: 'MANUAL' }) as never,
      drive: async (_id, i) => {
        sent.push(i);
        return driveReply(i) as never;
      },
      release: async () => {
        released++;
        return { accepted: true, robot_id: 'OR-03', controller_state: 'AUTONOMOUS', resumed: 'mission', control: {} as never } as never;
      },
    };
    setControlApi(api);
    useWorld.setState({
      connection: 'live',
      stale: false,
      version: 5,
      topology: { facility: { topology_hash: 'th' } } as unknown as Topology,
      robots: { 'OR-03': { id: 'OR-03', class: 'outrig', name: 'OR-03' } as unknown as Robot },
    });
    useNav.setState({ graphRevision: 'g1.c1' });
  });
  afterEach(() => {
    resetControl();
    vi.useRealTimers();
  });

  it('sends intents at 15..30 Hz with lease_id, monotonic command_seq and graph_revision, only after the lease is granted', async () => {
    const p = controlActions.takeControl('OR-03');
    expect(sent.length).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(useControl.getState().inputEnabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBeGreaterThanOrEqual(15);
    expect(sent.length).toBeLessThanOrEqual(30);
    expect(sent.every((i) => i.lease_id === 'L1' && i.graph_revision === 'g1.c1' && i.duration_ms <= 250)).toBe(true);
    const seqs = sent.map((i) => i.command_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(useControl.getState().rttMs).not.toBeNull();
  });

  it('blur / hidden -> zero input, SAFE_STOP and a release; no intent goes out afterwards', async () => {
    await controlActions.takeControl('OR-03');
    controlActions.setInput('keyboard', { throttle: 1 });
    await vi.advanceTimersByTimeAsync(200);
    controlActions.safeStop('client_hidden');
    expect(useControl.getState().input).toEqual({ throttle: 0, steer: 0, brake: false });
    expect(useControl.getState().state).toBe('SAFE_STOP');
    await vi.advanceTimersByTimeAsync(10);
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBe(n);
    expect(released).toBe(1);
    expect(sent[sent.length - 1]).toMatchObject({ throttle: 0, steer: 0, brake: true });
  });

  it('a rejected intent (lease revoked) stops the session and invents no pose or motion', async () => {
    await controlActions.takeControl('OR-03');
    driveReply = () => ({ accepted: false, code: 'lease_revoked', reason: 'Control was withdrawn: the lease expired', revoked_reason: 'lease_expired' });
    controlActions.setInput('keyboard', { throttle: 1 });
    await vi.advanceTimersByTimeAsync(300);
    const s = useControl.getState();
    expect(s.state === 'SAFE_STOP' || s.state === 'AUTONOMOUS').toBe(true);
    expect(s.inputEnabled).toBe(false);
    expect(s.ack).toBeNull();
    expect(s.stop?.reason).toBe('lease_expired');
  });

  it('a lost link (no acks) becomes link_lost within about a second', async () => {
    await controlActions.takeControl('OR-03');
    api.drive = async () => Promise.reject(new Error('offline'));
    api.heartbeat = async () => Promise.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(useControl.getState().stop?.reason).toBe('link_lost');
    expect(useControl.getState().inputEnabled).toBe(false);
  });

  it('out-of-order acks and a robot still acquiring are not shown as warnings or counted as refusals', async () => {
    await controlActions.takeControl('OR-03');
    driveReply = () => ({ accepted: false, code: 'not_controllable', reason: 'command_seq_not_increasing' });
    await vi.advanceTimersByTimeAsync(300);
    driveReply = () => ({ accepted: false, code: 'not_controllable', reason: 'lease_not_active: robot is still acquiring (retry)' });
    await vi.advanceTimersByTimeAsync(300);
    expect(useControl.getState().refused).toBe(0);
    expect(useControl.getState().notice).toBeNull();
    expect(useControl.getState().inputEnabled).toBe(true);
  });

  it('our own LEASE_PENDING control update (AUTO until the first ack) is not a revocation; a foreign or revoked one is', async () => {
    const ctlOf = (over: object) => ({ authority: 'AUTO', controller_state: 'LEASE_PENDING', lease_id: 'L1', lease_epoch: 1, controllable: true, ...over }) as never;
    const setCtl = (control: unknown) => useWorld.setState((st) => ({ robots: { ...st.robots, 'OR-03': { ...st.robots['OR-03'], control } as never } }));
    await controlActions.takeControl('OR-03');
    setCtl(ctlOf({}));
    expect(useControl.getState().inputEnabled).toBe(true);
    expect(useControl.getState().stop).toBeNull();
    setCtl(ctlOf({ authority: 'HUMAN', controller_state: 'MANUAL' }));
    expect(useControl.getState().inputEnabled).toBe(true);
    // somebody else's pending lease on the robot we thought we held: that IS a lost lease
    setCtl(ctlOf({ lease_id: 'L2' }));
    expect(useControl.getState().state).toBe('SAFE_STOP');
    expect(useControl.getState().inputEnabled).toBe(false);
  });

  it('a revoked control update (authority back to AUTO, no pending lease) stops the session', async () => {
    await controlActions.takeControl('OR-03');
    useWorld.setState((st) => ({ robots: { ...st.robots, 'OR-03': { ...st.robots['OR-03'], control: { authority: 'AUTO', controller_state: 'AUTONOMOUS', lease_epoch: 2, controllable: true, last_reason: 'deadman_timeout' } as never } } }));
    expect(useControl.getState().state).toBe('SAFE_STOP');
    expect(useControl.getState().stop?.reason).toBe('deadman_timeout');
  });

  it('a stale graph revision is shown verbatim and keeps the lease', async () => {
    await controlActions.takeControl('OR-03');
    driveReply = () => ({ accepted: false, code: 'not_controllable', reason: 'stale_graph_revision: the navigation graph changed; re-read /navigation/graphs' });
    await vi.advanceTimersByTimeAsync(100);
    expect(useControl.getState().notice?.text).toMatch(/^stale_graph_revision/);
    expect(useControl.getState().inputEnabled).toBe(true);
  });

  it('commit under a lease waits for the first ack and sends the lease id', async () => {
    const nav = {
      plan: async () => ({ ok: true, value: PLAN }),
      commit: vi.fn(async () => ({ ok: true, value: { plan_id: PLAN.plan_id, robot_id: 'OR-03', graph_revision: 'g1.c1', traffic_revision: 8 } })),
    };
    setNavApi(nav as unknown as HttpNavApi);
    await controlActions.takeControl('OR-03');
    useNav.setState({ robotId: 'OR-03', phase: 'selecting' });
    await navActions.planTo('t');
    const done = navActions.commit();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(nav.commit).toHaveBeenCalledWith('OR-03', expect.objectContaining({ lease_id: 'L1' }));
    expect(useControl.getState().ack).not.toBeNull();
  });
});
