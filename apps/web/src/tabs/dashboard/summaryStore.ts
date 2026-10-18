import { useEffect } from 'react';
import { create } from 'zustand';
import { parseContract } from '../../features/dod/schemas';
import type { DodContract } from '../../features/dod/types';
import { apiFetch } from '../execution/api';
import { activeLiveRunId, useExec } from '../execution/state';
import { parseSeatTeam, type SeatTeam } from '../agents/seats';
import type { ModelStatusWire } from './summary';

type Load = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
interface State {
  model: ModelStatusWire | null;
  modelFetched: boolean;
  modelFailed: boolean;
  incidentId: string | null;
  contract: DodContract | null;
  contractLoad: Load;
  team: SeatTeam | null;
  teamLoad: Load;
  /** newest contract in the run (used when nothing is open, to say how the last incident ended) */
  last: { incident_id: string; terminal: string | null } | null;
}
export const useDashSummary = create<State>()(() => ({ model: null, modelFetched: false, modelFailed: false, incidentId: null, contract: null, contractLoad: 'idle', team: null, teamLoad: 'idle', last: null }));

async function getJson(path: string): Promise<{ s: 'ok'; json: unknown } | { s: 'unavailable' } | { s: 'error' }> {
  try {
    const r = await apiFetch(path, { headers: { Accept: 'application/json' } });
    if (r.status === 404 || r.status === 501) return { s: 'unavailable' };
    if (!r.ok) return { s: 'error' };
    return { s: 'ok', json: await r.json() };
  } catch {
    return { s: 'error' };
  }
}

async function pullModel() {
  const r = await getJson('/models/status');
  if (r.s === 'ok' && typeof r.json === 'object' && r.json !== null) useDashSummary.setState({ model: r.json as ModelStatusWire, modelFetched: true, modelFailed: false });
  else useDashSummary.setState({ modelFetched: true, modelFailed: true });
}

let seq = 0;
async function pullIncident(runId: string, incidentId: string) {
  const me = ++seq;
  const cur = useDashSummary.getState();
  if (cur.incidentId !== incidentId) useDashSummary.setState({ incidentId, contract: null, contractLoad: 'loading', team: null, teamLoad: 'loading' });
  const rid = encodeURIComponent(runId);
  const iid = encodeURIComponent(incidentId);
  const [c, t] = await Promise.all([getJson(`/runs/${rid}/incidents/${iid}/contract`), getJson(`/runs/${rid}/incidents/${iid}/team`)]);
  if (me !== seq) return;
  const contract = c.s === 'ok' ? parseContract(c.json) : null;
  const team = t.s === 'ok' ? parseSeatTeam(t.json, incidentId) : null;
  useDashSummary.setState({
    contract,
    contractLoad: c.s === 'ok' ? (contract ? 'ready' : 'unavailable') : c.s,
    team,
    teamLoad: t.s === 'ok' ? (team ? 'ready' : 'unavailable') : t.s,
  });
}

async function pullLast(runId: string) {
  const r = await getJson(`/runs/${encodeURIComponent(runId)}/contracts`);
  if (r.s !== 'ok') return useDashSummary.setState({ last: null });
  const list = (r.json as { contracts?: Array<{ incident_id?: unknown; terminal_state?: unknown }> }).contracts;
  const l = Array.isArray(list) ? list[list.length - 1] : undefined;
  useDashSummary.setState({ last: l && typeof l.incident_id === 'string' ? { incident_id: l.incident_id, terminal: typeof l.terminal_state === 'string' ? l.terminal_state : null } : null });
}

/** the live baseline run; null until the run list has loaded (the default selection before that is a placeholder) */
export function useDashRunId(): string | null {
  return useExec((s) => (s.runsLoaded ? (activeLiveRunId(s.runs) ?? null) : null));
}

/** Model status always; contract + team for the open incident, or the last contract when nothing is open. */
export function useDashPolling(runId: string | null, openIncidentId: string | null) {
  useEffect(() => {
    void pullModel();
    const id = setInterval(() => void pullModel(), 8000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!runId) return;
    if (openIncidentId) {
      void pullIncident(runId, openIncidentId);
      const id = setInterval(() => void pullIncident(runId, openIncidentId), 5000);
      return () => clearInterval(id);
    }
    useDashSummary.setState({ incidentId: null, contract: null, contractLoad: 'idle', team: null, teamLoad: 'idle' });
    void pullLast(runId);
    const id = setInterval(() => void pullLast(runId), 15000);
    return () => clearInterval(id);
  }, [runId, openIncidentId]);
}
