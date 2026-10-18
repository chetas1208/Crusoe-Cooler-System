import { create } from 'zustand';
import type { CommunicationEventV1, ConnState, RoleFilter } from './types';

/**
 * Communications state. Module-level on purpose: the feed can be hidden, the Execution tab left and re-entered, without
 * touching ingestion. Events are keyed by (run_id, seq) — the canonical run sequence — so reconnect overlap, REST
 * backfill racing the stream and duplicate delivery can never produce two rows.
 */
export const MAX_EVENTS = 5000;

const kindOf = (e: CommunicationEventV1) => (e.kind && /^[A-Z_]+$/.test(e.kind) ? e.kind : e.message_type);
const FAIL_KINDS = new Set(['TOOL_REJECTED', 'PLAN_REJECTED', 'SAFETY_VETO', 'MODEL_ERROR', 'ESCALATION']);
export const isFailure = (e: CommunicationEventV1) =>
  FAIL_KINDS.has(kindOf(e)) ||
  /^(failed|error|rejected|denied|blocked|refused|timeout|unavailable|aborted|expired|safe_hold)/i.test(e.status ?? '') ||
  /^(failed|error|rejected|denied|blocked)/i.test(e.phase ?? '') ||
  /(\.|^)(failed|error|blocked|denied|rejected|deadman)$/i.test(e.subtype ?? '');

export interface FilterOpts {
  filter: RoleFilter;
  query: string;
  mode: 'live' | 'replay';
  cursorTick: number | null;
}

/** Pure; the list the feed shows. In replay only events at or before the cursor exist (no future leakage). */
export function filterEvents(events: CommunicationEventV1[], o: FilterOpts): CommunicationEventV1[] {
  const q = o.query.trim().toLowerCase();
  const cursor = o.mode === 'replay' && o.cursorTick !== null ? o.cursorTick : Infinity;
  const out: CommunicationEventV1[] = [];
  for (const e of events) {
    if (e.sim_tick > cursor) continue;
    if (o.filter !== 'all') {
      const cls = e.sender.class;
      const rcls = e.recipient?.class;
      const ok =
        o.filter === 'tools' ? e.message_type === 'tool_event' : o.filter === 'failures' ? isFailure(e) : o.filter === 'operator' ? e.message_type === 'operator' || cls === 'operator' : cls === o.filter || rcls === o.filter;
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
  events: CommunicationEventV1[];
  dropped: number;
  conn: ConnState;
  mode: 'live' | 'replay';
  cursorTick: number | null;
  filter: RoleFilter;
  query: string;
  /** the feed panel is shown (true) or hidden behind a one-line reopen bar (false) */
  open: boolean;
  selectedId: string | null;
  unread: number;
  readSeq: number;
  previewAt: number;
  backfill: { state: 'idle' | 'loading' | 'done' | 'error'; error: string | null };

  setRun(runId: string | null): void;
  ingest(events: CommunicationEventV1[]): number;
  setConn(c: ConnState): void;
  setMode(mode: 'live' | 'replay', cursorTick?: number | null): void;
  setCursor(tick: number | null): void;
  setFilter(f: RoleFilter): void;
  setQuery(q: string): void;
  setOpen(open: boolean): void;
  select(id: string | null): void;
  notePreview(): void;
  setBackfill(b: State['backfill']): void;
}

const keyOf = (e: { run_id: string; seq: number }) => `${e.run_id}:${e.seq}`;
let seen = new Set<string>();

export const useComms = create<State>()((set, get) => ({
  runId: null,
  events: [],
  dropped: 0,
  conn: 'CONNECTING',
  mode: 'live',
  cursorTick: null,
  filter: 'all',
  query: '',
  open: true,
  selectedId: null,
  unread: 0,
  readSeq: 0,
  previewAt: 0,
  backfill: { state: 'idle', error: null },

  setRun: (runId) => {
    if (get().runId === runId) return;
    seen = new Set();
    set({ runId, events: [], unread: 0, readSeq: 0, selectedId: null, backfill: { state: 'idle', error: null } });
  },

  ingest: (incoming) => {
    const st = get();
    const fresh: CommunicationEventV1[] = [];
    for (const e of incoming) {
      if (st.runId && e.run_id !== st.runId) continue;
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(e);
    }
    if (!fresh.length) return 0;
    fresh.sort((a, b) => a.seq - b.seq);
    const last = st.events.length ? st.events[st.events.length - 1].seq : -1;
    let events = fresh[0].seq > last ? st.events.concat(fresh) : st.events.concat(fresh).sort((a, b) => a.seq - b.seq);
    let dropped = st.dropped;
    if (events.length > MAX_EVENTS) {
      const cut = events.length - MAX_EVENTS;
      for (const d of events.slice(0, cut)) seen.delete(keyOf(d));
      events = events.slice(cut);
      dropped += cut;
    }
    const newest = events[events.length - 1].seq;
    const unread = st.open ? 0 : st.unread + fresh.filter((e) => e.seq > st.readSeq).length;
    set({ events, dropped, unread, readSeq: st.open ? newest : st.readSeq });
    return fresh.length;
  },

  setConn: (conn) => set((s) => (s.conn === conn ? s : { conn })),
  setMode: (mode, cursorTick = null) => set((s) => (s.mode === mode && s.cursorTick === (mode === 'replay' ? cursorTick : null) ? s : { mode, cursorTick: mode === 'replay' ? cursorTick : null })),
  setCursor: (cursorTick) => set((s) => (s.cursorTick === cursorTick ? s : { cursorTick })),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setOpen: (open) => set((s) => ({ open, ...(open ? { unread: 0, readSeq: s.events.length ? s.events[s.events.length - 1].seq : s.readSeq } : {}) })),
  select: (selectedId) => set({ selectedId }),
  notePreview: () => set({ previewAt: Date.now() }),
  setBackfill: (backfill) => set({ backfill }),
}));

export function resetCommsForTest() {
  seen = new Set();
  useComms.setState({ runId: null, events: [], dropped: 0, conn: 'CONNECTING', mode: 'live', cursorTick: null, filter: 'all', query: '', selectedId: null, unread: 0, readSeq: 0, previewAt: 0, backfill: { state: 'idle', error: null } });
}
