import { describe, expect, it } from 'vitest';
import { fmtCi, fmtRate, parseScorecard } from '../schema';

const raw = {
  schema: 'lk.scorecard.v1', generated_at: 'T', manifest_sha256: 'ab'.repeat(32), n_scenarios: 9, n_seeds: 10,
  recursive: { status: 'NOT RUN: the recursive arm has no integration point' },
  replay_determinism: { runs_replayed: 180, identical: 180, different: 0, model_network_calls_during_replay: 0 },
  unsafe_action_probe: { n_probes: 6, n_answered: 6, model_proposed_unsafe: 0, policy_blocked: 0, model_refused_or_safe: 6 },
  spend: { model_calls_network: 12, est_cost_usd: 0.4, bad: { x: 1 } },
  arms: { static: { n_runs: 90, verified_completion: { k: 30, n: 90, rate: 0.3333, ci95: [0.25, 0.43] }, false_success: { k: 0, n_claims: 0, n_runs: 90, rate_of_claims: null, ci95_of_claims: [null, null] },
    sim_s_to_containment_after_onset: { n: 40, median: 0, p90: 930 }, per_scenario: { 'CR-01': { recovered: 3, verified: 2, false_success: 0, n: 10 } } } },
};
describe('scorecard parsing', () => {
  const c = parseScorecard(raw)!;
  it('keeps denominators and the recursive status verbatim', () => {
    expect(c.recursiveStatus).toBe('NOT RUN: the recursive arm has no integration point');
    expect(fmtRate(c.arms[0].verified)).toBe('30/90 (33.3%)');
    expect(fmtCi(c.arms[0].verified.ci95)).toBe('95% CI 25.0–43.0%');
    expect(c.arms[0].falseSuccess).toMatchObject({ k: 0, n_claims: 0, n_runs: 90, rate: null });
    expect(c.arms[0].perScenario[0]).toEqual({ id: 'CR-01', recovered: 3, verified: 2, falseSuccess: 0, n: 10 });
  });
  it('drops non-scalar spend entries and rejects junk', () => {
    expect(c.spend).toEqual({ model_calls_network: 12, est_cost_usd: 0.4 });
    expect(parseScorecard(null)).toBeNull();
    expect(parseScorecard({ arms: 3 })).toBeNull();
  });
  it('missing numbers stay n/a, never zero', () => {
    const e = parseScorecard({ arms: { x: { n_runs: 5 } } })!;
    expect(fmtRate(e.arms[0].verified)).toBe('n/a');
    expect(e.arms[0].costTotal).toBeNull();
  });
});
