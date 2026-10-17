/**
 * Stream interest: tells the server which part of the world this browser is actually looking at, so it can send the
 * selected robot fast, visible zones at a moderate rate and the rest rarely. Purely a bandwidth/CPU hint — the server keeps
 * simulating everything, and unsubscribed clients see no change. Debounced; only sent when something changed.
 */
export interface Interest {
  visible_zone_ids?: string[];
  selected_entity_id?: string | null;
  camera_mode?: 'overview' | 'orbit' | 'chase' | 'pov' | 'map' | 'inspect' | 'drive';
  rate_budget?: number | { total_hz: number; selected_hz?: number; visible_hz?: number; background_hz?: number };
  manifest_id?: string;
}

export interface InterestReply {
  accepted?: boolean;
  effective?: unknown;
  stats?: unknown;
}

let current: Interest = {};
let lastSent = '';
let send: ((msg: Record<string, unknown>) => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let sentAt = 0;
let disabled = false;
export let lastReply: InterestReply | null = null;

export function bindInterestSender(fn: ((msg: Record<string, unknown>) => void) | null) {
  // a server that drops the socket right after our subscribe does not speak this protocol: stop sending it for this session
  if (!fn && sentAt && Date.now() - sentAt < 2000) disabled = true;
  sentAt = 0;
  send = fn;
  lastSent = ''; // a new connection always re-subscribes
  if (fn) flush();
}

let runId = 'current';
export function noteInterestReply(r: InterestReply & { code?: string; reason?: string }) {
  lastReply = r;
  // the connection is bound to one run; learn its id from the refusal and subscribe again with it
  const m = r.accepted === false && r.code === 'run_mismatch' ? /run (\S+)/.exec(r.reason ?? '') : null;
  if (m && m[1] !== runId) {
    runId = m[1];
    lastSent = '';
    flush();
  }
}

function flush() {
  timer = null;
  if (!send || disabled) return;
  const msg = { type: 'subscribe', run_id: runId, ...current };
  const key = JSON.stringify(msg);
  if (key === lastSent) return;
  lastSent = key;
  sentAt = Date.now();
  send(msg);
}

export function setInterest(p: Partial<Interest>) {
  const next = { ...current, ...p };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

export const getInterest = () => current;
export const getLastInterestReply = () => lastReply;
