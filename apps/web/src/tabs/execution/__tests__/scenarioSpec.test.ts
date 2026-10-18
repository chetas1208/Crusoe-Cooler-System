import { describe, expect, it } from 'vitest';
import {
  buildSpec,
  chainOf,
  classify,
  compareToSpec,
  directChainOf,
  hazardSpec,
  newIncidents,
  parseDefinitions,
  parseRequest,
  parseTopology,
  parseValidation,
  promptFor,
  resolveTarget,
  toWireSpec,
  verdictOf,
  type Definition,
} from '../scenarioSpec';

const wire = (over: Record<string, unknown> = {}) => ({
  scenario_id: 'CR-07',
  version: 'v8.0',
  severity: 'SEVERE',
  label: 'Stuck valve and misleading telemetry cascade',
  learning_goal: 'goal',
  seed: 12007,
  duration_sim_s: 1800,
  required_assets: ['valve_a1', 'sn_flow_trunk'],
  required_robot_tools: ['camera'],
  fault_injections: [
    { operator: 'valve_stuck', asset_id: 'valve_a1', tick: 240, params: { opening: 0.12 }, capability: 'real' },
    { operator: 'sensor_drift', asset_id: 'sn_flow_trunk', tick: 260, params: { rate: 0.01, cap: 0.55 }, capability: 'real' },
  ],
  readiness: { status: 'READY', ready: true, missing_assets: [], unsupported_faults: [], notes: [] },
  ...over,
});
const topo = parseTopology({
  assets: [
    { id: 'valve_a1', type: 'valve', label: 'V-A1', zone_id: 'zone_a', loop: 'tcs' },
    { id: 'sn_flow_trunk', type: 'sensor' },
    { id: 'pump_t1', type: 'pump' },
  ],
  edges: [{ id: 'p_hs_c', zone_id: 'zone_c', loop: 'tcs' }],
});
const def = (over: Record<string, unknown> = {}): Definition => parseDefinitions({ scenarios: [wire(over)] })[0];

describe('catalog parsing', () => {
  it('keeps what the backend sent and drops malformed entries instead of inventing them', () => {
    const d = parseDefinitions({ scenarios: [wire(), { nope: 1 }, null, { scenario_id: 'X' }] });
    expect(d.map((x) => x.scenario_id)).toEqual(['CR-07']);
    expect(d[0].fault_injections).toHaveLength(2);
    expect(parseDefinitions({})).toEqual([]);
    expect(parseDefinitions('garbage')).toEqual([]);
  });
  it('reads a capability the backend adds later without a code change', () => {
    const d = def({ fault_injections: [{ operator: 'facility_heat_rejection_loss', asset_id: 'chiller_01', tick: 240, params: {}, capability: 'proxy' }] });
    expect(d.fault_injections[0]).toMatchObject({ operator: 'facility_heat_rejection_loss', capability: 'proxy' });
  });
});

describe('typed spec', () => {
  it('resolves targets from the topology (assets and pipes) and flags unknown ones', () => {
    expect(resolveTarget('valve_a1', topo)).toMatchObject({ found: true, type: 'valve', zone: 'zone_a', loop: 'tcs' });
    expect(resolveTarget('p_hs_c', topo)).toMatchObject({ found: true, type: 'pipe', zone: 'zone_c' });
    expect(resolveTarget('rack_zz', topo).found).toBe(false);
    expect(resolveTarget('valve_a1', null).found).toBe(false);
  });
  it('builds faults from the registry, with the severity word mapped to its number and progression from params', () => {
    const s = buildSpec(def(), topo);
    expect(s.faults.map((f) => [f.kind, f.target_id, f.onset_tick, f.severity])).toEqual([
      ['valve_stuck', 'valve_a1', 240, 0.75],
      ['sensor_drift', 'sn_flow_trunk', 260, 0.75],
    ]);
    expect(buildSpec(def({ severity: 'MODERATE' }), topo).faults[0].severity).toBe(0.5);
    const w = toWireSpec(s);
    expect(Object.keys(w.faults[0]).sort()).toEqual(['kind', 'onset_tick', 'progression_s', 'severity', 'target_id']);
    expect(w.seed).toBe(12007);
  });
});

describe('classification', () => {
  it('is live-capable when the backend declares it ready and the targets resolve', () => {
    expect(classify(def(), topo, null).state).toBe('live');
  });
  it('is unsupported, with the reasons verbatim, for blocked readiness, missing assets, unsupported faults and validator errors', () => {
    const blocked = classify(def({ readiness: { status: 'NOT_IMPLEMENTED', ready: false, missing_assets: ['valve_a1'], unsupported_faults: [], notes: [] } }), topo, null);
    expect(blocked.state).toBe('unsupported');
    expect(blocked.reasons).toContain('Backend readiness: NOT_IMPLEMENTED');
    expect(blocked.reasons).toContain('Asset valve_a1 is not in the backend topology');
    const noTopo = classify(def({ required_assets: ['ghost_1'] }), topo, null);
    expect(noTopo.reasons).toContain('Asset ghost_1 is not in the backend topology');
    const uns = classify(def({ fault_injections: [{ operator: 'leak', asset_id: 'p_hs_c', tick: 1, params: {}, capability: 'unsupported' }] }), topo, null);
    expect(uns.state).toBe('unsupported');
    const v = parseValidation({ valid: false, issues: [{ path: 'faults.0.kind', severity: 'error', message: "Input should be 'fouling'" }], support: [] });
    const val = classify(def(), topo, v);
    expect(val.state).toBe('unsupported');
    expect(val.reasons.join(' ')).toContain("Backend validator (faults.0.kind): Input should be 'fouling'");
  });
  it('is partially modelled for proxy faults and for fields the validator says are not applied', () => {
    const p = classify(def({ fault_injections: [{ operator: 'workload_spike', asset_id: 'valve_a1', tick: 1, params: {}, capability: 'proxy' }] }), topo, null);
    expect(p.state).toBe('partial');
    expect(p.simulated[0]).toContain('workload_spike on valve_a1 is a proxy fault');
    const v = parseValidation({ valid: true, issues: [], support: [{ path: 'seed', applied: false, note: 'live run keeps its own stream' }] });
    const q = classify(def(), topo, v);
    expect(q.state).toBe('partial');
    expect(q.simulated).toContain('seed: live run keeps its own stream');
  });
  it('lets the live plan have the last word, and keeps a refused scenario retryable', () => {
    const refused = { scenarioId: 'CR-07', at: 1, status: 'refused' as const, code: 'UNSUPPORTED_FAULT', message: 'leak: not supported', injected: 0, planned: 0, detail: [] };
    const s = classify(def(), topo, null, refused);
    expect(s.state).toBe('unsupported');
    expect(s.label).toBe('Last launch refused');
    expect(s.reasons[0]).toBe('UNSUPPORTED_FAULT: leak: not supported');
    expect(classify(def(), topo, null, { ...refused, status: 'injected', injected: 2, planned: 2 }).label).toBe('Live (confirmed)');
  });
});

describe('request text', () => {
  it('names every fault, target and severity from the spec and nothing else', () => {
    const t = promptFor(buildSpec(def(), topo));
    expect(t).toContain('CR-07');
    expect(t).toContain('valve_stuck');
    expect(t).toContain('valve_a1');
    expect(t).toContain('sensor_drift');
    expect(t).toContain('sn_flow_trunk');
    expect(t).toContain('severe');
    expect(t.length).toBeLessThan(1900);
  });
});

const ready = {
  request_id: 'req_1',
  status: 'READY',
  phase: 'RUNNING',
  run_id: 'run_live',
  live: {
    run_id: 'run_live',
    supported_kinds: ['valve_stuck'],
    planned: [{ kind: 'valve_stuck', target: 'valve_a1', severity: 'severe', note: '' }],
    injections: [
      { kind: 'valve_stuck', target: 'valve_a1', accepted: true, command_id: 'c0', reason: null },
      { kind: 'sensor_drift', target: 'sn_flow_trunk', accepted: false, reason: 'rate cap' },
    ],
    rejected: [{ family: 'x', query: null, code: 'REQUEST_CAP', reason: 'more than 3' }],
    unsupported: [{ family: 'leak', reason: 'not supported by the plant' }],
    incident_ids: [],
  },
  interpretation: { laya: { engine: 'rule_fallback' }, crusoe: { model: 'nemotron' }, latencies_ms: { total_pipeline_ms: 12 }, compiler: { assumptions: ['a'] } },
};

describe('backend answer', () => {
  it('reads injections, rejections and structured unsupported reasons (never "[object Object]")', () => {
    const v = parseRequest(ready)!;
    expect(v.injections).toHaveLength(2);
    expect(v.unsupported).toEqual([{ family: 'leak', reason: 'not supported by the plant' }]);
    expect(v.rejected[0]).toMatchObject({ code: 'REQUEST_CAP' });
    expect(v.supportedKinds).toEqual(['valve_stuck']);
    expect(parseRequest({ live: { unsupported: ['plain string'] }, request_id: 'r' })!.unsupported[0].reason).toBe('plain string');
    expect(parseRequest({})).toBeNull();
  });
  it('derives a stored verdict only from a terminal request', () => {
    expect(verdictOf('CR-07', parseRequest({ ...ready, status: 'PROCESSING', phase: 'INTERPRETING' })!)).toBeNull();
    const partial = verdictOf('CR-07', parseRequest(ready)!)!;
    expect(partial.status).toBe('partial');
    expect(partial.injected).toBe(1);
    expect(partial.detail.join('|')).toContain('leak: not supported by the plant');
    expect(partial.detail.join('|')).toContain('sensor_drift@sn_flow_trunk: rate cap');
    const rej = verdictOf('CR-02', parseRequest({ request_id: 'r', status: 'REJECTED', phase: 'REJECTED', error_code: 'RATE_LIMITED', error_message: 'retry in 7s' })!)!;
    expect(rej).toMatchObject({ status: 'refused', code: 'RATE_LIMITED', message: 'retry in 7s' });
    const clean = verdictOf('CR-07', parseRequest({ ...ready, live: { ...ready.live, rejected: [], unsupported: [], injections: [{ kind: 'valve_stuck', target: 'valve_a1', accepted: true }] } })!)!;
    expect(clean.status).toBe('injected');
  });
  it('is only "injected" when every typed fault was accepted on its target and nothing else was injected', () => {
    const spec = buildSpec(def(), topo); // valve_a1 + sn_flow_trunk
    const both = parseRequest({ ...ready, live: { ...ready.live, rejected: [], unsupported: [], injections: [{ kind: 'valve_stuck', target: 'valve_a1', accepted: true }, { kind: 'sensor_drift', target: 'sn_flow_trunk', accepted: true }] } })!;
    expect(verdictOf('CR-07', both, spec)!.status).toBe('injected');
    // the model-backed planner dropped the valve and added a pipe fault: this must not read as a confirmed launch
    const drifted = parseRequest({ ...ready, live: { ...ready.live, rejected: [], unsupported: [], injections: [{ kind: 'sensor_drift', target: 'sn_flow_trunk', accepted: true }, { kind: 'fouling', target: 'p_hs_a', accepted: true }] } })!;
    const v = verdictOf('CR-07', drifted, spec)!;
    expect(v.status).toBe('partial');
    expect(v.detail).toContain('spec fault valve_stuck on valve_a1 was not injected');
    expect(v.detail).toContain('the backend also injected fouling on p_hs_a, which is not in the spec');
    expect(classify(def(), topo, null, v).label).toBe('Partially injected');
  });
  it('matches spec faults to injections by target and reports extras', () => {
    const spec = buildSpec(def(), topo);
    const c = compareToSpec(spec, parseRequest({ ...ready, live: { ...ready.live, injections: [ready.live.injections[0], { kind: 'workload_spike', target: 'rack_a1', accepted: true }] } })!);
    expect(c.matches[0].injection?.target).toBe('valve_a1');
    expect(c.matches[1].injection).toBeNull();
    expect(c.extra.map((x) => x.target)).toEqual(['rack_a1']);
  });
});

describe('phase chain', () => {
  const states = (v: ReturnType<typeof parseRequest>, sub = false) => chainOf(v, sub).map((s) => s.state);
  it('shows the first step working while the POST is in flight, and nothing before', () => {
    expect(states(null)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(states(null, true)[0]).toBe('active');
  });
  it('follows the backend phase', () => {
    expect(states(parseRequest({ request_id: 'r', status: 'PROCESSING', phase: 'INTERPRETING' }))).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending']);
    expect(states(parseRequest({ request_id: 'r', status: 'PROCESSING', phase: 'CREATING_RUN' }))).toEqual(['done', 'done', 'done', 'done', 'active', 'pending']);
  });
  it('READY without an incident waits honestly; with one it is done and names it', () => {
    expect(states(parseRequest(ready))).toEqual(['done', 'done', 'done', 'done', 'done', 'active']);
    const withInc = chainOf(parseRequest({ ...ready, live: { ...ready.live, incident_ids: ['inc_7'] } }));
    expect(withInc[5]).toMatchObject({ state: 'done', note: 'inc_7' });
  });
  it('marks where a rejected request stopped, with the backend message', () => {
    const unsup = chainOf(parseRequest({ request_id: 'r', status: 'REJECTED', phase: 'REJECTED', error_code: 'UNSUPPORTED_FAULT', error_message: 'leak: no', live: { unsupported: [{ family: 'leak', reason: 'no' }] } }));
    expect(unsup.map((s) => s.state)).toEqual(['done', 'done', 'done', 'failed', 'pending', 'pending']);
    expect(unsup[3].note).toBe('UNSUPPORTED_FAULT: leak: no');
    const rate = chainOf(parseRequest({ request_id: 'r', status: 'REJECTED', phase: 'REJECTED', error_code: 'RATE_LIMITED', error_message: 'retry in 3s' }));
    expect(rate.map((s) => s.state)).toEqual(['failed', 'pending', 'pending', 'pending', 'pending', 'pending']);
    const cap = chainOf(parseRequest({ request_id: 'r', status: 'REJECTED', phase: 'REJECTED', error_code: 'RATE_LIMITED', error_message: 'per-run cap', live: { planned: [{ kind: 'valve_stuck', target: 'valve_a1' }] } }));
    expect(cap.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'failed', 'pending']);
  });
});

const cr02 = () => parseDefinitions({ scenarios: [wire({ scenario_id: 'CR-02', label: 'Manifold rupture', fault_injections: [{ operator: 'leak', asset_id: 'p_hs_c', tick: 240, params: { orifice_m2: 2.8e-5 }, capability: 'real' }], required_assets: ['p_hs_c'] })] })[0];

describe('hazard kinds', () => {
  it('maps CR-02 to manifold_leak on the registry target with the registry orifice, and says containment is not repair', () => {
    const h = hazardSpec(cr02(), topo)!;
    expect(h.mode).toBe('hazard');
    expect(h.faults[0]).toMatchObject({ kind: 'manifold_leak', target_id: 'p_hs_c', params: { orifice_m2: 2.8e-5 } });
    expect(h.outcome).toContain('CONTAINED_NOT_REPAIRED');
    expect(toWireSpec(h).faults[0].kind).toBe('manifold_leak');
  });
  it('maps CR-04 to power_failure on feed_a and CR-05 to rack_thermal_runaway; scenarios without a hazard kind have none', () => {
    const d = (id: string, asset: string) => parseDefinitions({ scenarios: [wire({ scenario_id: id, fault_injections: [{ operator: 'x', asset_id: asset, tick: 1, params: {}, capability: 'real' }] })] })[0];
    const p = hazardSpec(d('CR-04', 'pump_t1'), topo)!;
    expect(p.faults[0]).toMatchObject({ kind: 'power_failure', target_id: 'feed_a' });
    expect(p.faults[0].resolved.found).toBe(true);
    expect(hazardSpec(d('CR-05', 'rack_a1'), topo)!.faults[0].kind).toBe('rack_thermal_runaway');
    expect(hazardSpec(d('CR-05', 'rack_a1'), topo)!.outcome).toContain('no autonomous firefighting');
    expect(hazardSpec(d('CR-06', 'strainer_02'), topo)).toBeNull();
  });
  it('classifies a validated hazard spec as live with its expected outcome, ignoring the stale registry operators', () => {
    const d = parseDefinitions({ scenarios: [wire({ scenario_id: 'CR-04', fault_injections: [{ operator: 'trip_pump', asset_id: 'pump_t1', tick: 1, params: {}, capability: 'unsupported' }], required_assets: ['pump_t1'] })] })[0];
    const h = hazardSpec(d, topo)!;
    const s = classify(d, topo, parseValidation({ valid: true, issues: [], support: [] }), undefined, h);
    expect(s.state).toBe('live');
    expect(s.label).toBe('Live: containment outcome');
    expect(s.outcome).toContain('ESCALATED');
    expect(classify(d, topo, null).state).toBe('unsupported'); // without the hazard plan the registry says unsupported
  });
});

describe('direct launch chain and incident link', () => {
  it('validated, injected, incident', () => {
    const base = { requestId: 'c', status: 'READY', phase: 'RUNNING', runId: 'r', errorCode: null, errorMessage: null, injections: [], planned: [], rejected: [], unsupported: [], incidentIds: [], incidentBasis: {}, supportedKinds: [], assumptions: [], laya: null, crusoe: null, latencies: null, via: 'command_bus' as const };
    expect(directChainOf(null, true).map((x) => x.state)).toEqual(['active', 'pending', 'pending']);
    expect(directChainOf(base).map((x) => x.state)).toEqual(['done', 'done', 'active']);
    expect(directChainOf({ ...base, incidentIds: ['INC-1'] }).map((x) => x.state)).toEqual(['done', 'done', 'done']);
    const bad = directChainOf({ ...base, status: 'REJECTED', errorCode: 'INJECTION_REFUSED', errorMessage: 'manifold_leak@p_hs_c: nope' });
    expect(bad.map((x) => x.state)).toEqual(['done', 'failed', 'pending']);
    expect(bad[1].note).toBe('INJECTION_REFUSED: manifold_leak@p_hs_c: nope');
  });
  it('links only incidents that are new and opened at or after the injection tick, and says why', () => {
    const list = [
      { id: 'INC-1', opened_tick: 10, affected_asset_ids: ['p_hs_c'] },
      { id: 'INC-2', opened_tick: 120, affected_asset_ids: ['p_hs_c'] },
      { id: 'INC-3', opened_tick: 130, affected_asset_ids: ['rack_z'] },
    ];
    const r = newIncidents(list, new Set(['INC-1']), 100, ['p_hs_c']);
    expect(r.ids).toEqual(['INC-2', 'INC-3']);
    expect(r.basis['INC-2']).toBe('touches a faulted target');
    expect(r.basis['INC-3']).toBe('first new incident after the injection');
    expect(newIncidents('x', new Set(), 0, []).ids).toEqual([]);
  });
});
