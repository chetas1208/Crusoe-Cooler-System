import React from 'react';
import { Play, Zap, Shield, AlertTriangle, CheckCircle2, Wrench } from 'lucide-react';

export interface ScenarioCardData {
  scenario_id: string;
  severity: 'SEVERE' | 'MODERATE';
  label: string;
  learning_goal: string;
  seed: number;
  duration_sim_s: number;
  required_assets: string[];
  required_robot_tools: string[];
  failure_injection_switches: string[];
  readiness?: {
    status: string;
    ready: boolean;
    unsupported_faults?: any[];
  };
}

interface ScenarioCardProps {
  data: ScenarioCardData;
  onStart(scenarioId: string, speed: number): void;
  loading?: boolean;
}

export function ScenarioCard({ data, onStart, loading }: ScenarioCardProps) {
  const isSevere = data.severity === 'SEVERE';
  const ready = data.readiness?.ready ?? true;

  return (
    <div
      className="ex-card"
      style={{
        background: 'var(--panel-2, #14171f)',
        border: '1px solid var(--line, #232936)',
        borderRadius: 8,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        position: 'relative',
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span
            className="mono"
            style={{
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: 0.5,
              color: isSevere ? '#ff5252' : '#ffb300',
              background: isSevere ? 'rgba(255,82,82,0.12)' : 'rgba(255,179,0,0.12)',
              padding: '2px 8px',
              borderRadius: 4,
              border: `1px solid ${isSevere ? 'rgba(255,82,82,0.3)' : 'rgba(255,179,0,0.3)'}`,
            }}
          >
            {data.scenario_id}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: isSevere ? '#ff5252' : '#ffb300',
            }}
          >
            {data.severity}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span
            className="chip tone-nominal"
            style={{
              fontSize: 10,
              padding: '1px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: '#00e5ff',
              background: 'rgba(0,229,255,0.1)',
              borderColor: 'rgba(0,229,255,0.3)',
            }}
          >
            <CheckCircle2 size={10} />
            {data.readiness?.status || 'READY'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--t3, #8a99ad)' }}>30:00</span>
        </div>
      </div>

      <div>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--t1, #f0f4f8)' }}>
          {data.label}
        </h4>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: 12,
            lineHeight: 1.45,
            color: 'var(--t2, #b0c0d4)',
          }}
        >
          {data.learning_goal}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
        <div style={{ display: 'flex', gap: 6, color: 'var(--t3, #8a99ad)' }}>
          <span style={{ minWidth: 64 }}>Assets:</span>
          <span className="mono" style={{ color: 'var(--t2, #b0c0d4)' }}>
            {data.required_assets.join(', ')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, color: 'var(--t3, #8a99ad)' }}>
          <span style={{ minWidth: 64 }}>Robot tools:</span>
          <span style={{ color: 'var(--t2, #b0c0d4)' }}>
            {data.required_robot_tools.join(', ')}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 8, display: 'flex', gap: 8 }}>
        <button
          className="btn btn--primary"
          disabled={loading || !ready}
          onClick={() => onStart(data.scenario_id, 1)}
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            padding: '6px 12px',
          }}
        >
          <Play size={13} />
          {loading ? 'Recording...' : 'Start Episode'}
        </button>
        <button
          className="btn"
          disabled={loading || !ready}
          title="Fast recorded generation (3× pace)"
          onClick={() => onStart(data.scenario_id, 3)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            padding: '6px 10px',
          }}
        >
          <Zap size={13} />
          3×
        </button>
      </div>
    </div>
  );
}
