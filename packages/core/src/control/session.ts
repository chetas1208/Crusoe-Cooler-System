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
 *  - intents are sent at ≤ 20 Hz, sequence-numbered, with a 200 ms TTL — never per frame, never REST-per-keypress;
 *  - the pose shown is the server's; this module only reconciles readouts against drive acks;
 *  - blur / hidden tab / disconnect / lost acks → zero input, SAFE_STOP and a release request immediately;
 *  - after a stop, controls stay disabled until a NEW lease is granted.
 */
import { create } from 'zustand';
import type { DriveAck, DriveIntent, DriveLimits, ReleaseResponse, ToolAction } from '../contracts.control';
import { REASON_LABEL, type StopReason } from './reasons';
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
  sent: 0,
  refused: 0,
  inputEnabled: false,
  clientId: `op_${uuid()}`,
};

export const useControl = create<ControlSessionState>()(() => initial);

/* ───────────────────────────── internals ───────────────────────────── */

const DRIVE_HZ = 20; // 15..30 Hz band (backend drive bucket: 25/s incl. heartbeats)
const INTENT_TTL_MS = 200;
const LINK_LOST_MS = 1000;

let driveTimer: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let unsubWorld: (() => void) | null = null;
let seq = 0;
let inFlight = 0;
let pendingTool: ToolAction | undefined;
let pendingManipulation: Partial<DriveIntent> | undefined;
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
  set({ state: 'LEASE_REQUESTED', robotId, leaseId: null, notice: null, stop: null, ack: null, exit: null, refused: 0, sent: 0, inputEnabled: false });
  try {
    const r = await api.lease(robotId, {
      expected_world_version: w.version,
      idempotency_key: uuid(),
      client_id: s.clientId,
      topology_revision: w.topology.facility.topology_hash,
    });
    if (!r.accepted) {
      set({ state: 'AUTONOMOUS', robotId: null });
      note('error', r.reason);
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
    note('error', err instanceof ControlNetworkError ? 'The control service did not answer, so control was not granted.' : why ? `Control refused: ${why}` : 'Control request failed.');
  }
}

function startLoops(robotId: string) {
  stopLoops();
  driveTimer = setInterval(() => void sendDrive(robotId), 1000 / DRIVE_HZ);
  hbTimer = setInterval(() => void sendHeartbeat(robotId), hbMs);
  watchdog = setInterval(() => {
    const s = get();
    if (!isManual(s.state)) return;
    if (Date.now() - s.ackAt > LINK_LOST_MS) safeStop('link_lost');
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

async function sendDrive(robotId: string) {
  const s = get();
  const api = getControlApi();
  if (!api || !isManual(s.state) || !s.leaseId) return;
  if (inFlight >= 2) return; // never queue behind a slow link
  const w = useWorld.getState();
  const outrig = w.robots[robotId]?.class === 'outrig';
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
    action: pendingManipulation?.action,
    joint_idx: pendingManipulation?.joint_idx,
    delta_rad: pendingManipulation?.delta_rad,
    gripper_aperture: pendingManipulation?.gripper_aperture,
    pick: pendingManipulation?.pick,
    place: pendingManipulation?.place,
  };
  const sentTool = pendingTool;
  pendingTool = undefined;
  pendingManipulation = undefined;
  inFlight++;
  const t0 = performance.now();
  set({ sent: s.sent + 1 });
  try {
    const r = await api.drive(robotId, intent);
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
        rttMs: prev === null ? rtt : prev * 0.8 + rtt * 0.2,
        exit: r.junction ? cur.exit : null,
      });
      deriveManualState();
      // server-validated manipulation outcomes (arm / gripper / pick / place / brush) travel in the drive ack: show refusals and failures verbatim
      const m = (r as unknown as { manipulation?: Record<string, { reason?: string; ok?: boolean; message?: string; cartridge_seated?: boolean }> }).manipulation;
      if (m?.rejected?.reason) note('warn', m.rejected.reason.replace(/^[a-z_]+:\s*/, (x) => x));
      else if (m?.pick && m.pick.ok === false && m.pick.message) note('warn', `Pick refused: ${m.pick.message}`);
      else if (m?.place && m.place.ok && m.place.cartridge_seated === false && m.place.message) note('warn', `Released: ${m.place.message}`);
      return;
    }
    // an out-of-order ack (two intents in flight) is benign: the newer intent already won; the real backend words it `command_seq_not_increasing`
    const staleSeq = r.code === 'stale_seq' || /command_seq_not_increasing|^lease_not_active/.test(r.reason);
    set({ refused: staleSeq ? get().refused : get().refused + 1, ackAt: staleSeq ? get().ackAt : now });
    if (sentTool) pendingTool = undefined;
    if (r.code === 'lease_revoked' || r.code === 'no_lease' || r.code === 'stale_epoch') {
      safeStop(r.revoked_reason ?? 'link_lost', true, r.reason);
    } else if (/^stale_graph_revision/.test(r.reason)) {
      // the graph changed under us: the intent was NOT applied (robot keeps the previous, short-lived intent then brakes). Re-read and carry on.
      controlHooks.onStaleGraph();
      note('warn', r.reason);
    } else if (/^lease_not_active/.test(r.reason)) {
      // the robot is still acquiring (server holds the lease in LEASE_PENDING until it settles): keep the 20 Hz loop going, say nothing
    } else if (!staleSeq) {
      note('warn', r.reason);
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

function jogJoint(joint_idx: number, delta_rad: number) {
  if (get().inputEnabled) {
    pendingManipulation = { action: 'joint_jog', joint_idx, delta_rad };
    const rId = get().robotId;
    if (rId) void sendDrive(rId);
  }
}

function setGripper(aperture_m: number) {
  if (get().inputEnabled) {
    pendingManipulation = { gripper_aperture: aperture_m };
    const rId = get().robotId;
    if (rId) void sendDrive(rId);
  }
}

function pick() {
  if (get().inputEnabled) {
    pendingManipulation = { action: 'pick', pick: true };
    const rId = get().robotId;
    if (rId) void sendDrive(rId);
  }
}

function place() {
  if (get().inputEnabled) {
    pendingManipulation = { action: 'place', place: true };
    const rId = get().robotId;
    if (rId) void sendDrive(rId);
  }
}

function cleanDeposit() {
  if (get().inputEnabled) {
    pendingManipulation = { action: 'clean_deposit' };
    const rId = get().robotId;
    if (rId) void sendDrive(rId);
  }
}

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
  releasingLease = null;
  releaseKey = null;
  useControl.setState({ ...initial, clientId: get().clientId });
}
