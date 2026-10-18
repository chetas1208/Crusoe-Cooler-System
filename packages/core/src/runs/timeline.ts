import type { Incident, StreamEvent } from '../contracts';
import type { RecordedCommand, ReplayFrame } from './types';

export type LaneId = 'physics' | 'robots' | 'agents' | 'operator' | 'verification';
export const LANES: Array<{ id: LaneId; label: string }> = [
  { id: 'physics', label: 'Physics' },
  { id: 'robots', label: 'Robots' },
  { id: 'agents', label: 'Agents' },
  { id: 'operator', label: 'Operator' },
  { id: 'verification', label: 'Verification' },
];

export interface Marker {
  id: string;
  lane: LaneId;
  from: number;
  to: number;
  label: string;
  detail?: string;
  tone: 'info' | 'watch' | 'warning' | 'critical' | 'ok';
  entity?: string;
  incident_id?: string;
  /** how many raw records this marker stands for (repeated telemetry/tool calls are collapsed) */
  count: number;
}

export interface SequenceItem {
  tick: number;
  lane: LaneId;
  label: string;
  tone: Marker['tone'];
}

export interface IncidentSpan {
  id: string;
  title: string;
  severity: Incident['severity'];
  status: Incident['status'];
  from: number;
  to: number | null;
  cause: string;
  sequence: SequenceItem[];
}

export interface TimelineModel {
  markers: Marker[];
  incidents: IncidentSpan[];
  from: number;
  to: number;
}

const SEV_TONE = { nominal: 'ok', watch: 'watch', warning: 'warning', critical: 'critical' } as const;
const rid = (s: string) => s.toUpperCase().replace('_', '-');

/** Derive lane markers from recorded events, the command ledger and (coarse) frames. Pure. */
export function buildTimeline(frames: ReplayFrame[], events: StreamEvent[], commands: RecordedCommand[], assetLabel: (id: string) => string = rid): TimelineModel {
  const markers: Marker[] = [];
  const from = frames[0]?.tick ?? events[0]?.sim_tick ?? 0;
  const to = frames[frames.length - 1]?.tick ?? events[events.length - 1]?.sim_tick ?? 0;

  /* physics: asset status excursions, collapsed to ranges */
  const open = new Map<string, { from: number; status: string }>();
  const flush = (id: string, at: number) => {
    const o = open.get(id);
    if (!o) return;
    markers.push({ id: `ph:${id}:${o.from}`, lane: 'physics', from: o.from, to: at, label: `${assetLabel(id)} ${o.status}`, detail: `Status stayed ${o.status} or worse from tick ${o.from} to ${at}.`, tone: o.status === 'critical' ? 'critical' : o.status === 'warning' ? 'warning' : 'watch', entity: id, count: 1 });
    open.delete(id);
  };
  for (const f of frames) {
    for (const [id, a] of Object.entries(f.assets)) {
      const bad = a.status === 'watch' || a.status === 'warning' || a.status === 'critical';
      const cur = open.get(id);
      if (bad && !cur) open.set(id, { from: f.tick, status: a.status });
      else if (bad && cur && (a.status === 'critical' || (a.status === 'warning' && cur.status === 'watch'))) cur.status = a.status;
      else if (!bad && cur) flush(id, f.tick);
    }
  }
  for (const id of [...open.keys()]) flush(id, to);

  /* scenario fault injections and operator actions from the ledger */
  for (const c of commands) {
    if (c.kind === 'test.inject_fault') {
      const k = String(c.args?.kind ?? 'fault');
      markers.push({ id: `cmd:${c.command_id}:${c.tick}`, lane: c.source === 'scenario' ? 'physics' : 'operator', from: c.tick, to: c.tick, label: `${c.source === 'scenario' ? 'Scenario injects' : 'Operator injects'} ${k.replace(/_/g, ' ')}`, detail: `target ${String(c.args?.target ?? 'auto')}${c.accepted ? '' : ` (refused: ${c.reason ?? 'unknown'})`}`, tone: c.accepted ? 'warning' : 'info', entity: String(c.args?.target ?? ''), count: 1 });
    } else {
      markers.push({ id: `cmd:${c.command_id}:${c.tick}`, lane: 'operator', from: c.tick, to: c.tick, label: c.kind.replace(/_/g, ' '), detail: `${c.target_id ?? ''}${c.accepted ? '' : ` — refused: ${c.reason ?? ''}`}`.trim(), tone: c.accepted ? 'info' : 'warning', entity: c.target_id, count: 1 });
    }
  }

  /* robots: one range per mission */
  const missions = new Map<string, Marker>();
  /* agents: one range per task (tool calls collapsed into its count) */
  const tasks = new Map<string, Marker>();
  const taskInc = new Map<string, string>();
  const incEvents = new Map<string, SequenceItem[]>();
  const incLast = new Map<string, Incident>();
  const robotMode = new Map<string, string>();
  const push = (inc: string | undefined, it: SequenceItem) => {
    if (!inc) return;
    const l = incEvents.get(inc) ?? [];
    l.push(it);
    incEvents.set(inc, l);
  };

  for (const e of events) {
    // lease events exist on the V4 backend but are not part of the typed StreamEvent union yet
    const t = e.type as string;
    if (t === 'robot.control.granted' || t === 'robot.control') {
      const pl = (e as unknown as { payload: { robot_id: string; lease_id?: string; event?: string } }).payload;
      const ev = t === 'robot.control.granted' ? 'granted' : String(pl.event ?? 'control');
      if (t === 'robot.control.granted' || /releas|expire|safe|dead|revok/i.test(ev))
        markers.push({ id: `ctl:${e.seq}`, lane: 'operator', from: e.sim_tick, to: e.sim_tick, label: `${rid(pl.robot_id)} manual lease ${ev.replace(/[._]/g, ' ')}`, detail: pl.lease_id ? `lease ${pl.lease_id}` : undefined, tone: /safe|dead|expire/i.test(ev) ? 'warning' : 'info', entity: pl.robot_id, count: 1 });
      continue;
    }
    switch (e.type) {
      case 'incident.opened':
      case 'incident.updated':
      case 'incident.closed': {
        const i = e.payload.incident;
        const prev = incLast.get(i.id);
        incLast.set(i.id, i);
        if (e.type === 'incident.opened') markers.push({ id: `inc:${i.id}`, lane: 'physics', from: e.sim_tick, to: e.sim_tick, label: `${i.id} opened — ${i.title}`, detail: i.cause, tone: SEV_TONE[i.severity], incident_id: i.id, count: 1 });
        if (e.type === 'incident.opened') push(i.id, { tick: e.sim_tick, lane: 'physics', label: `Opened — ${i.title}`, tone: SEV_TONE[i.severity] });
        else if (prev?.status !== i.status) push(i.id, { tick: e.sim_tick, lane: i.status === 'awaiting_approval' ? 'operator' : 'agents', label: `Status → ${i.status.replace(/_/g, ' ')}`, tone: i.status === 'escalated' || i.status === 'replanning' ? 'warning' : e.type === 'incident.closed' ? 'ok' : 'info' });
        break;
      }
      case 'mission.transition': {
        const m = e.payload.mission;
        const cur = missions.get(m.id);
        const step = m.steps.find((s) => s.status === 'active');
        if (!cur) missions.set(m.id, { id: `ms:${m.id}`, lane: 'robots', from: e.sim_tick, to: m.closed_tick ?? e.sim_tick, label: `${rid(m.robot_id)} · ${m.title}`, detail: step?.label, tone: 'info', entity: m.robot_id, incident_id: m.incident_id, count: 1 });
        else {
          cur.to = m.closed_tick ?? e.sim_tick;
          cur.count++;
          cur.detail = step?.label ?? cur.detail;
        }
        if (step && cur?.detail !== step.label) push(m.incident_id, { tick: e.sim_tick, lane: 'robots', label: `${rid(m.robot_id)} · ${step.label}`, tone: 'info' });
        else if (!cur && step) push(m.incident_id, { tick: e.sim_tick, lane: 'robots', label: `${rid(m.robot_id)} · ${step.label}`, tone: 'info' });
        break;
      }
      case 'agent.task': {
        const t = e.payload.task;
        taskInc.set(t.id, t.incident_id);
        const cur = tasks.get(t.id);
        const label = `${t.role.toUpperCase()} · ${t.title}`;
        if (!cur) {
          tasks.set(t.id, { id: `tk:${t.id}`, lane: 'agents', from: t.started_tick, to: t.ended_tick ?? e.sim_tick, label, detail: t.summary, tone: t.status === 'rejected' || t.status === 'failed' ? 'warning' : 'info', entity: t.robot_id ?? t.asset_ids[0], incident_id: t.incident_id, count: 1 });
          if (t.depth === 0) push(t.incident_id, { tick: t.started_tick, lane: 'agents', label, tone: 'info' });
        } else {
          cur.to = t.ended_tick ?? e.sim_tick;
          cur.detail = t.summary ?? cur.detail;
          cur.tone = t.status === 'rejected' || t.status === 'failed' ? 'warning' : t.status === 'verified' || t.status === 'completed' ? 'ok' : 'info';
        }
        break;
      }
      case 'agent.tool': {
        const cur = tasks.get(e.payload.task_id);
        if (cur) cur.count++;
        break;
      }
      case 'verification.result': {
        const v = e.payload.verification;
        if (v.status === 'pending') break;
        const tone = v.status === 'verified' ? 'ok' : 'warning';
        markers.push({ id: `vf:${v.id}`, lane: 'verification', from: e.sim_tick, to: e.sim_tick, label: v.status === 'verified' ? `Verified ${v.incident_id}` : `Rejected repair on ${v.incident_id}`, detail: v.checks.map((c) => `${c.label} ${typeof c.after === 'number' ? c.after.toFixed(2) : 'not measured'} ${c.unit ?? ''} ${c.pass ? 'pass' : 'fail'}`).join(' · '), tone, incident_id: v.incident_id, count: 1 });
        push(v.incident_id, { tick: e.sim_tick, lane: 'verification', label: v.status === 'verified' ? 'Verifier: all physics checks passed' : 'Verifier rejected the repair', tone });
        break;
      }
      case 'robot.pose': {
        // robots lane: a point per mode change (pose events are de-duplicated on change, so a gap says nothing about the mode)
        const r = e.payload;
        const prev = robotMode.get(r.robot_id) ?? 'DOCKED';
        robotMode.set(r.robot_id, r.mode);
        if (prev !== r.mode)
          markers.push({ id: `rb:${r.robot_id}:${e.sim_tick}`, lane: 'robots', from: e.sim_tick, to: e.sim_tick, label: `${rid(r.robot_id)} ${prev.toLowerCase().replace(/_/g, ' ')} → ${r.mode.toLowerCase().replace(/_/g, ' ')}`, detail: r.tool ? `tool ${r.tool}` : undefined, tone: r.mode === 'FAILED' || r.mode === 'BLOCKED' || r.mode === 'SAFE_HOLD' ? 'warning' : 'info', entity: r.robot_id, count: 1 });
        break;
      }
      default:
        break;
    }
  }
  markers.push(...missions.values(), ...tasks.values());
  markers.sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : 1));
  // a repeated event (reconnect overlap, a replayed parent segment) must not produce a second marker with the same id: React keys on it
  const seenIds = new Set<string>();
  for (let i = markers.length - 1; i >= 0; i--) {
    if (seenIds.has(markers[i].id)) markers.splice(i, 1);
    else seenIds.add(markers[i].id);
  }

  const incidents: IncidentSpan[] = [...incLast.values()]
    .map((i) => ({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      from: i.opened_tick,
      to: i.closed_tick ?? null,
      cause: i.cause,
      sequence: (incEvents.get(i.id) ?? []).sort((a, b) => a.tick - b.tick),
    }))
    .sort((a, b) => a.from - b.from);
  return { markers, incidents, from, to };
}

/** Collapse neighbouring same-lane/same-label markers that would overlap at the current zoom. Pure; returns display clusters. */
export interface Cluster extends Marker {
  members: number;
}
export function collapseForZoom(markers: Marker[], ticksPerPx: number, minPx = 5): Cluster[] {
  const out: Cluster[] = [];
  const lastByKey = new Map<string, Cluster>();
  for (const m of markers) {
    const key = `${m.lane}|${m.entity ?? ''}|${m.tone}`;
    const prev = lastByKey.get(key);
    if (prev && (m.from - prev.to) / ticksPerPx < minPx && m.lane !== 'verification') {
      prev.to = Math.max(prev.to, m.to);
      prev.count += m.count;
      prev.members++;
      prev.label = prev.members === 2 ? `${prev.label} … +1 more` : prev.label.replace(/\+\d+ more/, `+${prev.members - 1} more`);
      prev.detail = `${prev.members} records collapsed at this zoom — zoom in to separate them.`;
      continue;
    }
    const c: Cluster = { ...m, members: 1 };
    out.push(c);
    lastByKey.set(key, c);
  }
  return out;
}
