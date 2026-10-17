import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from './view';

/**
 * In Agent Operations mode the facility fades to 15–25% so the incident's hardware
 * reads clearly (frontend-ui.md §2C). Components ask how relevant they are.
 */
const RelevanceCtx = createContext<Set<string> | null>(null);

export function RelevanceProvider({ children }: { children: ReactNode }) {
  const mode = useView((s) => s.mode);
  const incId = useView((s) => s.focusedIncidentId);
  const incident = useWorld((s) => (incId ? s.incidents[incId] : undefined));
  const missions = useWorld((s) => s.missions);
  const set = useMemo(() => {
    if (mode !== 'agents') return null;
    const s = new Set<string>();
    if (incident) {
      s.add(incident.anchor.entity_id);
      incident.affected_asset_ids.forEach((a) => s.add(a));
      for (const mid of incident.mission_ids) {
        const m = missions[mid];
        if (m) {
          s.add(m.robot_id);
          s.add(m.target_id);
        }
      }
    }
    return s;
  }, [mode, incident, missions]);
  return <RelevanceCtx.Provider value={set}>{children}</RelevanceCtx.Provider>;
}

/** 1 = fully present, ~0.22 = faded context */
export function useRelevance(id: string): number {
  const set = useContext(RelevanceCtx);
  if (set === null) return 1;
  return set.has(id) ? 1 : 0.2;
}

export function useRelevanceSet() {
  return useContext(RelevanceCtx);
}
