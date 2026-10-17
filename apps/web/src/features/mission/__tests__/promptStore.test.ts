import { beforeEach, describe, expect, it } from 'vitest';
import { usePromptRequest } from '../promptStore';

const S = () => usePromptRequest.getState();
const st = () => S().steps.map((x) => x.state).join(',');
beforeEach(() => S().dismiss());

describe('prompt status chain', () => {
  it('walks received -> running from the backend phases, never ahead of them', () => {
    S().begin('x');
    expect(st()).toBe('active,pending,pending,pending,pending');
    S().update({ request_id: 'req_1', phase: 'CLASSIFYING', status: 'PROCESSING' });
    expect(st()).toBe('done,active,pending,pending,pending');
    S().update({ phase: 'INTERPRETING', status: 'PROCESSING', interpretation: { latencies_ms: { laya_ms: 12 }, laya: { engine: 'rule_fallback' } } });
    expect(st()).toBe('done,done,active,pending,pending');
    expect(S().latencies?.laya_ms).toBe(12);
    S().update({ phase: 'VALIDATING' });
    S().update({ phase: 'RUNNING', status: 'READY', run_id: 'run_9' });
    expect(st()).toBe('done,done,done,done,done');
    expect(S().runId).toBe('run_9');
    expect(S().steps.every((x) => x.atMs !== null)).toBe(true);
  });
  it('marks the step that was in progress as failed and keeps the server error text', () => {
    S().begin('x');
    S().update({ phase: 'INTERPRETING', status: 'PROCESSING' });
    S().update({ phase: 'FAILED', status: 'FAILED', error_message: 'provider unavailable', error_code: 'MODEL_DOWN' });
    expect(st()).toBe('done,done,failed,pending,pending');
    expect(S().error).toMatchObject({ at: 'interpreted', message: 'provider unavailable', code: 'MODEL_DOWN' });
  });
  it('a network failure on submit fails the first step', () => {
    S().begin('x');
    S().fail('submit', 'HTTP 503');
    expect(st()).toBe('failed,pending,pending,pending,pending');
  });

  it('a REJECTED request fails the step it stopped at and keeps the server reason verbatim', () => {
    S().begin('x');
    S().update({ phase: 'VALIDATING', status: 'PROCESSING' });
    S().update({ phase: 'REJECTED', status: 'REJECTED', error_code: 'UNSUPPORTED_FAULT', error_message: 'target p_17 is not faultable' });
    expect(S().error).toMatchObject({ message: 'target p_17 is not faultable', code: 'UNSUPPORTED_FAULT' });
    expect(S().steps.some((x) => x.state === 'failed')).toBe(true);
  });
  it('reads the live link: injections, refusals, and incident ids that arrive later', () => {
    S().begin('x');
    S().update({ phase: 'RUNNING', status: 'READY', run_id: 'run_live', live: { run_id: 'run_live', injections: [{ kind: 'fouling', target: 'p_hs_b', accepted: true }], rejected: [{ family: 'leak', reason: 'no leak physics' }], unsupported: [], incident_ids: [] } });
    expect(S().live?.injections[0]).toMatchObject({ kind: 'fouling', target: 'p_hs_b', accepted: true });
    expect(S().live?.incidentIds).toEqual([]);
    S().update({ live: { run_id: 'run_live', injections: [], rejected: [], unsupported: [], incident_ids: ['INC-004'] } });
    expect(S().live?.incidentIds).toEqual(['INC-004']);
  });
});
