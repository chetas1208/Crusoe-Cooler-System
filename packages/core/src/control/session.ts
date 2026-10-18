/**
 * Operator-side control session: the UI state machine for manual driving.
 *
 *   AUTONOMOUS → LEASE_REQUESTED → MANUAL_ARMED ⇄ MANUAL_DRIVING
 *        ↑                                │
 *        │            ┌───────────────────┤
 *        │       SAFE_STOP (unplanned) | RELEASE_PENDING (planned)
 *        └────────────┴──→ AUTONOMOUS | SAFE_HOLD
 *
 * Rules this file enforces (backend.md §10):
 *  - input is enabled ONLY after the server accepted a lease; nothing is sent before that;
 *  - intents are sent at ~8 Hz (DRIVE_HZ), sequence-numbered, with a 250 ms TTL, ONE request in flight at a time: a slow link or a
 *    loaded server lowers the rate instead of building a backlog (stale intents are never queued; the next one carries the latest input);
 *    manipulation commands (jog / gripper / pick / place / home / stow) wait in a tiny coalescing queue and ride the next free slot;
 *  - the pose shown is the server's; this module only reconciles readouts against drive acks;
 *  - blur / hidden tab / disconnect / lost acks → zero input, SAFE_STOP and a release request immediately;
 *  - after a stop, controls stay disabled until a NEW lease is granted.
 */
import { create } from 'zustand';
import type { DriveAck, DriveIntent, DriveLimits, ReleaseResponse, ToolAction } from '../contracts.control';
import { REASON_LABEL, plainRefusal, type PlainRefusal, type StopReason } from './reasons';
import { ARM_HOME_POSE, ARM_STOW_POSE, clampJog, readManipulator, stepToward } from './arm';
import { ControlNetworkError } from './client';
import { getControlApi } from './registry';
import { isLiveWorldSource, useReplay, useWorld } from '../store/world';

export type UiControlState = 'AUTONOMOUS' | 'LEASE_REQUESTED' | 'MANUAL_ARMED' | 'MANUAL_DRIVING' | 'SAFE_STOP' | 'RELEASE_PENDING' | 'SAFE_HOLD';

export interface Notice {
  id: number;
  tone: 'info' | 'warn' | 'error';
  text: string;
}

export interface ControlSessionState {
  state: UiControlState;
  robotId: string | null;
  leaseId: string | null;
  epoch: number;
  limits: DriveLimits | null;
  input: { throttle: number; steer: number; brake: boolean };
  /** junction exit chosen by the operator (sent with every intent until the junction is crossed) */
  exit: string | null;
  ack: DriveAck | null;
  ackAt: number;
  rttMs: number | null;
  linkOk: boolean;
  /** why the last manual session ended unplanned, kept on screen until the next take-over */
  stop: { reason: StopReason; text: string; at: number } | null;
  notice: Notice | null;
  sent: number;
  refused: number;
  /** why the last lease request was refused (kept until the next attempt), in the server's words plus a plain version */
  refusal: { robotId: string; reason: string; plain: PlainRefusal; at: number } | null;
  /** highest command_seq the server acknowledged as applied, and how many manipulation commands are still waiting to be sent */
  appliedSeq: number;
  manipPending: number;
  /** true once the server accepted a lease and until it is released */
  inputEnabled: boolean;
  /** the id the server sees as our principal */
  clientId: string;
}

const uuid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
};

const initial: ControlSessionState = {
  state: 'AUTONOMOUS',
  robotId: null,
  leaseId: null,
  epoch: 0,
  limits: null,
  input: { throttle: 0, steer: 0, brake: false },
  exit: null,
  ack: null,
  ackAt: 0,
  rttMs: null,
  linkOk: true,
  stop: null,
  notice: null,
  refusal: null,
  appliedSeq: 0,
  manipPending: 0,
  sent: 0,
  refused: 0,
  inputEnabled: false,
  clientId: `op_${uuid()}`,
};

export const useControl = create<ControlSessionState>()(() => initial);

/* ───────────────────────────── internals ───────────────────────────── */

const DRIVE_HZ = 8; // 4..8 Hz: each intent is valid for 250 ms, so 8 Hz keeps the robot moving while a slow server only ever sees one request at a time
const INTENT_TTL_MS = 250;
/** a drive request that has not been answered by now is abandoned (its slot is freed); the link watchdog decides whether that is a lost link */
const DRIVE_TIMEOUT_MS = 1000;
const LINK_LOST_MS = 1000;
/** the lease POST waits for the engine tick (and a loaded host): a 2.5 s client timeout abandoned leases the server then granted anyway */
const LEASE_TIMEOUT_MS = 8000;

let driveTimer: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let unsubWorld: (() => void) | null = null;
let seq = 0;
let inFlight = 0;
let pendingTool: ToolAction | undefined;
/** manipulation commands waiting for a free drive slot; same-key commands coalesce (jogs add up, gripper / targets keep the latest) */
interface Manip {
  key: string;
  fields: Partial<DriveIntent>;
}
const MAX_MANIP_QUEUE = 8;
let manipQueue: Manip[] = [];
let noticeId = 0;
let abortGrant = false;
let hbMs = 500;
let sources: Record<string, { throttle: number; steer: number; brake: boolean }> = {};
let releaseKey: string | null = null;
let releasingLease: { robotId: string; leaseId: string; epoch: number } | null = null;

/** Seams filled by control/nav.ts (which imports this module): the graph revision every intent is stamped with, and a refresh on a stale one. */
export const controlHooks: { graphRevision: () => string | null; onStaleGraph: () => void } = { graphRevision: () => null, onStaleGraph: () => undefined };

const set = (p: Partial<ControlSessionState>) => useControl.setState(p);
const get = () => useControl.getState();
const note = (tone: Notice['tone'], text: string) => set({ notice: { id: ++noticeId, tone, text } });

function stopLoops() {
  if (driveTimer) clearInterval(driveTimer);
  if (watchdog) clearInterval(watchdog);
  if (hbTimer) clearInterval(hbTimer);
  driveTimer = watchdog = hbTimer = null;
  manipQueue = [];
  cancelArmGoto();
  unsubWorld?.();
  unsubWorld = null;
}

function zeroInput() {
  sources = {};
  set({ input: { throttle: 0, steer: 0, brake: false } });
}

const isManual = (s: UiControlState) => s === 'MANUAL_ARMED' || s === 'MANUAL_DRIVING';

function deriveManualState() {
  const s = get();
  if (!isManual(s.state)) return;
  const moving = Math.abs(s.ack?.pose.velocity_m_s ?? 0) > 0.01;
  const active = Math.abs(s.input.throttle) > 0.01 || Math.abs(s.input.steer) > 0.3 || s.input.brake || moving;
  const next: UiControlState = active ? 'MANUAL_DRIVING' : 'MANUAL_ARMED';
  if (next !== s.state) set({ state: next });
}

/* ───────────────────────────── take control ───────────────────────────── */

async function takeControl(robotId: string) {
  const api = getControlApi();
  const s = get();
  const busy: UiControlState[] = ['LEASE_REQUESTED', 'MANUAL_ARMED', 'MANUAL_DRIVING', 'RELEASE_PENDING'];
  if (busy.includes(s.state)) return;
  if (!api) return note('warn', 'This backend does not offer manual control.');
  if (useReplay.getState().active || !isLiveWorldSource()) return note('warn', 'Replay is read-only. Fork the run from Execution to drive.');
  const w = useWorld.getState();
  if (!w.topology) return note('warn', 'The topology has not loaded yet.');
  if (w.connection !== 'live' || w.stale) return note('warn', 'The live stream is not connected, so control cannot be granted.');
  abortGrant = false;
  seq = 0;
  releaseKey = null;
  manipQueue = [];
  set({ state: 'LEASE_REQUESTED', robotId, leaseId: null, notice: null, stop: null, refusal: null, ack: null, exit: null, refused: 0, sent: 0, appliedSeq: 0, manipPending: 0, inputEnabled: false });
  try {
    const r = await api.lease(robotId, {
      expected_world_version: w.version,
      idempotency_key: uuid(),
      client_id: s.clientId,
      topology_revision: w.topology.facility.topology_hash,
    }, { timeoutMs: LEASE_TIMEOUT_MS });
    if (!r.accepted) {
      const plain = plainRefusal(r.reason);
      set({ state: 'AUTONOMOUS', robotId: null, refusal: { robotId, reason: r.reason, plain, at: Date.now() } });
      note('error', plain.hint ? `${plain.text} ${plain.hint}` : plain.text);
      return;
    }
    if (abortGrant) {
      // the operator backed out while the request was in flight: give the lease straight back
      releasingLease = { robotId, leaseId: r.lease_id, epoch: r.lease_epoch };
      set({ state: 'RELEASE_PENDING', leaseId: r.lease_id, epoch: r.lease_epoch });
      void sendRelease('operator_release');
      return;
    }
    hbMs = r.heartbeat_interval_ms;
    set({ state: 'MANUAL_ARMED', leaseId: r.lease_id, epoch: r.lease_epoch, limits: r.limits, ackAt: Date.now(), linkOk: true, inputEnabled: true });
    startLoops(robotId);
  } catch (err) {
    set({ state: 'AUTONOMOUS', robotId: null });
    const why = (err as { message?: string })?.message;
    const text = err instanceof ControlNetworkError ? 'The control service did not answer, so control was not granted.' : why ? `Control refused: ${why}` : 'Control request failed.';
    set({ refusal: { robotId, reason: text, plain: { key: 'no_answer', text, dockable: false, retry: true }, at: Date.now() } });
    note('error', text);
  }
}

function startLoops(robotId: string) {
  stopLoops();
  driveTimer = setInterval(() => void sendDrive(robotId), 1000 / DRIVE_HZ);
  hbTimer = setInterval(() => void sendHeartbeat(robotId), hbMs);
  let lastTick = Date.now();
  watchdog = setInterval(() => {
    const s = get();
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (!isManual(s.state)) return;
    // this page was not running for `gap` ms (a render stall, a throttled tab): answers may be queued behind us, so that time is not silence
    if (gap > 350) {
      set({ ackAt: s.ackAt + gap - 100 });
      return;
    }
    if (now - s.ackAt > LINK_LOST_MS) safeStop('link_lost');
  }, 100);
  // server-side truth: if the lease disappears or the stream drops, stop at once
  unsubWorld = useWorld.subscribe((w, prev) => {
    const s = get();
    if (!isManual(s.state) || !s.robotId) return;
    if (useReplay.getState().active) return safeStop('operator_stop');
    if (w.connection !== 'live' || w.stale) return safeStop('client_disconnect');
    const c = w.robots[s.robotId]?.control;
    if (!c || prev.robots[s.robotId]?.control === c) return;
    // our own lease is granted but the server flips AUTO -> HUMAN / MANUAL only when it acks the first intent (~200 ms): that update is not a revocation
    const ownPending = c.controller_state === 'LEASE_PENDING' && (!c.lease_id || c.lease_id === s.leaseId);
    if (ownPending) return;
    if (c.authority !== 'HUMAN' || (c.lease_id && c.lease_id !== s.leaseId)) {
      safeStop(c.last_reason ?? 'link_lost', true);
    }
  });
}

/* ───────────────────────────── drive loop ───────────────────────────── */

type ArmIntentExtras = Partial<DriveIntent> & { target_rad?: number };

async function sendDrive(robotId: string) {
  const s = get();
  const api = getControlApi();
  if (!api || !isManual(s.state) || !s.leaseId) return;
  // ONE request in flight: a slow link or a loaded server lowers the rate, it never builds a backlog. The next intent carries the newest input,
  // so a skipped tick loses nothing but a stale sample. (Manipulation commands wait in manipQueue and take the next free slot.)
  if (inFlight >= 1) return;
  const w = useWorld.getState();
  const outrig = w.robots[robotId]?.class === 'outrig';
  const manip = manipQueue.shift();
  if (manip) set({ manipPending: manipQueue.length });
  const mf = (manip?.fields ?? {}) as ArmIntentExtras;
  const intent: DriveIntent = {
    lease_id: s.leaseId,
    lease_epoch: s.epoch,
    command_seq: ++seq,
    idempotency_key: uuid(),
    topology_revision: w.topology?.facility.topology_hash ?? '',
    known_world_version: w.version,
    throttle: clamp1(s.input.throttle),
    steer: clamp1(s.input.steer),
    brake: s.input.brake,
    // exterior robots pick a legal junction branch ('left'|'right'|'straight' or an edge id); crawlers pick an exit segment
    selected_exit_segment_id: outrig ? null : s.exit,
    branch: outrig && s.exit ? s.exit : undefined,
    graph_revision: controlHooks.graphRevision() ?? undefined,
    duration_ms: INTENT_TTL_MS,
    tool: pendingTool,
    ...mf,
  };
  const sentTool = pendingTool;
  pendingTool = undefined;
  inFlight++;
  const t0 = performance.now();
  set({ sent: s.sent + 1 });
  try {
    const r = await api.drive(robotId, intent, { timeoutMs: DRIVE_TIMEOUT_MS });
    const now = Date.now();
    inFlight--;
    if (get().leaseId !== intent.lease_id || !isManual(get().state)) return;
    const rtt = performance.now() - t0;
    if (r.accepted) {
      const prev = get().rttMs;
      const cur = get();
      set({
        ack: r,
        ackAt: now,
        linkOk: true,
        appliedSeq: Math.max(cur.appliedSeq, Number(r.applied_seq) || 0),
        rttMs: prev === null ? rtt : prev * 0.8 + rtt * 0.2,
        exit: r.junction ? cur.exit : null,
      });
      deriveManualState();
      // server-validated manipulation outcomes (arm / gripper / pick / place / brush) travel in the drive ack: show refusals and failures verbatim
      const m = (r as unknown as { manipulation?: Record<string, { reason?: string; ok?: boolean; message?: string; cartridge_seated?: boolean }> }).manipulation;
      if (m?.rejected?.reason) note('warn', m.rejected.reason);
      else if (m?.pick && m.pick.ok === false && m.pick.message) note('warn', `Pick refused: ${m.pick.message}`);
      else if (m?.place && m.place.ok && m.place.cartridge_seated === false && m.place.message) note('warn', `Released: ${m.place.message}`);
      else if (m?.plant_effect && m.plant_effect.ok === false && m.plant_effect.reason) note('info', m.plant_effect.reason.replace(/^[a-z_]+:\s*/, ''));
      // the next waiting manipulation command goes out right away instead of sitting out the rest of the tick
      if (manipQueue.length) queueMicrotask(() => void sendDrive(robotId));
      return;
    }
    // an out-of-order ack (two intents in flight) is benign: the newer intent already won; the real backend words it `command_seq_not_increasing`
    const staleSeq = r.code === 'stale_seq' || /command_seq_not_increasing|^lease_not_active/.test(r.reason);
    // ANY answer from the server proves the link is alive (the watchdog is for silence): a robot still acquiring answers `lease_not_active` for
    // as long as the engine tick takes (>1 s on a loaded host) and must not be mistaken for a lost link
    set({ refused: staleSeq ? get().refused : get().refused + 1, ackAt: now });
    if (sentTool) pendingTool = undefined;
    if (r.code === 'lease_revoked' || r.code === 'no_lease' || r.code === 'stale_epoch') {
      safeStop(r.revoked_reason ?? 'link_lost', true, r.reason);
    } else if (/^stale_graph_revision/.test(r.reason)) {
      // the graph changed under us: the intent was NOT applied (robot keeps the previous, short-lived intent then brakes). Re-read and carry on.
      controlHooks.onStaleGraph();
      note('warn', r.reason);
    } else if (/^lease_not_active/.test(r.reason)) {
      // the robot is still acquiring (server holds the lease in LEASE_PENDING until it settles): keep the loop going, say nothing.
      // The manipulation command that rode this intent was NOT applied: put it back at the front.
      if (manip) {
        manipQueue.unshift(manip);
        set({ manipPending: manipQueue.length });
      }
    } else if (!staleSeq) {
      const p = plainRefusal(r.reason);
      note('warn', p.hint ? `${p.text} ${p.hint}` : p.text);
      // battery ran out mid-session: the server ends the lease on its own; show why instead of looking dead
      if (p.dockable) set({ refusal: { robotId, reason: r.reason, plain: p, at: Date.now() } });
    }
  } catch {
    inFlight--;
    set({ linkOk: false });
    // the watchdog turns a silent link into a safety stop after LINK_LOST_MS
  }
}

async function sendHeartbeat(robotId: string) {
  const s = get();
  const api = getControlApi();
  if (!api || !isManual(s.state) || !s.leaseId) return;
  if (Date.now() - s.ackAt < hbMs * 0.6) return; // recent drive acks already renewed the lease
  try {
    const r = await api.heartbeat(robotId, { lease_id: s.leaseId, lease_epoch: s.epoch });
    if (!isManual(get().state)) return;
    if (r.accepted) set({ ackAt: Date.now(), linkOk: true });
    else safeStop(r.revoked_reason ?? 'link_lost', true, r.reason);
  } catch {
    set({ linkOk: false });
  }
}

/* ───────────────────────────── stop / release ───────────────────────────── */

/**
 * Unplanned stop: zero input immediately, stop sending, tell the server. Controls stay disabled until the
 * operator takes control again (a new lease), because the old authority is gone.
 */
function safeStop(reason: StopReason, serverAlreadyStopped = false, text?: string) {
  const s = get();
  if (!(isManual(s.state) || s.state === 'LEASE_REQUESTED')) return;
  if (s.state === 'LEASE_REQUESTED') {
    abortGrant = true;
    return;
  }
  stopLoops();
  zeroInput();
  const robotId = s.robotId;
  set({
    state: 'SAFE_STOP',
    inputEnabled: false,
    stop: { reason, text: text ?? REASON_LABEL[reason], at: Date.now() },
  });
  if (!robotId || !s.leaseId) return;
  releasingLease = { robotId, leaseId: s.leaseId, epoch: s.epoch };
  releaseKey = uuid();
  // best effort zero-velocity intent (survives a closing page), then the release request
  const api = getControlApi();
  if (api && !serverAlreadyStopped) {
    void api
      .drive(robotId, {
        lease_id: s.leaseId,
        lease_epoch: s.epoch,
        command_seq: ++seq,
        idempotency_key: uuid(),
        topology_revision: useWorld.getState().topology?.facility.topology_hash ?? '',
        throttle: 0,
        steer: 0,
        brake: true,
        duration_ms: 250,
      }, { keepalive: true })
      .catch(() => undefined);
  }
  void sendRelease(reason);
}

async function sendRelease(reason: StopReason) {
  const api = getControlApi();
  const l = releasingLease;
  if (!api || !l) return finishRelease(null);
  if (retryTimer) clearTimeout(retryTimer);
  try {
    const r = await api.release(l.robotId, { lease_id: l.leaseId, lease_epoch: l.epoch, idempotency_key: releaseKey ?? (releaseKey = uuid()), reason }, { keepalive: true });
    finishRelease(r);
  } catch {
    // keep trying: the robot is held by the server's deadman either way, but we want it acknowledged
    retryTimer = setTimeout(() => void sendRelease(reason), 1000);
  }
}

function finishRelease(r: ReleaseResponse | null) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  releasingLease = null;
  releaseKey = null;
  const s = get();
  const hold = r && r.accepted ? r.controller_state === 'SAFE_HOLD' : false;
  set({ state: hold ? 'SAFE_HOLD' : 'AUTONOMOUS', leaseId: null, inputEnabled: false, ack: null, exit: null });
  if (r && !r.accepted && r.code !== 'no_lease') note('warn', r.reason);
  if (r && r.accepted && s.state === 'RELEASE_PENDING') {
    note('info', r.resumed === 'mission' ? 'Control released. The agent is resuming its mission.' : r.resumed === 'return_to_port' ? 'Control released. The crawler is returning to its port.' : r.resumed === 'docked' ? 'Control released. The crawler is docked.' : hold ? 'Control released, but the agent cannot resume yet: the robot is holding position.' : 'Control released.');
  }
}

/** Planned release (button / Esc): stop, hand back, wait for the server to confirm. */
function release(reason: StopReason = 'operator_release') {
  const s = get();
  if (s.state === 'LEASE_REQUESTED') {
    abortGrant = true;
    return;
  }
  if (!isManual(s.state) || !s.robotId || !s.leaseId) return;
  stopLoops();
  zeroInput();
  releasingLease = { robotId: s.robotId, leaseId: s.leaseId, epoch: s.epoch };
  releaseKey = uuid();
  set({ state: 'RELEASE_PENDING', inputEnabled: false });
  void sendRelease(reason);
}

/** Acknowledge a SAFE_HOLD (or any stale state) without a lease. */
function dismiss() {
  const s = get();
  if (s.state === 'SAFE_HOLD' || s.state === 'AUTONOMOUS') set({ state: 'AUTONOMOUS', stop: null, notice: null });
}

/* ───────────────────────────── input ───────────────────────────── */

const clamp1 = (x: number) => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);

/** Each input device writes its own axes; the strongest wins. Ignored unless a lease is held. */
function setInput(source: string, v: { throttle?: number; steer?: number; brake?: boolean }) {
  if (!get().inputEnabled) return;
  const cur = sources[source] ?? { throttle: 0, steer: 0, brake: false };
  sources[source] = { throttle: clamp1(v.throttle ?? cur.throttle), steer: clamp1(v.steer ?? cur.steer), brake: v.brake ?? cur.brake };
  let t = 0;
  let st = 0;
  let b = false;
  for (const x of Object.values(sources)) {
    if (Math.abs(x.throttle) > Math.abs(t)) t = x.throttle;
    if (Math.abs(x.steer) > Math.abs(st)) st = x.steer;
    b = b || x.brake;
  }
  set({ input: { throttle: t, steer: st, brake: b } });
  deriveManualState();
}

function chooseExit(id: string | null) {
  if (get().inputEnabled) set({ exit: id });
}

function tool(action: ToolAction) {
  if (get().inputEnabled) pendingTool = action;
}

/** Add a manipulation command to the queue (coalescing same-key commands) and try to send it now. */
function enqueueManip(m: Manip) {
  if (!get().inputEnabled) return;
  const same = manipQueue.find((q) => q.key === m.key);
  if (same) {
    if (m.key.startsWith('jog')) same.fields = { ...same.fields, delta_rad: clampJog((same.fields.delta_rad ?? 0) + (m.fields.delta_rad ?? 0)) };
    else same.fields = m.fields;
  } else {
    if (manipQueue.length >= MAX_MANIP_QUEUE) manipQueue.shift();
    manipQueue.push(m);
  }
  set({ manipPending: manipQueue.length });
  const rId = get().robotId;
  if (rId) void sendDrive(rId);
}

function jogJoint(joint_idx: number, delta_rad: number) {
  cancelArmGoto();
  enqueueManip({ key: `jog${joint_idx}`, fields: { action: 'joint_jog', joint_idx, delta_rad: clampJog(delta_rad) } });
}

function setGripper(aperture_m: number) {
  enqueueManip({ key: 'grip', fields: { gripper_aperture: Math.max(0, Math.min(0.07, aperture_m)) } });
}

function pick() {
  enqueueManip({ key: 'pick', fields: { action: 'pick', pick: true } });
}

function place() {
  enqueueManip({ key: 'place', fields: { action: 'place', place: true } });
}

function cleanDeposit() {
  enqueueManip({ key: 'clean', fields: { action: 'clean_deposit' } });
}

/* ───────── named arm poses (OUTRIG) ─────────
 * With the V12 arm contract (robot.manipulator published) the server owns the pose and gets `arm_home` / `arm_stow`. Until then, and if the
 * server refuses the named action, the UI walks the joints to the rest pose with bounded jogs (each is still validated server-side). */
let gotoTimer: ReturnType<typeof setInterval> | null = null;

function cancelArmGoto() {
  if (gotoTimer) clearInterval(gotoTimer);
  gotoTimer = null;
}

function armPose(kind: 'home' | 'stow') {
  const rId = get().robotId;
  if (!get().inputEnabled || !rId) return;
  cancelArmGoto();
  const view = () => readManipulator(useWorld.getState().robots[rId]);
  if (view().source === 'manipulator') {
    enqueueManip({ key: 'pose', fields: { action: kind === 'home' ? 'arm_home' : 'arm_stow' } });
    return;
  }
  const target = kind === 'home' ? ARM_HOME_POSE : ARM_STOW_POSE;
  let n = 0;
  const step = () => {
    const v = view();
    const todo = stepToward(v.joints, target);
    const gripDone = kind === 'home' || v.gripperM === null || v.gripperM < 0.012;
    if (!get().inputEnabled || get().robotId !== rId || n++ > 60 || (todo.length === 0 && gripDone)) return cancelArmGoto();
    for (const { idx, delta } of todo) enqueueManip({ key: `jog${idx}`, fields: { action: 'joint_jog', joint_idx: idx, delta_rad: delta } });
    if (kind === 'stow' && !gripDone) enqueueManip({ key: 'grip', fields: { gripper_aperture: 0 } });
  };
  step();
  gotoTimer = setInterval(step, 300);
}

const armHome = () => armPose('home');
const armStow = () => armPose('stow');

function say(tone: Notice['tone'], text: string) {
  note(tone, text);
}

export const controlActions = {
  takeControl,
  release,
  safeStop,
  setInput,
  chooseExit,
  tool,
  jogJoint,
  setGripper,
  pick,
  place,
  cleanDeposit,
  armHome,
  armStow,
  cancelArmGoto,
  dismiss,
  say,
};

/** Test / teardown helper. */
export function resetControl() {
  stopLoops();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  sources = {};
  seq = 0;
  inFlight = 0;
  pendingTool = undefined;
  manipQueue = [];
  cancelArmGoto();
  releasingLease = null;
  releaseKey = null;
  useControl.setState({ ...initial, clientId: get().clientId });
}
