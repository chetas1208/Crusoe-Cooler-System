import { useEffect } from 'react';
import { create } from 'zustand';
import type { RunSummary } from '@loopkeeper/core/runs';
import { getJson } from '@/lib/http';

interface RunsState {
  runs: RunSummary[];
  loaded: boolean;
  error: string | null;
  /** the run the Execution tab (comms / DoD / team) is looking at; null = the live run */
  selectedId: string | null;
  select(id: string | null): void;
  refresh(): Promise<void>;
}

export const useRuns = create<RunsState>()((set) => ({
  runs: [],
  loaded: false,
  error: null,
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
  refresh: async () => {
    const r = await getJson<RunSummary[]>('/runs');
    if (r.status === 'ok' && Array.isArray(r.json)) set({ runs: r.json, loaded: true, error: null });
    else set({ loaded: true, error: r.status === 'error' ? r.message : 'This backend does not list runs.' });
  },
}));

/** The run the live world belongs to: the newest baseline that is LIVE and running/paused (mirrors the web console). */
export function liveRunIdOf(runs: RunSummary[]): string | null {
  const c = runs.filter((r) => r.kind === 'baseline' && r.mode === 'LIVE' && (r.state === 'running' || r.state === 'paused'));
  c.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return c[0]?.run_id ?? null;
}

export const useLiveRunId = () => useRuns((s) => liveRunIdOf(s.runs));
export const useTargetRunId = () => useRuns((s) => s.selectedId ?? liveRunIdOf(s.runs));

/** Mount once (tabs layout): keeps the run list fresh. */
export function useRunsPolling(ms = 4000) {
  useEffect(() => {
    void useRuns.getState().refresh();
    const id = setInterval(() => void useRuns.getState().refresh(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
