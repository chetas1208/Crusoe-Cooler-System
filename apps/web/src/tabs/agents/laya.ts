import { useEffect, useState } from 'react';
import { authFetch } from '@loopkeeper/core/client';
import { activeTransport } from '@loopkeeper/core/store';

/** What the backend reports about the Laya triage classifier. Every figure shown in the UI comes from here. */
export interface LayaView {
  state: 'loading' | 'unavailable' | 'ready';
  engine: string | null;
  /** where the numbers come from, shown next to them */
  provenance: string | null;
  accuracy: number | null;
  abstentionRate: number | null;
  latencyP95Ms: number | null;
  queries: number | null;
}

const NONE: LayaView = { state: 'unavailable', engine: null, provenance: null, accuracy: null, abstentionRate: null, latencyP95Ms: null, queries: null };
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Tolerates both backend shapes: `laya.evaluation[engine]` (eval artifact) and flat runtime counters. */
export function parseLaya(raw: unknown): LayaView {
  const l = (raw as { laya?: Record<string, unknown> } | null)?.laya;
  if (!l || typeof l !== 'object') return NONE;
  const engine = typeof l.engine === 'string' ? l.engine : null;
  const ev = l.evaluation as Record<string, unknown> | undefined;
  const pick = ev && typeof ev === 'object' ? ((engine && (ev[engine] as Record<string, unknown>)) || (ev.laya_router as Record<string, unknown>) || null) : null;
  if (pick && num(pick.accuracy) !== null) {
    return { state: 'ready', engine, provenance: `eval artifact${typeof ev?.generated_at === 'string' ? ` ${String(ev.generated_at).slice(0, 10)}` : ''}`, accuracy: num(pick.accuracy), abstentionRate: num(pick.abstention_rate), latencyP95Ms: num(pick.latency_p95_ms), queries: null };
  }
  const q = num(l.queries);
  if (num(l.accuracy) !== null) {
    return { state: 'ready', engine, provenance: q !== null ? `runtime sample, ${q} queries` : 'runtime counters', accuracy: num(l.accuracy), abstentionRate: num(l.abstention_rate), latencyP95Ms: num(l.latency_p95_ms), queries: q };
  }
  return { ...NONE, engine, queries: q };
}

export function useLaya(): LayaView {
  const [v, setV] = useState<LayaView>({ ...NONE, state: 'loading' });
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const t = activeTransport();
      if (!t || t.info.kind !== 'live' || !t.info.url) {
        if (!stop) setV(NONE);
        return;
      }
      try {
        const r = await authFetch(`${t.info.url.replace(/\/$/, '')}/api/v1/providers/status`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(String(r.status));
        if (!stop) setV(parseLaya(await r.json()));
      } catch {
        if (!stop) setV(NONE);
      }
    };
    void tick();
    const id = setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  return v;
}
