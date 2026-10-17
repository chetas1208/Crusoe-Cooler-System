import { useEffect } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { haptic } from '@/lib/haptics';

/**
 * Haptic language for the on-call operator, driven only by streamed world changes:
 *   new incident → warning · approval needed → warning · resolved/verified → success · verifier rejection → error.
 * The first snapshot after (re)connecting only seeds state — you are never buzzed for history.
 */
export function useAlerts() {
  useEffect(() => {
    let seeded = false;
    const seenIncidents = new Set<string>();
    const seenApprovals = new Set<string>();
    const status = new Map<string, string>();
    const verif = new Map<string, string>();
    let lastPhase = '';
    return useWorld.subscribe((s) => {
      if (s.phase !== 'ready') {
        lastPhase = s.phase;
        return;
      }
      if (!seeded || lastPhase !== 'ready') {
        for (const i of Object.values(s.incidents)) {
          seenIncidents.add(i.id);
          status.set(i.id, i.status);
          if (i.approval) seenApprovals.add(i.approval.id);
          if (i.verification) verif.set(i.id, i.verification.status);
        }
        seeded = true;
        lastPhase = 'ready';
        return;
      }
      for (const i of Object.values(s.incidents)) {
        if (!seenIncidents.has(i.id)) {
          seenIncidents.add(i.id);
          if (!i.closed_tick) {
            if (i.severity === 'critical') haptic.error();
            else haptic.warning();
          }
        }
        const a = i.approval;
        if (a && a.status === 'pending' && !seenApprovals.has(a.id)) {
          seenApprovals.add(a.id);
          haptic.warning();
        }
        const prev = status.get(i.id);
        if (prev !== i.status) {
          status.set(i.id, i.status);
          if (prev && (i.status === 'resolved')) haptic.success();
        }
        const v = i.verification?.status;
        if (v && verif.get(i.id) !== v) {
          verif.set(i.id, v);
          if (v === 'rejected') haptic.error();
        }
      }
    });
  }, []);
}
