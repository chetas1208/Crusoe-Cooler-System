/**
 * Manual-control service for the TypeScript reference simulator (MOCK).
 *
 * Implements backend.md §10 exactly as the real backend must: server-owned exclusive leases,
 * sequence-numbered short-TTL drive intents, a deadman, fixed-step server-side integration along the
 * pipe centerline (pose is never client-authoritative), reason-coded SAFE_HOLD and a reconciled handoff
 * back to the agent. Both the embedded transport and apps/mock-api call this one class, so the browser
 * and the network mock behave identically.
 */
import type { EntityId, EventType, Topology, Vec3 } from '../contracts';
import {
  CONTROL_DEFAULTS as D,
  type ControlErrorCode,
  type ControlReason,
  type ControlRefusal,
  type ControllerState,
  type DriveAck,
  type DriveIntent,
  type DriveLimits,
  type DriveResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type JunctionExit,
  type JunctionInfo,
  type LeaseRequest,
  type LeaseResponse,
  type ReleaseAck,
  type ReleaseRequest,
  type ReleaseResponse,
  type RobotControlInfo,
  type RobotControlPayload,
  type ScanResult,
  type ToolCapability,
  type ControlEventKind,
} from '../contracts.control';
import { clamp, createRng, samplePath, type Rng } from '../geometry';
import { REASON_TEXT } from '../control/reasons';
import type { PlantState } from './plant';
import type { PipeGraph, RobotActor } from './robots';

export interface ControlDeps {
  topo: Topology;
  graph: PipeGraph;
  plant: PlantState;
  robots: Record<string, RobotActor>;
  emit: (type: EventType, entity: string, payload: unknown) => void;
  tick: () => number;
  /** wall-clock ms; injectable so tests can drive the deadman deterministically */
  now: () => number;
  /** optional overrides (tests) */
  safeHoldResumeMs?: number;
  deadmanMs?: number;
  leaseTtlMs?: number;
}

interface Lease {
  lease_id: string;
  epoch: number;
  principal: string;
  expires_ms: number;
  last_ms: number;
  last_seq: number;
  last_key: string;
  throttle: number;
  steer: number;
  brake: boolean;
  until_ms: number;
  exit: EntityId | null;
  odometer: number;
}

interface RobotCtl {
  epoch: number;
  lease: Lease | null;
  /** SAFE_HOLD after an unplanned stop */
  hold: { since_ms: number; reason: ControlReason; lease_id: string; principal: string; auto: boolean } | null;
  lamp: boolean;
  scan: { until_ms: number } | null;
  lastScan?: ScanResult;
  lastReason?: ControlReason;
  lastSeq: number;
  lastEol: number;
  rejects: Map<string, number>;
  leaseKeys: Map<string, LeaseResponse>;
  releaseKeys: Map<string, ReleaseResponse>;
  lastAck: DriveAck | null;
  lastRevoked: { lease_id: string; reason: ControlReason } | null;
}

const BRAKE_DECEL = 2.5;
const DECEL = 1.5;

const refuse = (code: ControlErrorCode, reason: string, extra: Partial<ControlRefusal> = {}): ControlRefusal => ({ accepted: false, code, reason, ...extra });

export class ControlService {
  private ctl = new Map<string, RobotCtl>();
  private seq = 0;
  private rng: Rng;
  readonly stats = { accepted: 0, rejected: 0 };
  /** accepted vs rejected operator commands are kept apart (backend.md §10.4) */
  readonly rejectedLog: Array<{ tick: number; robot_id: string; code: ControlErrorCode; seq?: number }> = [];
  readonly limits: DriveLimits = {
    max_speed_m_s: D.max_speed_m_s,
    max_accel_m_s2: D.max_accel_m_s2,
    intent_ttl_ms: [...D.intent_ttl_ms] as [number, number],
    max_intent_rate_hz: D.max_intent_rate_hz,
  };

  constructor(private d: ControlDeps) {
    this.rng = createRng(0x51ca9);
    for (const r of Object.values(d.robots)) {
      this.ctl.set(r.id, {
        epoch: 0,
        lease: null,
        hold: null,
        lamp: true,
        scan: null,
        lastSeq: 0,
        lastEol: 0,
        rejects: new Map(),
        leaseKeys: new Map(),
        releaseKeys: new Map(),
        lastAck: null,
        lastRevoked: null,
      });
      r.controlProvider = (x) => this.info(x);
    }
  }

  private get deadmanMs() {
    return this.d.deadmanMs ?? D.deadman_ms;
  }
  private get leaseTtlMs() {
    return this.d.leaseTtlMs ?? D.lease_ttl_ms;
  }
  private get holdResumeMs() {
    return this.d.safeHoldResumeMs ?? D.safe_hold_resume_ms;
  }

  /* ───────────────────────────── queries ───────────────────────────── */

  private node(id: string) {
    return this.d.topo.nodes.find((n) => n.id === id);
  }

  private zoneIsolated(edgeId: string): boolean {
    const z = this.d.graph.edge(edgeId)?.zone_id;
    return (z === 'zone_a' && !!this.d.plant.controls.isolated['valve_za']) || (z === 'zone_b' && !!this.d.plant.controls.isolated['valve_zb']);
  }

  private isNearServiceTarget(pos: Vec3): boolean {
    for (const a of this.d.topo.assets) {
      if (a.service_xyz_m) {
        const d = Math.hypot(pos[0] - a.service_xyz_m[0], pos[2] - a.service_xyz_m[2]);
        if (d < 1.8) return true;
      }
    }
    return false;
  }

  /** Why this robot cannot be put under manual control right now (null = it can). */
  uncontrollableReason(r: RobotActor): string | null {
    if (r.mode === 'FAILED' || r.mode === 'ABORTED') return `${r.name} has ${r.mode.toLowerCase()} — it cannot be driven.`;
    if (r.mode === 'WORKING') return r.klass === 'inpipe' ? 'The crawler is brushing deposits — wait for the action to finish.' : 'A service task is in progress — wait for the action to finish.';
    if (r.battery <= 8) return `Battery ${Math.round(r.battery)}% is too low to drive.`;
    if (r.klass === 'inpipe') {
      if (r.segment_id === undefined || r.s_m === undefined) return 'The robot has no reported pipe position.';
      const e = this.d.graph.edge(r.segment_id);
      if (!e?.robot_passable) return `Segment ${e?.label ?? r.segment_id} is not robot-passable: ${e?.not_passable_reason ?? 'blocked'}.`;
      if (this.zoneIsolated(r.segment_id)) return `Segment ${e.label} is isolated for service (valve closed).`;
    }
    return null;
  }

  private tools(r: RobotActor, c: RobotCtl): ToolCapability[] {
    const moving = Math.abs(r.manual?.v ?? 0) > 0.02 || r.speed > 0.02;
    const manual = !!c.lease;
    if (r.klass === 'outrig') {
      const nearTarget = this.isNearServiceTarget(r.pos);
      return [
        { id: 'lamp', label: c.lamp ? 'Work light off' : 'Work light on', available: manual, reason: manual ? undefined : 'Take control first.' },
        {
          id: 'scan',
          label: c.scan ? 'Inspecting equipment…' : 'Visual & IR inspection',
          available: manual && !c.scan,
          reason: !manual ? 'Take control first.' : c.scan ? 'Inspection in progress.' : undefined,
        },
        {
          id: 'brush_clear',
          label: 'Service action (strainer / valve / clamp)',
          available: manual && nearTarget && !moving,
          reason: !manual ? 'Take control first.' : !nearTarget ? 'Position the rover within 1.8 m of a service point.' : moving ? 'Stop rover before servicing.' : undefined,
        },
      ];
    }
    return [
      { id: 'lamp', label: c.lamp ? 'Lamp off' : 'Lamp on', available: manual, reason: manual ? undefined : 'Take control first.' },
      {
        id: 'scan',
        label: c.scan ? 'Scanning…' : 'Scan wall',
        available: manual && !moving && !c.scan,
        reason: !manual ? 'Take control first.' : c.scan ? 'A scan is already running.' : moving ? 'Stop the crawler to scan.' : undefined,
      },
      { id: 'brush_clear', label: 'Brush clear', available: false, reason: 'Requires an approved work order on an isolated section.' },
    ];
  }

  private exitsAt(nodeId: string, fromEdge: string): string[] {
    return this.d.topo.edges.filter((e) => e.id !== fromEdge && e.robot_passable && (e.from === nodeId || e.to === nodeId)).map((e) => e.id);
  }

  private allExitsAt(nodeId: string, fromEdge: string): JunctionExit[] {
    const g = this.d.graph;
    const edge = g.edge(fromEdge);
    const out: JunctionExit[] = [];
    // direction of travel into the node
    const atEnd = edge.to === nodeId;
    const L = g.length(fromEdge);
    const tIn = samplePath(g.path(fromEdge), atEnd ? L : 0).t;
    const dirIn: Vec3 = atEnd ? tIn : [-tIn[0], -tIn[1], -tIn[2]];
    for (const e of this.d.topo.edges) {
      if (e.id === fromEdge || (e.from !== nodeId && e.to !== nodeId)) continue;
      const leavingFromStart = e.from === nodeId;
      const tOut = samplePath(g.path(e.id), leavingFromStart ? 0 : g.length(e.id)).t;
      const dirOut: Vec3 = leavingFromStart ? tOut : [-tOut[0], -tOut[1], -tOut[2]];
      // right-hand vector of the travel direction on the ground plane
      const right: Vec3 = [-dirIn[2], 0, dirIn[0]];
      const lat = dirOut[0] * right[0] + dirOut[2] * right[2];
      const fwd = dirOut[0] * dirIn[0] + dirOut[2] * dirIn[2];
      out.push({
        segment_id: e.id,
        label: e.label,
        passable: e.robot_passable,
        reason: e.robot_passable ? (this.zoneIsolated(e.id) ? 'Isolated for service (valve closed).' : undefined) : e.not_passable_reason,
        bearing_deg: Math.round((Math.atan2(lat, fwd) * 180) / Math.PI),
      });
    }
    return out.sort((a, b) => a.bearing_deg - b.bearing_deg);
  }

  private ahead(r: RobotActor): { node: string; dist: number } | null {
    const m = r.manual;
    if (!m || !m.edge_id || m.s === undefined) return null;
    const e = this.d.graph.edge(m.edge_id);
    const L = this.d.graph.length(m.edge_id);
    // "ahead" follows the direction of travel: the nose when driving forward, the tail when backing up
    const travel = (m.v < -0.01 ? -1 : 1) * m.facing;
    return travel > 0 ? { node: e.to, dist: L - m.s } : { node: e.from, dist: m.s };
  }

  private junctionOf(r: RobotActor, c: RobotCtl): JunctionInfo | undefined {
    const a = this.ahead(r);
    if (!a || a.dist > 2.5 || !r.manual?.edge_id) return undefined;
    const exits = this.allExitsAt(a.node, r.manual.edge_id);
    if (exits.filter((x) => x.passable).length < 2) return undefined;
    return { node_id: a.node, node_label: this.node(a.node)?.label ?? a.node, distance_m: Math.round(a.dist * 100) / 100, exits, selected: c.lease?.exit ?? null };
  }

  info(r: RobotActor): RobotControlInfo {
    const c = this.ctl.get(r.id)!;
    const reason = this.uncontrollableReason(r);
    const holder = c.lease?.principal ?? c.hold?.principal;
    const state: ControllerState = c.lease ? 'MANUAL' : c.hold ? 'SAFE_HOLD' : 'AUTONOMOUS';
    const a = this.ahead(r);
    const m = r.manual;
    return {
      authority: c.lease ? 'HUMAN' : c.hold ? 'STOP' : 'AUTO',
      controller_state: state,
      controllable: !reason || state !== 'AUTONOMOUS',
      uncontrollable_reason: reason && state === 'AUTONOMOUS' ? reason : undefined,
      lease_id: c.lease?.lease_id,
      lease_epoch: c.epoch,
      holder,
      facing: m?.facing ?? this.facingOf(r),
      velocity_m_s: round(m?.v ?? 0, 3),
      lamp: c.lamp,
      last_applied_seq: c.lastSeq,
      last_reason: c.lastReason,
      next_node: a ? { id: a.node, label: this.node(a.node)?.label ?? a.node, distance_m: round(a.dist, 2) } : undefined,
      junction: m ? this.junctionOf(r, c) : undefined,
      tools: this.tools(r, c),
      last_scan: c.lastScan,
      odometer_m: round(c.lease?.odometer ?? 0, 2),
    };
  }

  private facingOf(r: RobotActor): 1 | -1 {
    if (r.segment_id === undefined || r.s_m === undefined) return 1;
    const t = samplePath(this.d.graph.path(r.segment_id), r.s_m).t;
    return t[0] * r.heading[0] + t[1] * r.heading[1] + t[2] * r.heading[2] >= 0 ? 1 : -1;
  }

  /** The robots whose control info should ride along on robot.pose (anything not plainly autonomous). */
  isEngaged(id: string) {
    const c = this.ctl.get(id);
    return !!c && (!!c.lease || !!c.hold);
  }

  /* ───────────────────────────── events ───────────────────────────── */

  private event(r: RobotActor, event: ControlEventKind, reason?: string, data?: Record<string, number | string>) {
    const payload: RobotControlPayload = { robot_id: r.id, event, reason, control: this.info(r), data };
    this.d.emit('robot.control', r.id, payload);
  }

  private reject(r: RobotActor | undefined, robotId: string, resp: ControlRefusal, seq?: number): ControlRefusal {
    this.stats.rejected++;
    this.rejectedLog.push({ tick: this.d.tick(), robot_id: robotId, code: resp.code, seq });
    if (this.rejectedLog.length > 200) this.rejectedLog.shift();
    const c = this.ctl.get(robotId);
    if (r && c && c.lease) {
      // emit at most one rejection event per code per two seconds so a held key cannot flood the feed
      const now = this.d.now();
      const last = c.rejects.get(resp.code) ?? 0;
      if (now - last > 2000) {
        c.rejects.set(resp.code, now);
        this.event(r, 'drive.rejected', resp.code, { reason: resp.reason });
      }
    }
    return resp;
  }

  /* ───────────────────────────── lease ───────────────────────────── */

  lease(robotId: string, req: LeaseRequest): LeaseResponse {
    const r = this.d.robots[robotId];
    const c = this.ctl.get(robotId);
    if (!r || !c) return refuse('unknown_robot', `No robot with id ${robotId}.`);
    if (!req || typeof req.idempotency_key !== 'string' || req.idempotency_key.length < 8 || typeof req.client_id !== 'string' || !req.client_id) {
      return refuse('bad_request', 'A lease needs an idempotency key and a client id.');
    }
    const cached = c.leaseKeys.get(req.idempotency_key);
    if (cached) return cached;
    const done = (resp: LeaseResponse) => {
      c.leaseKeys.set(req.idempotency_key, resp);
      if (c.leaseKeys.size > 50) c.leaseKeys.delete(c.leaseKeys.keys().next().value as string);
      return resp;
    };
    const now = this.d.now();
    const tick = this.d.tick();
    this.expire(r, c, now);
    if (typeof req.expected_world_version !== 'number' || req.expected_world_version > tick + 2) return done(refuse('stale_world_version', 'Your view is ahead of the server — reload the world.', { current_world_version: tick }));
    if (tick - req.expected_world_version > D.max_stale_ticks) return done(refuse('stale_world_version', 'Your view of the plant is out of date. Refresh and take control again.', { current_world_version: tick }));
    if (req.topology_revision !== this.d.topo.facility.topology_hash) return done(refuse('topology_changed', 'The pipe topology changed since you loaded it. Reload before driving.', { current_world_version: tick }));
    if (c.lease) return done(refuse('lease_held', c.lease.principal === req.client_id ? 'You already hold control of this robot in another session.' : 'Another operator holds control of this robot.', { holder: c.lease.principal }));
    const why = c.hold ? null : this.uncontrollableReason(r);
    if (why) return done(refuse('not_controllable', why));
    if (!r.beginManual()) return done(refuse('not_controllable', 'The robot has no reported pipe position.'));
    c.epoch++;
    c.hold = null;
    c.lastRevoked = null;
    c.lastSeq = 0;
    c.scan = null;
    c.lastReason = undefined;
    const lease: Lease = {
      lease_id: `ls_${robotId}_${c.epoch}_${(++this.seq).toString(36)}${Math.floor(this.rng.next() * 1e6).toString(36)}`,
      epoch: c.epoch,
      principal: req.client_id,
      expires_ms: now + this.leaseTtlMs,
      last_ms: now,
      last_seq: 0,
      last_key: '',
      throttle: 0,
      steer: 0,
      brake: true,
      until_ms: 0,
      exit: null,
      odometer: 0,
    };
    c.lease = lease;
    if (r.klass === 'inpipe') {
      r.setManualPose(r.manual!.edge_id!, r.manual!.s!, r.manual!.facing, 0);
    } else {
      r.setManualFloorPose(r.manual!.x!, r.manual!.z!, r.manual!.yaw ?? 0, 0);
    }
    this.event(r, 'human.override', 'operator_takeover');
    return done({
      accepted: true,
      robot_id: robotId,
      lease_id: lease.lease_id,
      lease_epoch: lease.epoch,
      granted_world_version: tick,
      expires_in_ms: this.leaseTtlMs,
      heartbeat_interval_ms: D.heartbeat_interval_ms,
      deadman_ms: this.deadmanMs,
      limits: this.limits,
      topology_revision: this.d.topo.facility.topology_hash,
      control: this.info(r),
    });
  }

  heartbeat(robotId: string, req: HeartbeatRequest): HeartbeatResponse {
    const r = this.d.robots[robotId];
    const c = this.ctl.get(robotId);
    if (!r || !c) return refuse('unknown_robot', `No robot with id ${robotId}.`);
    const now = this.d.now();
    this.expire(r, c, now);
    const bad = this.checkLease(c, req?.lease_id, req?.lease_epoch);
    if (bad) return bad;
    const l = c.lease!;
    l.last_ms = now;
    l.expires_ms = now + this.leaseTtlMs;
    return { accepted: true, expires_in_ms: this.leaseTtlMs, controller_state: 'MANUAL' };
  }

  private checkLease(c: RobotCtl, leaseId: unknown, epoch: unknown): ControlRefusal | null {
    if (!c.lease) {
      if (c.lastRevoked && c.lastRevoked.lease_id === leaseId) return refuse('lease_revoked', `Control was withdrawn: ${REASON_TEXT[c.lastRevoked.reason]}.`, { revoked_reason: c.lastRevoked.reason });
      return refuse('no_lease', 'You do not hold control of this robot.');
    }
    if (leaseId !== c.lease.lease_id) return refuse('no_lease', 'That lease is not the one held on this robot.', { holder: c.lease.principal });
    if (epoch !== c.lease.epoch) return refuse('stale_epoch', 'The control epoch is stale — take control again.');
    return null;
  }

  /* ───────────────────────────── drive ───────────────────────────── */

  drive(robotId: string, i: DriveIntent): DriveResponse {
    const r = this.d.robots[robotId];
    const c = this.ctl.get(robotId);
    if (!r || !c) return refuse('unknown_robot', `No robot with id ${robotId}.`);
    const now = this.d.now();
    this.expire(r, c, now);
    const seq = typeof i?.command_seq === 'number' ? i.command_seq : undefined;
    const bad = this.checkLease(c, i?.lease_id, i?.lease_epoch);
    if (bad) return this.reject(r, robotId, bad, seq);
    const l = c.lease!;
    const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
    if (!Number.isInteger(i.command_seq) || i.command_seq < 1 || !num(i.throttle, -1, 1) || !num(i.steer, -1, 1) || typeof i.brake !== 'boolean' || !num(i.duration_ms, D.intent_ttl_ms[0], D.intent_ttl_ms[1]) || typeof i.idempotency_key !== 'string' || i.idempotency_key.length < 8) {
      return this.reject(r, robotId, refuse('bad_request', 'Drive intent is malformed or out of range.'), seq);
    }
    if (i.command_seq <= l.last_seq) {
      if (i.idempotency_key === l.last_key && c.lastAck) return c.lastAck; // exact replay: same answer, no second effect
      return this.reject(r, robotId, refuse('stale_seq', 'Command sequence is not newer than the last accepted one.'), seq);
    }
    if (i.topology_revision !== this.d.topo.facility.topology_hash) return this.reject(r, robotId, refuse('topology_changed', 'The pipe topology changed — reload before driving.'), seq);
    const m = r.manual!;

    if (r.klass === 'outrig') {
      l.last_seq = i.command_seq;
      l.last_key = i.idempotency_key;
      l.last_ms = now;
      l.expires_ms = now + this.leaseTtlMs;
      l.throttle = i.throttle;
      l.steer = i.steer;
      l.brake = i.brake;
      l.until_ms = now + i.duration_ms;
      l.exit = null;
      c.lastSeq = i.command_seq;
      if (i.tool === 'lamp_on' || i.tool === 'lamp_off') c.lamp = i.tool === 'lamp_on';
      if (i.tool === 'scan' && !c.scan && Math.abs(r.speed) < 0.05) c.scan = { until_ms: now + 2500 };
      this.stats.accepted++;
      const ack = this.ack(r, c);
      c.lastAck = ack;
      return ack;
    }

    const here = this.d.graph.edge(m.edge_id!);
    if (!here.robot_passable) return this.reject(r, robotId, refuse('not_passable', `Segment ${here.label} is not robot-passable: ${here.not_passable_reason ?? 'blocked'}.`), seq);
    // an exit that names the segment we are already on was crossed a moment ago: ignore, don't refuse
    const wantedExit = i.selected_exit_segment_id && i.selected_exit_segment_id !== m.edge_id ? i.selected_exit_segment_id : null;
    if (wantedExit) {
      const ex = this.d.graph.edge(wantedExit);
      const adjacent = !!ex && (ex.from === here.from || ex.from === here.to || ex.to === here.from || ex.to === here.to) && ex.id !== here.id;
      if (!ex || !adjacent) return this.reject(r, robotId, refuse('not_passable', 'That segment does not branch from the current one.'), seq);
      if (!ex.robot_passable) return this.reject(r, robotId, refuse('not_passable', `${ex.label} cannot be entered: ${ex.not_passable_reason ?? 'not robot-passable'}.`), seq);
      if (this.zoneIsolated(ex.id)) return this.reject(r, robotId, refuse('not_passable', `${ex.label} is isolated for service (valve closed).`), seq);
    }
    // commit
    l.last_seq = i.command_seq;
    l.last_key = i.idempotency_key;
    l.last_ms = now;
    l.expires_ms = now + this.leaseTtlMs;
    l.throttle = i.throttle;
    l.steer = i.steer;
    l.brake = i.brake;
    l.until_ms = now + i.duration_ms;
    l.exit = wantedExit;
    c.lastSeq = i.command_seq;
    if (i.tool === 'lamp_on' || i.tool === 'lamp_off') c.lamp = i.tool === 'lamp_on';
    if (i.tool === 'scan' && !c.scan && Math.abs(m.v) < 0.02) c.scan = { until_ms: now + 3500 };
    this.stats.accepted++;
    const ack = this.ack(r, c);
    c.lastAck = ack;
    return ack;
  }

  private ack(r: RobotActor, c: RobotCtl): DriveAck {
    const m = r.manual!;
    if (r.klass === 'outrig') {
      return {
        accepted: true,
        robot_id: r.id,
        lease_epoch: c.epoch,
        applied_seq: c.lastSeq,
        controller_state: 'MANUAL',
        world_version: this.d.tick(),
        pose: {
          segment_id: 'floor_corridor',
          s_m: round(c.lease?.odometer ?? 0, 2),
          speed_m_s: round(r.speed, 3),
          velocity_m_s: round(m?.v ?? 0, 3),
          facing: 1,
          position_xyz_m: [r.pos[0], r.pos[1], r.pos[2]],
        },
        odometer_m: round(c.lease?.odometer ?? 0, 2),
      };
    }
    return {
      accepted: true,
      robot_id: r.id,
      lease_epoch: c.epoch,
      applied_seq: c.lastSeq,
      controller_state: 'MANUAL',
      world_version: this.d.tick(),
      pose: { segment_id: m.edge_id!, s_m: round(m.s!, 3), speed_m_s: round(Math.abs(m.v), 3), velocity_m_s: round(m.v, 3), facing: m.facing, position_xyz_m: [r.pos[0], r.pos[1], r.pos[2]] },
      junction: this.junctionOf(r, c),
      next_node: (() => {
        const a = this.ahead(r);
        return a ? { id: a.node, label: this.node(a.node)?.label ?? a.node, distance_m: round(a.dist, 2) } : undefined;
      })(),
      odometer_m: round(c.lease?.odometer ?? 0, 2),
    };
  }

  /* ───────────────────────────── release ───────────────────────────── */

  release(robotId: string, req: ReleaseRequest): ReleaseResponse {
    const r = this.d.robots[robotId];
    const c = this.ctl.get(robotId);
    if (!r || !c) return refuse('unknown_robot', `No robot with id ${robotId}.`);
    if (!req || typeof req.idempotency_key !== 'string' || req.idempotency_key.length < 8) return refuse('bad_request', 'Release needs an idempotency key.');
    const cached = c.releaseKeys.get(req.idempotency_key);
    if (cached) return cached;
    const now = this.d.now();
    this.expire(r, c, now);
    const done = (resp: ReleaseResponse) => {
      c.releaseKeys.set(req.idempotency_key, resp);
      if (c.releaseKeys.size > 50) c.releaseKeys.delete(c.releaseKeys.keys().next().value as string);
      return resp;
    };
    if (c.lease) {
      if (req.lease_id !== c.lease.lease_id) return refuse('no_lease', 'That lease is not the one held on this robot.', { holder: c.lease.principal });
      const reason: ControlReason = req.reason && req.reason !== 'operator_release' ? req.reason : 'operator_release';
      c.lease = null;
      c.lastReason = reason;
      return done(this.finalize(r, c, reason));
    }
    if (c.hold && c.hold.lease_id === req.lease_id) {
      // the operator acknowledges an earlier safety stop: hand back to the agent now
      return done(this.finalize(r, c, c.hold.reason));
    }
    // already released / revoked-and-resumed: releasing is idempotent so the UI can always get out
    return done({ accepted: true, robot_id: robotId, controller_state: c.hold ? 'SAFE_HOLD' : 'AUTONOMOUS', resumed: 'none', already_released: true, control: this.info(r) });
  }

  /** Zero the robot, give the motors back to the agent and report what the agent will do. */
  private finalize(r: RobotActor, c: RobotCtl, reason: ControlReason): ReleaseAck {
    c.scan = null;
    c.hold = null;
    if (r.klass === 'inpipe') {
      r.setManualPose(r.manual!.edge_id!, r.manual!.s!, r.manual!.facing, 0);
    } else {
      r.setManualFloorPose(r.manual!.x!, r.manual!.z!, r.manual!.yaw ?? 0, 0);
    }
    const resumed = r.endManual();
    if (resumed === 'blocked') {
      c.hold = { since_ms: this.d.now(), reason: 'resume_blocked', lease_id: '', principal: '', auto: false };
      c.lastReason = 'resume_blocked';
      this.event(r, 'safe_hold', 'resume_blocked');
      return { accepted: true, robot_id: r.id, controller_state: 'SAFE_HOLD', resumed, control: this.info(r) };
    }
    this.event(r, 'agent.resumed', reason, { resumed });
    return { accepted: true, robot_id: r.id, controller_state: 'AUTONOMOUS', resumed, control: this.info(r) };
  }

  /* ───────────────────────────── safety ───────────────────────────── */

  /** Withdraw the lease: zero velocity, SAFE_HOLD, reason-coded event. The agent resumes after reconciliation. */
  revoke(robotId: string, reason: ControlReason) {
    const r = this.d.robots[robotId];
    const c = this.ctl.get(robotId);
    if (!r || !c || !c.lease) return;
    const l = c.lease;
    c.lease = null;
    c.lastReason = reason;
    c.lastRevoked = { lease_id: l.lease_id, reason };
    c.scan = null;
    c.hold = { since_ms: this.d.now(), reason, lease_id: l.lease_id, principal: l.principal, auto: true };
    r.setHoldMode(true);
    this.event(r, 'safe_hold', reason);
  }

  private expire(r: RobotActor, c: RobotCtl, now: number) {
    const l = c.lease;
    if (!l) return;
    if (now - l.last_ms > this.deadmanMs) this.revoke(r.id, 'deadman_timeout');
    else if (now > l.expires_ms) this.revoke(r.id, 'lease_expired');
  }

  /* ───────────────────────────── fixed-step integration ───────────────────────────── */

  /**
   * Advance every manually-held robot by dtWall seconds of real time. Called from the engine tick; this
   * is the ONLY place a manual pose changes. Manual motion runs in real time regardless of sim speed.
   */
  integrate(dtWall: number) {
    const now = this.d.now();
    for (const r of Object.values(this.d.robots)) {
      const c = this.ctl.get(r.id)!;
      const m = r.manual;
      if (!m) continue;
      this.expire(r, c, now);
      const l = c.lease;
      // interlocks: a closed isolation valve or a flat battery withdraws control
      if (l) {
        if (r.klass === 'inpipe' && m.edge_id && this.zoneIsolated(m.edge_id)) this.revoke(r.id, 'safety_interlock');
        else if (r.battery <= 5) this.revoke(r.id, 'low_battery');
      }
      if (!c.lease && c.hold && c.hold.auto && Math.abs(m.v) < 1e-3 && now - c.hold.since_ms > this.holdResumeMs) {
        // reconciled and idle long enough: the agent takes the robot back
        const reason = c.hold.reason;
        c.lastReason = 'safe_hold_timeout';
        this.finalize(r, c, reason);
        continue;
      }
      this.stepKin(r, c, Math.min(dtWall, 0.1), now);
      if (c.scan && now >= c.scan.until_ms) this.finishScan(r, c);
    }
  }

  private stepKin(r: RobotActor, c: RobotCtl, dt: number, now: number) {
    const m = r.manual!;
    const l = c.lease;

    if (r.klass === 'outrig') {
      const vmax = 0.45;
      const live = !!l && !c.scan && l.until_ms > now && !l.brake;
      const tgt = live ? l!.throttle * vmax : 0;
      const braking = !l || l.brake || l.until_ms <= now || !!c.scan;
      const rate = braking && Math.abs(tgt) < Math.abs(m.v) + 1e-9 ? BRAKE_DECEL : tgt * m.v >= 0 && Math.abs(tgt) > Math.abs(m.v) ? D.max_accel_m_s2 : DECEL;
      let v = m.v + clamp(tgt - m.v, -rate * dt, rate * dt);
      if (Math.abs(v) < 1e-4 && tgt === 0) v = 0;
      const steer = l?.steer ?? 0;
      let yaw = (m.yaw ?? 0) + steer * 1.6 * dt;
      let curX = m.x ?? r.pos[0];
      let curZ = m.z ?? r.pos[2];
      const dist = v * dt;
      let nx = curX + Math.sin(yaw) * dist;
      let nz = curZ + Math.cos(yaw) * dist;
      nx = clamp(nx, -15.2, 9.8);
      nz = clamp(nz, -10.4, 6.4);
      if (l) l.odometer += Math.abs(dist);
      r.setManualFloorPose(nx, nz, yaw, v);
      return;
    }

    const g = this.d.graph;
    const edgeId = m.edge_id!;
    const edge = g.edge(edgeId);
    const vmax = edge.clearance_mm < 40 ? 0.2 : D.max_speed_m_s;
    const live = !!l && !c.scan && l.until_ms > now && !l.brake;
    const tgt = live ? l!.throttle * vmax : 0;
    const braking = !l || l.brake || l.until_ms <= now || !!c.scan;
    const rate = braking && Math.abs(tgt) < Math.abs(m.v) + 1e-9 ? BRAKE_DECEL : tgt * m.v >= 0 && Math.abs(tgt) > Math.abs(m.v) ? D.max_accel_m_s2 : DECEL;
    let v = m.v + clamp(tgt - m.v, -rate * dt, rate * dt);
    if (Math.abs(v) < 1e-4 && tgt === 0) v = 0;
    let s = m.s!;
    let facing = m.facing;
    let currentEdgeId = edgeId;
    const L = g.length(currentEdgeId);
    const ds = facing * v * dt;
    const sNew = s + ds;
    if (sNew >= 0 && sNew <= L) {
      s = sNew;
    } else {
      const forward = sNew > L;
      const nodeId = forward ? edge.to : edge.from;
      const endS = forward ? L : 0;
      const over = Math.abs(sNew - endS);
      const exits = this.exitsAt(nodeId, currentEdgeId).filter((id) => !this.zoneIsolated(id));
      let pick: string | null = null;
      if (exits.length === 1) pick = exits[0];
      else if (exits.length > 1 && l) {
        if (l.exit && exits.includes(l.exit)) pick = l.exit;
        else if (Math.abs(l.steer) > 0.5) {
          const ordered = this.allExitsAt(nodeId, currentEdgeId).filter((x) => exits.includes(x.segment_id));
          pick = (l.steer > 0 ? ordered[ordered.length - 1] : ordered[0]).segment_id;
        }
      }
      if (!pick) {
        s = endS;
        v = 0;
        if (exits.length === 0 && l && Math.abs(m.v) > 0.01 && now - c.lastEol > 3000) {
          c.lastEol = now;
          this.event(r, 'end_of_line', 'dead_end', { segment: edge.label });
        }
      } else {
        const e2 = g.edge(pick);
        const enterAtStart = e2.from === nodeId;
        const L2 = g.length(pick);
        const dNew = enterAtStart ? 1 : -1;
        const reversing = v < 0;
        facing = (reversing ? -dNew : dNew) as 1 | -1;
        s = clamp(enterAtStart ? over : L2 - over, 0, L2);
        currentEdgeId = pick;
        if (l) l.exit = null;
      }
    }
    if (l) l.odometer += currentEdgeId === m.edge_id ? Math.abs(s - m.s!) : Math.abs(ds);
    r.setManualPose(currentEdgeId, s, facing, v);
  }

  private finishScan(r: RobotActor, c: RobotCtl) {
    c.scan = null;
    const m = r.manual!;
    if (r.klass === 'outrig') {
      this.event(r, 'scan.result', 'scan_complete', {
        target: 'equipment',
        result: 'inspection_complete',
      });
      return;
    }
    const edgeId = m.edge_id!;
    const ms = m.s ?? 0;
    const f = this.d.plant.faults;
    const occ = f.occl[edgeId] ?? 0;
    const loc = f.occlS[edgeId] ?? -99;
    const profile = Math.exp(-(((ms - loc) / 0.42) ** 2));
    const est = clamp(occ * profile + this.rng.normal() * 0.015, 0, 0.97);
    const dn = this.d.graph.edge(edgeId).diameter_mm;
    c.lastScan = { tick: this.d.tick(), segment_id: edgeId, s_m: round(ms, 2), occlusion_pct: Math.round(est * 100), effective_bore_mm: Math.round(dn * (1 - est)), provenance: 'simulated' };
    this.event(r, 'scan.result', 'scan_complete', { occlusion_pct: c.lastScan.occlusion_pct, effective_bore_mm: c.lastScan.effective_bore_mm, s_m: c.lastScan.s_m });
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
