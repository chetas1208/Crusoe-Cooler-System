import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ path: string; init?: RequestInit }> = [];
let responder: (path: string, init?: RequestInit) => Response | Promise<Response>;
vi.mock('../api', () => ({ apiFetch: (path: string, init?: RequestInit) => { calls.push({ path, init }); return Promise.resolve(responder(path, init)); } }));

import { httpProblem, useScenarioLive } from '../scenarioLive';
import { parseDefinitions } from '../scenarioSpec';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const cr06 = parseDefinitions({ scenarios: [{ scenario_id: 'CR-06', severity: 'SEVERE', label: 'Multi-row fouling', learning_goal: 'g', seed: 12006, duration_sim_s: 1800, required_assets: ['strainer_02'], required_robot_tools: [], fault_injections: [{ operator: 'strainer_blockage', asset_id: 'strainer_02', tick: 240, params: { omax: 0.78 }, capability: 'real' }], readiness: { status: 'READY', ready: true, missing_assets: [], unsupported_faults: [], notes: [] } }] })[0];

const reset = () => { useScenarioLive.getState().dismissLaunch(); useScenarioLive.setState({ verdicts: {}, validations: {}, plans: {}, hazardNotes: {}, launch: null, openId: null }); calls.length = 0; };

beforeEach(() => { vi.useFakeTimers(); reset(); });
afterEach(() => { reset(); vi.useRealTimers(); });

describe('httpProblem', () => {
  it('keeps the status and the backend text verbatim, including Retry-After', async () => {
    expect(await httpProblem(json({ detail: 'too many scenario requests; retry in 7s' }, 429, { 'Retry-After': '7' }))).toBe('HTTP 429: too many scenario requests; retry in 7s (Retry-After 7s)');
    expect(await httpProblem(new Response('upstream down', { status: 502 }))).toBe('HTTP 502: upstream down');
  });
});

describe('catalog', () => {
  it('shows an error and no scenarios when the backend refuses (no fixtures)', async () => {
    responder = () => new Response('nope', { status: 503 });
    await useScenarioLive.getState().loadCatalog();
    const s = useScenarioLive.getState();
    expect(s.defsLoad).toBe('error');
    expect(s.defsError).toBe('HTTP 503: nope');
    expect(s.defs).toEqual([]);
  });
  it('loads definitions and topology from the backend', async () => {
    responder = (p) => (p === '/scenarios' ? json({ scenarios: [{ scenario_id: 'CR-06', label: 'x', severity: 'SEVERE' }] }) : json({ assets: [{ id: 'strainer_02', type: 'strainer' }], edges: [] }));
    await useScenarioLive.getState().loadCatalog();
    const s = useScenarioLive.getState();
    expect(s.defsLoad).toBe('ready');
    expect(s.defs.map((d) => d.scenario_id)).toEqual(['CR-06']);
    expect(s.topo?.assets[0].id).toBe('strainer_02');
  });
});

describe('launch', () => {
  it('posts the typed spec as a live request, follows the phase chain and stores the backend verdict', async () => {
    let polls = 0;
    responder = (p) => {
      if (p === '/scenario-requests') return json({ request_id: 'req_1', status: 'QUEUED', phase: 'RECEIVED' }, 202);
      polls++;
      return polls < 2
        ? json({ request_id: 'req_1', status: 'PROCESSING', phase: 'INTERPRETING' })
        : json({ request_id: 'req_1', status: 'READY', phase: 'RUNNING', run_id: 'run_live', live: { run_id: 'run_live', injections: [{ kind: 'strainer_blockage', target: 'strainer_02', accepted: true }], incident_ids: ['inc_1'] } });
    };
    await useScenarioLive.getState().start(cr06);
    const post = calls[0];
    expect(post.path).toBe('/scenario-requests');
    const body = JSON.parse(String(post.init?.body));
    expect(body.prompt).toContain('strainer_blockage');
    expect(body.prompt).toContain('strainer_02');
    expect(Object.keys(post.init?.headers as Record<string, string>)).toEqual(['Content-Type']); // anything else fails the backend's CORS preflight
    expect(useScenarioLive.getState().launch?.view?.requestId).toBe('req_1');
    await vi.advanceTimersByTimeAsync(700);
    expect(useScenarioLive.getState().launch?.view?.phase).toBe('INTERPRETING');
    await vi.advanceTimersByTimeAsync(700);
    const l = useScenarioLive.getState().launch!;
    expect(l.view?.status).toBe('READY');
    expect(l.view?.incidentIds).toEqual(['inc_1']);
    expect(useScenarioLive.getState().verdicts['CR-06']).toMatchObject({ status: 'injected', injected: 1 });
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(n); // terminal with an incident: polling stopped
  });

  it('shows a rejected request with its code and message and records a refused verdict', async () => {
    responder = (p) => (p === '/scenario-requests'
      ? json({ request_id: 'req_2', status: 'QUEUED', phase: 'RECEIVED' }, 202)
      : json({ request_id: 'req_2', status: 'REJECTED', phase: 'REJECTED', error_code: 'RATE_LIMITED', error_message: 'launches on one run must be 10s apart (retry in 4s)' }));
    await useScenarioLive.getState().start(cr06);
    await vi.advanceTimersByTimeAsync(700);
    const v = useScenarioLive.getState();
    expect(v.launch?.view).toMatchObject({ status: 'REJECTED', errorCode: 'RATE_LIMITED', errorMessage: 'launches on one run must be 10s apart (retry in 4s)' });
    expect(v.verdicts['CR-06']).toMatchObject({ status: 'refused', code: 'RATE_LIMITED' });
  });

  it('shows an HTTP-level refusal verbatim and does not poll', async () => {
    responder = () => json({ detail: 'rate limit exceeded' }, 429, { 'Retry-After': '3' });
    await useScenarioLive.getState().start(cr06);
    expect(useScenarioLive.getState().launch?.httpError).toBe('HTTP 429: rate limit exceeded (Retry-After 3s)');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.length).toBe(1);
  });

  it('allows one launch at a time', async () => {
    responder = (p) => (p === '/scenario-requests' ? json({ request_id: 'req_3', status: 'QUEUED', phase: 'RECEIVED' }, 202) : json({ request_id: 'req_3', status: 'PROCESSING', phase: 'CLASSIFYING' }));
    await useScenarioLive.getState().start(cr06);
    await useScenarioLive.getState().start(cr06);
    expect(calls.filter((c) => c.path === '/scenario-requests')).toHaveLength(1);
  });
});

describe('validator', () => {
  it('sends the wire spec and keeps the backend verdict', async () => {
    responder = () => json({ valid: false, spec: null, issues: [{ path: 'faults.0.kind', severity: 'error', message: 'bad kind' }], support: [], backend: 'live' });
    await useScenarioLive.getState().validate(cr06);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(calls[0].path).toBe('/scenarios/validate');
    expect(body.spec.faults[0]).toEqual({ kind: 'strainer_blockage', target_id: 'strainer_02', onset_tick: 240, severity: 0.75, progression_s: 0 });
    expect(useScenarioLive.getState().validations['CR-06'].view?.issues[0].message).toBe('bad kind');
  });
});

describe('hazard plans', () => {
  const cr02 = parseDefinitions({ scenarios: [{ scenario_id: 'CR-02', severity: 'SEVERE', label: 'Manifold rupture', learning_goal: 'g', seed: 1, duration_sim_s: 1800, required_assets: ['p_hs_c'], required_robot_tools: [], fault_injections: [{ operator: 'leak', asset_id: 'p_hs_c', tick: 240, params: { orifice_m2: 2.8e-5 }, capability: 'real' }], readiness: { status: 'READY', ready: true, missing_assets: [], unsupported_faults: [], notes: [] } }] })[0];
  const validate = (kinds: string[]) => (p: string, init?: RequestInit) => {
    if (p !== '/scenarios/validate') return json({});
    const kind = JSON.parse(String(init?.body)).spec.faults[0].kind;
    return kinds.includes(kind) ? json({ valid: true, spec: null, issues: [], support: [], backend: 'live' }) : json({ valid: false, spec: null, issues: [{ path: 'faults.0.kind', severity: 'error', message: `Input should be ${kinds.join(', ')}` }], support: [], backend: 'live' });
  };

  it('uses the hazard kind when the backend validator accepts it, and the registry faults when it does not', async () => {
    responder = validate(['manifold_leak']);
    await useScenarioLive.getState().validate(cr02);
    expect(useScenarioLive.getState().plans['CR-02'].mode).toBe('hazard');
    expect(useScenarioLive.getState().plans['CR-02'].faults[0].kind).toBe('manifold_leak');
    responder = validate(['leak']);
    await useScenarioLive.getState().validate(cr02);
    const s = useScenarioLive.getState();
    expect(s.plans['CR-02'].mode).toBe('registry');
    expect(s.plans['CR-02'].faults[0].kind).toBe('leak');
    expect(s.hazardNotes['CR-02'][0]).toContain('faults.0.kind: Input should be leak');
  });

  it('launches a hazard spec on the command bus against the live run and links the new incident', async () => {
    responder = (p, init) => {
      if (p === '/scenarios/validate') return validate(['manifold_leak'])(p, init);
      if (p === '/runs') return json([{ run_id: 'run_live', kind: 'baseline', mode: 'LIVE', state: 'running', created_at: '2026-01-01', current_tick: 100 }]);
      if (p === '/commands') return json({ command_id: 'x', accepted: true });
      if (p === '/incidents') return json(calls.filter((c) => c.path === '/commands').length ? [{ id: 'INC-9', opened_tick: 120, affected_asset_ids: ['p_hs_c'] }] : []);
      return json({});
    };
    await useScenarioLive.getState().validate(cr02);
    calls.length = 0;
    await useScenarioLive.getState().start(cr02);
    const cmd = calls.find((c) => c.path === '/commands')!;
    const body = JSON.parse(String(cmd.init?.body));
    expect(body.kind).toBe('test.inject_fault');
    expect(body.args).toEqual({ kind: 'manifold_leak', target: 'p_hs_c', params: { orifice_m2: 2.8e-5 } });
    expect(calls.some((c) => c.path === '/scenario-requests')).toBe(false); // not through the model planner
    const l = useScenarioLive.getState().launch!;
    expect(l.view).toMatchObject({ via: 'command_bus', status: 'READY', runId: 'run_live' });
    expect(useScenarioLive.getState().verdicts['CR-02'].status).toBe('injected');
    await vi.advanceTimersByTimeAsync(2100);
    expect(useScenarioLive.getState().launch?.view?.incidentIds).toEqual(['INC-9']);
  });
});
