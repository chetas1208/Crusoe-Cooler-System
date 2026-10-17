import { X } from 'lucide-react';
import { STEPS, usePromptRequest } from './promptStore';
import './mission.css';

const ms = (v?: number | null) => (v === undefined || v === null ? null : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** Real request chain from the V9 scenario-request API. Hideable (the Execution toggle chip) and it never touches the simulation. */
export function PromptStatusStrip() {
  const s = usePromptRequest();
  if (!s.startedAt) return null;
  return (
    <section className="pm-strip" aria-label="Prompt status" role="group">
      <ol className="pm-steps">
        {STEPS.map((st, i) => {
          const x = s.steps[i];
          return (
            <li key={st.id} data-state={x.state} aria-current={x.state === 'active' ? 'step' : undefined}>
              <i aria-hidden />
              <span>{st.label}</span>
              {x.atMs !== null && <em className="mono">{ms(x.atMs)}</em>}
            </li>
          );
        })}
      </ol>
      <div className="pm-meta mono">
        {s.requestId && <span>{s.requestId}</span>}
        {s.latencies?.laya_ms !== undefined && <span>laya {ms(s.latencies.laya_ms)}</span>}
        {s.latencies?.crusoe_ms !== undefined && <span>crusoe {ms(s.latencies.crusoe_ms)}</span>}
        {s.latencies?.total_pipeline_ms !== undefined && <span>pipeline {ms(s.latencies.total_pipeline_ms)}</span>}
        {s.engine?.laya && <span>{s.engine.laya}</span>}
        {s.engine?.crusoe && <span>{s.engine.crusoe}</span>}
        {s.runId && <span>run {s.runId}</span>}
      </div>
      {s.live && (
        <div className="pm-live">
          <span className="mono">live run {s.live.runId ?? s.runId ?? '?'}</span>
          {s.live.injections.map((i, k) => (
            <span key={k} className="mono" data-bad={!i.accepted || undefined}>{i.accepted ? 'injected' : 'refused'} {i.kind} → {i.target}{i.reason ? ` (${i.reason})` : ''}</span>
          ))}
          {s.live.rejected.map((r, k) => <span key={'r' + k} className="mono" data-bad>not injected: {r.family}: {r.reason}</span>)}
          {s.live.unsupported.length > 0 && <span className="mono" data-bad>unsupported: {s.live.unsupported.join(', ')}</span>}
          <span className="mono">{s.live.incidentIds.length ? `incident: ${s.live.incidentIds.join(', ')}` : s.status === 'READY' ? 'incident: pending' : ''}</span>
        </div>
      )}
      {s.error && (
        <p className="pm-err" role="alert">
          Failed at {s.error.at.replace('_', ' ')}: {s.error.message}
          {s.error.code ? ` (${s.error.code})` : ''}
        </p>
      )}
      <button type="button" className="pm-x" onClick={() => usePromptRequest.getState().dismiss()} aria-label="Dismiss prompt status">
        <X size={13} aria-hidden />
      </button>
    </section>
  );
}
