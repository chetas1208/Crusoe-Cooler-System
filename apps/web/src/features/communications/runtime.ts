import { authFetch } from '@loopkeeper/core/client';
import { activeTransport, onCommStreamEvent, useWorld } from '@loopkeeper/core/store';
import { usePlayhead, type RunSummary } from '@loopkeeper/core/runs';
import { activeLiveRunId, isReplayOnly, resolveRunsApi, useExec } from '../../tabs/execution/state';
import { useCommunications } from './communicationStore';
import { parseCommunicationEvent, unwrapStreamPayload } from './schemas';
import type { CommunicationEventV1, ConnState } from './types';

/**
 * Ingestion runtime for the Communications panel. It lives as long as ANY consumer (launcher, panel) is mounted, which is
 * always on desktop and mobile (the launcher is in the header): closing the panel never stops it.
 *
 *   live run   : REST backfill with since_seq, then `comm.*` stream events (same stream/run_id/seq as everything else),
 *                re-backfilled after every reconnect; duplicates dropped by (run_id, seq)
 *   other runs : forks / scenario runs / replays are read over REST (polled while running)
 *   replay     : everything the run recorded is loaded, but only events at or before the playhead are shown
 *
 * Nothing here ever invents a message: no events -> the empty state says so.
 */
const PAGE = 200;
const MAX_PAGES = 40;
const PREVIEW_RE = /^comm\.operator\.preview/;

let users = 0;
/** test hook only: stops the runtime from overwriting connection/mode/run while a browser flow drives the store */
export const syncFreeze = { on: false };
let stop: (() => void) | null = null;
export const dropReasons: Record<string, number> = {};

function note(reason: string) {
  dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
}

export function connFrom(conn: string, stale: boolean, replay: boolean, restError: boolean): ConnState {
  if (replay) return 'REPLAY';
  if (restError) return 'ERROR';
  if (conn === 'offline') return 'OFFLINE';
  if (conn === 'reconnecting') return 'RECONNECTING';
  if (conn === 'connecting') return 'CONNECTING';
  return stale ? 'STALE' : 'LIVE';
}

async function fetchPage(base: string, runId: string, afterSeq: number, parent: boolean): Promise<{ events: CommunicationEventV1[]; hasMore: boolean; lineage: string[] }> {
  const r = await authFetch(`${base}/api/v1/runs/${encodeURIComponent(runId)}/communications?after_seq=${afterSeq}&limit=${PAGE}${parent ? '&include_parent=true' : ''}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return { events: [], hasMore: false, lineage: [] }; // unknown / denied run or no communications on this backend: nothing to show, nothing invented
  if (!r.ok) throw new Error(`communications HTTP ${r.status}`);
  const j = (await r.json()) as unknown;
  const arr = (Array.isArray(j) ? j : ((j as Record<string, unknown>).events ?? (j as Record<string, unknown>).items ?? (j as Record<string, unknown>).communications ?? [])) as unknown[];
  const events: CommunicationEventV1[] = [];
  for (const raw of arr) {
    const p = parseCommunicationEvent(raw, undefined, runId);
    if (p.ok) events.push(p.event);
    else note(p.reason);
  }
  const hasMore = Array.isArray(j) ? arr.length >= PAGE : Boolean((j as Record<string, unknown>).has_more ?? arr.length >= PAGE);
  const lin = (j as { lineage?: { parent_run_id?: string } }).lineage?.parent_run_id;
  return { events, hasMore, lineage: lin ? [lin] : [] };
}

/** the Retry button: backfill again right now (set while ingestion runs; a no-op when nothing is mounted) */
let retryNow: (() => void) | null = null;
export const retryCommunications = () => retryNow?.();

export function startCommunications(): () => void {
  const store = useCommunications;
  let alive = true;
  let backfilling = false;
  let again = false;
  let ownRuns: RunSummary[] = [];
  let restError = false;
  let buf: CommunicationEventV1[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const base = () => {
    const t = activeTransport();
    return t?.info.kind === 'live' ? t.info.url?.replace(/\/$/, '') : undefined;
  };

  const targetRun = (): { id: string | null; replay: boolean } => {
    const ex = useExec.getState();
    const runs = ex.runs.length ? ex.runs : ownRuns;
    const sel = ex.selectedId ? runs.find((r) => r.run_id === ex.selectedId) : undefined;
    const live = activeLiveRunId(runs);
    if (sel) return { id: sel.run_id, replay: ex.mode !== 'live' || isReplayOnly(sel) };
    return { id: live, replay: false };
  };

  const syncState = () => {
    if (syncFreeze.on) return;
    const w = useWorld.getState();
    const { id, replay } = targetRun();
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
    const b = base();
    const { id } = targetRun();
    if (!b || !id) return;
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
        const run = (useExec.getState().runs.length ? useExec.getState().runs : ownRuns).find((r) => r.run_id === id);
        const { events, hasMore, lineage } = await fetchPage(b, id, after, Boolean(run?.parent_run_id));
        if (!alive || store.getState().runId !== id) return;
        if (lineage.length) store.getState().setLineage(lineage);
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

  retryNow = () => {
    if (store.getState().backfill.state !== 'loading') void backfill();
  };

  const offStream = onCommStreamEvent((e) => {
    if (PREVIEW_RE.test(e.type)) {
      store.getState().notePreview(); // V9 ghost drive: shown as a banner, never as a feed row
      return;
    }
    const u = unwrapStreamPayload(e);
    const p = parseCommunicationEvent(u.raw, u.seq, u.run);
    if (!p.ok) return note(p.reason);
    buf.push(p.event);
    if (!flushTimer) flushTimer = setTimeout(flush, 100); // <= 10 React updates/s however hard the burst
  });

  // world connection / staleness / playhead -> state
  const offWorld = useWorld.subscribe((s, prev) => {
    if (s.connection !== prev.connection || s.stale !== prev.stale) {
      syncState();
      if (s.connection === 'live' && prev.connection !== 'live') void backfill(); // reconnect: catch up from the last seq we hold
    }
  });
  const offExec = useExec.subscribe((s, prev) => {
    if (s.selectedId !== prev.selectedId || s.mode !== prev.mode || s.runs !== prev.runs) {
      syncState();
      if (store.getState().backfill.state !== 'loading') void backfill();
    }
  });
  const offHead = usePlayhead.subscribe((s) => !syncFreeze.on && store.getState().setCursor(s.tick));

  const tick = async () => {
    try {
      const api = resolveRunsApi();
      if (api && !useExec.getState().runs.length) ownRuns = await api.listRuns();
    } catch {
      /* the runs poll of the Execution tab reports its own errors */
    }
    syncState();
    const { id, replay } = targetRun();
    const s = store.getState();
    // running forks / scenario runs have no stream here: poll; a replay is complete after one backfill
    const needsPoll = id !== null && !replay && id !== activeLiveRunId(useExec.getState().runs.length ? useExec.getState().runs : ownRuns);
    if (id && (s.backfill.state === 'idle' || needsPoll || (s.backfill.state === 'error' && alive))) void backfill();
  };
  void tick();
  const iv = setInterval(tick, 2500);

  return () => {
    alive = false;
    retryNow = null;
    clearInterval(iv);
    if (flushTimer) clearTimeout(flushTimer);
    offStream();
    offWorld();
    offExec();
    offHead();
  };
}

/** ref-counted: the first consumer starts ingestion, the last one stops it */
export function acquireCommunications(): () => void {
  if (users++ === 0) stop = startCommunications();
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
