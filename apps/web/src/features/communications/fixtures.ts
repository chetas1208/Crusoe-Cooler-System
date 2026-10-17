/**
 * FIXTURE: synthetic events for unit tests and the `?e2e` Playwright hook ONLY.
 * Nothing in a production code path imports this file; the panel never shows generated text to an operator.
 */
import type { CommunicationEventV1, MessageKind } from './types';

const KINDS: MessageKind[] = ['agent_message', 'task_transition', 'tool_event', 'verification', 'safety', 'operator', 'simulation', 'provider'];
const CLASSES = ['sentinel', 'inpipe', 'outrig', 'operator', 'verifier'];

export function fixtureEvent(seq: number, over: Partial<CommunicationEventV1> = {}, run = 'run_fixture'): CommunicationEventV1 {
  const cls = CLASSES[seq % CLASSES.length];
  const kind = KINDS[seq % KINDS.length];
  return {
    event_id: `${run}#${seq}`,
    run_id: run,
    seq,
    sim_tick: seq * 2,
    sim_time_ms: seq * 1000,
    wall_time_utc: new Date(Date.UTC(2026, 9, 17, 6, 0, 0) + seq * 1000).toISOString(),
    sender: { kind: 'agent', id: cls === 'sentinel' ? 'SEN-0' + (1 + (seq % 5)) : cls === 'inpipe' ? 'IR-0' + (1 + (seq % 9)) : cls === 'outrig' ? 'OR-0' + (1 + (seq % 8)) : cls, class: cls },
    recipient: seq % 3 === 0 ? { kind: 'agent', id: 'SEN-01', class: 'sentinel' } : undefined,
    thread_id: `thr_${seq % 40}`,
    task_id: `task_${seq % 25}`,
    robot_id: cls === 'inpipe' ? 'IR-0' + (1 + (seq % 9)) : undefined,
    message_type: kind,
    phase: 'step',
    status: kind === 'safety' && seq % 7 === 0 ? 'blocked' : 'ok',
    summary: `FIXTURE event ${seq}: ${kind}`,
    evidence_ids: seq % 4 === 0 ? [`ev_${seq}`] : undefined,
    schema_version: '1',
    ...over,
  };
}

export const fixtureBurst = (from: number, n: number, run = 'run_fixture') => Array.from({ length: n }, (_, i) => fixtureEvent(from + i, {}, run));
