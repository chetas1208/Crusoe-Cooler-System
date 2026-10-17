import type { Robot } from '@loopkeeper/core/contracts';

export type ClassFilter = 'all' | 'inpipe' | 'outrig';
export type StatusFilter = 'working' | 'idle' | 'repairing' | 'manual';
export const STATUS_FILTERS: StatusFilter[] = ['working', 'idle', 'repairing', 'manual'];

const ACTIVE = new Set(['ASSIGNED', 'ROUTE_PLANNING', 'TRAVELING', 'INSPECTING', 'WORKING', 'VERIFYING', 'RETURNING']);

/** Which status chips a robot satisfies. Derived from data (mode / control authority), never from the id. */
export function activity(r: Robot, leaseHolderId?: string | null): Record<StatusFilter, boolean> {
  const manual = r.control?.authority === 'HUMAN' || leaseHolderId === r.id;
  return {
    manual,
    working: !manual && ACTIVE.has(r.mode),
    repairing: !manual && (r.mode === 'WORKING' || r.mode === 'VERIFYING'),
    idle: !manual && (r.mode === 'IDLE' || r.mode === 'DOCKED'),
  };
}

export function matchesQuery(r: Robot, q: string, missionTitle?: string): boolean {
  if (!q) return true;
  const hay = `${r.id} ${r.name} ${r.mode} ${r.home_id} ${r.pose.segment_id ?? ''} ${missionTitle ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}
