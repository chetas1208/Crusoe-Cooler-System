import { memo } from 'react';
import { aria, eventKind, fmtSim, kindLabel, toneOf } from './format';
import { isFailure } from './communicationStore';
import type { CommunicationEventV1 } from './types';

export const ROW_H = 58;

/** One message. Every string is rendered as a React text node (escaped); nothing from an agent is ever parsed as markup. */
export const Row = memo(function Row({ e, selected, index, total, onOpen, inherited }: { e: CommunicationEventV1; selected: boolean; index: number; total: number; onOpen: (id: string) => void; inherited?: boolean }) {
  const fail = isFailure(e);
  const tone = toneOf(e.sender.class);
  return (
    <button
      type="button"
      className="cm-row"
      data-selected={selected}
      data-kind={e.message_type}
      data-fail={fail || undefined}
      data-inherited={inherited || undefined}
      style={{ height: ROW_H, ['--tone' as string]: tone }}
      role="article"
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={aria(e)}
      title={e.wall_time_utc ? `${e.wall_time_utc} UTC · seq ${e.seq}` : `seq ${e.seq}`}
      onClick={() => onOpen(e.event_id)}
    >
      <span className="cm-row__l1">
        {inherited && <span className="cm-kind" title="Message from the parent run, before the fork">parent</span>}
        <time className="cm-time mono" dateTime={e.wall_time_utc || undefined}>{fmtSim(e.sim_time_ms)}</time>
        <b className="cm-who">{e.sender.id}</b>
        {e.recipient && <span className="cm-to">→ {e.recipient.id}</span>}
        <span className="cm-kind">{kindLabel(eventKind(e))}</span>
        {(e.subtype || e.phase || e.status) && <span className="cm-stage" data-bad={fail || undefined}>{[e.subtype, e.phase !== e.status ? e.phase : undefined, e.status].filter(Boolean).join(' · ')}</span>}
        {e.evidence_ids && e.evidence_ids.length > 0 && <span className="cm-ev" title={`${e.evidence_ids.length} evidence id(s)`}>{e.evidence_ids.length} ev</span>}
      </span>
      <span className="cm-row__sum">{e.summary}</span>
    </button>
  );
});
