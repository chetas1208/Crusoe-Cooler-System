import { useEffect } from 'react';
import { create } from 'zustand';
import { apiFetch } from '../execution/api';
import { activeLiveRunId, useExec } from '../execution/state';
import { edgeEnvelopes, parseEnvEvents, type EnvEvent, type EnvTag } from './envelopes';
import { parseSeatTeam, type SeatTeam } from './seats';

type Load = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
interface State {
  runId: string | null;
  incidentId: string | null;
  load: Load;
  error: string | null;
  team: SeatTeam | null;
  /** envelope kinds per child task id, from the run's communications log */
  envelopes: Record<string, EnvTag[]>;
  envLoad: Load;
  updatedAt: number | null;
}
export const useSeatTeamStore = create<State>()(() => ({ runId: null, incidentId: null, load: 'idle', error: null, team: null, envelopes: {}, envLoad: 'idle', updatedAt: null }));

async function getJson(path: string): Promise<{ status: 'ok'; json: unknown } | { status: 'unavailable' } | { status: 'error'; message: string }> {
  try {
    const r = await apiFetch(path, { headers: { Accept: 'application/json' } });
    if (r.status === 404 || r.status === 501) return { status: 'unavailable' };
    if (!r.ok) return { status: 'error', message: `HTTP ${r.status}` };
    return { status: 'ok', json: await r.json() };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

let seq = 0;
/** one team + envelope refresh for (run, incident); a stale answer for a previous selection is dropped */
export async function refreshSeatTeam(runId: string, incidentId: string): Promise<void> {
  const me = ++seq;
  const cur = useSeatTeamStore.getState();
  if (cur.runId !== runId || cur.incidentId !== incidentId) useSeatTeamStore.setState({ runId, incidentId, load: 'loading', error: null, team: null, envelopes: {}, envLoad: 'idle' });
  const rid = encodeURIComponent(runId);
  const iid = encodeURIComponent(incidentId);
  const t = await getJson(`/runs/${rid}/incidents/${iid}/team`);
  if (me !== seq) return;
  if (t.status !== 'ok') {
    useSeatTeamStore.setState({ load: t.status, error: t.status === 'error' ? t.message : null, team: t.status === 'unavailable' ? null : useSeatTeamStore.getState().team, updatedAt: Date.now() });
    return;
  }
  const team = parseSeatTeam(t.json, incidentId);
  useSeatTeamStore.setState({ load: team ? 'ready' : 'unavailable', team, error: null, updatedAt: Date.now() });
  if (!team) return;
  // the incident's own thread, newest first; envelope kinds are read from it (the log has no per-kind filter)
  const events: EnvEvent[] = [];
  let any = false;
  let before: number | null = null;
  for (let page = 0; page < 4; page++) {
    const r = await getJson(`/runs/${rid}/communications?thread_id=${iid}&order=desc&limit=200${before ? `&before_seq=${before}` : ''}`);
    if (me !== seq) return;
    if (r.status !== 'ok') break;
    any = true;
    events.push(...parseEnvEvents(r.json));
    const j = r.json as { has_more?: boolean; prev_before_seq?: number | null };
    if (!j.has_more || !j.prev_before_seq) break;
    before = j.prev_before_seq;
  }
  const envelopes = edgeEnvelopes(events, team.tasks);
  // keep the same object when nothing changed so the graph is not re-laid-out on every poll
  const same = JSON.stringify(envelopes) === JSON.stringify(useSeatTeamStore.getState().envelopes);
  useSeatTeamStore.setState(same ? { envLoad: any ? 'ready' : 'unavailable' } : { envelopes, envLoad: any ? 'ready' : 'unavailable' });
}

/** the run the Agents tab describes: the backend's live baseline (the team graph exists for the live run only) */
export function useAgentsRunId(): string | null {
  return useExec((s) => (s.runsLoaded ? (activeLiveRunId(s.runs) ?? s.selectedId) : null));
}

/** polls while the tab is mounted and an incident is selected; faster while the incident is open */
export function useSeatTeam(runId: string | null, incidentId: string | null, open: boolean): State {
  useEffect(() => {
    if (!runId || !incidentId) return;
    void refreshSeatTeam(runId, incidentId);
    const id = setInterval(() => void refreshSeatTeam(runId, incidentId), open ? 5000 : 30000);
    return () => clearInterval(id);
  }, [runId, incidentId, open]);
  return useSeatTeamStore();
}
