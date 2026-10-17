/** FIXTURE: payloads shaped like the real /incidents/{id}/contract and /team responses, for unit tests and the `?e2e` screenshot hook only. */
export const fixtureContract = {
  run_id: 'run_fixture',
  incident_id: 'INC-1',
  contract: {
    id: 'FIXTURE-dod_INC-1', incident_id: 'INC-1', version: 2, state: 'EVALUATING', terminal_state: null, goal: 'FIXTURE goal', frozen_tick: 120,
    revisions: [{ version: 2, reason: 'FIXTURE: added rack margin hold after verifier review', tick: 300 }],
    checks: [
      { id: 'c1', label: 'Rack A3 thermal margin above 8 K', unit: 'K', direction: 'min', threshold: 8, hold_sim_s: 120, subject: ['rack_a3'] },
      { id: 'c2', label: 'TCS flow restored', unit: 'kg/s', direction: 'min', threshold: 3.0, hold_sim_s: 60, subject: ['p_hs_c'] },
      { id: 'c3', label: 'Pump vibration below limit', unit: 'mm/s', direction: 'max', threshold: 4.5, hold_sim_s: 30, subject: ['pump_t1'] },
    ],
    evaluation: { checks: { c1: { status: 'passing', measured: 9.4, held_s: 45 }, c2: { status: 'failing', measured: 2.1, held_s: 0 }, c3: { status: 'passing', measured: null, held_s: 0 } } },
  },
};
export const fixtureTeam = {
  run_id: 'run_fixture', incident_id: 'INC-1',
  seats: [{ seat: 'SEN-01', function: 'goal architect / planner', tasks: ['t1'] }, { seat: 'SEN-02', function: 'INPIPE coordinator', tasks: ['t2'] }, { seat: 'SEN-03', function: 'OUTRIG coordinator', tasks: [] }, { seat: 'SEN-04', function: 'safety arbiter', tasks: [] }, { seat: 'SEN-05', function: 'independent verifier', tasks: [] }],
  tasks: [
    { id: 't1', seat: 'SEN-01', role: 'sentinel', kind: 'plan', title: 'FIXTURE: restore TCS flow', status: 'running', parent_id: null, depth: 0, robot_id: null, model: { provider: 'crusoe', model_id: 'fixture', fallback: false, latency_ms: 840 }, tool_calls: 3 },
    { id: 't2', seat: 'SEN-02', role: 'inpipe', kind: 'robot', title: 'FIXTURE: inspect P-hs_c bore', status: 'blocked', parent_id: 't1', depth: 1, robot_id: 'IR-03', model: { fallback: true }, tool_calls: 9 },
  ],
  edges: [{ from: 't1', to: 't2' }],
  budgets: { limits: { max_depth: 3, max_active_llm_subtasks_per_incident: 6, max_plan_revisions: 2 }, max_depth_seen: 1, llm_tasks: 1, tasks: 2, plan_revisions: 1, attempts: 2, contract_version: 2 },
  warnings: [{ seq: 9, type: 'loop.detected', task_id: 't2', message: 'same inspection requested 3 times' }, { seq: 12, type: 'drift.detected', message: 'plan diverged from the frozen goal' }],
};
