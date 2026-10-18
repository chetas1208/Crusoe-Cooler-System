import { create } from 'zustand';
import type { CommunicationEventV1, ConnState, Density, RoleFilter } from './types';
import { getLayout } from '../responsive/layout';

/**
 * Communications state. Module-level on purpose: the panel can be closed, unmounted and reopened any number of times
 * (and the Execution tab left and re-entered) without touching ingestion, filters, scroll position or the run context.
 * Events are keyed by (run_id, seq) — the canonical run sequence — so reconnect overlap, REST backfill racing the stream
 * and duplicate delivery can never produce two rows.
 */
export const MAX_EVENTS = 20_000;
const OPEN_KEY = 'lk.comms.open';
const DENSITY_KEY = 'lk.comms.density';
const GROUP_KEY = 'lk.comms.grouped';
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // private mode / blocked storage: the panel works without it
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export const isFailure = (e: CommunicationEventV1) => (FAIL_KINDS.has(kindOf(e)) && kindOf(e) !== 'HUMAN_OVERRIDE' && kindOf(e) !== 'STOP') || /^(failed|error|rejected|denied|blocked|refused|timeout|unavailable|aborted|expired|safe_hold)/i.test(e.status ?? '') || /^(failed|error|rejected|denied|blocked)/i.test(e.phase ?? '') || /(\.|^)(failed|error|blocked|denied|rejected|deadman)$/i.test(e.subtype ?? '');
const kindOf = (e: CommunicationEventV1) => (e.kind && /^[A-Z_]+$/.test(e.kind) ? e.kind : e.message_type);
const FAIL_KINDS = new Set(['TOOL_REJECTED', 'PLAN_REJECTED', 'SAFETY_VETO', 'MODEL_ERROR', 'ESCALATION', 'HUMAN_OVERRIDE', 'STOP']);
export const isSafety = (e: CommunicationEventV1) => e.message_type === 'safety' || e.message_type === 'verification' || kindOf(e) === 'SAFETY_VETO' || kindOf(e) === 'VERIFICATION_RESULT';

export interface AdvFilters {
  sender: string;
  recipient: string;
  robot: string;
  incident: string;
  type: string;
  /** all | last 1 / 5 minutes of simulated time | a custom [from,to] range in simulated seconds */
  period: 'all' | '1m' | '5m' | 'custom';
  from: number | null;
  to: number | null;
}
export const NO_ADV: AdvFilters = { sender: '', recipient: '', robot: '', incident: '', type: '', period: 'all', from: null, to: null };
export const advActive = (a: AdvFilters) => a.sender !== '' || a.recipient !== '' || a.robot !== '' || a.incident !== '' || a.type !== '' || a.period !== 'all';

export interface FilterOpts {
  adv?: AdvFilters;
  filter: RoleFilter;
  query: string;
  mode: 'live' | 'replay';
  cursorTick: number | null;
}

/** Pure; the list the panel shows. In replay only events at or before the cursor exist (no future leakage). */
export function filterEvents(events: CommunicationEventV1[], o: FilterOpts): CommunicationEventV1[] {
  const q = o.query.trim().toLowerCase();
  const cursor = o.mode === 'replay' && o.cursorTick !== null ? o.cursorTick : Infinity;
  const a = o.adv ?? NO_ADV;
  // "last N minutes" is relative to what the reader is looking at: the playhead in replay, the newest message live
  let refMs = 0;
  if (a.period === '1m' || a.period === '5m') for (const e of events) if (e.sim_tick <= cursor && e.sim_time_ms > refMs) refMs = e.sim_time_ms;
  const winMs = a.period === '1m' ? 60_000 : a.period === '5m' ? 300_000 : 0;
  const out: CommunicationEventV1[] = [];
  for (const e of events) {
    if (e.sim_tick > cursor) continue;
    if (a.sender && e.sender.id !== a.sender) continue;
    if (a.recipient && e.recipient?.id !== a.recipient) continue;
    if (a.robot && e.robot_id !== a.robot) continue;
    if (a.incident && e.incident_id !== a.incident) continue;
    if (a.type && e.message_type !== a.type && e.kind !== a.type) continue;
    if (winMs && e.sim_time_ms < refMs - winMs) continue;
    if (a.period === 'custom') {
      if (a.from !== null && e.sim_time_ms < a.from * 1000) continue;
      if (a.to !== null && e.sim_time_ms > a.to * 1000) continue;
    }
    if (o.filter !== 'all') {
      const cls = e.sender.class;
      const rcls = e.recipient?.class;
      const ok =
        o.filter === 'tools'
          ? e.message_type === 'tool_event'
          : o.filter === 'failures'
            ? isFailure(e)
            : o.filter === 'operator'
              ? e.message_type === 'operator' || cls === 'operator'
              : cls === o.filter || rcls === o.filter;
      if (!ok) continue;
    }
    if (q) {
      const hay = `${e.summary} ${e.sender.id} ${e.recipient?.id ?? ''} ${e.thread_id ?? ''} ${e.robot_id ?? ''} ${e.task_id ?? ''} ${e.asset_id ?? ''} ${e.incident_id ?? ''} ${e.mission_id ?? ''}`.toLowerCase();
      if (!q.split(/\s+/).every((t) => hay.includes(t))) continue;
    }
    out.push(e);
  }
  return out;
}

interface State {
  runId: string | null;
  /** run ids whose events belong to this run's history (a fork shows its parent's messages up to the fork) */
  lineage: string[];
  events: CommunicationEventV1[];
  dropped: number;
  conn: ConnState;
  mode: 'live' | 'replay';
  cursorTick: number | null;
  filter: RoleFilter;
  adv: AdvFilters;
  query: string;
  open: boolean;
  /** row density and thread grouping are reader preferences: they survive closing the panel and reloads */
  density: Density;
  grouped: boolean;
  /** thread ids the reader folded */
  collapsed: Record<string, boolean>;
  selectedId: string | null;
  /** pinned to the newest message; false once the reader scrolls back in history */
  follow: boolean;
  unread: number;
  readSeq: number;
  scrollTop: number;
  /** bumped when the reader opens the panel on purpose; the panel then takes focus so ESC works from the keyboard */
  focusRequest: number;
  previewAt: number;
  alert: { text: string; at: number } | null;
  backfill: { state: 'idle' | 'loading' | 'done' | 'error'; error: string | null };

  setRun(runId: string | null): void;
  setLineage(ids: string[]): void;
  ingest(events: CommunicationEventV1[]): number;
  setConn(c: ConnState): void;
  setMode(mode: 'live' | 'replay', cursorTick?: number | null): void;
  setCursor(tick: number | null): void;
  setFilter(f: RoleFilter): void;
  setQuery(q: string): void;
  setAdv(p: Partial<AdvFilters>): void;
  clearAdv(): void;
  setOpen(open: boolean, focus?: boolean): void;
  setDensity(d: Density): void;
  setGrouped(g: boolean): void;
  toggleThread(id: string): void;
  select(id: string | null): void;
  setFollow(f: boolean): void;
  markRead(): void;
  setScrollTop(y: number): void;
  notePreview(): void;
  setBackfill(b: State['backfill']): void;
  clearAlert(): void;
}

const keyOf = (e: { run_id: string; seq: number }) => `${e.run_id}:${e.seq}`;
let seen = new Set<string>();

function readOpen(): boolean {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* private mode */
  }
  // first load: docked OPEN on a desktop-class window (>= 900 x 520, regular chrome, fine pointer); collapsed on phones and touch tablets. The choice is remembered per browser (OPEN_KEY).
  const l = getLayout();
  return typeof window !== 'undefined' && l.host === 'dock' && !l.coarse;
}

export const useCommunications = create<State>()((set, get) => ({
  runId: null,
  lineage: [],
  events: [],
  dropped: 0,
  conn: 'CONNECTING',
  mode: 'live',
  cursorTick: null,
  filter: 'all',
  adv: NO_ADV,
  query: '',
  open: readOpen(),
  density: lsGet(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable',
  grouped: lsGet(GROUP_KEY) !== '0',
  collapsed: {},
  selectedId: null,
  follow: true,
  unread: 0,
  readSeq: 0,
  scrollTop: 0,
  focusRequest: 0,
  previewAt: 0,
  alert: null,
  backfill: { state: 'idle', error: null },

  setRun: (runId) => {
    if (get().runId === runId) return;
    seen = new Set();
    set({ runId, lineage: [], events: [], collapsed: {}, unread: 0, readSeq: 0, selectedId: null, follow: true, scrollTop: 0, alert: null, backfill: { state: 'idle', error: null } });
  },

  setLineage: (lineage) => set((s) => (JSON.stringify(s.lineage) === JSON.stringify(lineage) ? s : { lineage })),

  ingest: (incoming) => {
    const st = get();
    const fresh: CommunicationEventV1[] = [];
    for (const e of incoming) {
      if (st.runId && e.run_id !== st.runId && !st.lineage.includes(e.run_id)) continue;
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(e);
    }
    if (!fresh.length) return 0;
    let events = st.events;
    const last = events.length ? events[events.length - 1].seq : -1;
    fresh.sort((a, b) => a.seq - b.seq);
    if (fresh[0].seq > last) events = events.concat(fresh);
    else {
      events = events.concat(fresh).sort((a, b) => a.seq - b.seq);
    }
    let dropped = st.dropped;
    if (events.length > MAX_EVENTS) {
      const cut = events.length - MAX_EVENTS;
      for (const d of events.slice(0, cut)) seen.delete(keyOf(d));
      events = events.slice(cut);
      dropped += cut;
    }
    const viewing = st.open && st.follow;
    const newest = events[events.length - 1].seq;
    const unread = viewing ? 0 : st.unread + fresh.filter((e) => e.seq > st.readSeq).length;
    // a safety/verification failure is the only thing allowed to interrupt a screen reader (and at most every 10 s)
    const bad = [...fresh].reverse().find((e) => isSafety(e) && isFailure(e));
    const alert = bad && (!st.alert || Date.now() - st.alert.at > 10_000) ? { text: `${bad.sender.id}: ${bad.summary}`.slice(0, 200), at: Date.now() } : st.alert;
    set({ events, dropped, unread, readSeq: viewing ? newest : st.readSeq, alert });
    return fresh.length;
  },

  setConn: (conn) => set((s) => (s.conn === conn ? s : { conn })),
  setMode: (mode, cursorTick = null) => set({ mode, cursorTick: mode === 'replay' ? cursorTick : null }),
  setCursor: (cursorTick) => set((s) => (s.cursorTick === cursorTick ? s : { cursorTick })),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setAdv: (p) => set((s) => ({ adv: { ...s.adv, ...p } })),
  clearAdv: () => set({ adv: NO_ADV }),
  setOpen: (open, focus = false) => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* private mode */
    }
    set((s) => ({ open, ...(open && focus ? { focusRequest: s.focusRequest + 1 } : {}), ...(open && s.follow ? { unread: 0, readSeq: s.events.length ? s.events[s.events.length - 1].seq : s.readSeq } : {}) }));
  },
  setDensity: (density) => {
    lsSet(DENSITY_KEY, density);
    set({ density });
  },
  setGrouped: (grouped) => {
    lsSet(GROUP_KEY, grouped ? '1' : '0');
    set({ grouped });
  },
  toggleThread: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
  select: (selectedId) => set({ selectedId }),
  setFollow: (follow) => set((s) => (s.follow === follow ? s : { follow })),
  markRead: () => set((s) => (s.unread === 0 && s.readSeq === (s.events.length ? s.events[s.events.length - 1].seq : 0) ? s : { unread: 0, readSeq: s.events.length ? s.events[s.events.length - 1].seq : s.readSeq })),
  setScrollTop: (scrollTop) => set({ scrollTop }),
  notePreview: () => set({ previewAt: Date.now() }),
  setBackfill: (backfill) => set({ backfill }),
  clearAlert: () => set({ alert: null }),
}));

export function resetCommunicationsForTest() {
  seen = new Set();
  useCommunications.setState({ runId: null, events: [], collapsed: {}, dropped: 0, conn: 'CONNECTING', mode: 'live', cursorTick: null, filter: 'all', adv: NO_ADV, query: '', selectedId: null, follow: true, unread: 0, readSeq: 0, scrollTop: 0, previewAt: 0, alert: null, backfill: { state: 'idle', error: null } });
}
