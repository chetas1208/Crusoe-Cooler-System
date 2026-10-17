import { create } from 'zustand';
import { apiFetch } from '../../tabs/execution/api';
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
  showDod: boolean;
  showTeam: boolean;
  pickIncident(id: string): void;
  setShow(k: 'showDod' | 'showTeam', v: boolean): void;
  refresh(runId: string): Promise<void>;
  reset(runId: string | null): void;
}

/** test hook only (`?e2e`): stops polling from replacing fixture data */
export const dodFreeze = { on: false };
const key = (k: string) => `lk.v11.${k}`;
const read = (k: string, d: boolean) => {
  try {
    const v = localStorage.getItem(key(k));
    return v === null ? d : v === '1';
  } catch {
    return d;
  }
};

async function get(path: string): Promise<{ status: 'ok'; json: unknown } | { status: 'unavailable' } | { status: 'error'; message: string }> {
  try {
    const r = await apiFetch(path, { headers: { Accept: 'application/json' } });
    if (r.status === 404 || r.status === 501) return { status: 'unavailable' };
    if (!r.ok) return { status: 'error', message: `HTTP ${r.status}` };
    return { status: 'ok', json: await r.json() };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

export const useDod = create<State>()((set, get_) => ({
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
  showDod: read('dod', false),
  showTeam: read('team', false),
  setShow: (k, v) => {
    try {
      localStorage.setItem(key(k === 'showDod' ? 'dod' : 'team'), v ? '1' : '0');
    } catch {
      /* private mode */
    }
    set({ [k]: v } as Partial<State>);
  },
  pickIncident: (incidentId) => set({ incidentId, contract: null, contractLoad: 'loading', team: null, teamLoad: 'loading' }),
  reset: (runId) => set({ runId, incidents: [], incidentId: null, contract: null, contractLoad: 'idle', contractError: null, team: null, teamLoad: 'idle', teamError: null, updatedAt: null }),
  refresh: async (runId) => {
    if (dodFreeze.on) return;
    if (get_().runId !== runId) get_().reset(runId);
    const id = encodeURIComponent(runId);
    // 1) which incidents have a contract; 2) that incident's contract and team (the backend serves them per incident)
    const list = await get(`/runs/${id}/contracts`);
    if (get_().runId !== runId) return;
    if (list.status !== 'ok') {
      set({ contractLoad: list.status, contractError: list.status === 'error' ? list.message : null, teamLoad: list.status, teamError: list.status === 'error' ? list.message : null, updatedAt: Date.now() });
      return;
    }
    const raw = (list.json as { contracts?: unknown[] }).contracts;
    const incidents: ContractSummary[] = (Array.isArray(raw) ? raw : []).flatMap((c) => {
      const o = c as Record<string, unknown>;
      return typeof o?.incident_id === 'string' ? [{ incident_id: o.incident_id, id: String(o.id ?? ''), version: Number(o.version ?? 1), state: String(o.state ?? ''), terminal_state: (o.terminal_state as string | null) ?? null }] : [];
    });
    // default: the newest contract that is still open, else the newest
    const chosen = get_().incidentId && incidents.some((i) => i.incident_id === get_().incidentId) ? get_().incidentId : ([...incidents].reverse().find((i) => !i.terminal_state)?.incident_id ?? incidents[incidents.length - 1]?.incident_id ?? null);
    if (!chosen) {
      set({ incidents, incidentId: null, contract: null, contractLoad: 'unavailable', team: null, teamLoad: 'unavailable', updatedAt: Date.now() });
      return;
    }
    const [c, t] = await Promise.all([get(`/runs/${id}/incidents/${encodeURIComponent(chosen)}/contract`), get(`/runs/${id}/incidents/${encodeURIComponent(chosen)}/team`)]);
    if (get_().runId !== runId) return;
    const contract = c.status === 'ok' ? parseContract(c.json) : null;
    set({
      incidents,
      incidentId: chosen,
      contract: c.status === 'ok' ? contract : get_().contract,
      contractLoad: c.status === 'ok' ? (contract ? 'ready' : 'unavailable') : c.status,
      contractError: c.status === 'error' ? c.message : null,
      team: t.status === 'ok' ? parseTeam(t.json) : get_().team,
      teamLoad: t.status === 'ok' ? 'ready' : t.status,
      teamError: t.status === 'error' ? t.message : null,
      updatedAt: Date.now(),
    });
  },
}));
