import { beforeEach, describe, expect, it } from 'vitest';
import { resetCommunicationsForTest, NO_ADV, useCommunications } from '../communicationStore';
import { fixtureEvent } from '../fixtures';
import { DIVIDER_H, HEAD_H, ROW_H, buildItems, indexAt, moveActive, scrollToReveal } from '../listModel';
import { activeChips, filterCount } from '../chips';
import { chipsOf, outcomeOf, redact, REDACTED, taskDepths, fmtWall } from '../format';
import { computeVarWindow } from '../virtualization';
import { parseS } from '../Filters';
import type { CommunicationEventV1 } from '../types';

const ev = (seq: number, over: Partial<CommunicationEventV1> = {}) => fixtureEvent(seq, { thread_id: 'INC-1', task_id: undefined, robot_id: undefined, ...over });
const base = { grouped: true, collapsed: {}, density: 'comfortable' as const, depths: new Map<string, number>(), newAfterSeq: null };

describe('thread grouping', () => {
  it('puts a collapsible header over a run of 2+ messages of one thread and leaves a lone message flat', () => {
    const evs = [ev(1), ev(2), ev(3, { thread_id: 'INC-2' }), ev(4, { thread_id: 'INC-3' }), ev(5, { thread_id: 'INC-3' })];
    const { items } = buildItems(evs, base);
    expect(items.map((i) => i.t)).toEqual(['head', 'row', 'row', 'row', 'head', 'row', 'row']);
    const h = items[0];
    expect(h.t === 'head' && h.thread).toMatchObject({ id: 'INC-1', count: 2, collapsed: false });
  });
  it('a collapsed thread keeps its header (with the live count) and drops its rows; other threads are untouched', () => {
    const evs = [ev(1), ev(2), ev(3), ev(4, { thread_id: 'INC-9' })];
    const { items } = buildItems(evs, { ...base, collapsed: { 'INC-1': true } });
    expect(items.map((i) => i.t)).toEqual(['head', 'row']);
    expect(items[0].t === 'head' && items[0].thread.count).toBe(3);
    expect(items[0].t === 'head' && items[0].thread.collapsed).toBe(true);
  });
  it('counts failures per thread and flat mode shows no headers', () => {
    const evs = [ev(1), ev(2, { status: 'failed' }), ev(3, { message_type: 'TOOL_REJECTED' })];
    const g = buildItems(evs, base).items[0];
    expect(g.t === 'head' && g.thread.fails).toBe(2);
    expect(buildItems(evs, { ...base, grouped: false }).items.every((i) => i.t === 'row')).toBe(true);
  });
  it('prefix sums add up and density changes row height only', () => {
    const evs = [ev(1), ev(2), ev(3)];
    const a = buildItems(evs, base);
    expect(a.offsets[a.items.length]).toBe(HEAD_H + 3 * ROW_H.comfortable);
    const b = buildItems(evs, { ...base, density: 'compact' });
    expect(b.offsets[b.items.length]).toBe(HEAD_H + 3 * ROW_H.compact);
  });
  it('inserts the new-messages divider before the first unread message, once, and never first', () => {
    const evs = [ev(1), ev(2), ev(3), ev(4)];
    const { items } = buildItems(evs, { ...base, grouped: false, newAfterSeq: 2 });
    expect(items.map((i) => i.t)).toEqual(['row', 'row', 'divider', 'row', 'row']);
    const d = items[2];
    expect(d.t === 'divider' && d.count).toBe(2);
    expect(items[2].h).toBe(DIVIDER_H);
    expect(buildItems(evs, { ...base, grouped: false, newAfterSeq: 0 }).items[0].t).toBe('row'); // everything is new: no divider above the first row
    expect(buildItems(evs, { ...base, newAfterSeq: 2 }).items.filter((i) => i.t === 'divider')).toHaveLength(1);
  });
  it('indents sub-tasks by the parent chain, capped', () => {
    const evs = [ev(1, { task_id: 'a' }), ev(2, { task_id: 'b', parent_id: 'a' }), ev(3, { task_id: 'c', parent_id: 'b' }), ev(4, { task_id: 'd', parent_id: 'c' }), ev(5, { task_id: 'e', parent_id: 'd' })];
    const d = taskDepths(evs);
    expect([d.get('b'), d.get('c'), d.get('d'), d.get('e')]).toEqual([1, 2, 3, 3]);
    expect(d.get('a')).toBeUndefined();
    const loop = taskDepths([ev(1, { task_id: 'x', parent_id: 'y' }), ev(2, { task_id: 'y', parent_id: 'x' })]);
    expect(loop.get('x')).toBeLessThanOrEqual(3); // a cycle in the data cannot hang the list
  });
});

describe('windowing variable heights', () => {
  const evs = Array.from({ length: 3000 }, (_, i) => ev(i + 1, { thread_id: `T${Math.floor(i / 7)}` }));
  const { offsets, items } = buildItems(evs, base);
  it('keeps the DOM bounded anywhere and the padding adds up to the total', () => {
    for (const top of [0, 5000, offsets[items.length] / 2, offsets[items.length] - 600]) {
      const w = computeVarWindow(offsets, top, 600);
      expect(w.end - w.start).toBeLessThan(30);
      const mid = offsets[w.end] - offsets[w.start];
      expect(w.padTop + mid + w.padBottom).toBe(offsets[items.length]);
    }
  });
  it('finds the item under a scroll offset', () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, HEAD_H)).toBe(1);
    expect(indexAt(offsets, HEAD_H + ROW_H.comfortable - 1)).toBe(1);
    expect(indexAt(offsets, HEAD_H + ROW_H.comfortable)).toBe(2);
  });
});

describe('keyboard navigation', () => {
  const keys = ['a', 'b', 'c', 'd'];
  it('j / k move by one and clamp at the ends; Home / End jump', () => {
    expect(moveActive(keys, 'a', 1)).toBe('b');
    expect(moveActive(keys, 'd', 1)).toBe('d');
    expect(moveActive(keys, 'a', -1)).toBe('a');
    expect(moveActive(keys, 'b', 'last')).toBe('d');
    expect(moveActive(keys, 'c', 'first')).toBe('a');
    expect(moveActive(keys, 'a', 8)).toBe('d');
  });
  it('with no active row j starts at the top and k at the newest; an empty list stays null', () => {
    expect(moveActive(keys, null, 1)).toBe('a');
    expect(moveActive(keys, null, -1)).toBe('d');
    expect(moveActive(keys, 'gone', 1)).toBe('a');
    expect(moveActive([], null, 1)).toBeNull();
  });
  it('reveals a row with the least movement and leaves visible rows alone', () => {
    const offs = [0, 80, 160, 240, 320, 400];
    expect(scrollToReveal(offs, 1, 0, 200)).toBe(0); // fully visible
    expect(scrollToReveal(offs, 4, 0, 200)).toBe(206); // below: bottom edge + pad meets the viewport bottom
    expect(scrollToReveal(offs, 0, 150, 200)).toBe(0); // above
  });
});

describe('filter chips', () => {
  const none = { filter: 'all' as const, query: '', adv: NO_ADV };
  it('one chip per active popover filter, with the patch that removes it', () => {
    const c = activeChips({ ...none, adv: { ...NO_ADV, sender: 'SEN-01', robot: 'IR-03', type: 'TOOL_REJECTED', period: '5m' } });
    expect(c.map((x) => x.id)).toEqual(['sender', 'robot', 'type', 'period']);
    expect(c.find((x) => x.id === 'type')?.label).toBe('Tool rejected');
    expect(c.find((x) => x.id === 'period')?.patch).toEqual({ adv: { period: 'all', from: null, to: null } });
  });
  it('role and search count as filters but only show as chips on request', () => {
    const s = { filter: 'failures' as const, query: ' ir-03 ', adv: NO_ADV };
    expect(activeChips(s)).toHaveLength(0);
    expect(activeChips(s, true).map((x) => x.id)).toEqual(['role', 'query']);
    expect(filterCount(s)).toBe(2);
    expect(filterCount(none)).toBe(0);
  });
  it('a custom range reads as m:ss to m:ss and the m:ss parser agrees', () => {
    const c = activeChips({ ...none, adv: { ...NO_ADV, period: 'custom', from: 60, to: 210 } });
    expect(c[0].label).toBe('1:00 to 3:30');
    expect(parseS('3:30')).toBe(210);
    expect(parseS('45')).toBe(45);
    expect(parseS('x')).toBeNull();
  });
  it('removing a chip through its patch restores the unfiltered list state', () => {
    resetCommunicationsForTest();
    const st = () => useCommunications.getState();
    st().setAdv({ sender: 'SEN-01' });
    const chip = activeChips({ filter: st().filter, query: st().query, adv: st().adv })[0];
    st().setAdv(chip.patch.adv!);
    expect(st().adv).toEqual(NO_ADV);
  });
});

describe('row status, chips and redaction', () => {
  const real = (over: Record<string, unknown>) => ev(1, over as never);
  it('derives the outcome only from fields the backend sent', () => {
    expect(outcomeOf(real({ message_type: 'tool_event', kind: 'TOOL_ACCEPTED', status: 'ok' }))?.label).toBe('Accepted');
    expect(outcomeOf(real({ message_type: 'tool_event', kind: 'TOOL_REJECTED', status: 'blocked' }))?.label).toBe('Rejected');
    expect(outcomeOf(real({ message_type: 'task_transition', kind: 'PROGRESS', status: 'failed', subtype: 'task.failed' }))?.label).toBe('Failed');
    expect(outcomeOf(real({ message_type: 'safety', kind: 'SAFETY_VETO', status: 'blocked' }))?.label).toBe('Vetoed');
    expect(outcomeOf(real({ message_type: 'verification', kind: 'VERIFICATION_RESULT', status: 'ok', subtype: 'verification.passed' }))?.label).toBe('Verified');
    expect(outcomeOf(real({ message_type: 'verification', kind: 'VERIFICATION_RESULT', status: 'warning', subtype: 'contract.terminal', detail: { terminal_state: 'TIMED_OUT' } }))?.label).toBe('Warning');
    expect(outcomeOf(real({ message_type: 'verification', kind: 'VERIFICATION_RESULT', status: 'ok', subtype: 'contract.terminal', detail: { terminal_state: 'VERIFIED' } }))?.label).toBe('Verified');
    expect(outcomeOf(real({ message_type: 'tool_event', kind: 'REQUEST_TOOL', status: 'pending' }))?.label).toBe('Pending');
    expect(outcomeOf(real({ message_type: 'agent_message', kind: 'OBSERVATION', status: 'info' }))).toBeNull();
  });
  it('a completed task is "Done", never "Verified"', () => {
    expect(outcomeOf(real({ message_type: 'task_transition', kind: 'PROGRESS', status: 'ok', subtype: 'task.completed' }))).toMatchObject({ id: 'done' });
  });
  it('chips come from tool, model, evidence, robot and task fields', () => {
    const c = chipsOf(real({ detail: { tool: 'read_telemetry', latency_ms: 12 }, model_id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', evidence_ids: ['e1', 'e2'], robot_id: 'IR-08', task_id: 't_1' }));
    expect(c.map((x) => x.id)).toEqual(['tool', 'model', 'evidence', 'robot', 'task']);
    expect(c[0].text).toBe('read_telemetry 12 ms');
    expect(c[1].text).toBe('Nemotron-3-Nano-30B-A3B');
  });
  it('redacts secret-looking keys and values but keeps token counts', () => {
    const r = redact({ tool: 'x', api_key: 'abc', nested: { Authorization: 'Bearer zzz', tokens_in: 5, access_token: 't' }, note: 'Bearer abcdef123456', list: [{ password: 'p' }] }) as Record<string, unknown>;
    expect(r.api_key).toBe(REDACTED);
    expect((r.nested as Record<string, unknown>).Authorization).toBe(REDACTED);
    expect((r.nested as Record<string, unknown>).tokens_in).toBe(5);
    expect((r.nested as Record<string, unknown>).access_token).toBe(REDACTED);
    expect(r.note).toBe(REDACTED);
    expect((r.list as Array<Record<string, unknown>>)[0].password).toBe(REDACTED);
    expect(r.tool).toBe('x');
  });
  it('formats wall time for the hover tooltip', () => {
    expect(fmtWall('2026-10-17T23:44:44.483Z')).toBe('2026-10-17 23:44:44 UTC');
    expect(fmtWall('')).toBe('');
  });
});

describe('reader preferences', () => {
  beforeEach(() => resetCommunicationsForTest());
  it('thread collapse is per thread and cleared when the run changes; density and grouping persist across reset', () => {
    const st = () => useCommunications.getState();
    st().setRun('r1');
    st().toggleThread('INC-1');
    expect(st().collapsed['INC-1']).toBe(true);
    st().toggleThread('INC-1');
    expect(st().collapsed['INC-1']).toBe(false);
    st().toggleThread('INC-2');
    st().setRun('r2');
    expect(st().collapsed).toEqual({});
    st().setDensity('compact');
    st().setGrouped(false);
    expect(st().density).toBe('compact');
    expect(st().grouped).toBe(false);
    st().setDensity('comfortable');
    st().setGrouped(true);
  });
});
