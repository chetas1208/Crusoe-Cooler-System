import { create } from 'zustand';
import { HttpRunsApi, type RunsApi, type RunSummary, type ForkResult } from '@loopkeeper/core/runs';
import { activeTransport, getLiveWorldState } from '@loopkeeper/core/store';

export type ExecMode = 'live' | 'replay' | 'branch';

interface ExecState {
  mode: ExecMode;
  runs: RunSummary[];
  runsError: string | null;
  runsLoaded: boolean;
  selectedId: string | null;
  /** branch lab: the run compared against the selected one */
  otherId: string | null;
  scenarioOpen: boolean;
  notice: { tone: 'info' | 'ok' | 'warning'; text: string } | null;
  forking: boolean;
  lastFork: ForkResult | null;
  /** which topology the 3D scene shows for the selected run: its recorded one, or the live one when the backend cannot serve it */
  topoStamp: { runId: string; recorded: string; shown: string; source: 'run' | 'parent' | 'live-fallback' | 'unavailable'; matchesLive: boolean; error?: string } | null;
  /** first snapshot of a non-baseline run has arrived */
  worldReady: boolean;
  setMode(m: ExecMode): void;
  select(id: string | null): void;
  setOther(id: string | null): void;
  setScenarioOpen(v: boolean): void;
  say(tone: 'info' | 'ok' | 'warning', text: string): void;
}

export const useExec = create<ExecState>()((set) => ({
  mode: 'live',
  runs: [],
  runsError: null,
  runsLoaded: false,
  selectedId: 'run_baseline',
  otherId: null,
  scenarioOpen: false,
  notice: null,
  forking: false,
  lastFork: null,
  worldReady: true,
  topoStamp: null,
  setMode: (mode) => set({ mode }),
  select: (selectedId) => set({ selectedId }),
  setOther: (otherId) => set({ otherId }),
  setScenarioOpen: (scenarioOpen) => set({ scenarioOpen }),
  say: (tone, text) => set({ notice: { tone, text } }),
}));

let cached: { key: unknown; api: RunsApi } | null = null;

/** The runs backend that matches the transport the app is running on (embedded simulator or REST). */
export function resolveRunsApi(): RunsApi | null {
  const t = activeTransport();
  if (!t) return null;
  if (cached?.key === t) return cached.api;
  const emb = (t as unknown as { runsApi?: RunsApi }).runsApi;
  let api: RunsApi | null = emb ?? null;
  if (!api && t.info.kind === 'live' && t.info.url) api = new HttpRunsApi(t.info.url, getLiveWorldState().health?.backend !== 'live');
  if (api) cached = { key: t, api };
  return api;
}

export const BASELINE = 'run_baseline';

/**
 * The run the live 3D world belongs to: a baseline in LIVE mode whose state is running/paused (newest wins if several).
 * Stopped baselines (earlier backend sessions, possibly on another topology) are replays, never the live monitor.
 */
export function activeLiveRunId(runs: RunSummary[]): string | null {
  const c = runs.filter((r) => r.kind === 'baseline' && r.mode === 'LIVE' && (r.state === 'running' || r.state === 'paused'));
  c.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return c[0]?.run_id ?? null;
}

/** a run can only be looked at as a replay unless the backend is still running it */
export const isReplayOnly = (r: Pick<RunSummary, 'state'> | undefined) => !r || r.state === 'stopped' || r.state === 'failed';

export const fmtTick = (n: number) => n.toLocaleString('en-US');
export const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
export function runBadge(r: Pick<RunSummary, 'mode' | 'state'>) {
  if (r.state === 'stopped') return { text: 'STOPPED', tone: 'isolated' };
  if (r.state === 'failed') return { text: 'FAILED', tone: 'critical' };
  if (r.state === 'paused') return { text: r.mode === 'FORK' ? 'FORK — PAUSED' : 'PAUSED', tone: 'watch' };
  return r.mode === 'FORK' ? { text: 'FORK — LIVE', tone: 'service' } : { text: 'LIVE', tone: 'nominal' };
}
