import { useEffect } from 'react';
import { create } from 'zustand';
import { getJson } from '@/lib/http';

export interface Supervisor {
  id: string;
  title: string;
  specialty: string;
  status: string;
}

interface State {
  loaded: boolean;
  list: Supervisor[];
}
const useSup = create<State>()(() => ({ loaded: false, list: [] }));

async function pull() {
  const r = await getJson<{ nodes?: Record<string, unknown>[] }>('/agents/graph');
  if (r.status !== 'ok') {
    useSup.setState({ loaded: true });
    return;
  }
  const list = (r.json.nodes ?? [])
    .filter((n) => n.kind === 'supervisor' && typeof n.id === 'string')
    .map((n) => ({ id: String(n.id), title: String(n.title ?? n.id).replace(/^SEN-\d+\s*·\s*/, ''), specialty: String(n.specialty ?? ''), status: String(n.status ?? 'unknown') }));
  useSup.setState({ loaded: true, list });
}

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** The virtual SENTINEL supervisors the backend reports (GET /agents/graph). Empty when it reports none. */
export function useSupervisors(): State {
  useEffect(() => {
    if (users++ === 0) {
      void pull();
      timer = setInterval(pull, 20000);
    }
    return () => {
      if (--users === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSup();
}
