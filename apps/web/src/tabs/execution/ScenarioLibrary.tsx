import React, { useState, useEffect } from 'react';
import { X, Layers, AlertOctagon, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react';
import { ScenarioCard, type ScenarioCardData } from './ScenarioCard';
import { useExecutionPanels } from './ExecutionPanelsStore';
import { useExec, resolveRunsApi } from './state';
import { ScenarioComposer } from './ScenarioComposer';

const FALLBACK_SCENARIOS: ScenarioCardData[] = [
  {
    scenario_id: 'CR-01',
    severity: 'SEVERE',
    label: 'CDU circulation collapse',
    learning_goal: 'Distinguish TCS circulation loss from thermal-only alarms and execute duty pump swap.',
    seed: 12001,
    duration_sim_s: 1800,
    required_assets: ['pump_t1', 'pump_t2', 'cdu_01'],
    required_robot_tools: ['pump kit', 'camera'],
    failure_injection_switches: ['pump_degradation'],
  },
  {
    scenario_id: 'CR-02',
    severity: 'SEVERE',
    label: 'Manifold rupture and aisle flood',
    learning_goal: 'Isolate ruptured manifold segment, clear floor hazard, and verify pressure recovery without unsafe entry.',
    seed: 12002,
    duration_sim_s: 1800,
    required_assets: ['p_hs_c', 'valve_zc'],
    required_robot_tools: ['pipe clamp', 'pressure kit'],
    failure_injection_switches: ['leak'],
  },
  {
    scenario_id: 'CR-03',
    severity: 'SEVERE',
    label: 'Heat rejection collapse',
    learning_goal: 'Separate FWS chiller boundary failure from TCS pressure loss and shed compute load.',
    seed: 12003,
    duration_sim_s: 1800,
    required_assets: ['chiller_01', 'cdu_01', 'pump_t1'],
    required_robot_tools: ['camera'],
    failure_injection_switches: ['set_chiller_setpoint'],
  },
  {
    scenario_id: 'CR-04',
    severity: 'SEVERE',
    label: 'Power and cooling double contingency',
    learning_goal: 'Constrain actions by available power, prioritize survivability, and coordinate compute load shedding.',
    seed: 12004,
    duration_sim_s: 1800,
    required_assets: ['pump_t1', 'pump_f1', 'rack_a1'],
    required_robot_tools: ['camera'],
    failure_injection_switches: ['trip_pump'],
  },
  {
    scenario_id: 'CR-05',
    severity: 'SEVERE',
    label: 'Electrical rack smoke/fire',
    learning_goal: 'Emergency containment with prohibited autonomous rack repair inside an energized/smoke hazard.',
    seed: 12005,
    duration_sim_s: 1800,
    required_assets: ['rack_a1'],
    required_robot_tools: ['camera'],
    failure_injection_switches: ['workload_spike'],
  },
  {
    scenario_id: 'CR-06',
    severity: 'SEVERE',
    label: 'Multi-row fouling and starvation',
    learning_goal: 'Localize common hydraulic restriction and verify flow recovery after cartridge exchange.',
    seed: 12006,
    duration_sim_s: 1800,
    required_assets: ['strainer_02', 'p_hs_b', 'p_hs_c', 'p_hs_d'],
    required_robot_tools: ['basket', 'brush', 'camera'],
    failure_injection_switches: ['strainer_blockage'],
  },
  {
    scenario_id: 'CR-07',
    severity: 'SEVERE',
    label: 'Stuck valve and misleading telemetry cascade',
    learning_goal: 'Prove the verifier rejects premature success from a biased sensor.',
    seed: 12007,
    duration_sim_s: 1800,
    required_assets: ['valve_a1', 'sn_flow_trunk', 'rack_a1'],
    required_robot_tools: ['valve actuator', 'calibration kit', 'camera'],
    failure_injection_switches: ['valve_stuck', 'sensor_drift'],
  },
  {
    scenario_id: 'MD-01',
    severity: 'MODERATE',
    label: 'Single-rack strainer restriction',
    learning_goal: 'Moderate service degradation with a safe, serviceable cartridge path.',
    seed: 22001,
    duration_sim_s: 1800,
    required_assets: ['strainer_02', 'rack_e5'],
    required_robot_tools: ['basket', 'camera'],
    failure_injection_switches: ['strainer_blockage'],
  },
  {
    scenario_id: 'MD-02',
    severity: 'MODERATE',
    label: 'Temperature-sensor drift',
    learning_goal: 'Classify a false positive without unnecessary repair.',
    seed: 22002,
    duration_sim_s: 1800,
    required_assets: ['sn_flow_trunk', 'rack_b1'],
    required_robot_tools: ['calibration kit', 'camera'],
    failure_injection_switches: ['sensor_drift'],
  },
];

export function ScenarioLibrary() {
  const [scenarios, setScenarios] = useState<ScenarioCardData[]>(FALLBACK_SCENARIOS);
  const [filter, setFilter] = useState<'ALL' | 'SEVERE' | 'MODERATE'>('ALL');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const setPanel = useExecutionPanels((s) => s.setPanel);
  const setActiveView = useExecutionPanels((s) => s.setActiveView);
  const say = useExec((s) => s.say);

  useEffect(() => {
    let unmounted = false;
    async function load() {
      try {
        const res = await fetch('/api/v1/scenarios');
        if (res.ok) {
          const json = await res.json();
          if (json.scenarios && Array.isArray(json.scenarios) && !unmounted) {
            setScenarios(json.scenarios);
          }
        }
      } catch (err) {
        // use fallback if backend is unreachable
      }
    }
    void load();
    return () => {
      unmounted = true;
    };
  }, []);

  const handleStart = async (scenarioId: string, speed: number) => {
    setLoadingId(scenarioId);
    say('info', `Generating 30:00 recorded episode for ${scenarioId} (${speed}× speed)...`);
    const sc = scenarios.find((s) => s.scenario_id === scenarioId);
    try {
      const res = await fetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: scenarioId,
          seed: sc?.seed || 12002,
          duration_sim_s: 1800,
          simulation_speed: speed,
          mode: 'LIVE',
          idempotency_key: `v8-exec-${scenarioId}-${Date.now()}`,
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        say('warning', `Failed to start episode: ${txt}`);
        setLoadingId(null);
        return;
      }

      const run = await res.json();
      say('ok', `Episode ${run.run_id} ready (30:00 horizon, outcome: ${run.meta?.verdict?.outcome || 'CONTAINED'}).`);
      useExec.getState().select(run.run_id);
      useExec.getState().setMode('replay');
      setActiveView('player');
      setPanel('scenarioLibrary', false);
      setPanel('runsPanel', true);
      setPanel('runInspector', true);
      setPanel('timelinePanel', true);
    } catch (e: any) {
      say('warning', `Episode launch error: ${e.message || String(e)}`);
    } finally {
      setLoadingId(null);
    }
  };

  const filtered = scenarios.filter((s) => {
    if (filter === 'SEVERE') return s.severity === 'SEVERE';
    if (filter === 'MODERATE') return s.severity === 'MODERATE';
    return true;
  });

  return (
    <div
      className="panel"
      style={{
        position: 'absolute',
        top: 48,
        left: 20,
        width: 'calc(100% - 40px)',
        maxWidth: 1200,
        maxHeight: 'calc(100vh - 120px)',
        background: 'rgba(11, 14, 20, 0.94)',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--line, #232936)',
        borderRadius: 10,
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--line, #232936)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(20, 24, 34, 0.7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Layers size={18} style={{ color: 'var(--nominal, #00e5ff)' }} />
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--t1, #f0f4f8)' }}>
              Scenario Library — 9 Physical Incidents
            </h3>
            <span style={{ fontSize: 11, color: 'var(--t3, #8a99ad)' }}>
              30:00 exact world horizon · Seven Catastrophic & Two Moderate cases · Governed repairs & counterfactuals
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--panel-2, #14171f)', padding: 2, borderRadius: 6 }}>
            {(['ALL', 'SEVERE', 'MODERATE'] as const).map((f) => (
              <button
                key={f}
                className="chip"
                data-active={filter === f}
                onClick={() => setFilter(f)}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  border: 'none',
                  background: filter === f ? 'var(--panel-3, #222a38)' : 'transparent',
                }}
              >
                {f === 'ALL' ? 'All (9)' : f === 'SEVERE' ? 'Severe (7)' : 'Moderate (2)'}
              </button>
            ))}
          </div>

          <button
            className="btn btn--icon"
            onClick={() => setPanel('scenarioLibrary', false)}
            title="Close Library (Esc)"
            style={{ width: 30, height: 30, padding: 0 }}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div style={{ padding: '14px 18px 0 18px' }}>
        <ScenarioComposer
          compact
          onCompleted={() => {
            setPanel('scenarioLibrary', false);
            setPanel('runsPanel', true);
            setPanel('runInspector', true);
            setPanel('timelinePanel', true);
          }}
        />
      </div>

      <div
        style={{
          padding: 18,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: 16,
        }}
      >
        {filtered.map((sc) => (
          <ScenarioCard
            key={sc.scenario_id}
            data={sc}
            onStart={handleStart}
            loading={loadingId === sc.scenario_id}
          />
        ))}
      </div>
    </div>
  );
}
