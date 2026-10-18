import { create } from 'zustand';
import { getJson } from '@/lib/http';
import { parseContract, parseTeam } from './schemas';
import type { ContractSummary, DodContract, TeamGraph } from './types';

type Load = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
interface State {
  runId: string | null;
  /** incidents that have a contract in this run, and the one being shown */
  incidents: ContractSummary[];
  incidentId: string | null;
  contract: DodContract | null;
  contractLoad: Load;
  contractError: string | null;
  team: TeamGraph | null;
  teamLoad: Load;
  teamError: string | null;
  updatedAt: number | null;
  pickIncident(id: string): void;
  refresh(runId: string): Promise<void>;
  reset(runId: string | null): void;
}

export const useDod = create<State>()((set, get) => ({
  runId: null,
  incidents: [],
  incidentId: null,
  contract: null,
  contractLoad: 'idle',
  contractError: null,
  team: null,
  teamLoad: 'idle',
  teamError: null,
  updatedAt: null,
  pickIncident: (incidentId) => set({ incidentId, contract: null, contractLoad: 'loading', team: null, teamLoad: 'loading' }),
  reset: (runId) => set({ runId, incidents: [], incidentId: null, contract: null, contractLoad: 'idle', contractError: null, team: null, teamLoad: 'idle', teamError: null, updatedAt: null }),
  refresh: async (runId) => {
    if (get().runId !== runId) get().reset(runId);
    const id = encodeURIComponent(runId);
    // 1) which incidents have a contract; 2) that incident's contract and team (the backend serves them per incident)
    const list = await getJson<{ contracts?: unknown[] }>(`/runs/${id}/contracts`);
    if (get().runId !== runId) return;
    if (list.status !== 'ok') {
      const msg = list.status === 'error' ? list.message : null;
      set({ contractLoad: list.status, contractError: msg, teamLoad: list.status, teamError: msg, updatedAt: Date.now() });
      return;
    }
    const raw = list.json.contracts;
    const incidents: ContractSummary[] = (Array.isArray(raw) ? raw : []).flatMap((c) => {
      const o = c as Record<string, unknown>;
      return typeof o?.incident_id === 'string' ? [{ incident_id: o.incident_id, id: String(o.id ?? ''), version: Number(o.version ?? 1), state: String(o.state ?? ''), terminal_state: (o.terminal_state as string | null) ?? null }] : [];
    });
    // default: the newest contract that is still open, else the newest
    const chosen = get().incidentId && incidents.some((i) => i.incident_id === get().incidentId) ? get().incidentId : ([...incidents].reverse().find((i) => !i.terminal_state)?.incident_id ?? incidents[incidents.length - 1]?.incident_id ?? null);
    if (!chosen) {
      set({ incidents, incidentId: null, contract: null, contractLoad: 'unavailable', team: null, teamLoad: 'unavailable', updatedAt: Date.now() });
      return;
    }
    const [c, t] = await Promise.all([getJson(`/runs/${id}/incidents/${encodeURIComponent(chosen)}/contract`), getJson(`/runs/${id}/incidents/${encodeURIComponent(chosen)}/team`)]);
    if (get().runId !== runId) return;
    const contract = c.status === 'ok' ? parseContract(c.json) : null;
    set({
      incidents,
      incidentId: chosen,
      contract: c.status === 'ok' ? contract : get().contract,
      contractLoad: c.status === 'ok' ? (contract ? 'ready' : 'unavailable') : c.status,
      contractError: c.status === 'error' ? c.message : null,
      team: t.status === 'ok' ? parseTeam(t.json) : get().team,
      teamLoad: t.status === 'ok' ? 'ready' : t.status,
      teamError: t.status === 'error' ? t.message : null,
      updatedAt: Date.now(),
    });
  },
}));
