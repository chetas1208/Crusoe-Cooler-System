import { create } from 'zustand';
import { apiFetch } from './api';
import { activeLiveRunId } from './state';
import {
  buildSpec,
  hazardSpec,
  newIncidents,
  isTerminal,
  parseDefinitions,
  parseRequest,
  parseTopology,
  parseValidation,
  promptFor,
  toWireSpec,
  verdictOf,
  type Definition,
  type LiveVerdict,
  type PreviewSpec,
  type RequestView,
  type TopoLite,
  type ValidatorView,
} from './scenarioSpec';

type Load = 'idle' | 'loading' | 'ready' | 'error';

export interface Launch {
  scenarioId: string;
  spec: PreviewSpec;
  prompt: string;
  startedAt: number;
  /** POST not answered yet */
  submitting: boolean;
  view: RequestView | null;
  /** the HTTP layer refused or failed (rate limit, auth, network): the body text exactly as received */
  httpError: string | null;
  /** polling gave up waiting for an incident link (the request itself is final) */
  linkTimedOut: boolean;
}

interface State {
  defs: Definition[];
  defsLoad: Load;
  defsError: string | null;
  topo: TopoLite | null;
  topoError: string | null;
  validations: Record<string, { state: 'loading' | 'ready' | 'error'; view: ValidatorView | null; error: string | null }>;
  /** the spec each scenario launches: the typed hazard kind when the backend validator accepts it, else the registry faults */
  plans: Record<string, PreviewSpec>;
  /** why the hazard kind was not used (the validator's own messages), per scenario */
  hazardNotes: Record<string, string[]>;
  verdicts: Record<string, LiveVerdict>;
  /** the scenario whose preview/launch dialog is open */
  openId: string | null;
  launch: Launch | null;
  loadCatalog(): Promise<void>;
  open(id: string | null): void;
  validate(def: Definition): Promise<void>;
  start(def: Definition): Promise<void>;
  dismissLaunch(): void;
}

/** verbatim text of a failed HTTP answer (JSON `detail` / `message` when present, else the body), with the status in front */
export async function httpProblem(res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).trim();
  } catch {
    /* body unreadable */
  }
  let msg = body;
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: unknown };
    const d = j.detail ?? j.message;
    if (typeof d === 'string') msg = d;
    else if (d !== undefined) msg = JSON.stringify(d);
  } catch {
    /* plain text */
  }
  const retry = res.headers?.get?.('Retry-After');
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${msg ? `: ${msg.slice(0, 600)}` : ''}${retry ? ` (Retry-After ${retry}s)` : ''}`;
}

const POLL_MS = 700;
const LINK_POLL_MS = 2000;
const LINK_WAIT_MS = 90_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollGen = 0;

export const useScenarioLive = create<State>()((set, get) => ({
  defs: [],
  defsLoad: 'idle',
  defsError: null,
  topo: null,
  topoError: null,
  validations: {},
  plans: {},
  hazardNotes: {},
  verdicts: {},
  openId: null,
  launch: null,

  loadCatalog: async () => {
    set({ defsLoad: 'loading', defsError: null });
    try {
      const [s, t] = await Promise.all([apiFetch('/scenarios'), apiFetch('/topology').catch((e: Error) => e)]);
      if (!s.ok) {
        set({ defsLoad: 'error', defsError: await httpProblem(s) });
        return;
      }
      const defs = parseDefinitions(await s.json());
      let topo: TopoLite | null = null;
      let topoError: string | null = null;
      if (t instanceof Error) topoError = t.message;
      else if (!t.ok) topoError = await httpProblem(t);
      else {
        topo = parseTopology(await t.json());
        if (!topo) topoError = 'topology response had no assets/edges';
      }
      set({ defs, defsLoad: 'ready', defsError: defs.length ? null : 'the backend returned an empty scenario list', topo, topoError, validations: {}, plans: {}, hazardNotes: {} });
      // ask the backend validator about every scenario up front, so the cards show its verdict (and the new fault kinds it learns) before anyone opens one
      await Promise.all(defs.map((d) => get().validate(d)));
    } catch (e) {
      set({ defsLoad: 'error', defsError: (e as Error).message || 'request failed' });
    }
  },

  open: (openId) => {
    set({ openId });
    if (!openId) return;
    const def = get().defs.find((d) => d.scenario_id === openId);
    if (def) void get().validate(def);
  },

  validate: async (def) => {
    const id = def.scenario_id;
    set((s) => ({ validations: { ...s.validations, [id]: { state: 'loading', view: null, error: null } } }));
    const ask = async (spec: PreviewSpec): Promise<{ view: ValidatorView | null; error: string | null }> => {
      try {
        const res = await apiFetch('/scenarios/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: toWireSpec(spec) }) });
        if (!res.ok) return { view: null, error: await httpProblem(res) };
        const view = parseValidation(await res.json());
        return view ? { view, error: null } : { view: null, error: 'unreadable validator response' };
      } catch (e) {
        return { view: null, error: (e as Error).message || 'request failed' };
      }
    };
    const done = (spec: PreviewSpec, r: { view: ValidatorView | null; error: string | null }, notes?: string[]) =>
      set((s) => ({
        plans: { ...s.plans, [id]: spec },
        hazardNotes: notes ? { ...s.hazardNotes, [id]: notes } : s.hazardNotes,
        validations: { ...s.validations, [id]: r.view ? { state: 'ready', view: r.view, error: null } : { state: 'error', view: null, error: r.error } },
      }));
    // 1) the typed hazard kind for this scenario, if the backend validator knows it; 2) the registry's own faults
    const hz = hazardSpec(def, get().topo);
    let notes: string[] | undefined;
    if (hz) {
      const r = await ask(hz);
      if (r.view?.valid) return done(hz, r);
      notes = r.view ? r.view.issues.filter((i) => i.severity === 'error').map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`) : [r.error ?? 'validator unavailable'];
    }
    done(buildSpec(def, get().topo), await ask(buildSpec(def, get().topo)), notes);
  },

  start: async (def) => {
    const cur = get().launch;
    if (cur && (cur.submitting || (cur.view && !isTerminal(cur.view.status)))) return; // one launch at a time (the backend caps in-flight requests too)
    const spec = get().plans[def.scenario_id] ?? buildSpec(def, get().topo);
    if (spec.mode === 'hazard') return startDirect(def, spec);
    const prompt = promptFor(spec);
    const gen = ++pollGen;
    if (pollTimer) clearTimeout(pollTimer);
    set({ launch: { scenarioId: def.scenario_id, spec, prompt, startedAt: Date.now(), submitting: true, view: null, httpError: null, linkTimedOut: false } });
    try {
      const res = await apiFetch('/scenario-requests', {
        method: 'POST',
        // no Idempotency-Key header: the backend's CORS allow-list does not include it, so a cross-origin launch (dev server, tunnel) would die in the preflight
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, requested_duration_seconds: def.duration_sim_s || 1800, requested_speed: 1 }),
      });
      if (gen !== pollGen) return;
      if (!res.ok) {
        const msg = await httpProblem(res);
        set((s) => (s.launch ? { launch: { ...s.launch, submitting: false, httpError: msg } } : s));
        return;
      }
      const first = parseRequest(await res.json());
      if (!first) {
        set((s) => (s.launch ? { launch: { ...s.launch, submitting: false, httpError: 'unreadable response from POST /scenario-requests' } } : s));
        return;
      }
      set((s) => (s.launch ? { launch: { ...s.launch, submitting: false, view: first } } : s));
      poll(first.requestId, gen, def.scenario_id, spec);
    } catch (e) {
      if (gen !== pollGen) return;
      set((s) => (s.launch ? { launch: { ...s.launch, submitting: false, httpError: (e as Error).message || 'request failed' } } : s));
    }
  },

  dismissLaunch: () => {
    pollGen++;
    if (pollTimer) clearTimeout(pollTimer);
    set({ launch: null });
  },
}));

let lastDirectAt = 0;
const DIRECT_SPACING_MS = 10_000;

/**
 * Typed hazard faults (manifold_leak, power_failure, ...) go to the command bus as test.inject_fault, the engine's only write path.
 * The prompt planner (api/scenario_live.py) has no mapping for these kinds yet, so it cannot carry them; this path therefore has no
 * per-run fault cap (only the /commands rate limit) and applies the planner's 10 s launch spacing here, in the UI.
 */
async function startDirect(def: Definition, spec: PreviewSpec): Promise<void> {
  const gen = ++pollGen;
  if (pollTimer) clearTimeout(pollTimer);
  const prompt = `POST /commands test.inject_fault ${spec.faults.map((f) => `${f.kind} -> ${f.target_id}`).join(', ')}`;
  const fail = (httpError: string): void => useScenarioLive.setState((s) => (s.launch ? { launch: { ...s.launch, submitting: false, httpError } } : s));
  const wait = DIRECT_SPACING_MS - (Date.now() - lastDirectAt);
  useScenarioLive.setState({ launch: { scenarioId: def.scenario_id, spec, prompt, startedAt: Date.now(), submitting: true, view: null, httpError: null, linkTimedOut: false } });
  if (wait > 0) return void fail(`RATE_LIMITED: launches must be 10 s apart (retry in ${Math.ceil(wait / 1000)} s)`);
  try {
    const runsRes = await apiFetch('/runs');
    if (!runsRes.ok) return void fail(`could not find the live run: ${await httpProblem(runsRes)}`);
    const runs = (await runsRes.json()) as Array<{ run_id: string; kind: string; mode: string; state: string; created_at: string; current_tick?: number }>;
    const runId = activeLiveRunId(runs as never);
    if (!runId) return void fail('no running live run to inject into');
    const tick = Number(runs.find((r) => r.run_id === runId)?.current_tick ?? 0);
    const incRes = await apiFetch('/incidents');
    const baseline = new Set<string>(incRes.ok ? ((await incRes.json()) as Array<{ id?: string }>).flatMap((i) => (typeof i.id === 'string' ? [i.id] : [])) : []);
    lastDirectAt = Date.now();
    const stamp = Date.now();
    const injections: RequestView['injections'] = [];
    for (let i = 0; i < spec.faults.length; i++) {
      const f = spec.faults[i];
      const commandId = `lib-${def.scenario_id}-${stamp}-${i}`;
      let accepted = false;
      let reason: string | null = null;
      try {
        const res = await apiFetch('/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command_id: commandId, kind: 'test.inject_fault', args: { kind: f.kind, target: f.target_id, ...(Object.keys(f.params).length ? { params: f.params } : {}) } }),
        });
        const body = (await res.json().catch(() => ({}))) as { accepted?: boolean; reason?: string };
        accepted = res.ok && body.accepted === true;
        reason = accepted ? null : body.reason ?? `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      } catch (e) {
        reason = (e as Error).message || 'request failed';
      }
      injections.push({ kind: f.kind, target: f.target_id, accepted, duplicate: false, reason, commandId });
    }
    if (gen !== pollGen) return;
    const any = injections.some((i) => i.accepted);
    const view: RequestView = {
      via: 'command_bus', requestId: `cmd-${def.scenario_id}-${stamp}`, status: any ? 'READY' : 'REJECTED', phase: any ? 'RUNNING' : 'REJECTED', runId,
      errorCode: any ? null : 'INJECTION_REFUSED', errorMessage: any ? null : injections.map((i) => `${i.kind}@${i.target}: ${i.reason}`).join('; '),
      injections, planned: spec.faults.map((f) => ({ kind: f.kind, target: f.target_id })), rejected: [], unsupported: [], incidentIds: [], incidentBasis: {},
      supportedKinds: [], assumptions: [], laya: null, crusoe: null, latencies: null,
    };
    const verdict = verdictOf(def.scenario_id, view, spec);
    useScenarioLive.setState((s) => ({ launch: s.launch ? { ...s.launch, submitting: false, view } : s.launch, verdicts: verdict ? { ...s.verdicts, [def.scenario_id]: verdict } : s.verdicts }));
    if (!any) return;
    const targets = spec.faults.map((f) => f.target_id);
    const t0 = Date.now();
    const step = async () => {
      if (gen !== pollGen) return;
      try {
        const r = await apiFetch('/incidents');
        if (r.ok) {
          const { ids, basis } = newIncidents(await r.json(), baseline, tick, targets);
          if (gen !== pollGen) return;
          if (ids.length) {
            useScenarioLive.setState((s) => ({ launch: s.launch && s.launch.view?.requestId === view.requestId ? { ...s.launch, view: { ...s.launch.view, incidentIds: ids, incidentBasis: basis } } : s.launch }));
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - t0 > LINK_WAIT_MS) {
        useScenarioLive.setState((s) => (s.launch ? { launch: { ...s.launch, linkTimedOut: true } } : s));
        return;
      }
      pollTimer = setTimeout(step, LINK_POLL_MS);
    };
    pollTimer = setTimeout(step, LINK_POLL_MS);
  } catch (e) {
    if (gen === pollGen) fail((e as Error).message || 'request failed');
  }
}

function poll(requestId: string, gen: number, scenarioId: string, spec: PreviewSpec) {
  const t0 = Date.now();
  const step = async () => {
    if (gen !== pollGen) return;
    let next = POLL_MS;
    try {
      const res = await apiFetch(`/scenario-requests/${encodeURIComponent(requestId)}`);
      if (gen !== pollGen) return;
      if (res.ok) {
        const view = parseRequest(await res.json());
        if (view) {
          const terminal = isTerminal(view.status);
          const verdict = verdictOf(scenarioId, view, spec);
          const linkWait = view.status === 'READY' && view.incidentIds.length === 0;
          const timedOut = linkWait && Date.now() - t0 > LINK_WAIT_MS;
          useScenarioLive.setState((s) => ({
            launch: s.launch && s.launch.view?.requestId === requestId ? { ...s.launch, view, linkTimedOut: timedOut } : s.launch,
            verdicts: verdict ? { ...s.verdicts, [scenarioId]: verdict } : s.verdicts,
          }));
          if (terminal && !linkWait) return;
          if (timedOut) return;
          next = terminal ? LINK_POLL_MS : POLL_MS;
        }
      } else if (res.status === 404) {
        const msg = await httpProblem(res);
        useScenarioLive.setState((s) => (s.launch ? { launch: { ...s.launch, httpError: msg } } : s));
        return;
      }
    } catch {
      /* transient network error: keep polling */
    }
    pollTimer = setTimeout(step, next);
  };
  pollTimer = setTimeout(step, POLL_MS);
}
