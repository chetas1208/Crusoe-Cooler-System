import { describe, expect, it } from 'vitest';
import { classifyModel, fmtInt, fmtUsd, seatChips, tallyChecks, terminalWording, usageOf } from '../summary';
import { deriveSeatCards } from '../../agents/seats';

describe('terminal state wording', () => {
  const tally = tallyChecks([{ state: 'PASS' }, { state: 'FAIL' }, { state: 'UNKNOWN' }]);
  it('says fixed only for VERIFIED', () => {
    expect(terminalWording('VERIFIED', tally, true)).toMatchObject({ tone: 'good', headline: 'Fixed and verified' });
    for (const t of ['PARTIAL', 'CONTAINED_NOT_REPAIRED', 'ESCALATED', 'FAILED', 'TIMED_OUT', 'UNKNOWN', 'SOMETHING_NEW']) {
      const w = terminalWording(t, tally, true);
      expect(w.tone, t).not.toBe('good');
      expect(w.headline.toLowerCase(), t).not.toMatch(/^fixed/);
    }
  });
  it('uses plain language and the check tally', () => {
    expect(terminalWording('CONTAINED_NOT_REPAIRED', tally, true).detail).toMatch(/isolated.*still there/);
    expect(terminalWording('PARTIAL', tally, true).detail).toContain('1 of 3 checks pass, 1 fail, 1 not measured');
    expect(terminalWording('ESCALATED', tally, true).tone).toBe('bad');
    expect(terminalWording('TIMED_OUT', tally, true).headline).toBe('Ran out of time');
  });
  it('is honest when there is no terminal state or no contract', () => {
    expect(terminalWording(null, tally, true).headline).toBe('In progress');
    expect(terminalWording(null, null, false).headline).toBe('No Definition of Done published');
    expect(terminalWording('mystery', null, true).headline).toBe('Unrecognised outcome');
  });
});

describe('Crusoe model status', () => {
  const ok = { provider: 'crusoe', model_id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', status: 'live', last_latency_ms: 1730, fallback_active: false };
  it('live only when everything agrees', () => {
    expect(classifyModel(ok, { model_state: 'live' }, { fetched: true, failed: false })).toMatchObject({ state: 'live', tone: 'good', latencyMs: 1730 });
  });
  it('degraded when the engine says degraded / fallback, even if the endpoint says live', () => {
    expect(classifyModel(ok, { model_state: 'degraded' }, { fetched: true, failed: false }).state).toBe('degraded');
    expect(classifyModel(ok, { model_state: 'fallback' }, { fetched: true, failed: false }).state).toBe('degraded');
    expect(classifyModel({ ...ok, fallback_active: true }, null, { fetched: true, failed: false }).state).toBe('degraded');
  });
  it('unavailable when the endpoint says so, when it fails, and for unknown values', () => {
    expect(classifyModel({ ...ok, status: 'unavailable' }, null, { fetched: true, failed: false }).state).toBe('unavailable');
    expect(classifyModel(null, null, { fetched: true, failed: true })).toMatchObject({ state: 'unavailable', tone: 'bad' });
    const u = classifyModel({ ...ok, status: 'banana' }, null, { fetched: true, failed: false });
    expect(u.state).not.toBe('live');
    expect(u.tone).not.toBe('good');
  });
  it('mock is never shown as live; before the first answer it is only "checking"', () => {
    expect(classifyModel({ ...ok, status: 'mock' }, null, { fetched: true, failed: false })).toMatchObject({ state: 'mock', tone: 'warn' });
    expect(classifyModel(null, null, { fetched: false, failed: false }).state).toBe('checking');
  });
});

describe('usage', () => {
  it('reads tokens from engine health and never estimates cost', () => {
    const u = usageOf({ status: 'live' }, { tokens_in: 1000, tokens_out: 200, calls: 5, failures: 1 });
    expect(u).toEqual({ tokensIn: 1000, tokensOut: 200, calls: 5, failures: 1, costUsd: null });
    expect(fmtUsd(u.costUsd)).toBe('not reported');
    expect(fmtInt(1000)).toBe('1,000');
  });
  it('prefers what the model-status endpoint itself reports', () => {
    expect(usageOf({ status: 'live', usage: { tokens_in: 5, cost_usd: 0.4321 } }, { tokens_in: 1 }).costUsd).toBe(0.4321);
    expect(usageOf({ status: 'live', usage: { tokens_in: 5 } }, { tokens_in: 1 }).tokensIn).toBe(5);
    expect(fmtUsd(0.004)).toBe('$0.0040');
  });
});

describe('seat chips', () => {
  it('always five, failures are bad, unknown is never idle', () => {
    const chips = seatChips(deriveSeatCards(null));
    expect(chips).toHaveLength(5);
    expect(chips.every((c) => c.label === 'no data')).toBe(true);
  });
});
