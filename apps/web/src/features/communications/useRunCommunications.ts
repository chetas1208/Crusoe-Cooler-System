import { useEffect, useMemo } from 'react';
import { acquireCommunications } from './runtime';
import { installCommsTestHook } from './testHook';
import { useCommunications, filterEvents } from './communicationStore';

/** Mount anywhere that must keep ingestion alive (the launcher does, on every screen). Safe to call from several components. */
export function useCommunicationsIngest() {
  useEffect(() => {
    void installCommsTestHook();
    return acquireCommunications();
  }, []);
}

/** The list the reader sees: filtered, and in replay cut at the playhead. */
export function useVisibleCommunications() {
  const events = useCommunications((s) => s.events);
  const filter = useCommunications((s) => s.filter);
  const query = useCommunications((s) => s.query);
  const adv = useCommunications((s) => s.adv);
  const mode = useCommunications((s) => s.mode);
  const cursor = useCommunications((s) => s.cursorTick);
  return useMemo(() => filterEvents(events, { filter, adv, query, mode, cursorTick: cursor }), [events, filter, adv, query, mode, cursor]);
}
