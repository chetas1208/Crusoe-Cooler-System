import { describe, expect, it } from 'vitest';
import { parseContract, parseTeam, whyNotDone } from '../schemas';
import { fixtureContract, fixtureTeam } from '../fixtures';

describe('contract parsing', () => {
  it('never lets an unmeasured check pass, and keeps measured values and hold timers', () => {
    const c = parseContract(fixtureContract)!;
    // c1 is "passing" (hold not yet met, but measured); c3 claimed passing with measured null -> UNKNOWN
    expect(c.checks.map((k) => k.state)).toEqual(['PASS', 'FAIL', 'UNKNOWN']);
    expect(c.checks[2].measured).toBeNull();
    expect(c.checks[0]).toMatchObject({ measured: 9.4, hold_required_s: 120, hold_elapsed_s: 45, comparator: '>=', asset_id: 'rack_a3' });
    expect(c.checks[2].comparator).toBe('<=');
    expect(c.revision_reason).toContain('verifier review');
    expect(c.revision).toBe(2);
    expect(c.lifecycle).toBe('EVALUATING');
  });
  it('escapes nothing and bounds everything (text stays text, control chars stripped)', () => {
    const c = parseContract({ contract_id: 'x', checks: [{ label: '<b>x</b>\u0007' + 'y'.repeat(500), measured: 1 }] })!;
    expect(c.checks[0].label.startsWith('<b>x</b>y')).toBe(true);
    expect(c.checks[0].label.length).toBe(200);
  });
  it('returns null for junk', () => {
    expect(parseContract(null)).toBeNull();
    expect(parseContract({})).toBeNull();
  });
});

describe('why not done yet', () => {
  const base = parseContract(fixtureContract)!;
  it('names the failing check with measured vs threshold', () => {
    const w = whyNotDone(base);
    expect(w.done).toBe(false);
    expect(w.text).toContain('TCS flow restored');
    expect(w.text).toContain('2.10 kg/s');
    expect(w.text).toContain('>= 3');
  });
  it('is never "done" from checks alone: all PASS without a terminal verdict waits for the verifier', () => {
    const allPass = { ...base, checks: base.checks.slice(0, 1).map((k) => ({ ...k, hold_elapsed_s: 120 })) };
    const w = whyNotDone(allPass);
    expect(w.done).toBe(false);
    expect(w.text).toMatch(/independent verifier/);
  });
  it('reports a hold that is still running', () => {
    const w = whyNotDone({ ...base, checks: base.checks.slice(0, 1) });
    expect(w.text).toContain('held 45 s of the required 2m 0s');
  });
  it('only a server VERIFIED terminal state says done', () => {
    expect(whyNotDone({ ...base, terminal: 'VERIFIED' }).done).toBe(true);
    expect(whyNotDone({ ...base, terminal: 'CONTAINED_NOT_REPAIRED' }).text).toMatch(/contained not repaired/);
    expect(whyNotDone({ ...base, lifecycle: 'PROPOSED' }).text).toMatch(/not frozen/);
    expect(whyNotDone(null).done).toBe(false);
  });
});

describe('team parsing', () => {
  it('reads tasks, owners, depth, budgets and loop warnings', () => {
    const t = parseTeam(fixtureTeam);
    expect(t.members).toHaveLength(5);
    expect(t.tasks[1]).toMatchObject({ owner: 'IR-03', parent_id: 't1', depth: 1, tool_calls: 9 });
    expect(t.tasks[1].warnings[0]).toMatchObject({ kind: 'loop', text: 'same inspection requested 3 times' }); // attached to the task it names
    expect(t.warnings).toEqual([{ kind: 'drift', text: 'plan diverged from the frozen goal', seq: 12 }]);
    expect(t.budgets).toMatchObject({ max_depth: 3, depth_seen: 1, llm_tasks: 1, max_plan_revisions: 2, plan_revisions: 1 });
    expect(parseTeam(undefined)).toEqual({ members: [], tasks: [], budgets: null, warnings: [] });
  });
});
