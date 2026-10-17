import { cleanText } from '../communications/schemas';

/** lk.scorecard.v1 (backend/src/loopkeeper/eval, served read-only at GET /api/v1/eval/scorecard). Every number shown is copied from it, with its denominator. */
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export interface Rate { k: number | null; n: number | null; rate: number | null; ci95: [number | null, number | null] }
export interface ArmRow {
  arm: string;
  n_runs: number | null;
  n_errors: number | null;
  verified: Rate;
  plantRecovered: { k: number | null; n: number | null };
  falseSuccess: { k: number | null; n_claims: number | null; n_runs: number | null; rate: number | null; ci95: [number | null, number | null] };
  containment: { n: number | null; median: number | null; p90: number | null };
  recovery: { n: number | null; median: number | null; p90: number | null };
  costTotal: number | null;
  costPerVerified: number | null;
  trace: { traced: number | null; total: number | null; rate: number | null };
  unsafe: { proposed: number | null; blocked: number | null };
  perScenario: Array<{ id: string; recovered: number | null; verified: number | null; falseSuccess: number | null; n: number | null }>;
}
export interface Scorecard {
  schema: string;
  generated_at: string;
  manifest_sha256: string;
  n_scenarios: number | null;
  n_seeds: number | null;
  arms: ArmRow[];
  /** verbatim, never rewritten: the recursive DOD + delegation arm may be NOT RUN */
  recursiveStatus: string | null;
  replay: { replayed: number | null; identical: number | null; different: number | null; modelCalls: number | null };
  unsafeProbe: { probes: number | null; answered: number | null; proposedUnsafe: number | null; blocked: number | null; refusedOrSafe: number | null } | null;
  spend: Record<string, number | string | null>;
}

const rate = (r: unknown): Rate => {
  const o = isObj(r) ? r : {};
  const ci = Array.isArray(o.ci95) ? o.ci95 : [];
  return { k: num(o.k), n: num(o.n), rate: num(o.rate), ci95: [num(ci[0]), num(ci[1])] };
};
const pct = (o: unknown) => (isObj(o) ? { n: num(o.n), median: num(o.median), p90: num(o.p90) } : { n: null, median: null, p90: null });

export function parseScorecard(raw: unknown): Scorecard | null {
  if (!isObj(raw) || !isObj(raw.arms)) return null;
  const arms: ArmRow[] = Object.entries(raw.arms).flatMap(([name, a]) => {
    if (!isObj(a)) return [];
    const fs = isObj(a.false_success) ? a.false_success : {};
    const ci = Array.isArray(fs.ci95_of_claims) ? fs.ci95_of_claims : [];
    const tc = isObj(a.trace_coverage) ? a.trace_coverage : {};
    const ua = isObj(a.unsafe_actions_in_runs) ? a.unsafe_actions_in_runs : {};
    const pr = isObj(a.plant_recovered_at_end) ? a.plant_recovered_at_end : {};
    const ps = isObj(a.per_scenario) ? a.per_scenario : {};
    return [{
      arm: cleanText(name, 40),
      n_runs: num(a.n_runs),
      n_errors: num(a.n_errors),
      verified: rate(a.verified_completion),
      plantRecovered: { k: num(pr.k), n: num(pr.n) },
      falseSuccess: { k: num(fs.k), n_claims: num(fs.n_claims), n_runs: num(fs.n_runs), rate: num(fs.rate_of_claims), ci95: [num(ci[0]), num(ci[1])] },
      containment: pct(a.sim_s_to_containment_after_onset),
      recovery: pct(a.sim_s_to_recovery_after_onset),
      costTotal: num(a.cost_usd_total),
      costPerVerified: num(a.cost_per_verified_run_usd),
      trace: { traced: num(tc.actions_traced), total: num(tc.actions_total), rate: num(tc.rate) },
      unsafe: { proposed: num(ua.proposed), blocked: num(ua.blocked) },
      perScenario: Object.entries(ps).flatMap(([id, s]) => (isObj(s) ? [{ id: cleanText(id, 16), recovered: num(s.recovered), verified: num(s.verified), falseSuccess: num(s.false_success), n: num(s.n) }] : [])),
    }];
  });
  const rd = isObj(raw.replay_determinism) ? raw.replay_determinism : {};
  const up = isObj(raw.unsafe_action_probe) ? raw.unsafe_action_probe : null;
  const sp = isObj(raw.spend) ? raw.spend : {};
  return {
    schema: cleanText(raw.schema ?? '', 40),
    generated_at: cleanText(raw.generated_at ?? '', 40),
    manifest_sha256: cleanText(raw.manifest_sha256 ?? '', 80),
    n_scenarios: num(raw.n_scenarios),
    n_seeds: num(raw.n_seeds),
    arms,
    recursiveStatus: isObj(raw.recursive) && typeof raw.recursive.status === 'string' ? cleanText(raw.recursive.status, 600) : null,
    replay: { replayed: num(rd.runs_replayed), identical: num(rd.identical), different: num(rd.different), modelCalls: num(rd.model_network_calls_during_replay) },
    unsafeProbe: up ? { probes: num(up.n_probes), answered: num(up.n_answered), proposedUnsafe: num(up.model_proposed_unsafe), blocked: num(up.policy_blocked), refusedOrSafe: num(up.model_refused_or_safe) } : null,
    spend: Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === 'number' || typeof v === 'string' || v === null).map(([k, v]) => [cleanText(k, 40), typeof v === 'string' ? cleanText(v, 80) : (v as number | null)])),
  };
}

export const fmtRate = (r: Rate) => (r.k === null || r.n === null ? 'n/a' : `${r.k}/${r.n}${r.rate !== null ? ` (${(r.rate * 100).toFixed(1)}%)` : ''}`);
export const fmtCi = (ci: [number | null, number | null]) => (ci[0] === null || ci[1] === null ? '' : `95% CI ${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%`);
