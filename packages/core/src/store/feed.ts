import type { Severity, StreamEvent } from '../contracts';
import { REASON_TEXT } from '../control/reasons';

/** A plain-language line for the event ribbon / history drawer. */
export interface FeedItem {
  id: string;
  seq: number;
  simTimeS: number;
  wallTs: number;
  kind: 'incident' | 'mission' | 'verify' | 'approval' | 'agent' | 'system';
  severity: Severity | 'info' | 'ok';
  text: string;
  incidentId?: string;
  assetId?: string;
  robotId?: string;
}

const RID = (id: string) => id.toUpperCase().replace('_', '-');

/** Convert a raw stream event into zero-or-one feed lines. Only high-signal events qualify. */
export function describeEvent(e: StreamEvent, prev?: { incidentStatus?: string; stepKey?: string }): FeedItem | null {
  const base = { id: e.event_id, seq: e.seq, simTimeS: e.sim_time_s, wallTs: Date.now() };
  switch (e.type) {
    case 'incident.opened': {
      const i = e.payload.incident;
      return { ...base, kind: 'incident', severity: i.severity, text: `SENTINEL opened ${i.id} · ${i.title}`, incidentId: i.id, assetId: i.anchor.entity_id };
    }
    case 'incident.updated': {
      const i = e.payload.incident;
      if (prev?.incidentStatus === i.status) return null;
      const map: Record<string, string> = {
        investigating: 'is investigating',
        awaiting_approval: 'is waiting for operator approval',
        mitigating: 'is executing the repair',
        verifying: 'repair complete — verification running',
        replanning: 'verification rejected the repair — replanning',
        escalated: 'needs an operator',
      };
      const t = map[i.status];
      if (!t) return null;
      return { ...base, kind: 'incident', severity: i.status === 'replanning' || i.status === 'escalated' ? 'warning' : 'info', text: `${i.id} ${t}`, incidentId: i.id, assetId: i.anchor.entity_id };
    }
    case 'incident.closed': {
      const i = e.payload.incident;
      return {
        ...base,
        kind: 'incident',
        severity: 'ok',
        text: i.status === 'dismissed' ? `${i.id} dismissed — ${i.close_reason ?? 'no action needed'}` : `${i.id} resolved and verified — ${i.title}`,
        incidentId: i.id,
        assetId: i.anchor.entity_id,
      };
    }
    case 'mission.transition': {
      const m = e.payload.mission;
      const step = m.steps.find((s) => s.status === 'active');
      if (!step || prev?.stepKey === `${m.id}:${step.id}`) return null;
      return { ...base, kind: 'mission', severity: 'info', text: `${RID(m.robot_id)} · ${step.label}`, incidentId: m.incident_id, robotId: m.robot_id, assetId: m.target_id };
    }
    case 'robot.control': {
      const c = e.payload;
      const id = RID(c.robot_id);
      const why = typeof c.reason === 'string' ? (REASON_TEXT[c.reason as keyof typeof REASON_TEXT] ?? c.reason) : '';
      const common = { ...base, kind: 'mission' as const, robotId: c.robot_id };
      switch (c.event) {
        case 'human.override':
          return { ...common, severity: 'info', text: `${id} · operator took manual control (human.override) — mission paused` };
        case 'agent.resumed': {
          const how = c.data?.resumed;
          return { ...common, severity: 'ok', text: `${id} · control released (agent.resumed) — ${how === 'mission' ? 'agent continues its mission' : how === 'return_to_port' ? 'returning to port' : how === 'docked' ? 'docked' : 'autonomy back'}` };
        }
        case 'safe_hold':
          return { ...common, severity: 'warning', text: `${id} · safety stop, holding position — ${why}` };
        case 'scan.result':
          return { ...common, severity: 'info', text: `${id} · wall scan at ${c.data?.s_m} m: ${c.data?.occlusion_pct}% of bore blocked (simulated)` };
        case 'drive.rejected':
          return { ...common, severity: 'info', text: `${id} · drive command refused: ${c.data?.reason ?? c.reason}` };
        case 'end_of_line':
          return { ...common, severity: 'info', text: `${id} · reached the end of the line (${c.data?.segment})` };
      }
      return null;
    }
    case 'verification.result': {
      const v = e.payload.verification;
      if (v.status === 'pending') return null;
      return {
        ...base,
        kind: 'verify',
        severity: v.status === 'verified' ? 'ok' : 'warning',
        text: v.status === 'verified' ? `Verifier confirmed ${v.incident_id}: ${v.checks.length} physics checks passed` : `Verifier rejected the repair on ${v.incident_id}`,
        incidentId: v.incident_id,
      };
    }
    case 'agent.task': {
      const t = e.payload.task;
      if (t.status === 'working' || t.depth > 0) return null;
      return { ...base, kind: 'agent', severity: 'info', text: `${t.role.toUpperCase()} · ${t.title}`, incidentId: t.incident_id };
    }
    default:
      return null;
  }
}
