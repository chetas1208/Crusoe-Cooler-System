import { beforeEach, describe, expect, it } from 'vitest';
import { cleanText, parseCommunicationEvent, unwrapStreamPayload } from '../schemas';
import { MAX_EVENTS, NO_ADV, filterEvents, isFailure, resetCommunicationsForTest, useCommunications } from '../communicationStore';
import { computeWindow, isAtBottom } from '../virtualization';
import { fixtureBurst, fixtureEvent } from '../fixtures';
import { connFrom } from '../runtime';

const st = () => useCommunications.getState();
beforeEach(() => {
  resetCommunicationsForTest();
  st().setRun('run_fixture');
});

describe('schema', () => {
  const base = { event_id: 'e1', run_id: 'r', seq: 5, sim_tick: 10, sender: { kind: 'agent', id: 'SEN-01', class: 'SENTINEL' }, message_type: 'task_transition', summary: 'assigned', schema_version: '1' };
  it('accepts a valid envelope and lower-cases the class', () => {
    const r = parseCommunicationEvent(base);
    expect(r.ok && r.event.sender.class).toBe('sentinel');
  });
  it('keeps markup as literal text and strips control / bidi characters', () => {
    const r = parseCommunicationEvent({ ...base, summary: '<img src=x onerror=alert(1)>\u0007‮ ok' });
    expect(r.ok && r.event.summary).toBe('<img src=x onerror=alert(1)> ok');
    expect(cleanText('a\u0000b', 10)).toBe('ab');
  });
  it('bounds lengths and drops incomplete events', () => {
    const r = parseCommunicationEvent({ ...base, summary: 'x'.repeat(5000), thread_id: 't'.repeat(999), evidence_ids: Array.from({ length: 500 }, (_, i) => `e${i}`) });
    expect(r.ok && r.event.summary.length).toBe(600);
    expect(r.ok && r.event.thread_id!.length).toBe(160);
    expect(r.ok && r.event.evidence_ids!.length).toBe(60);
    expect(parseCommunicationEvent({ ...base, seq: undefined }).ok).toBe(false);
    expect(parseCommunicationEvent({ ...base, sender: undefined }).ok).toBe(false);
    expect(parseCommunicationEvent({ ...base, summary: '   ' }).ok).toBe(false);
  });
  it('unwraps a stream event whose payload is the envelope', () => {
    const u = unwrapStreamPayload({ type: 'comm.message', seq: 9, run_id: 'r', payload: base });
    expect(u.seq).toBe(9);
    expect((u.raw as { event_id: string }).event_id).toBe('e1');
  });
});

describe('store', () => {
  it('dedupes by (run_id, seq): reconnect overlap and REST/stream races never add a row', () => {
    st().ingest(fixtureBurst(1, 10));
    expect(st().ingest(fixtureBurst(5, 10))).toBe(4); // 5..10 already held, 11..14 are new
    st().ingest(fixtureBurst(1, 14));
    expect(st().events.length).toBe(14);
    expect(new Set(st().events.map((e) => e.seq)).size).toBe(14);
  });
  it('keeps events ordered by seq when a backfill arrives after live events', () => {
    st().ingest(fixtureBurst(100, 5));
    st().ingest(fixtureBurst(1, 5));
    expect(st().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 100, 101, 102, 103, 104]);
  });
  it('ignores events of another run', () => {
    expect(st().ingest(fixtureBurst(1, 3, 'other_run'))).toBe(0);
  });
  it('switching run clears the list but not filters or open state', () => {
    st().setFilter('tools');
    st().setOpen(false);
    st().ingest(fixtureBurst(1, 3));
    st().setRun('run_two');
    expect(st().events.length).toBe(0);
    expect(st().filter).toBe('tools');
    expect(st().open).toBe(false);
  });
  it('counts unread while closed or reading history, and clears when the reader returns to live', () => {
    st().setOpen(false);
    st().ingest(fixtureBurst(1, 4));
    expect(st().unread).toBe(4);
    st().setOpen(true);
    expect(st().unread).toBe(0);
    st().setFollow(false);
    st().ingest(fixtureBurst(5, 3));
    expect(st().unread).toBe(3);
    st().setFollow(true);
    st().markRead();
    expect(st().unread).toBe(0);
  });
  it('close / reopen x3 keeps filters, query, selection and scroll', () => {
    st().setFilter('failures');
    st().setQuery('IR-04');
    st().ingest(fixtureBurst(1, 30));
    st().select('run_fixture#7');
    st().setScrollTop(321);
    for (let i = 0; i < 3; i++) {
      st().setOpen(false);
      st().ingest(fixtureBurst(100 + i * 5, 5)); // ingestion continues while closed
      st().setOpen(true);
    }
    expect(st().filter).toBe('failures');
    expect(st().query).toBe('IR-04');
    expect(st().selectedId).toBe('run_fixture#7');
    expect(st().scrollTop).toBe(321);
    expect(st().events.length).toBe(45);
  });
  it('caps memory and forgets dropped keys', () => {
    st().ingest(fixtureBurst(1, MAX_EVENTS + 500));
    expect(st().events.length).toBe(MAX_EVENTS);
    expect(st().dropped).toBe(500);
    expect(st().ingest([fixtureEvent(1)])).toBe(1); // seq 1 was dropped, so it can come back
  });
  it('raises an alert only for safety/verification failures and at most every 10 s', () => {
    st().ingest([fixtureEvent(1, { message_type: 'tool_event', status: 'failed' })]);
    expect(st().alert).toBeNull();
    st().ingest([fixtureEvent(2, { message_type: 'safety', status: 'blocked' })]);
    const first = st().alert;
    expect(first?.text).toContain('FIXTURE event 2');
    st().ingest([fixtureEvent(3, { message_type: 'safety', status: 'blocked', summary: 'second' })]);
    expect(st().alert).toBe(first);
  });
});

describe('filters and replay cursor', () => {
  const evs = fixtureBurst(1, 200);
  const o = { filter: 'all' as const, query: '', mode: 'live' as const, cursorTick: null };
  it('replay shows only events at or before the cursor (no future leakage)', () => {
    const shown = filterEvents(evs, { ...o, mode: 'replay', cursorTick: 100 });
    expect(shown.length).toBe(50);
    expect(Math.max(...shown.map((e) => e.sim_tick))).toBeLessThanOrEqual(100);
    expect(filterEvents(evs, { ...o, mode: 'replay', cursorTick: 0 }).length).toBe(0);
    expect(filterEvents(evs, { ...o, mode: 'live', cursorTick: 0 }).length).toBe(200); // cursor is ignored live
  });
  it('role filters, failures, operator and search', () => {
    expect(filterEvents(evs, { ...o, filter: 'sentinel' }).every((e) => e.sender.class === 'sentinel' || e.recipient?.class === 'sentinel')).toBe(true);
    expect(filterEvents(evs, { ...o, filter: 'tools' }).every((e) => e.message_type === 'tool_event')).toBe(true);
    const fails = filterEvents(evs, { ...o, filter: 'failures' });
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.every((e) => e.status === 'blocked')).toBe(true);
    expect(filterEvents(evs, { ...o, filter: 'operator' }).every((e) => e.message_type === 'operator' || e.sender.class === 'operator')).toBe(true);
    expect(filterEvents(evs, { ...o, query: 'thr_7 ir-' }).every((e) => e.thread_id === 'thr_7')).toBe(true);
  });
});

describe('connection mapping', () => {
  it('maps world state to the seven panel states', () => {
    expect(connFrom('connecting', false, false, false)).toBe('CONNECTING');
    expect(connFrom('live', false, false, false)).toBe('LIVE');
    expect(connFrom('live', true, false, false)).toBe('STALE');
    expect(connFrom('reconnecting', false, false, false)).toBe('RECONNECTING');
    expect(connFrom('offline', false, false, false)).toBe('OFFLINE');
    expect(connFrom('live', false, true, false)).toBe('REPLAY');
    expect(connFrom('live', false, false, true)).toBe('ERROR');
  });
});

describe('virtualisation', () => {
  it('renders a bounded window for 5,000 rows anywhere in the list', () => {
    for (const top of [0, 1234, 58 * 2500, 58 * 4999]) {
      const w = computeWindow(5000, 58, top, 520);
      expect(w.end - w.start).toBeLessThanOrEqual(30);
      expect(w.padTop + (w.end - w.start) * 58 + w.padBottom).toBe(5000 * 58);
    }
    expect(computeWindow(0, 58, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
  it('knows the live edge', () => {
    expect(isAtBottom(1000, 400, 1400)).toBe(true);
    expect(isAtBottom(900, 400, 1400)).toBe(false);
  });
});

describe('measured cost with 5,000 events', () => {
  it('ingests, filters and windows within a small budget', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) st().ingest(fixtureBurst(1 + i * 100, 100)); // 50 bursts of 100, as the 10 Hz flush would deliver
    const tIngest = performance.now() - t0;
    expect(st().events.length).toBe(5000);
    const t1 = performance.now();
    const shown = filterEvents(st().events, { filter: 'tools', query: 'ir-', mode: 'live', cursorTick: null });
    const tFilter = performance.now() - t1;
    const t2 = performance.now();
    for (let i = 0; i < 1000; i++) computeWindow(5000, 58, i * 97, 520);
    const tWin = performance.now() - t2;
    console.log(`MEASURED 5,000 events: ingest ${tIngest.toFixed(1)} ms (50 bursts), filter ${tFilter.toFixed(2)} ms (${shown.length} hits), 1000 windows ${tWin.toFixed(2)} ms`);
    expect(tIngest).toBeLessThan(1500);
    expect(tFilter).toBeLessThan(50);
  });
});

describe('V11 envelope and detailed filters', () => {
  const mk = (seq: number, over: Record<string, unknown>) => fixtureEvent(seq, over as never);
  const evs = [
    mk(1, { message_type: 'TASK_ASSIGN', sender: { kind: 'agent', id: 'SEN-01', class: 'sentinel' }, recipient: { kind: 'agent', id: 'SEN-02', class: 'sentinel' }, incident_id: 'INC-1', robot_id: undefined, sim_time_ms: 10_000, sim_tick: 20 }),
    mk(2, { message_type: 'TOOL_REJECTED', sender: { kind: 'agent', id: 'SEN-04', class: 'sentinel' }, robot_id: 'IR-03', incident_id: 'INC-1', sim_time_ms: 70_000, sim_tick: 140 }),
    mk(3, { message_type: 'SAFETY_VETO', status: 'ok', sender: { kind: 'agent', id: 'SEN-04', class: 'sentinel' }, robot_id: 'OR-02', incident_id: 'INC-2', sim_time_ms: 200_000, sim_tick: 400 }),
    mk(4, { message_type: 'HEARTBEAT', sender: { kind: 'agent', id: 'IR-03', class: 'inpipe' }, robot_id: 'IR-03', sim_time_ms: 330_000, sim_tick: 660 }),
  ];
  const o = { filter: 'all' as const, query: '', mode: 'live' as const, cursorTick: null, adv: NO_ADV };
  it('filters by sender, recipient, robot, incident and type', () => {
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, sender: 'SEN-04' } }).map((e) => e.seq)).toEqual([2, 3]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, recipient: 'SEN-02' } }).map((e) => e.seq)).toEqual([1]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, robot: 'IR-03' } }).map((e) => e.seq)).toEqual([2, 4]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, incident: 'INC-2' } }).map((e) => e.seq)).toEqual([3]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, type: 'TOOL_REJECTED' } }).map((e) => e.seq)).toEqual([2]);
  });
  it('period: last minutes are relative to the newest message live and to the playhead in replay; custom is an explicit range', () => {
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, period: '1m' } }).map((e) => e.seq)).toEqual([4]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, period: '5m' } }).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(filterEvents(evs, { ...o, mode: 'replay', cursorTick: 400, adv: { ...NO_ADV, period: '5m' } }).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(filterEvents(evs, { ...o, adv: { ...NO_ADV, period: 'custom', from: 60, to: 210 } }).map((e) => e.seq)).toEqual([2, 3]);
  });
  it('V11 rejection / veto / model-error kinds count as failures; a heartbeat does not', () => {
    expect(filterEvents(evs, { ...o, filter: 'failures' }).map((e) => e.seq)).toEqual([2, 3]);
    expect(isFailure(mk(9, { message_type: 'MODEL_ERROR', status: 'ok' }))).toBe(true);
    expect(isFailure(mk(10, { message_type: 'HEARTBEAT', status: 'ok' }))).toBe(false);
  });
});

describe('agent-envelope.v1 fields', () => {
  it('reads kind, message_id, priority and parent_task_id; the envelope kind drives failure and type filters', () => {
    const r = parseCommunicationEvent({ event_id: 'e', run_id: 'r', seq: 3, sim_tick: 6, sender: { id: 'SEN-04', class: 'SENTINEL' }, message_type: 'safety', kind: 'SAFETY_VETO', message_id: 'm1', priority: 'high', parent_task_id: 't1', summary: 'vetoed' });
    expect(r.ok && r.event).toMatchObject({ kind: 'SAFETY_VETO', message_id: 'm1', priority: 'high', parent_id: 't1' });
    if (!r.ok) throw new Error('parse');
    expect(isFailure(r.event)).toBe(true);
    expect(filterEvents([r.event], { filter: 'all', query: '', mode: 'live', cursorTick: null, adv: { ...NO_ADV, type: 'SAFETY_VETO' } })).toHaveLength(1);
  });
});

describe('reopen / filter switch never shows an empty window while ingested events exist', () => {
  it('clamps a stale scroll offset to the current list (filter shrank 5,000 -> 12 rows)', async () => {
    const { clampTop } = await import('../virtualization');
    const ROW = 52;
    const top = clampTop(12, ROW, 5000 * ROW, 400); // offset left over from the long list
    const w = computeWindow(12, ROW, top, 400);
    expect(w.end - w.start).toBe(12);
  });
  it('reopening with an offset beyond the end still renders the last rows', async () => {
    const { clampTop } = await import('../virtualization');
    const w = computeWindow(300, 52, clampTop(300, 52, 10_000_000, 600), 600);
    expect(w.end).toBe(300);
    expect(w.end - w.start).toBeGreaterThan(10);
  });
  it('the store keeps every ingested event while the panel is closed (rows are available on reopen)', () => {
    resetCommunicationsForTest();
    const st = useCommunications.getState();
    st.setRun('run_x');
    st.setOpen(false);
    const mk = (seq: number) => ({ event_id: `e${seq}`, run_id: 'run_x', seq, sim_tick: seq, sim_time_ms: seq * 500, sender: { id: 'SEN-01', class: 'sentinel' }, message_type: 'progress', summary: `m${seq}` }) as unknown as import('../types').CommunicationEventV1;
    st.ingest([mk(1), mk(2), mk(3)]);
    st.setOpen(true);
    expect(useCommunications.getState().events.length).toBe(3);
    const visible = filterEvents(useCommunications.getState().events, { filter: 'all', query: '', mode: 'live', cursorTick: null });
    expect(visible.length).toBe(3);
  });
});
