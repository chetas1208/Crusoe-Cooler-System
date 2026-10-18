import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, ArrowRight, CheckCircle2, Clock, Cpu, AlertTriangle, ShieldCheck, RefreshCw, XCircle } from 'lucide-react';
import { useExec } from './state';
import { apiFetch } from './api';
import { usePromptRequest } from '../../features/mission/promptStore';
import { useUi } from '../../ui/store';

export const CHIP_PRESETS = [
  {
    label: 'Middle racks overheating',
    prompt: 'Something is wrong with the water near the middle racks, maybe overheating. Handle it.',
  },
  {
    label: 'Back racks cooling & blocked pipe',
    prompt: 'The cooling near the back racks seems to be dying and one pipe is probably blocked. Fix it.',
  },
  {
    label: 'CDU pump pressure drop',
    prompt: 'CDU secondary pump pressure is dropping rapidly and Row A temperatures are spiking. Check it out.',
  },
  {
    label: 'Central manifold coolant leak',
    prompt: 'Potential chemical or coolant leak spotted near central manifold valve. Isolate immediately.',
  },
];

interface ScenarioComposerProps {
  onCompleted?: (runId: string) => void;
  compact?: boolean;
}

interface InterpretationData {
  laya?: {
    result?: {
      incident_family?: string;
      urgency?: string;
      confidence?: number;
      latency_ms?: number;
      checkpoint?: string;
      engine?: string;
    };
  };
  crusoe?: {
    proposal?: {
      summary?: string;
      assumptions?: string[];
    };
    model?: string;
  };
  compiler?: {
    resolved_assets?: string[];
    definition_of_done?: string[];
    validation_report?: {
      valid?: boolean;
      readiness?: string;
    };
  };
  latencies_ms?: {
    laya_ms?: number;
    crusoe_ms?: number;
    total_pipeline_ms?: number;
  };
}

const PHASES = [
  { id: 'RECEIVED', label: 'Received' },
  { id: 'CLASSIFYING', label: 'Classifying (Laya)' },
  { id: 'INTERPRETING', label: 'Interpreting (Crusoe)' },
  { id: 'VALIDATING', label: 'Compiling Safe Scenario' },
  { id: 'CREATING_RUN', label: 'Creating 30-min Run' },
  { id: 'RUNNING', label: 'Running Physics & Robots' },
];

export function ScenarioComposer({ onCompleted, compact = false }: ScenarioComposerProps) {
  const [prompt, setPrompt] = useState('Something is wrong with the water near the middle racks, maybe overheating. Handle it.');
  const [loading, setLoading] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<InterpretationData | null>(null);

  const pollTimerRef = useRef<any>(null);

  const handleSubmit = async (overridePrompt?: string) => {
    const textToSubmit = (overridePrompt ?? prompt).trim();
    if (!textToSubmit || loading) return;

    setLoading(true);
    setError(null);
    setPhase('RECEIVED');
    setStatus('QUEUED');
    setRequestId(null);
    setRunId(null);
    setInterpretation(null);

    usePromptRequest.getState().begin(textToSubmit);
    try {
      const res = await apiFetch('/scenario-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: textToSubmit,
          requested_duration_seconds: 1800,
          requested_speed: 1,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      usePromptRequest.getState().update(data);
      setRequestId(data.request_id);
      setPhase(data.phase ?? 'RECEIVED');
      setStatus(data.status ?? 'QUEUED');
    } catch (err: any) {
      setError(err.message || 'Failed to submit scenario request');
      usePromptRequest.getState().fail('submit', err.message || 'Failed to submit scenario request');
      setLoading(false);
    }
  };

  // Poll request status until READY or FAILED
  // the final latency / incident fields are written after the request flips to READY: look once more shortly after
  useEffect(() => {
    if (!requestId || status !== 'READY') return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/scenario-requests/${requestId}`);
        if (!res.ok) return;
        const data = await res.json();
        usePromptRequest.getState().update(data);
        if (data.interpretation) setInterpretation(data.interpretation);
      } catch {
        /* the strip keeps what it has */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [requestId, status]);

  useEffect(() => {
    if (!requestId || status === 'READY' || status === 'FAILED' || status === 'REJECTED' || status === 'CANCELED') {
      return;
    }

    const poll = async () => {
      try {
        const res = await apiFetch(`/scenario-requests/${requestId}`);
        if (!res.ok) return;

        const data = await res.json();
        usePromptRequest.getState().update(data);
        setPhase(data.phase);
        setStatus(data.status);
        if (data.interpretation) {
          setInterpretation(data.interpretation);
        }
        if (data.run_id) {
          setRunId(data.run_id);
        }

        if (data.status === 'READY' && data.run_id) {
          setLoading(false);
          useExec.getState().select(data.run_id);
          onCompleted?.(data.run_id);
        } else if (data.status === 'FAILED' || data.status === 'REJECTED' || data.status === 'CANCELED') {
          // REJECTED = refused by the backend (unsupported fault, rate limit, quota): its reason, verbatim, and stop polling
          setLoading(false);
          setError(`${data.status}${data.error_code ? ` (${data.error_code})` : ''}: ${data.error_message || 'no message from the backend'}`);
        }
      } catch (e) {
        // network retry
      }
    };

    pollTimerRef.current = setInterval(poll, 700);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [requestId, status, onCompleted]);

  const currentPhaseIndex = PHASES.findIndex((p) => p.id === phase);

  return (
    <div
      className="scenario-composer panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 10 : 14,
        padding: compact ? 12 : 18,
        background: 'rgba(10, 16, 26, 0.95)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(0, 229, 255, 0.25)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6), 0 0 16px rgba(0, 229, 255, 0.1)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="#00e5ff" />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', color: '#e0f2fe' }}>
            NATURAL-LANGUAGE CRISIS LAUNCHER (V9)
          </span>
        </div>
        <span style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.04em' }}>
          Crusoe Nemotron · Laya Router · Autonomous Physics
        </span>
      </div>

      {/* Input Composer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={loading}
            placeholder="Describe an incident in natural language (e.g. 'The cooling near the back racks seems to be dying...')"
            rows={compact ? 2 : 3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 6,
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.45,
              color: '#f8fafc',
              resize: 'none',
              fontFamily: 'inherit',
              outline: 'none',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>

        {/* Quick-tap colloquial chip presets */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CHIP_PRESETS.map((chip, idx) => (
            <button
              key={idx}
              className="chip"
              disabled={loading}
              onClick={() => {
                setPrompt(chip.prompt);
                handleSubmit(chip.prompt);
              }}
              style={{
                fontSize: 10,
                padding: '3px 8px',
                background: prompt === chip.prompt ? 'rgba(0, 229, 255, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                border: prompt === chip.prompt ? '1px solid #00e5ff' : '1px solid rgba(255, 255, 255, 0.08)',
                color: prompt === chip.prompt ? '#67e8f9' : 'var(--t2)',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
              title={chip.prompt}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* Submit Button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            className="btn btn--primary"
            disabled={loading || !prompt.trim()}
            onClick={() => handleSubmit()}
            style={{
              fontSize: 12,
              padding: '6px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: loading ? '#0369a1' : 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
              border: '1px solid #38bdf8',
              boxShadow: '0 0 12px rgba(2, 132, 199, 0.4)',
            }}
          >
            {loading ? (
              <>
                <RefreshCw size={13} className="spin" />
                <span>Compiling & Launching...</span>
              </>
            ) : (
              <>
                <Sparkles size={13} />
                <span>Run Simulation (30:00)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '8px 12px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid #ef4444',
            borderRadius: 6,
            color: '#fca5a5',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <AlertTriangle size={14} color="#ef4444" />
          <span>{error}</span>
        </div>
      )}

      {/* Step-by-Step Progress Lifecycle */}
      {(loading || status === 'READY') && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '10px 12px',
            background: 'rgba(15, 23, 42, 0.7)',
            borderRadius: 6,
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Pipeline Lifecycle · {requestId ?? 'Starting...'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
            {PHASES.map((p, idx) => {
              const isPast = status === 'READY' || (currentPhaseIndex >= 0 && idx < currentPhaseIndex);
              const isCurrent = status !== 'READY' && idx === currentPhaseIndex;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 4px',
                    borderRadius: 4,
                    background: isCurrent ? 'rgba(0, 229, 255, 0.15)' : isPast ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                    border: isCurrent ? '1px solid #00e5ff' : isPast ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255, 255, 255, 0.04)',
                    textAlign: 'center',
                  }}
                >
                  {isPast ? (
                    <CheckCircle2 size={12} color="#22c55e" />
                  ) : isCurrent ? (
                    <RefreshCw size={12} color="#00e5ff" className="spin" />
                  ) : (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.2)' }} />
                  )}
                  <span style={{ fontSize: 9, fontWeight: isCurrent ? 700 : 500, color: isCurrent ? '#67e8f9' : isPast ? '#4ade80' : 'var(--t3)' }}>
                    {p.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Model Interpretations & Definition of Done Drawer */}
          {interpretation && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginTop: 4,
                padding: '8px 10px',
                background: 'rgba(10, 14, 22, 0.8)',
                borderRadius: 4,
                border: '1px solid rgba(0, 229, 255, 0.15)',
                fontSize: 11,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#38bdf8' }}>
                  Derived Crisis Scenario: {interpretation.crusoe?.proposal?.summary ?? 'Localized Anomaly'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--t3)' }}>
                  Total: {interpretation.latencies_ms?.total_pipeline_ms !== undefined ? `${interpretation.latencies_ms.total_pipeline_ms} ms` : 'not reported yet'}
                </span>
              </div>

              {/* Laya & Crusoe Badges */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {interpretation.laya?.result && (
                  <span className="badge" style={{ fontSize: 10, background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid #10b981' }}>
                    Laya: {interpretation.laya.result.incident_family} (conf {(interpretation.laya.result.confidence ?? 0).toFixed(2)}, {Math.round(interpretation.laya.result.latency_ms ?? 0)}ms)
                  </span>
                )}
                {interpretation.crusoe && (
                  <span className="badge" style={{ fontSize: 10, background: 'rgba(14, 165, 233, 0.15)', color: '#38bdf8', border: '1px solid #0284c7' }}>
                    Crusoe: {interpretation.crusoe.model}
                  </span>
                )}
                {interpretation.compiler?.resolved_assets && (
                  <span className="badge" style={{ fontSize: 10, background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: '1px solid #ca8a04' }}>
                    Target: {interpretation.compiler.resolved_assets.join(', ')}
                  </span>
                )}
              </div>

              {/* Definition of Done Invariants */}
              {interpretation.compiler?.definition_of_done && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t2)', marginBottom: 2 }}>
                    MEASURABLE DEFINITION OF DONE:
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--t2)', fontSize: 10 }}>
                    {interpretation.compiler.definition_of_done.map((dod, i) => (
                      <li key={i}>{dod}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {status === 'READY' && runId && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid #22c55e',
                borderRadius: 4,
                color: '#4ade80',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              <span>Simulation Ready: {runId} (30:00 simulated)</span>
              <button
                className="btn btn--sm btn--primary"
                onClick={() => {
                  useUi.getState().setTab('execution');
                  useExec.getState().select(runId);
                }}
                style={{ fontSize: 10, padding: '2px 8px' }}
              >
                Inspect in Execution →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
