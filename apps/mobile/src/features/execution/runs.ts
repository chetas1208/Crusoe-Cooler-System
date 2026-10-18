import { HttpRunsApi, closeReplay, openReplay, type RunSummary } from '@loopkeeper/core/runs';
import { selectRunWorld } from '@loopkeeper/core/runs';
import { getLiveWorldState, setCommandRouter } from '@loopkeeper/core/store';
import { resolveApiUrl } from '@/lib/api';
import { useRuns } from '@/hooks/useRuns';

let cached: { url: string; mock: boolean; api: HttpRunsApi } | null = null;

export function runsApi(): HttpRunsApi {
  const url = resolveApiUrl();
  const mock = getLiveWorldState().health?.backend !== 'live';
  if (!cached || cached.url !== url || cached.mock !== mock) cached = { url, mock, api: new HttpRunsApi(url, mock, mock ? 'Mock API (MOCK)' : 'Live backend') };
  return cached.api;
}

const READ_ONLY = 'Replay is read-only. Exit the replay to command the live run.';

/** Show a recorded run read-only: the replay world replaces the live world on every tab, commands are refused. */
export function startReplay(runId: string) {
  useRuns.getState().select(runId);
  selectRunWorld(true);
  setCommandRouter(async (req) => ({ command_id: req.command_id, accepted: false, reason: READ_ONLY }));
  void openReplay(runsApi(), runId);
}

export function exitReplay() {
  closeReplay();
  selectRunWorld(false);
  setCommandRouter(null);
}

export function runBadge(r: Pick<RunSummary, 'mode' | 'state'>): { text: string; tone: 'isolated' | 'critical' | 'watch' | 'service' | 'nominal' } {
  if (r.state === 'stopped') return { text: 'STOPPED', tone: 'isolated' };
  if (r.state === 'failed') return { text: 'FAILED', tone: 'critical' };
  if (r.state === 'paused') return { text: r.mode === 'FORK' ? 'FORK · PAUSED' : 'PAUSED', tone: 'watch' };
  return r.mode === 'FORK' ? { text: 'FORK · LIVE', tone: 'service' } : { text: 'LIVE', tone: 'nominal' };
}
