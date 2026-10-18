/**
 * Pure model of the scenario library (no network, no React): what the backend registry says, the typed spec we would launch,
 * how each scenario is classified, the request that carries it into the LIVE run and how the backend's answer is read back.
 *
 * Truth rules (docs/engineering/V12_COORDINATION.md): nothing here claims physics. Support comes from the backend (GET /scenarios
 * readiness + per-fault capability, POST /scenarios/validate, and finally the live plan returned by /scenario-requests/{id}).
 * Fault-kind names and reasons are never invented in the UI: when the backend adds kinds they appear here without a code change.
 */

export type Capability = 'real' | 'proxy' | 'unsupported';

export interface RegistryFault {
  operator: string;
  asset_id: string;
  tick: number;
  params: Record<string, number>;
  capability: Capability;
}

export interface Readiness {
  status: string;
  ready: boolean;
  missing_assets: string[];
  unsupported_faults: Array<{ operator?: string; asset_id?: string }>;
  notes: string[];
}

export interface Definition {
  scenario_id: string;
  severity: 'SEVERE' | 'MODERATE';
  label: string;
  learning_goal: string;
  seed: number;
  duration_sim_s: number;
  required_assets: string[];
  required_robot_tools: string[];
  fault_injections: RegistryFault[];
  readiness: Readiness;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** Defensive parse of GET /scenarios. Entries without an id or label are dropped, never invented. */
export function parseDefinitions(json: unknown): Definition[] {
  const list = isObj(json) && Array.isArray(json.scenarios) ? json.scenarios : [];
  const out: Definition[] = [];
  for (const raw of list) {
    if (!isObj(raw) || typeof raw.scenario_id !== 'string' || typeof raw.label !== 'string') continue;
    const r = isObj(raw.readiness) ? raw.readiness : {};
    const faults: RegistryFault[] = (Array.isArray(raw.fault_injections) ? raw.fault_injections : []).flatMap((f) => {
      if (!isObj(f) || typeof f.operator !== 'string') return [];
      const params: Record<string, number> = {};
      if (isObj(f.params)) for (const [k, v] of Object.entries(f.params)) if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
      const cap = f.capability === 'proxy' || f.capability === 'unsupported' ? f.capability : 'real';
      return [{ operator: f.operator, asset_id: String(f.asset_id ?? ''), tick: num(f.tick), params, capability: cap as Capability }];
    });
    out.push({
      scenario_id: raw.scenario_id,
      severity: raw.severity === 'MODERATE' ? 'MODERATE' : 'SEVERE',
      label: raw.label,
      learning_goal: String(raw.learning_goal ?? ''),
      seed: num(raw.seed),
      duration_sim_s: num(raw.duration_sim_s, 1800),
      required_assets: strs(raw.required_assets),
      required_robot_tools: strs(raw.required_robot_tools),
      fault_injections: faults,
      readiness: {
        status: typeof r.status === 'string' ? r.status : 'UNKNOWN',
        ready: r.ready === true,
        missing_assets: strs(r.missing_assets),
        unsupported_faults: Array.isArray(r.unsupported_faults) ? (r.unsupported_faults.filter(isObj) as Readiness['unsupported_faults']) : [],
        notes: strs(r.notes),
      },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ topology resolution
export interface TopoLite {
  assets: Array<{ id: string; type?: string; label?: string; zone_id?: string; loop?: string }>;
  edges: Array<{ id: string; label?: string; zone_id?: string; loop?: string; role?: string }>;
}

export function parseTopology(json: unknown): TopoLite | null {
  if (!isObj(json) || !Array.isArray(json.assets) || !Array.isArray(json.edges)) return null;
  const pick = (a: unknown) => (isObj(a) && typeof a.id === 'string' ? [{ id: a.id, type: typeof a.type === 'string' ? a.type : undefined, label: typeof a.label === 'string' ? a.label : undefined, zone_id: typeof a.zone_id === 'string' ? a.zone_id : undefined, loop: typeof a.loop === 'string' ? a.loop : undefined, role: typeof a.role === 'string' ? a.role : undefined }] : []);
  return { assets: json.assets.flatMap(pick), edges: json.edges.flatMap(pick) };
}

export interface Resolved {
  id: string;
  found: boolean;
  /** asset type, or 'pipe' for an edge */
  type: string | null;
  label: string | null;
  zone: string | null;
  loop: string | null;
}

export function resolveTarget(id: string, topo: TopoLite | null): Resolved {
  const none: Resolved = { id, found: false, type: null, label: null, zone: null, loop: null };
  if (!topo || !id) return none;
  const a = topo.assets.find((x) => x.id === id);
  if (a) return { id, found: true, type: a.type ?? 'asset', label: a.label ?? null, zone: a.zone_id ?? null, loop: a.loop ?? null };
  const e = topo.edges.find((x) => x.id === id);
  if (e) return { id, found: true, type: 'pipe', label: e.label ?? null, zone: e.zone_id ?? null, loop: e.loop ?? null };
  return none;
}

// ------------------------------------------------------------------------------------------------ typed spec
/** severity label -> the 0..1 value the backend uses for the same word (scenario_live.SEV_FLOAT): shown, never invented per fault */
export const SEVERITY_VALUE = { SEVERE: 0.75, MODERATE: 0.5 } as const;

export interface PreviewFault {
  kind: string;
  target_id: string;
  onset_tick: number;
  severity: number;
  progression_s: number;
  /** the registry's own parameters for this fault, shown as-is */
  params: Record<string, number>;
  capability: Capability;
  resolved: Resolved;
}

export interface PreviewSpec {
  scenario_id: string;
  title: string;
  severity: Definition['severity'];
  seed: number;
  faults: PreviewFault[];
  workload_factor: number;
  sim_speed: number;
  agent_policy: 'autonomous' | 'supervised';
  approval_window_s: number;
  background_faults: boolean;
  /** 'hazard' = the typed V12 hazard kind the backend validator accepted; 'registry' = the registry's own fault operators */
  mode: 'registry' | 'hazard';
  /** realistic expected outcome, for hazard scenarios */
  outcome?: string;
}

export function buildSpec(def: Definition, topo: TopoLite | null): PreviewSpec {
  return {
    scenario_id: def.scenario_id,
    title: def.label,
    severity: def.severity,
    seed: def.seed,
    faults: def.fault_injections.map((f) => ({
      kind: f.operator,
      target_id: f.asset_id,
      onset_tick: f.tick,
      severity: SEVERITY_VALUE[def.severity],
      progression_s: f.params.duration_s ?? f.params.tau_s ?? 0,
      params: f.params,
      capability: f.capability,
      resolved: resolveTarget(f.asset_id, topo),
    })),
    workload_factor: 1,
    sim_speed: 1,
    agent_policy: 'autonomous',
    approval_window_s: 24,
    background_faults: false,
    mode: 'registry',
  };
}

// ------------------------------------------------------------------------------------------------ V12 hazard kinds
/**
 * Which hazard fault kind models each scenario, and how its target and parameters come from the registry entry. This is only the
 * scenario -> kind relation; whether the backend supports the kind is asked of the backend validator (POST /scenarios/validate), and a
 * scenario falls back to its registry faults when the validator does not accept the hazard kind.
 */
const HAZARD: Record<string, (d: Definition) => { kind: string; target: string; params: Record<string, number> }> = {
  'CR-01': (d) => {
    const f = d.fault_injections[0];
    return { kind: 'cdu_pump_backup_failure', target: f?.asset_id || 'pump_t1', params: { ...(f?.params.health_end !== undefined ? { primary_health_end: f.params.health_end } : {}), ...(f?.params.duration_s !== undefined ? { duration_s: f.params.duration_s } : {}) } };
  },
  'CR-02': (d) => {
    const f = d.fault_injections.find((x) => x.operator === 'leak') ?? d.fault_injections[0];
    return { kind: 'manifold_leak', target: f?.asset_id || 'p_hs_c', params: (f?.params.orifice_m2 !== undefined ? { orifice_m2: f.params.orifice_m2 } : {}) as Record<string, number> };
  },
  'CR-03': (d) => ({ kind: 'facility_heat_rejection_loss', target: d.fault_injections[0]?.asset_id || 'chiller_01', params: {} }),
  // the registry trips pump_t1 and pump_f1: those are the two pumps on power feed A
  'CR-04': () => ({ kind: 'power_failure', target: 'feed_a', params: {} }),
  'CR-05': (d) => ({ kind: 'rack_thermal_runaway', target: d.fault_injections[0]?.asset_id || 'rack_a1', params: {} }),
};

/** the outcome each hazard can realistically reach (backend hazard docs): containment or escalation, never self-repair */
export const HAZARD_OUTCOME: Record<string, string> = {
  cdu_pump_backup_failure: 'Expected outcome: the duty pump fails and the standby is dead, weak or trips on start, so a pump swap alone does not restore flow; a replacement can fail commissioning and need a retry. Not self-repairing.',
  manifold_leak: 'Expected outcome: CONTAINED_NOT_REPAIRED. Isolating the row zone valve makes the leak exactly zero, but it is only repaired by replacing the isolated section; it re-opens if the valve is reopened first.',
  facility_heat_rejection_loss: 'Expected outcome: CONTAINED by shedding load, not repaired. The fault is upstream (facility chiller capacity); local repairs such as a pump swap cannot restore it.',
  power_failure: 'Expected outcome: CONTAINED_NOT_REPAIRED or ESCALATED. Power returns only by an explicit restore once utility or generator is available; shedding load slows the UPS drain.',
  rack_thermal_runaway: 'Expected outcome: CONTAINED_NOT_REPAIRED or ESCALATED. De-powering the rack stops the heat source; there is no suppression model and no autonomous firefighting, and robots stay out of the zone.',
};

/** the hazard-kind spec for a scenario, or null when no hazard kind is mapped to it */
export function hazardSpec(def: Definition, topo: TopoLite | null): PreviewSpec | null {
  const m = HAZARD[def.scenario_id];
  if (!m) return null;
  const base = buildSpec(def, topo);
  const h = m(def);
  const resolved = /^(feed_a|zone_[a-z])$/.test(h.target) && h.kind === 'power_failure' ? { id: h.target, found: true, type: 'power domain', label: null, zone: null, loop: null } : resolveTarget(h.target, topo);
  return {
    ...base,
    mode: 'hazard',
    outcome: HAZARD_OUTCOME[h.kind],
    faults: [{ kind: h.kind, target_id: h.target, onset_tick: base.faults[0]?.onset_tick ?? 240, severity: SEVERITY_VALUE[def.severity], progression_s: h.params.duration_s ?? 0, params: h.params, capability: 'real', resolved }],
  };
}

/** the body POST /scenarios/validate accepts (ScenarioSpec is extra=forbid: no params, no resolved) */
export function toWireSpec(s: PreviewSpec) {
  return {
    scenario_id: s.scenario_id,
    title: s.title,
    faults: s.faults.map((f) => ({ kind: f.kind, target_id: f.target_id, onset_tick: f.onset_tick, severity: f.severity, progression_s: f.progression_s })),
    seed: s.seed,
    workload_factor: s.workload_factor,
    sim_speed: s.sim_speed,
    agent_policy: s.agent_policy,
    approval_window_s: s.approval_window_s,
    background_faults: s.background_faults,
  };
}

// ------------------------------------------------------------------------------------------------ validator verdict
export interface ValidatorIssue {
  path: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix?: string;
}
export interface ValidatorView {
  valid: boolean;
  issues: ValidatorIssue[];
  support: Array<{ path: string; applied: boolean; note: string }>;
}

export function parseValidation(json: unknown): ValidatorView | null {
  if (!isObj(json) || typeof json.valid !== 'boolean') return null;
  const issues = (Array.isArray(json.issues) ? json.issues : []).flatMap((i) => (isObj(i) && typeof i.message === 'string' ? [{ path: String(i.path ?? ''), severity: (i.severity === 'error' || i.severity === 'warning' ? i.severity : 'info') as ValidatorIssue['severity'], message: i.message, fix: typeof i.fix === 'string' ? i.fix : undefined }] : []));
  const support = (Array.isArray(json.support) ? json.support : []).flatMap((s) => (isObj(s) && typeof s.path === 'string' ? [{ path: s.path, applied: s.applied === true, note: String(s.note ?? '') }] : []));
  return { valid: json.valid, issues, support };
}

// ------------------------------------------------------------------------------------------------ classification
export type SupportState = 'live' | 'partial' | 'unsupported';

export interface Support {
  state: SupportState;
  /** short chip text */
  label: string;
  /** why, verbatim from the backend where it came from the backend */
  reasons: string[];
  /** what is actually simulated when the state is partial (proxy faults + registry notes) */
  simulated: string[];
  /** the realistic expected outcome of a hazard scenario (containment or escalation, not repair) */
  outcome?: string;
}

export interface LiveVerdict {
  scenarioId: string;
  at: number;
  status: 'injected' | 'partial' | 'refused' | 'failed';
  code?: string;
  message?: string;
  injected: number;
  planned: number;
  detail: string[];
}

const faultText = (f: { operator?: string; kind?: string; asset_id?: string; target_id?: string }) => `${f.operator ?? f.kind} on ${f.asset_id ?? f.target_id}`;

/**
 * Pre-launch classification from what the backend publishes. The registry can be optimistic about the LIVE path, so a `live` state here
 * only means "the backend declares it launchable"; the plan returned at launch is the final word and is stored as a LiveVerdict.
 */
export function classify(def: Definition, topo: TopoLite | null, validator: ValidatorView | null, verdict?: LiveVerdict, spec?: PreviewSpec | null): Support {
  const hazard = spec?.mode === 'hazard';
  const outcome = hazard ? spec?.outcome : undefined;
  const reasons: string[] = [];
  const simulated: string[] = [];
  const r = def.readiness;
  let blocked = false;
  if (r.status === 'BLOCKED' || r.status === 'NOT_IMPLEMENTED') {
    blocked = true;
    reasons.push(`Backend readiness: ${r.status}`);
  }
  for (const m of r.missing_assets) {
    blocked = true;
    reasons.push(`Asset ${m} is not in the backend topology`);
  }
  if (topo) {
    for (const a of def.required_assets) if (!r.missing_assets.includes(a) && !resolveTarget(a, topo).found) {
      blocked = true;
      reasons.push(`Asset ${a} is not in the backend topology`);
    }
  }
  for (const f of hazard ? [] : def.fault_injections) {
    if (f.capability === 'unsupported') {
      blocked = true;
      reasons.push(`${faultText(f)} is declared unsupported by the backend registry`);
    }
  }
  if (validator) {
    for (const i of validator.issues) if (i.severity === 'error') {
      blocked = true;
      reasons.push(`Backend validator${i.path ? ` (${i.path})` : ''}: ${i.message}`);
    }
  }
  if (blocked) return { state: 'unsupported', label: 'Unsupported', reasons, simulated, outcome };

  for (const f of hazard ? [] : def.fault_injections) if (f.capability === 'proxy') simulated.push(`${faultText(f)} is a proxy fault, not the physical event`);
  if (r.status === 'PARTIAL') reasons.push('Backend readiness: PARTIAL');
  const notApplied = validator?.support.filter((s) => !s.applied) ?? [];
  for (const s of notApplied) simulated.push(`${s.path}: ${s.note}`);
  if (verdict && verdict.status !== 'injected') {
    // the live plan is the last word for this session: say what happened, keep Start available so a newly landed backend can be re-checked
    const state: SupportState = verdict.status === 'partial' ? 'partial' : 'unsupported';
    const why = [verdict.code ? `${verdict.code}: ` : '', verdict.message ?? ''].join('').trim();
    return { state, label: verdict.status === 'partial' ? 'Partially injected' : verdict.status === 'failed' ? 'Last launch failed' : 'Last launch refused', reasons: verdict.status === 'partial' ? [...verdict.detail] : [why || 'refused by the live path', ...verdict.detail], simulated, outcome };
  }
  if (hazard) return { state: 'live', label: verdict?.status === 'injected' ? 'Live (confirmed): containment' : 'Live: containment outcome', reasons, simulated, outcome };
  if (simulated.length || r.status === 'PARTIAL') return { state: 'partial', label: 'Partially modelled', reasons, simulated: [...simulated, ...r.notes], outcome };
  return { state: 'live', label: verdict?.status === 'injected' ? 'Live (confirmed)' : 'Live-capable', reasons, simulated: [], outcome };
}

// ------------------------------------------------------------------------------------------------ the launch request
const HUMAN: Record<string, string> = {
  pump_degradation: 'pump failure (impeller degradation)',
  leak: 'coolant leak (pipe or manifold rupture)',
  set_chiller_setpoint: 'heat rejection loss (facility chiller setpoint rise)',
  trip_pump: 'pump trip (loss of power to the pump)',
  workload_spike: 'rack workload spike (sudden extra electrical load)',
  strainer_blockage: 'strainer blockage',
  valve_stuck: 'stuck balancing valve',
  sensor_drift: 'flow sensor drift',
  fouling: 'pipe fouling',
};
export const humanKind = (op: string) => HUMAN[op] ?? op.replace(/_/g, ' ');

/**
 * The text that carries the typed spec into the same live path as the prompt box (POST /scenario-requests). Names every fault, target and
 * severity from the spec, and says nothing about repairs: the agents decide those.
 */
export function promptFor(spec: PreviewSpec): string {
  const sev = spec.severity === 'SEVERE' ? 'severe' : 'moderate';
  const parts = spec.faults.map((f) => `a ${sev} ${humanKind(f.kind)} fault (${f.kind}) on ${f.target_id}`);
  // the scenario title is left out on purpose: words like "smoke" or "power" would make the interpreter pick a different (unsupported) family
  // than the registry's own fault operators, and the launch must carry exactly the typed faults
  return `Simulate this incident (${spec.scenario_id}): inject ${parts.join(' and ')}.`.slice(0, 1900);
}

// ------------------------------------------------------------------------------------------------ the backend's answer
export interface InjectionView {
  kind: string;
  target: string;
  severity?: string;
  accepted: boolean;
  duplicate: boolean;
  reason: string | null;
  commandId: string | null;
}
export interface RejectedView {
  family: string | null;
  query: string | null;
  code: string;
  reason: string;
}
export interface RequestView {
  /** 'planner' = POST /scenario-requests; 'command_bus' = typed hazard faults sent as test.inject_fault commands */
  via?: 'planner' | 'command_bus';
  requestId: string;
  status: string;
  phase: string;
  runId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  injections: InjectionView[];
  planned: Array<{ kind: string; target: string; severity?: string; note?: string }>;
  rejected: RejectedView[];
  unsupported: Array<{ family: string; reason: string }>;
  incidentIds: string[];
  /** incident id -> why it was linked to this launch (target overlap, or just the first one opened after the injection) */
  incidentBasis: Record<string, string>;
  supportedKinds: string[];
  assumptions: string[];
  laya: string | null;
  crusoe: string | null;
  latencies: { laya_ms?: number; crusoe_ms?: number; total_pipeline_ms?: number; inject_ms?: number } | null;
}

export const isTerminal = (s: string) => s === 'READY' || s === 'FAILED' || s === 'REJECTED' || s === 'CANCELED';

export function parseRequest(json: unknown): RequestView | null {
  if (!isObj(json) || typeof json.request_id !== 'string') return null;
  const live = isObj(json.live) ? json.live : {};
  const interp = isObj(json.interpretation) ? json.interpretation : {};
  const compiler = isObj(interp.compiler) ? interp.compiler : {};
  const injections = (Array.isArray(live.injections) ? live.injections : []).flatMap((i) => (isObj(i) && typeof i.kind === 'string' ? [{ kind: i.kind, target: String(i.target ?? ''), severity: typeof i.severity === 'string' ? i.severity : undefined, accepted: i.accepted === true, duplicate: i.duplicate === true, reason: typeof i.reason === 'string' ? i.reason : null, commandId: typeof i.command_id === 'string' ? i.command_id : null }] : []));
  const planned = (Array.isArray(live.planned) ? live.planned : []).flatMap((i) => (isObj(i) && typeof i.kind === 'string' ? [{ kind: i.kind, target: String(i.target ?? ''), severity: typeof i.severity === 'string' ? i.severity : undefined, note: typeof i.note === 'string' && i.note ? i.note : undefined }] : []));
  const rejected = (Array.isArray(live.rejected) ? live.rejected : []).flatMap((i) => (isObj(i) ? [{ family: typeof i.family === 'string' ? i.family : null, query: typeof i.query === 'string' ? i.query : null, code: String(i.code ?? ''), reason: String(i.reason ?? '') }] : []));
  // the backend sends {family, reason}; older builds sent bare strings: keep both readable, never print "[object Object]"
  const unsupported = (Array.isArray(live.unsupported) ? live.unsupported : []).map((u) => (isObj(u) ? { family: String(u.family ?? ''), reason: String(u.reason ?? '') } : { family: '', reason: String(u) }));
  const lat = isObj(interp.latencies_ms) ? (interp.latencies_ms as RequestView['latencies']) : null;
  return {
    requestId: json.request_id,
    status: String(json.status ?? ''),
    phase: String(json.phase ?? ''),
    runId: typeof json.run_id === 'string' ? json.run_id : typeof live.run_id === 'string' ? live.run_id : null,
    errorCode: typeof json.error_code === 'string' ? json.error_code : null,
    errorMessage: typeof json.error_message === 'string' ? json.error_message : null,
    injections,
    planned,
    rejected,
    unsupported,
    incidentIds: strs(live.incident_ids),
    incidentBasis: isObj(live.incident_match) ? Object.fromEntries(Object.entries(live.incident_match).map(([k, v]) => [k, String(v)])) : {},
    supportedKinds: strs(live.supported_kinds),
    assumptions: strs(compiler.assumptions),
    laya: isObj(interp.laya) && typeof interp.laya.engine === 'string' ? interp.laya.engine : null,
    crusoe: isObj(interp.crusoe) && typeof interp.crusoe.model === 'string' ? interp.crusoe.model : null,
    latencies: lat,
  };
}

/**
 * What the backend said about this launch, as a stored verdict for the card. With the spec given, "injected" means every typed fault
 * was accepted on its target and nothing else was injected; any difference makes it "partial" and is listed.
 */
export function verdictOf(scenarioId: string, v: RequestView, spec?: PreviewSpec, now = Date.now()): LiveVerdict | null {
  if (!isTerminal(v.status)) return null;
  const accepted = v.injections.filter((i) => i.accepted).length;
  const detail = [
    ...v.unsupported.map((u) => `${u.family ? `${u.family}: ` : ''}${u.reason}`),
    ...v.rejected.map((r) => `${r.code}: ${r.reason}`),
    ...v.injections.filter((i) => !i.accepted).map((i) => `${i.kind}@${i.target}: ${i.reason ?? 'refused'}`),
  ];
  if (v.status === 'READY') {
    if (spec) {
      const { matches, extra } = compareToSpec(spec, v);
      for (const m of matches) if (!m.injection?.accepted && !m.injection) detail.push(`spec fault ${m.fault.kind} on ${m.fault.target_id} was not injected`);
      for (const x of extra) if (x.accepted) detail.push(`the backend also injected ${x.kind} on ${x.target}, which is not in the spec`);
    }
    return { scenarioId, at: now, status: detail.length ? 'partial' : 'injected', injected: accepted, planned: Math.max(v.injections.length, spec?.faults.length ?? 0), detail };
  }
  const status = v.status === 'FAILED' ? 'failed' : 'refused';
  return { scenarioId, at: now, status, code: v.errorCode ?? undefined, message: v.errorMessage ?? undefined, injected: accepted, planned: v.injections.length, detail: [] };
}

/** typed fault vs what the backend actually injected: matched by target (the backend chooses the fault kind name itself) */
export interface Match {
  fault: PreviewFault;
  injection: InjectionView | null;
}
export function compareToSpec(spec: PreviewSpec, v: RequestView): { matches: Match[]; extra: InjectionView[] } {
  const used = new Set<InjectionView>();
  const matches = spec.faults.map((fault) => {
    const injection = v.injections.find((i) => i.target === fault.target_id && !used.has(i)) ?? null;
    if (injection) used.add(injection);
    return { fault, injection };
  });
  return { matches, extra: v.injections.filter((i) => !used.has(i)) };
}

// ------------------------------------------------------------------------------------------------ phase chain
export type StepState = 'pending' | 'active' | 'done' | 'failed';
export interface ChainStep {
  id: 'received' | 'classified' | 'interpreted' | 'compiled' | 'injected' | 'incident';
  label: string;
  state: StepState;
  note?: string;
}

/** backend phase -> how many chain steps are complete while the request sits in it (the next one is the active one) */
const DONE_IN_PHASE: Record<string, number> = { RECEIVED: 1, CLASSIFYING: 1, INTERPRETING: 2, VALIDATING: 3, CREATING_RUN: 4 };

/** received -> classified -> interpreted -> compiled -> injected -> incident; every state comes from the backend's phase/status, none is animated */
export function chainOf(v: RequestView | null, submitting = false, direct = false): ChainStep[] {
  if (direct || v?.via === 'command_bus') return directChainOf(v, submitting);
  const steps: ChainStep[] = [
    { id: 'received', label: 'Received', state: 'pending' },
    { id: 'classified', label: 'Classified (Laya)', state: 'pending' },
    { id: 'interpreted', label: 'Interpreted (model)', state: 'pending' },
    { id: 'compiled', label: 'Compiled to faults', state: 'pending' },
    { id: 'injected', label: 'Injected into live run', state: 'pending' },
    { id: 'incident', label: 'Incident opened', state: 'pending' },
  ];
  if (!v) {
    if (submitting) steps[0].state = 'active';
    return steps;
  }
  if (isTerminal(v.status) && v.status !== 'READY') {
    // the backend overwrites the phase with REJECTED/FAILED, so where it stopped is read from what it had produced by then
    const compiled = v.planned.length > 0 || v.rejected.length > 0 || v.unsupported.length > 0 || v.injections.length > 0 || v.crusoe !== null;
    const failIdx = !compiled ? 0 : v.planned.length > 0 ? 4 : 3;
    steps.forEach((s, i) => {
      if (i < failIdx) s.state = 'done';
    });
    steps[failIdx].state = 'failed';
    steps[failIdx].note = [v.errorCode, v.errorMessage].filter(Boolean).join(': ') || v.status;
    return steps;
  }
  const doneThrough = v.status === 'READY' ? 5 : (DONE_IN_PHASE[v.phase] ?? 0);
  steps.forEach((s, i) => {
    if (i < doneThrough) s.state = 'done';
  });
  if (v.status === 'READY') {
    if (v.incidentIds.length) {
      steps[5].state = 'done';
      steps[5].note = v.incidentIds.join(', ');
    } else {
      steps[5].state = 'active';
      steps[5].note = 'waiting: the monitor has not opened an incident yet';
    }
    return steps;
  }
  const next = steps.find((s) => s.state === 'pending');
  if (next) next.state = 'active';
  return steps;
}

/** typed hazard faults sent straight to the command bus: validated -> injected -> incident (no model, no planner) */
export function directChainOf(v: RequestView | null, submitting = false): ChainStep[] {
  const steps: ChainStep[] = [
    { id: 'received', label: 'Spec validated by the backend', state: 'pending' },
    { id: 'injected', label: 'Injected via the command bus', state: 'pending' },
    { id: 'incident', label: 'Incident opened', state: 'pending' },
  ];
  if (!v) {
    if (submitting) steps[0].state = 'active';
    return steps;
  }
  steps[0].state = 'done';
  if (v.status === 'REJECTED' || v.status === 'FAILED') {
    steps[1].state = 'failed';
    steps[1].note = [v.errorCode, v.errorMessage].filter(Boolean).join(': ') || v.status;
    return steps;
  }
  if (v.status !== 'READY') {
    steps[1].state = 'active';
    return steps;
  }
  steps[1].state = 'done';
  if (v.incidentIds.length) {
    steps[2].state = 'done';
    steps[2].note = v.incidentIds.join(', ');
  } else {
    steps[2].state = 'active';
    steps[2].note = 'waiting: the monitor has not opened an incident yet';
  }
  return steps;
}

/** the incident ids opened after an injection (read-only): id unseen before, opened at or after the injection tick */
export function newIncidents(list: unknown, baseline: Set<string>, tick: number, targets: string[]): { ids: string[]; basis: Record<string, string> } {
  const rows = Array.isArray(list) ? list.filter(isObj) : [];
  const fresh = rows
    .filter((i) => typeof i.id === 'string' && !baseline.has(i.id) && num(i.opened_tick) >= tick)
    .sort((a, b) => num(a.opened_tick) - num(b.opened_tick));
  const basis: Record<string, string> = {};
  for (const i of fresh) {
    const aff = new Set([...strs(i.affected_asset_ids), ...(isObj(i.anchor) && typeof i.anchor.entity_id === 'string' ? [i.anchor.entity_id] : [])]);
    basis[i.id as string] = targets.some((t) => aff.has(t)) ? 'touches a faulted target' : 'first new incident after the injection';
  }
  return { ids: fresh.map((i) => i.id as string), basis };
}
