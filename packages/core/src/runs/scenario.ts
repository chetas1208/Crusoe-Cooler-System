import type { FaultKind, Topology } from '../contracts';
import { canonical, hashString } from './hash';
import { FAULT_CATALOG, type FieldSupport, type ModelStatus, type ScenarioFault, type ScenarioSpec, type ScenarioValidation, type ValidationIssue } from './types';

/** Authoring limits — enforced by the UI (clamp) AND by validateScenario (reject). Units are part of the contract. */
export const SCENARIO_LIMITS = {
  maxFaults: 4,
  onsetTick: { min: 20, max: 14400, unit: 'tick (0.5 sim-s)' },
  severity: { min: 0.1, max: 1, step: 0.05, unit: 'fraction of capacity' },
  progressionS: { min: 0, max: 1800, unit: 's' },
  seed: { min: 1, max: 999_999, unit: '' },
  workload: { min: 0.5, max: 1.2, step: 0.05, unit: '× nominal rack load' },
  simSpeed: { min: 0.5, max: 60, unit: 'sim-s per s' },
  approvalWindowS: { min: 5, max: 120, unit: 's' },
  titleMax: 80,
  textMax: 600,
} as const;

const DT_S = 0.5;
export const tickToSeconds = (t: number) => t * DT_S;

/** Which topology entities each supported kind can target in the TS simulator (the real backend reports its own). */
const TARGETS: Partial<Record<FaultKind, { test: (t: Topology, id: string) => boolean; hint: string }>> = {
  fouling: { test: (t, id) => ['p_12', 'p_17'].includes(id) && t.edges.some((e) => e.id === id), hint: 'p_12 or p_17 (zone supply headers)' },
  strainer_blockage: { test: (t, id) => t.assets.some((a) => a.id === id && a.type === 'strainer'), hint: 'strainer_01 or strainer_02' },
  valve_stuck: { test: (t, id) => /^valve_(a1|a2|b1|b2)$/.test(id) && t.assets.some((a) => a.id === id), hint: 'valve_a1, valve_a2, valve_b1 or valve_b2' },
  pump_degradation: { test: (t, id) => t.assets.some((a) => a.id === id && a.type === 'pump'), hint: 'a pump (pump_t1, pump_t2, pump_f1, pump_f2)' },
  sensor_drift: { test: (t, id) => /^sn_flow_(za|zb|trunk)$/.test(id) && t.assets.some((a) => a.id === id), hint: 'sn_flow_za, sn_flow_zb or sn_flow_trunk' },
  workload_spike: { test: (t, id) => t.assets.some((a) => a.id === id && a.type === 'rack'), hint: 'a rack (rack_a1 … rack_b2)' },
};

export function targetsFor(kind: FaultKind, topo: Topology): string[] {
  const rule = TARGETS[kind];
  if (!rule) return [];
  const ids = [...topo.assets.map((a) => a.id), ...topo.edges.map((e) => e.id)];
  return ids.filter((id) => rule.test(topo, id));
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const KINDS = new Set(FAULT_CATALOG.map((c) => c.kind));

function range(issues: ValidationIssue[], path: string, v: unknown, r: { min: number; max: number; unit: string }, label: string, integer = false) {
  if (!isNum(v)) {
    issues.push({ path, severity: 'error', message: `${label} must be a number.`, fix: `Enter a value from ${r.min} to ${r.max}${r.unit ? ` ${r.unit}` : ''}.` });
    return false;
  }
  if (integer && !Number.isInteger(v)) {
    issues.push({ path, severity: 'error', message: `${label} must be a whole number.`, fix: `Round to ${Math.round(v)}.` });
    return false;
  }
  if (v < r.min || v > r.max) {
    issues.push({ path, severity: 'error', message: `${label} ${v} is outside ${r.min}–${r.max}${r.unit ? ` ${r.unit}` : ''}.`, fix: `Choose a value between ${r.min} and ${r.max}.` });
    return false;
  }
  return true;
}

/** What this simulator does with each authored field. The real backend returns its own list. */
export const MOCK_SUPPORT: FieldSupport[] = [
  { path: 'faults[].kind', applied: true, note: 'Injected through the engine fault manager.' },
  { path: 'faults[].target_id', applied: true, note: 'Passed to the fault manager as the location.' },
  { path: 'faults[].onset_tick', applied: true, note: 'Injected when the run reaches this tick.' },
  { path: 'faults[].severity', applied: false, note: 'Recorded in the spec and evidence only. The TS simulator draws fault magnitude from its seeded stream.' },
  { path: 'faults[].progression_s', applied: false, note: 'Recorded only. The TS simulator uses its own per-kind progression time constants.' },
  { path: 'seed', applied: true, note: 'Seeds every random stream.' },
  { path: 'workload_factor', applied: true, note: 'Scales all rack loads.' },
  { path: 'sim_speed', applied: true, note: 'Sim seconds per wall second.' },
  { path: 'agent_policy', applied: true, note: 'Autonomous (operator veto window) or supervised (explicit approval).' },
  { path: 'background_faults', applied: true, note: 'Seeded random faults on top of authored ones.' },
];

export function defaultScenario(): ScenarioSpec {
  return {
    scenario_id: '',
    title: 'Untitled scenario',
    faults: [{ kind: 'fouling', target_id: 'p_17', onset_tick: 120, severity: 0.7, progression_s: 120 }],
    seed: 42,
    workload_factor: 1,
    sim_speed: 6,
    agent_policy: 'autonomous',
    approval_window_s: 24,
    background_faults: false,
  };
}

/** Pure, side-effect-free: never touches a live world. */
export function validateScenario(input: unknown, topo: Topology, backend: 'mock' | 'live' = 'mock'): ScenarioValidation {
  const issues: ValidationIssue[] = [];
  const fail = (): ScenarioValidation => ({ valid: false, spec: null, issues, support: MOCK_SUPPORT, backend });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    issues.push({ path: '', severity: 'error', message: 'Scenario must be an object.', fix: 'Send {faults, seed, workload_factor, sim_speed, agent_policy}.' });
    return fail();
  }
  const s = input as Record<string, unknown>;
  const faultsIn = Array.isArray(s.faults) ? s.faults : null;
  if (!faultsIn) issues.push({ path: 'faults', severity: 'error', message: 'faults must be a list.', fix: 'Add up to four faults, or turn on background faults.' });
  const faults: ScenarioFault[] = [];
  if (faultsIn) {
    if (faultsIn.length > SCENARIO_LIMITS.maxFaults)
      issues.push({ path: 'faults', severity: 'error', message: `At most ${SCENARIO_LIMITS.maxFaults} faults per scenario (got ${faultsIn.length}).`, fix: `Remove ${faultsIn.length - SCENARIO_LIMITS.maxFaults}.` });
    const seen = new Set<string>();
    faultsIn.slice(0, 16).forEach((raw, i) => {
      const p = `faults[${i}]`;
      if (!raw || typeof raw !== 'object') return void issues.push({ path: p, severity: 'error', message: 'Fault must be an object.' });
      const f = raw as Record<string, unknown>;
      const kind = f.kind as FaultKind;
      let ok = true;
      if (typeof kind !== 'string' || !KINDS.has(kind)) {
        issues.push({ path: `${p}.kind`, severity: 'error', message: `Unknown fault kind${typeof kind === 'string' ? ` "${kind.slice(0, 40)}"` : ''}.`, fix: `Use one of: ${FAULT_CATALOG.filter((c) => c.support === 'supported').map((c) => c.kind).join(', ')}.` });
        ok = false;
      } else {
        const cat = FAULT_CATALOG.find((c) => c.kind === kind)!;
        if (cat.support !== 'supported') {
          issues.push({ path: `${p}.kind`, severity: 'error', message: `${cat.label} is planned, not supported.`, fix: cat.reason ?? 'Pick a supported fault kind.' });
          ok = false;
        } else {
          const rule = TARGETS[kind]!;
          if (typeof f.target_id !== 'string' || !rule.test(topo, f.target_id)) {
            const known = typeof f.target_id === 'string' && (topo.assets.some((a) => a.id === f.target_id) || topo.edges.some((e) => e.id === f.target_id));
            issues.push({
              path: `${p}.target_id`,
              severity: 'error',
              message: known ? `${String(f.target_id).slice(0, 40)} exists but ${cat.label.toLowerCase()} cannot be applied to it here.` : `Unknown target "${String(f.target_id).slice(0, 40)}".`,
              fix: `For ${cat.label.toLowerCase()} use ${rule.hint}.`,
            });
            ok = false;
          } else if (seen.has(`${kind}:${f.target_id}`)) {
            issues.push({ path: `${p}.target_id`, severity: 'error', message: `${kind} on ${f.target_id} is listed twice.`, fix: 'Remove the duplicate or change the target.' });
            ok = false;
          } else seen.add(`${kind}:${f.target_id}`);
        }
      }
      ok = range(issues, `${p}.onset_tick`, f.onset_tick, SCENARIO_LIMITS.onsetTick, 'Onset tick', true) && ok;
      ok = range(issues, `${p}.severity`, f.severity, SCENARIO_LIMITS.severity, 'Severity') && ok;
      ok = range(issues, `${p}.progression_s`, f.progression_s, SCENARIO_LIMITS.progressionS, 'Progression time') && ok;
      if (ok) faults.push({ kind, target_id: f.target_id as string, onset_tick: f.onset_tick as number, severity: f.severity as number, progression_s: f.progression_s as number });
    });
  }
  let ok = true;
  ok = range(issues, 'seed', s.seed, SCENARIO_LIMITS.seed, 'Seed', true) && ok;
  ok = range(issues, 'workload_factor', s.workload_factor, SCENARIO_LIMITS.workload, 'Workload') && ok;
  ok = range(issues, 'sim_speed', s.sim_speed, SCENARIO_LIMITS.simSpeed, 'Sim speed') && ok;
  const policy = s.agent_policy;
  if (policy !== 'autonomous' && policy !== 'supervised') {
    issues.push({ path: 'agent_policy', severity: 'error', message: 'Agent policy must be "autonomous" or "supervised".' });
    ok = false;
  }
  const approval = s.approval_window_s ?? 24;
  ok = range(issues, 'approval_window_s', approval, SCENARIO_LIMITS.approvalWindowS, 'Approval window') && ok;
  const bg = s.background_faults === true;
  if (s.background_faults !== undefined && typeof s.background_faults !== 'boolean') issues.push({ path: 'background_faults', severity: 'error', message: 'background_faults must be true or false.' });
  const title = typeof s.title === 'string' ? s.title.trim().slice(0, SCENARIO_LIMITS.titleMax) : '';
  if (typeof s.title === 'string' && s.title.length > SCENARIO_LIMITS.titleMax) issues.push({ path: 'title', severity: 'warning', message: `Title shortened to ${SCENARIO_LIMITS.titleMax} characters.` });
  if (faultsIn && faultsIn.length === 0 && !bg) issues.push({ path: 'faults', severity: 'error', message: 'This scenario would never do anything.', fix: 'Add a fault or enable background faults.' });
  if (policy === 'supervised' && faults.length) issues.push({ path: 'agent_policy', severity: 'info', message: 'Supervised: repairs wait for an explicit approval; an unattended run will stall at "awaiting approval".' });
  for (const f of faults) if (f.severity !== undefined && f.progression_s !== undefined) void f;
  if (faults.some((f) => f.severity < 0.4)) issues.push({ path: 'faults', severity: 'info', message: 'Low severity faults may stay below detection thresholds.' });

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError || !faultsIn) return fail();
  const spec: ScenarioSpec = {
    scenario_id: '',
    title: title || 'Untitled scenario',
    faults,
    seed: s.seed as number,
    workload_factor: s.workload_factor as number,
    sim_speed: s.sim_speed as number,
    agent_policy: policy as 'autonomous' | 'supervised',
    approval_window_s: approval as number,
    background_faults: bg,
  };
  spec.scenario_id = `scn_${hashString(canonical({ ...spec, title: '' })).slice(0, 8)}`;
  return { valid: true, spec, issues, support: MOCK_SUPPORT, backend };
}

/* ───────────────────────── text -> spec (MOCK rules, not a model) ───────────────────────── */

const KIND_WORDS: Array<[FaultKind, RegExp]> = [
  ['leak', /\bleak/i],
  ['strainer_blockage', /strainer|clog|blockage|debris/i],
  ['valve_stuck', /valve.{0,12}(stuck|seiz|jam)|(stuck|seiz|jam).{0,12}valve/i],
  ['pump_degradation', /pump.{0,14}(degrad|wear|fail|weak)|(degrad|wear).{0,14}pump/i],
  ['sensor_drift', /sensor.{0,12}drift|drift/i],
  ['workload_spike', /workload|load spike|power spike|spike/i],
  ['fouling', /foul|deposit|scal(e|ing)|buildup|build-up/i],
];

function resolveTarget(kind: FaultKind, clause: string, topo: Topology): string | null {
  const c = clause.toLowerCase();
  const pool = targetsFor(kind, topo);
  const direct = pool.find((id) => new RegExp(`\\b${id.replace(/[_]/g, '[_ -]?')}\\b`, 'i').test(c));
  if (direct) return direct;
  const label = pool.find((id) => {
    const a = topo.assets.find((x) => x.id === id) ?? topo.edges.find((x) => x.id === id);
    return a && new RegExp(`\\b${a.label.replace(/[-]/g, '[- ]?')}\\b`, 'i').test(c);
  });
  if (label) return label;
  const zone = /zone\s*([ab])\b/i.exec(c);
  if (zone && kind === 'fouling') return zone[1].toLowerCase() === 'a' ? 'p_12' : 'p_17';
  const rack = /rack\s*([ab][12])\b/i.exec(c);
  if (rack) {
    const id = kind === 'valve_stuck' ? `valve_${rack[1].toLowerCase()}` : `rack_${rack[1].toLowerCase()}`;
    if (pool.includes(id)) return id;
  }
  return pool.length === 1 ? pool[0] : null;
}

/** Deterministic keyword interpreter. Honest about being rules, not a language model; everything it cannot map is reported, not guessed. */
export function interpretScenarioText(text: string, topo: Topology): { draft: Record<string, unknown>; unresolved: string[] } {
  const t = text.slice(0, SCENARIO_LIMITS.textMax);
  const unresolved: string[] = [];
  const d = defaultScenario();
  const faults: ScenarioFault[] = [];
  const clauses = t.split(/[.;\n]|\bthen\b|\bafter that\b/i).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const hit = KIND_WORDS.find(([, re]) => re.test(clause));
    if (!hit) {
      if (!/\b(seed|speed|load|supervis|autonom|background|workload)\b/i.test(clause)) unresolved.push(`No fault kind recognised in: "${clause.slice(0, 80)}"`);
      continue;
    }
    const kind = hit[0];
    const target = kind === 'leak' ? '' : resolveTarget(kind, clause, topo);
    if (target === null) {
      unresolved.push(`Could not find a target for ${kind} in: "${clause.slice(0, 80)}"`);
      continue;
    }
    const tick = /\btick\s*(\d+)/i.exec(clause);
    const secs = /\b(?:at|after|in|t\s*=)\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|min|mins|minutes)\b/i.exec(clause);
    let onset: number = d.faults[0].onset_tick;
    if (tick) onset = Number(tick[1]);
    else if (secs) onset = Math.round((Number(secs[1]) * (/^m/i.test(secs[2]) ? 60 : 1)) / DT_S);
    else unresolved.push(`No onset time for ${kind}; using tick ${onset}.`);
    let sev = 0.7;
    const pct = /(\d{1,3})\s*%\s*(?:severity|severe)?/i.exec(clause);
    if (/severe|major|critical|heavy|high/i.test(clause)) sev = 0.85;
    else if (/moderate|medium/i.test(clause)) sev = 0.5;
    else if (/mild|minor|slight|low|small/i.test(clause)) sev = 0.25;
    else if (pct) sev = Number(pct[1]) / 100;
    faults.push({ kind, target_id: target, onset_tick: onset, severity: sev, progression_s: /sudden|abrupt|instant/i.test(clause) ? 0 : /slow|gradual/i.test(clause) ? 600 : 120 });
  }
  const seed = /\bseed\s*(\d+)/i.exec(t);
  const speed = /\b(\d+(?:\.\d+)?)\s*[x×]\b|\bspeed\s*(\d+(?:\.\d+)?)/i.exec(t);
  const load = /\b(\d{2,3})\s*%\s*(?:of\s*)?(?:load|workload)|\bload\s*(\d{2,3})\s*%/i.exec(t);
  return {
    draft: {
      ...d,
      title: t.slice(0, 60).replace(/\s+/g, ' ').trim() || d.title,
      faults,
      seed: seed ? Number(seed[1]) : d.seed,
      sim_speed: speed ? Number(speed[1] ?? speed[2]) : d.sim_speed,
      workload_factor: load ? Number(load[1] ?? load[2]) / 100 : d.workload_factor,
      agent_policy: /supervis/i.test(t) ? 'supervised' : 'autonomous',
      background_faults: /with background|random faults|background faults/i.test(t) && !/no background/i.test(t),
    },
    unresolved,
  };
}

export function validateScenarioText(text: string, topo: Topology): ScenarioValidation {
  if (text.length > SCENARIO_LIMITS.textMax) {
    return { valid: false, spec: null, backend: 'mock', support: MOCK_SUPPORT, issues: [{ path: 'text', severity: 'error', message: `Description is ${text.length} characters; the limit is ${SCENARIO_LIMITS.textMax}.`, fix: 'Shorten it.' }] };
  }
  const { draft, unresolved } = interpretScenarioText(text, topo);
  const v = validateScenario(draft, topo);
  v.interpreter = { provider: 'mock', model_id: 'keyword-rules-v0', kind: 'rules', unresolved };
  for (const u of unresolved) v.issues.push({ path: 'text', severity: 'warning', message: u });
  return v;
}

export function mockModelStatus(): ModelStatus {
  return {
    provider: 'mock',
    model_id: 'mock-policy-v0',
    status: 'mock',
    scenario_text: { available: true, kind: 'rules', reason: 'Mock backend: a keyword interpreter turns text into a draft. No language model is involved.' },
  };
}
