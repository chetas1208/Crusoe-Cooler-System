import { useEffect } from 'react';
import { closeReplay, openMonitor, openReplay, setRunTopology, resetRunPoses, selectRunWorld, setLabelResolver, showLiveSnapshot, type RunsApi, type ApiProblem, type RunSummary } from '@loopkeeper/core/runs';
import { getLiveWorldState, sendCommand, setCommandRouter, useWorld } from '@loopkeeper/core/store';
import { usePlayer, usePlayhead } from '@loopkeeper/core/runs';
import { activeLiveRunId, isReplayOnly, resolveRunsApi, useExec } from './state';

const READ_ONLY = 'Replay is read-only. Fork to interact.';

/** keep the run list fresh while the tab is open */
export function useRunsPolling() {
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const api = resolveRunsApi();
      if (!api) return;
      try {
        const runs = await api.listRuns();
        if (stop) return;
        useExec.setState((s) => ({ runs, runsError: null, runsLoaded: true, selectedId: s.selectedId && runs.some((r) => r.run_id === s.selectedId) ? s.selectedId : (activeLiveRunId(runs) ?? runs[0]?.run_id ?? null) }));
      } catch (e) {
        if (!stop) useExec.setState({ runsError: (e as ApiProblem).message ?? String(e), runsLoaded: true });
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
}

/** asset labels in the timeline come from the topology, not from the recording */
export function useLabelResolver() {
  const assets = useWorld((s) => s.assetsById);
  const edges = useWorld((s) => s.edgesById);
  useEffect(() => {
    setLabelResolver((id) => assets[id]?.label ?? edges[id]?.label ?? id.toUpperCase().replace('_', '-'));
  }, [assets, edges]);
}

/**
 * Decides which world the shared 3D scene shows and where operator commands go:
 *  live + baseline      -> the live store (nothing changes)
 *  live + scenario/fork -> the run world store fed by that run's snapshots; commands go to that run
 *  replay / branch      -> the run world store fed by the replay player; commands are refused
 * Everything is restored when the tab unmounts.
 */
export function useWorldBinding() {
  const mode = useExec((s) => s.mode);
  const selectedId = useExec((s) => s.selectedId);
  const runsLoaded = useExec((s) => s.runsLoaded);
  // what kind of thing the selected run is NOW (it can flip from running to stopped while the tab is open)
  const liveId = useExec((s) => activeLiveRunId(s.runs));
  const selState = useExec((s) => s.runs.find((r) => r.run_id === s.selectedId)?.state ?? '');
  const selKind = useExec((s) => s.runs.find((r) => r.run_id === s.selectedId)?.kind ?? '');

  useEffect(
    () => () => {
      selectRunWorld(false);
      setCommandRouter(null);
      closeReplay();
    },
    [],
  );

  useEffect(() => {
    const api = resolveRunsApi();
    if (!api || !runsLoaded || !selectedId) return;
    const sel = useExec.getState().runs.find((r) => r.run_id === selectedId);
    // Only the backend's active baseline is the live monitor; a stopped run is ALWAYS a replay, whatever the mode chip says.
    const isLiveMonitor = selectedId === liveId;
    const wantsLive = mode === 'live' && !isReplayOnly(sel);
    if (wantsLive && isLiveMonitor) {
      closeReplay();
      selectRunWorld(false);
      setCommandRouter(null);
      useExec.setState({ worldReady: true, topoStamp: null });
      void openMonitor(api, selectedId);
      return () => closeReplay();
    }
    if (wantsLive && sel && sel.kind !== 'baseline') {
      // scenario / fork the backend is still holding: poll its world snapshots, commands go to that run
      closeReplay();
      selectRunWorld(true);
      void matchRunTopology(api, selectedId);
      resetRunPoses();
      useExec.setState({ worldReady: false });
      setCommandRouter((req) => api.command(selectedId, req).catch((e) => ({ command_id: req.command_id, accepted: false, reason: (e as ApiProblem).message })));
      let n = 0;
      let stop = false;
      let busy = false;
      const pull = async () => {
        if (busy) return;
        busy = true;
        try {
          const snap = await api.world(selectedId);
          if (stop) return;
          showLiveSnapshot(snap, n++ % 2 === 0);
          if (!useExec.getState().worldReady) useExec.setState({ worldReady: true });
        } catch {
          /* the run list poll reports an unreachable backend */
        } finally {
          busy = false;
        }
      };
      void pull();
      const id = setInterval(pull, 250);
      return () => {
        stop = true;
        clearInterval(id);
      };
    }
    // replay (stopped run, or replay / branch chip): strictly read-only, on the topology the run was recorded with
    selectRunWorld(true);
    void matchRunTopology(api, selectedId);
    setCommandRouter(async (req) => ({ command_id: req.command_id, accepted: false, reason: READ_ONLY }));
    useExec.setState({ worldReady: true });
    void openReplay(api, selectedId);
    return undefined;
  }, [mode, selectedId, runsLoaded, liveId, selState, selKind]);
}

/** plain-language text for the fork refusals the backend can send (problem codes in the JSON body, mirrored in X-Problem-Code) */
export function forkProblemText(e: unknown, run?: Pick<RunSummary, 'topology_version' | 'run_id'>): string {
  const x = e as { code?: string; message?: string; status?: number };
  const live = getLiveWorldState().topology?.facility as { topology_version?: string } | undefined;
  switch (x.code) {
    case 'topology_mismatch':
      return `Cannot fork ${run?.run_id ?? 'this run'}: it was recorded on an older layout (${run?.topology_version ?? 'unknown'}) and the backend only forks runs recorded on the current one (${live?.topology_version ?? 'current'}). You can still replay it.`;
    case 'stale_parent':
      return 'The run moved on since that checkpoint was listed (the parent changed). Nothing was created; try the fork again.';
    case 'unknown_checkpoint':
      return 'That checkpoint no longer exists in this run. Nothing was created.';
    default:
      return x.message ?? 'The backend refused the fork.';
  }
}

/**
 * Fork the selected run at a recorded checkpoint: the latest compatible one at or before the playhead (in the live monitor: the
 * newest one). Sends fork_tick, expected_parent_hash = that checkpoint's hash and its snapshot id; selects the child afterwards.
 */
export async function startFork(label?: string) {
  const api = resolveRunsApi();
  const st = useExec.getState();
  if (!api || !st.selectedId) return;
  const run = st.runs.find((r) => r.run_id === st.selectedId);
  const pl = usePlayer.getState();
  const head = pl.monitor ? Infinity : usePlayhead.getState().tick;
  const cps = pl.checkpoints.filter((c) => c.compatible && c.tick <= head);
  const cp = cps[cps.length - 1];
  if (!cp) {
    useExec.setState({ notice: { tone: 'warning', text: pl.checkpoints.length ? `No restorable checkpoint exists at or before tick ${Math.round(head)}; move the playhead later.` : 'This run has no checkpoints yet, so it cannot be forked.' } });
    return;
  }
  useExec.setState({ forking: true, notice: null });
  try {
    const res = await api.fork(st.selectedId, { fork_tick: Math.floor(cp.tick), expected_parent_hash: cp.hash, chosen_snapshot_id: cp.snapshot_id, label });
    const runs = await api.listRuns().catch(() => null);
    useExec.setState((s) => ({ runs: runs ?? (s.runs.some((r) => r.run_id === res.run.run_id) ? s.runs : [...s.runs, res.run]), lastFork: res, selectedId: res.run.run_id, mode: 'live', forking: false, notice: { tone: 'ok', text: `Fork ${res.run.run_id} created from ${res.parent_run_id} at tick ${res.fork_tick} (checkpoint ${cp.snapshot_id.slice(0, 8)}). The parent is unchanged.` } }));
  } catch (e) {
    useExec.setState({ forking: false, notice: { tone: 'warning', text: forkProblemText(e, run) } });
  }
}

export async function runCommand(api: RunsApi, runId: string, kind: 'pause' | 'resume' | 'set_sim_speed' | 'test.inject_fault' | 'approve_action' | 'hold_action', targetId?: string, args?: Record<string, unknown>) {
  const req = { command_id: `ex_${Date.now()}`, kind, target_id: targetId, args };
  try {
    const ack = runId === (activeLiveRunId(useExec.getState().runs) ?? 'run_baseline') ? await sendCommand(kind, targetId, args) : await api.command(runId, req);
    if (!ack.accepted) useExec.setState({ notice: { tone: 'warning', text: ack.reason ?? 'The engine refused that command.' } });
    return ack;
  } catch (e) {
    useExec.setState({ notice: { tone: 'warning', text: (e as ApiProblem).message ?? String(e) } });
    return null;
  }
}

const verOf = (t: { facility: { topology_hash?: string } }) => ((t.facility as { topology_version?: string }).topology_version ?? t.facility.topology_hash ?? '');
const recordedOf = (r: RunSummary | undefined) => r?.topology_version ?? r?.topology_hash ?? '?';

/**
 * A run keeps the topology version it was recorded with (never today's layout). Fetch GET /runs/{id}/topology and show THAT in the
 * run world. A fork child falls back to its parent's topology (same version by construction). If the backend cannot recover it
 * (409 topology_unavailable) the scene is NOT drawn with the live layout: the stage shows an honest "topology unavailable" state.
 */
async function matchRunTopology(api: RunsApi, runId: string) {
  const live = getLiveWorldState().topology;
  const liveV = live ? verOf(live) : '';
  const run = useExec.getState().runs.find((r) => r.run_id === runId);
  useExec.setState({ topoStamp: null });
  const tryOne = async (id: string, source: 'run' | 'parent') => {
    if (!api.topology) throw Object.assign(new Error('this backend has no per-run topology endpoint'), { code: 'topology_unavailable' });
    const t = await api.topology(id);
    const v = verOf(t);
    if (useExec.getState().selectedId !== runId) return;
    if (!live || v === liveV) setRunTopology(null);
    else setRunTopology(t);
    useExec.setState({ topoStamp: { runId, recorded: recordedOf(run) === '?' ? v : recordedOf(run), shown: v, source, matchesLive: !live || v === liveV } });
  };
  try {
    await tryOne(runId, 'run');
  } catch (e) {
    const err = e as { code?: string; message?: string; status?: number };
    if (run?.parent_run_id) {
      try {
        await tryOne(run.parent_run_id, 'parent');
        return;
      } catch {
        /* fall through to the honest state */
      }
    }
    if (useExec.getState().selectedId !== runId) return;
    const hardMiss = err.status === 409 || err.code === 'topology_unavailable' || err.status === 404;
    // an old backend without the endpoint: keep the live layout and say so; a run whose layout is known-gone: draw nothing
    const sameAsLive = !!live && (run?.topology_hash === live.facility.topology_hash || recordedOf(run) === liveV);
    if (hardMiss && !sameAsLive) {
      useExec.setState({ topoStamp: { runId, recorded: recordedOf(run), shown: '', source: 'unavailable', matchesLive: false, error: err.message } });
    } else {
      setRunTopology(null);
      useExec.setState({ topoStamp: { runId, recorded: recordedOf(run), shown: liveV, source: 'live-fallback', matchesLive: true, error: err.message } });
    }
  }
}
