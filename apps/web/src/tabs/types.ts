export type TabId = 'dashboard' | 'map' | 'agents' | 'execution';
export const TABS: Array<{ id: TabId; label: string; key: string }> = [
  { id: 'dashboard', label: 'Dashboard', key: '1' },
  { id: 'map', label: 'Map', key: '2' },
  { id: 'agents', label: 'Agents', key: '3' },
  { id: 'execution', label: 'Execution', key: '4' },
];
