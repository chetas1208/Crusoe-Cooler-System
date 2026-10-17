import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { authFetch } from '@loopkeeper/core/client';
import { activeTransport } from '@loopkeeper/core/store';

export interface Supervisor {
  id: string;
  title: string;
  specialty: string;
  status: string;
}

interface SupState {
  loaded: boolean;
  list: Supervisor[];
}
const useSup = create<SupState>()(() => ({ loaded: false, list: [] }));

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

async function pull() {
  const t = activeTransport();
  if (!t || t.info.kind !== 'live' || !t.info.url) {
    useSup.setState({ loaded: true, list: [] });
    return;
  }
  try {
    const r = await authFetch(`${t.info.url.replace(/\/$/, '')}/api/v1/agents/graph`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    const g = (await r.json()) as { nodes?: Array<Record<string, unknown>> };
    const list = (g.nodes ?? [])
      .filter((n) => n.kind === 'supervisor' && typeof n.id === 'string')
      .map((n) => ({ id: String(n.id), title: String(n.title ?? n.id).replace(/^SEN-\d+\s*·\s*/, ''), specialty: String(n.specialty ?? ''), status: String(n.status ?? 'unknown') }));
    useSup.setState({ loaded: true, list });
  } catch {
    useSup.setState({ loaded: true, list: [] });
  }
}

/** The virtual SENTINEL supervisors the backend reports (GET /agents/graph). Empty when it reports none (e.g. the TS mock). */
export function useSupervisors(): { loaded: boolean; list: Supervisor[] } {
  const [, force] = useState(0);
  useEffect(() => {
    if (users++ === 0) {
      void pull();
      timer = setInterval(pull, 20000);
    }
    const un = useSup.subscribe(() => force((n) => n + 1));
    return () => {
      un();
      if (--users === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSup.getState();
}
