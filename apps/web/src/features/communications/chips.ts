import type { AdvFilters } from './communicationStore';
import { NO_ADV } from './communicationStore';
import { kindLabel } from './format';
import { ROLE_FILTERS, type RoleFilter } from './types';

export interface FilterChip {
  id: string;
  /** "Sender" etc: read by a screen reader before the value */
  field: string;
  label: string;
  /** what removing this chip changes */
  patch: { filter?: RoleFilter; query?: string; adv?: Partial<AdvFilters> };
}

const mmss = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/** One chip per active filter. `includeVisible` also lists the role filter and the search text (already visible in their own controls). */
export function activeChips(s: { filter: RoleFilter; query: string; adv: AdvFilters }, includeVisible = false): FilterChip[] {
  const out: FilterChip[] = [];
  const a = s.adv;
  if (includeVisible && s.filter !== 'all') out.push({ id: 'role', field: 'Role', label: ROLE_FILTERS.find((r) => r.id === s.filter)?.label ?? s.filter, patch: { filter: 'all' } });
  if (includeVisible && s.query.trim()) out.push({ id: 'query', field: 'Search', label: `"${s.query.trim()}"`, patch: { query: '' } });
  if (a.sender) out.push({ id: 'sender', field: 'Sender', label: a.sender, patch: { adv: { sender: '' } } });
  if (a.recipient) out.push({ id: 'recipient', field: 'Recipient', label: a.recipient, patch: { adv: { recipient: '' } } });
  if (a.robot) out.push({ id: 'robot', field: 'Robot', label: a.robot, patch: { adv: { robot: '' } } });
  if (a.incident) out.push({ id: 'incident', field: 'Incident', label: a.incident, patch: { adv: { incident: '' } } });
  if (a.type) out.push({ id: 'type', field: 'Type', label: kindLabel(a.type), patch: { adv: { type: '' } } });
  if (a.period !== 'all') {
    const label = a.period === '1m' ? 'Last 1 min' : a.period === '5m' ? 'Last 5 min' : a.from === null && a.to === null ? 'Custom range' : `${mmss(a.from) || 'start'} to ${mmss(a.to) || 'now'}`;
    out.push({ id: 'period', field: 'Period', label, patch: { adv: { period: 'all', from: null, to: null } } });
  }
  return out;
}

/** how many filters narrow the list (role, search and every popover filter) */
export const filterCount = (s: { filter: RoleFilter; query: string; adv: AdvFilters }) => activeChips(s, true).length;

export const CLEAR_ALL = { filter: 'all' as RoleFilter, query: '', adv: NO_ADV };
