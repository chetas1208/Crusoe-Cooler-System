import { describe, expect, it } from 'vitest';
import { activeLlm, deriveSeatCards, incidentWarnings, parseSeatTeam, tierOf } from '../seats';
import { edgeEnvelopes, edgeLabel, parseEnvEvents } from '../envelopes';

const NANO = { provider: 'crusoe', model_id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', fallback: false, latency_ms: 900 };
const SUPER = { provider: 'crusoe', model_id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B', fallback: false, latency_ms: 5000 };
const POLICY = { provider: 'deterministic', model_id: 'policy-engine-v1', fallback: false, latency_ms: 3 };
const task = (id: string, seat: string, status: string, model: unknown, extra: Record<string, unknown> = {}) => ({ id, seat, role: 'sentinel', kind: 'x', title: `T ${id}`, status, parent_id: null, depth: 0, robot_id: null, model, tool_calls: 2, ...extra });
const raw = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  seats: ['SEN-01', 'SEN-02', 'SEN-03', 'SEN-04', 'SEN-05'].map((s) => ({ seat: s, function: `fn ${s}`, tasks: [] })),
  tasks,
  budgets: { limits: { max_depth: 3, max_active_llm_subtasks_per_incident: 6, max_plan_revisions: 2 }, max_depth_seen: 1, llm_tasks: 3, plan_revisions: 0 },
  warnings: [],
  ...extra,
});

describe('model tier comes from decision metadata', () => {
  it('maps Nano / Super / deterministic and never guesses', () => {
    expect(tierOf(NANO)).toBe('nano');
    expect(tierOf(SUPER)).toBe('super');
    expect(tierOf(POLICY)).toBe('policy');
    expect(tierOf({ provider: 'crusoe', model_id: 'x', fallback: true })).toBe('policy');
    expect(tierOf({ provider: 'crusoe', model_id: 'some-other-model' })).toBe('other');
    expect(tierOf(undefined)).toBe('none');
    expect(tierOf({})).toBe('none');
  });
});

describe('seat cards', () => {
  it('always yields the five seats with the V11 names, even with no data', () => {
    const c = deriveSeatCards(null);
    expect(c.map((x) => x.id)).toEqual(['SEN-01', 'SEN-02', 'SEN-03', 'SEN-04', 'SEN-05']);
    expect(c.map((x) => x.title)).toEqual(['Goal Architect', 'INPIPE Field Coordinator', 'OUTRIG Maintenance Coordinator', 'Safety & Governance Arbiter', 'Independent Verifier']);
    expect(c.every((x) => x.state === 'no_data')).toBe(true);
  });

  it('derives current task, tier tally, budget and verdict per seat', () => {
    const team = parseSeatTeam(
      raw([
        task('t_1', 'SEN-01', 'completed', NANO),
        task('t_2', 'SEN-01', 'completed', SUPER, { tool_calls: 3 }),
        task('t_3', 'SEN-01', 'working', NANO),
        task('t_4', 'SEN-04', 'completed', POLICY),
      ]),
      'INC-1',
    )!;
    const c = deriveSeatCards(team, { outcomes: { t_4: { label: 'Within policy', ok: true } } });
    const s1 = c[0];
    expect(s1.state).toBe('working');
    expect(s1.currentTask?.id).toBe('t_3');
    expect(s1.tier).toBe('nano');
    expect(s1.tierTally).toEqual([{ tier: 'nano', n: 2 }, { tier: 'super', n: 1 }]);
    expect(s1.modelCalls).toBe(3);
    expect(s1.toolCalls).toBe(7);
    expect(c[3].verdict).toEqual({ tone: 'neutral', text: 'Completed: Within policy' });
    expect(c[1].state).toBe('idle');
    expect(activeLlm(team)).toEqual({ active: 1, limit: 6 });
  });

  it('never paints a failure green', () => {
    const team = parseSeatTeam(raw([task('t_1', 'SEN-03', 'failed', POLICY), task('t_2', 'SEN-04', 'rejected', POLICY), task('t_3', 'SEN-01', 'completed', NANO)]), 'INC-1')!;
    const c = deriveSeatCards(team, { outcomes: { t_3: { label: 'Valve still closed', ok: false } } });
    expect(c[2].state).toBe('failed');
    expect(c[2].verdict?.tone).toBe('bad');
    expect(c[3].verdict?.text).toMatch(/^Rejected/);
    expect(c[0].verdict?.tone).toBe('warn'); // completed with a negative outcome is amber, not green
  });

  it('a verifier rejection is a failed seat even though its task completed', () => {
    const team = parseSeatTeam(raw([task('t_9', 'SEN-05', 'completed', SUPER)]), 'INC-1')!;
    const c = deriveSeatCards(team, { verification: { status: 'rejected', passed: 1, total: 2, reason: 'flow below limit', attempt: 1 } });
    expect(c[4].state).toBe('failed');
    expect(c[4].verdict).toEqual({ tone: 'bad', text: 'Rejected 1/2 checks, attempt 1: flow below limit' });
  });

  it('shows unrecognised states as unknown, not as idle or done', () => {
    const team = parseSeatTeam(raw([task('t_1', 'SEN-02', 'teleporting', POLICY)]), 'INC-1')!;
    const s2 = deriveSeatCards(team)[1];
    expect(s2.state).toBe('unknown');
    expect(s2.stateLabel).toContain('teleporting');
  });

  it('puts drift / loop warnings on the seat that owns the task, others on the incident', () => {
    const team = parseSeatTeam(
      raw([task('t_1', 'SEN-01', 'working', NANO)], {
        warnings: [
          { seq: 1, type: 'drift.detected', kind: 'stuck_stage', task_id: 't_1' },
          { seq: 2, type: 'loop.detected', message: 'same tool 5 times' },
        ],
      }),
      'INC-1',
    )!;
    const c = deriveSeatCards(team);
    expect(c[0].warnings).toEqual([{ kind: 'drift', text: 'stuck stage', taskId: 't_1', seat: undefined, seq: 1 }]);
    expect(incidentWarnings(team).map((w) => `${w.kind}:${w.text}`)).toEqual(['loop:same tool 5 times']);
  });

  it('returns null for junk and strips control characters', () => {
    expect(parseSeatTeam(null, 'x')).toBeNull();
    expect(parseSeatTeam({}, 'x')).toBeNull();
    const t = parseSeatTeam(raw([task('t_1', 'SEN-01', 'working', NANO, { title: 'a\u0007b' })]), 'x')!;
    expect(t.tasks[0].title).toBe('ab');
  });
});

describe('envelope kinds on edges', () => {
  const tasks = [
    { id: 't_1', kind: 'classify', seat: 'SEN-01' },
    { id: 't_2', kind: 'service', seat: 'SEN-03' },
    { id: 't_3', kind: 'verify', seat: 'SEN-05' },
    { id: 't_4', kind: 'verify', seat: 'SEN-05' },
  ];
  const events = parseEnvEvents({
    events: [
      { seq: 1, kind: 'TASK_ASSIGN', task_id: 't_2', subtype: 'task.delegated' },
      { seq: 2, kind: 'ACK', task_id: 't_2' },
      { seq: 3, kind: 'PROGRESS', task_id: 't_2' },
      { seq: 4, kind: 'MODEL_ERROR', task_id: 't_1' },
      { seq: 5, kind: 'VERIFICATION_REQUEST', subtype: 'verification.started' },
      { seq: 6, kind: 'VERIFICATION_RESULT', subtype: 'verification.failed' },
      { seq: 7, kind: 'VERIFICATION_REQUEST', subtype: 'verification.started' },
      { seq: 8, kind: 'VERIFICATION_RESULT', subtype: 'verification.passed' },
      { seq: 9, kind: 'TASK_ASSIGN', task_id: 'not_in_scope' },
      { seq: 10, kind: 'lowercase_junk', task_id: 't_1' },
    ],
  });
  const m = edgeEnvelopes(events, tasks);
  it('ignores tool chatter, junk and out-of-scope tasks', () => {
    expect(events).toHaveLength(9);
    expect(m['t_2'].map((t) => t.kind)).toEqual(['TASK_ASSIGN', 'ACK']);
    expect(m['not_in_scope']).toBeUndefined();
  });
  it('marks failure kinds as bad', () => {
    expect(m['t_1']).toEqual([{ kind: 'MODEL_ERROR', bad: true }]);
    expect(edgeLabel(m['t_1'])).toMatchObject({ text: 'MODEL_ERROR', bad: true });
  });
  it('pairs the k-th verification attempt with the k-th verify task and flags a failed verdict', () => {
    expect(m['t_3']).toEqual([{ kind: 'VERIFICATION_RESULT', bad: true }, { kind: 'VERIFICATION_REQUEST', bad: false }]);
    expect(m['t_4'][0]).toEqual({ kind: 'VERIFICATION_RESULT', bad: false });
  });
  it('has no label when nothing was recorded', () => {
    expect(edgeLabel(undefined)).toBeNull();
    expect(edgeLabel([])).toBeNull();
    expect(edgeLabel(m['t_2'])).toMatchObject({ text: 'TASK_ASSIGN +1', bad: false });
  });
});
