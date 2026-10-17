import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import type { Tone } from '@/theme';

const SEV = { critical: 3, warning: 2, watch: 1, nominal: 0 } as const;

export const incidentTone = (i: Incident): Tone => (i.closed_tick ? (i.status === 'dismissed' ? 'isolated' : 'nominal') : i.status === 'escalated' ? 'critical' : i.severity);

/** All incidents, newest first. */
export function useIncidents() {
  const incidents = useWorld((s) => s.incidents);
  return useMemo(() => Object.values(incidents).sort((a, b) => b.opened_tick - a.opened_tick), [incidents]);
}

/** Open incidents, most severe first. */
export function useOpenIncidents() {
  const all = useIncidents();
  return useMemo(() => all.filter((i) => !i.closed_tick).sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.opened_tick - a.opened_tick), [all]);
}

/** The incident the Live sheet pins: the most severe open one, else the most recently closed (briefly). */
export function usePinnedIncident(pinnedId?: string | null): Incident | undefined {
  const open = useOpenIncidents();
  const all = useIncidents();
  const simTime = useWorld((s) => s.simTimeS);
  return useMemo(() => {
    if (pinnedId) {
      const p = all.find((i) => i.id === pinnedId);
      if (p) return p;
    }
    if (open.length) return open[0];
    const recent = all.find((i) => i.closed_tick !== undefined);
    // a freshly closed incident lingers a few minutes of sim time so its outcome can be read
    if (recent && recent.closed_tick !== undefined && simTime - recent.closed_tick * 0.5 < 240) return recent;
    return undefined;
  }, [pinnedId, open, all, simTime]);
}
