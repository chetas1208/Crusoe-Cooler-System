import { useCommunications, resetCommunicationsForTest } from './communicationStore';
import { cleanText } from './schemas';
import { syncFreeze } from './runtime';
import { dodFreeze, useDod } from '../dod/store';
import { parseContract, parseTeam } from '../dod/schemas';
import { usePromptRequest } from '../mission/promptStore';
import type { CommunicationEventV1 } from './types';

/**
 * Playwright hook, installed ONLY when the page is opened with `?e2e`. It lets the browser flows feed the real store/panel
 * (fixtures come from fixtures.ts, loaded lazily) without a backend. Production URLs never reach this code.
 */
export async function installCommsTestHook() {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('e2e')) return;
  const { fixtureBurst, fixtureEvent } = await import('./fixtures');
  const dodFx = await import('../dod/fixtures');
  const st = () => useCommunications.getState();
  (window as unknown as { __lkComms: unknown }).__lkComms = {
    runId: () => st().runId,
    ensureRun: (id: string) => st().setRun(id),
    burst: (from: number, n: number, over?: Partial<CommunicationEventV1>) => st().ingest(fixtureBurst(from, n, st().runId ?? 'run_fixture').map((e) => ({ ...e, ...over, summary: over?.summary ? cleanText(over.summary, 600) : e.summary }))),
    event: (seq: number, over?: Partial<CommunicationEventV1>) => st().ingest([fixtureEvent(seq, over, st().runId ?? 'run_fixture')]),
    preview: () => st().notePreview(),
    mode: (m: 'live' | 'replay', cursor?: number) => st().setMode(m, cursor ?? null),
    cursor: (c: number) => st().setCursor(c),
    conn: (c: Parameters<ReturnType<typeof st>['setConn']>[0]) => st().setConn(c),
    state: () => ({ n: st().events.length, unread: st().unread, follow: st().follow, open: st().open, filter: st().filter, query: st().query, scrollTop: st().scrollTop, selected: st().selectedId, conn: st().conn, mode: st().mode }),
    dod: () => {
      dodFreeze.on = true;
      useDod.setState({ incidents: [{ incident_id: 'INC-1', id: 'x', version: 2, state: 'EVALUATING', terminal_state: null }], incidentId: 'INC-1', contract: parseContract(dodFx.fixtureContract), contractLoad: 'ready', team: parseTeam(dodFx.fixtureTeam), teamLoad: 'ready', showDod: true, showTeam: true });
    },
    prompt: (phase: string, status = 'PROCESSING') => { const p = usePromptRequest.getState(); if (!p.startedAt) p.begin('FIXTURE prompt'); p.update({ request_id: 'req_fixture', phase, status }); },
    freeze: (on: boolean) => { syncFreeze.on = on; },
    reset: () => resetCommunicationsForTest(),
  };
}
