import { FAULT_INFO, humanizeKind } from './faultLabels';
import { READING_META, type AssetStatus, type FaultKind, type IncidentStage, type IncidentStatus, type RobotMode, type Severity } from './contracts';

export function formatReading(metric: string, v: number | undefined | null) {
  const m = READING_META[metric];
  if (v === undefined || v === null || Number.isNaN(v)) return { text: '—', unit: m?.unit ?? '', label: m?.label ?? metric };
  const d = m?.decimals ?? 1;
  return { text: v.toFixed(d), unit: m?.unit ?? '', label: m?.label ?? metric };
}

export function formatSimClock(s: number) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function formatDuration(s: number) {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { nominal: 'Nominal', watch: 'Watch', warning: 'Warning', critical: 'Critical' };

export const STATUS_LABEL: Record<AssetStatus, string> = {
  nominal: 'Nominal',
  watch: 'Watch',
  warning: 'Warning',
  critical: 'Critical',
  offline: 'Offline',
  isolated: 'Isolated',
  service: 'In service',
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Opened',
  investigating: 'Investigating',
  awaiting_approval: 'Awaiting approval',
  mitigating: 'Repairing',
  verifying: 'Verifying',
  replanning: 'Replanning',
  escalated: 'Needs operator',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const STAGE_LABEL: Record<IncidentStage, string> = {
  observed: 'Observed',
  hypothesized: 'Hypothesized',
  investigated: 'Investigated',
  repaired: 'Repaired',
  verified: 'Verified',
};

const CAUSE_LABEL_BASE: Record<FaultKind | 'unknown', string> = {
  ...(Object.fromEntries(Object.entries(FAULT_INFO).map(([k, v]) => [k, v.label])) as Record<FaultKind, string>),
  workload_spike: 'Workload surge',
  unknown: 'Under investigation',
};
/** Cause chip labels. Kinds this build does not know (newer backend) fall back to a humanized label instead of `undefined`. */
export const CAUSE_LABEL: Record<FaultKind | 'unknown', string> = new Proxy(CAUSE_LABEL_BASE, {
  get: (t, k) => (typeof k === 'string' ? (t as Record<string, string>)[k] ?? humanizeKind(k) : undefined),
});

export const ROBOT_MODE_LABEL: Record<RobotMode, string> = {
  IDLE: 'Idle',
  ASSIGNED: 'Assigned',
  ROUTE_PLANNING: 'Planning route',
  TRAVELING: 'Travelling',
  INSPECTING: 'Inspecting',
  WORKING: 'Working',
  VERIFYING: 'Verifying',
  RETURNING: 'Returning',
  DOCKED: 'Docked',
  BLOCKED: 'Blocked',
  FAILED: 'Failed',
  ABORTED: 'Aborted',
  NEEDS_CHARGE: 'Needs charge',
  SAFE_HOLD: 'Safe hold',
};

export const roleLabel = (r: 'sentinel' | 'inpipe' | 'outrig') => r.toUpperCase();
export const labelOfId = (id: string) => id.toUpperCase().replace('_', '-');
