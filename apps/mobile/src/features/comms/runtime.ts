import { onCommStreamEvent, useWorld } from '@loopkeeper/core/store';
import { usePlayer, usePlayhead } from '@loopkeeper/core/runs';
import { getJson } from '@/lib/http';
import { liveRunIdOf, useRuns } from '@/hooks/useRuns';
import { useComms } from './store';
import { parseCommunicationEvent, unwrapStreamPayload } from './schemas';
import type { CommunicationEventV1, ConnState } from './types';

/**
 * Ingestion for the Communications feed (shared by every consumer; ref-counted).
 *   live run   : REST backfill with after_seq, then `comm.*` stream events (same run_id/seq as everything else),
 *                re-backfilled after every reconnect; duplicates dropped by (run_id, seq)
 *   other runs : forks / scenario runs / stopped runs are read over REST (polled while running)
 *   replay     : everything the run recorded is loaded, but only events at or before the playhead are shown
 * Nothing here ever invents a message: no events -> the empty state says so.
 */
const PAGE = 200;
const MAX_PAGES = 25;
const PREVIEW_RE = /^comm\.operator\.preview/;

let users = 0;
let stop: (() => void) | null = null;

export function connFrom(conn: string, stale: boolean, replay: boolean, restError: boolean): ConnState {
  if (replay) return 'REPLAY';
  if (restError) return 'ERROR';
  if (conn === 'offline') return 'OFFLINE';
  if (conn === 'reconnecting') return 'RECONNECTING';
  if (conn === 'connecting') return 'CONNECTING';
  return stale ? 'STALE' : 'LIVE';
}

async function fetchPage(runId: string, afterSeq: number): Promise<{ events: CommunicationEventV1[]; hasMore: boolean }> {
  const r = await getJson<Record<string, unknown> | unknown[]>(`/runs/${encodeURIComponent(runId)}/communications?after_seq=${afterSeq}&limit=${PAGE}`);
  if (r.status === 'unavailable') return { events: [], hasMore: false };
  if (r.status === 'error') throw new Error(r.message);
  const j = r.json;
  const arr = (Array.isArray(j) ? j : (j.events ?? j.items ?? j.communications ?? [])) as unknown[];
  const events: CommunicationEventV1[] = [];
  for (const raw of arr) {
    const p = parseCommunicationEvent(raw, undefined, runId);
    if (p.ok) events.push(p.event);
  }
  const hasMore = Array.isArray(j) ? arr.length >= PAGE : Boolean(j.has_more ?? arr.length >= PAGE);
  return { events, hasMore };
}

function start(): () => void {
  const store = useComms;
  let alive = true;
  let backfilling = false;
  let again = false;
  let restError = false;
  let buf: CommunicationEventV1[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const target = (): { id: string | null; replay: boolean } => {
    const runs = useRuns.getState().runs;
    const sel = useRuns.getState().selectedId;
    const live = liveRunIdOf(runs);
    const p = usePlayer.getState();
    const replaying = p.phase === 'ready' && !p.monitor && p.runId !== null;
    if (replaying) return { id: p.runId, replay: true };
    if (sel) {
      const r = runs.find((x) => x.run_id === sel);
      return { id: sel, replay: !!r && (r.state === 'stopped' || r.state === 'failed') && sel !== live };
    }
    return { id: live, replay: false };
  };

  const syncState = () => {
    const w = useWorld.getState();
    const { id, replay } = target();
    const s = store.getState();
    if (id !== s.runId) s.setRun(id);
    s.setMode(replay ? 'replay' : 'live', usePlayhead.getState().tick);
    s.setConn(connFrom(w.connection, w.stale, replay, restError));
  };

  const flush = () => {
    flushTimer = null;
    if (!buf.length) return;
    const b = buf;
    buf = [];
    store.getState().ingest(b);
  };

  const backfill = async () => {
    const { id } = target();
    if (!id) return;
    if (backfilling) {
      again = true;
      return;
    }
    backfilling = true;
    store.getState().setBackfill({ state: 'loading', error: null });
    try {
      let pages = 0;
      for (;;) {
        const evs = store.getState().events;
        const after = evs.length && store.getState().runId === id ? evs[evs.length - 1].seq : 0;
        const { events, hasMore } = await fetchPage(id, after);
        if (!alive || store.getState().runId !== id) return;
        store.getState().ingest(events);
        if (!hasMore || !events.length || ++pages >= MAX_PAGES) break;
      }
      restError = false;
      store.getState().setBackfill({ state: 'done', error: null });
    } catch (e) {
      restError = true;
      store.getState().setBackfill({ state: 'error', error: (e as Error).message });
    } finally {
      backfilling = false;
      syncState();
      if (again && alive) {
        again = false;
        void backfill();
      }
    }
  };

  const offStream = onCommStreamEvent((e) => {
    if (PREVIEW_RE.test(e.type)) {
      store.getState().notePreview(); // ghost drive: a banner, never a feed row
      return;
    }
    const u = unwrapStreamPayload(e);
    const p = parseCommunicationEvent(u.raw, u.seq, u.run);
    if (!p.ok) return;
    buf.push(p.event);
    if (!flushTimer) flushTimer = setTimeout(flush, 100); // <= 10 React updates/s however hard the burst
  });

  const offWorld = useWorld.subscribe((s, prev) => {
    if (s.connection !== prev.connection || s.stale !== prev.stale) {
      syncState();
      if (s.connection === 'live' && prev.connection !== 'live') void backfill(); // reconnect: catch up from the last seq we hold
    }
  });
  const offRuns = useRuns.subscribe((s, prev) => {
    if (s.selectedId !== prev.selectedId || s.runs !== prev.runs) {
      syncState();
      if (store.getState().backfill.state !== 'loading' && target().id !== store.getState().runId) void backfill();
    }
  });
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (s.phase !== prev.phase || s.runId !== prev.runId) {
      syncState();
      void backfill();
    }
  });
  const offHead = usePlayhead.subscribe((s) => store.getState().setCursor(s.tick));

  const tick = () => {
    syncState();
    const { id, replay } = target();
    const s = store.getState();
    const live = liveRunIdOf(useRuns.getState().runs);
    // running forks / scenario runs have no stream here: poll; a replay is complete after one backfill
    const needsPoll = id !== null && !replay && id !== live;
    if (id && (s.backfill.state === 'idle' || needsPoll || s.backfill.state === 'error')) void backfill();
  };
  tick();
  const iv = setInterval(tick, 2500);

  return () => {
    alive = false;
    clearInterval(iv);
    if (flushTimer) clearTimeout(flushTimer);
    offStream();
    offWorld();
    offRuns();
    offPlayer();
    offHead();
  };
}

/** ref-counted: the first consumer starts ingestion, the last one stops it */
export function acquireComms(): () => void {
  if (users++ === 0) stop = start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      stop?.();
      stop = null;
    }
  };
}
