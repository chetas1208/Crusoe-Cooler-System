import { memo } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, CircleX } from 'lucide-react';
import { Badge } from '../../ui/kit/index';
import { KindPill, MsgChipEl, OutcomeMark, PartyBadge } from './badges';
import { aria, chipsOf, fmtSim, fmtWall, outcomeOf } from './format';
import { isFailure } from './communicationStore';
import { ROW_H, type ThreadInfo } from './listModel';
import type { CommunicationEventV1, Density } from './types';

/** One message. Every string is rendered as a React text node (escaped); nothing from an agent is ever parsed as markup. */
export const Row = memo(function Row({
  e, selected, index, total, density, depth, active, inherited, onOpen, onActive,
}: {
  e: CommunicationEventV1; selected: boolean; index: number; total: number; density: Density; depth: number; active: boolean; inherited?: boolean;
  onOpen: (id: string) => void; onActive: (key: string) => void;
}) {
  const fail = isFailure(e);
  const comfortable = density === 'comfortable';
  const chips = comfortable ? chipsOf(e) : [];
  const key = `${e.run_id}:${e.seq}`;
  const o = outcomeOf(e);
  return (
    <div
      className="cm-row"
      role="article"
      tabIndex={active ? 0 : -1}
      data-key={key}
      data-selected={selected}
      data-kind={e.message_type}
      data-fail={fail || undefined}
      data-inherited={inherited || undefined}
      data-density={density}
      data-class={e.sender.class}
      data-depth={depth || undefined}
      style={{ height: ROW_H[density], ['--depth' as string]: depth }}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={aria(e)}
      aria-current={selected || undefined}
      onClick={() => onOpen(e.event_id)}
      onFocus={() => onActive(key)}
      onKeyDown={(ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) {
          ev.preventDefault();
          onOpen(e.event_id);
        }
      }}
    >
      <div className="cm-row__l1">
        {inherited && <Badge tone="neutral" sm variant="outline" title="Message from the parent run, before the fork">parent run</Badge>}
        <time className="cm-time mono" dateTime={e.wall_time_utc || undefined} title={fmtWall(e.wall_time_utc) || `seq ${e.seq}`}>{fmtSim(e.sim_time_ms)}</time>
        <PartyBadge p={e.sender} role="from" />
        {e.recipient && (
          <>
            <ArrowRight size={12} className="cm-arrow" aria-hidden />
            <PartyBadge p={e.recipient} role="to" />
          </>
        )}
        <span className="cm-grow" />
        {!comfortable && <KindPill e={e} iconOnly />}
        {o && <OutcomeMark e={e} iconOnly={!comfortable} />}
      </div>
      <div className="cm-row__sum" title={e.summary}>{e.summary}</div>
      {comfortable && (
        <div className="cm-row__l3">
          <KindPill e={e} />
          {chips.map((c) => (
            <MsgChipEl key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
});

const spanText = (a: number, b: number) => (a === b ? fmtSim(a) : `${fmtSim(a)}–${fmtSim(b)}`);

/** Collapsible thread header: the thread id, the message that opened it, how many messages and failures, and when. */
export const ThreadHead = memo(function ThreadHead({ t, itemKey, active, onToggle, onActive }: { t: ThreadInfo; itemKey: string; active: boolean; onToggle: (id: string) => void; onActive: (key: string) => void }) {
  const Chev = t.collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className="cm-thread"
      data-key={itemKey}
      data-collapsed={t.collapsed || undefined}
      aria-expanded={!t.collapsed}
      tabIndex={active ? 0 : -1}
      aria-label={`Thread ${t.id}, ${t.count} messages${t.fails ? `, ${t.fails} failed` : ''}, ${t.collapsed ? 'collapsed' : 'expanded'}. ${t.title}`}
      title={`${t.collapsed ? 'Expand' : 'Collapse'} thread ${t.id}`}
      style={{ height: 40 }}
      onClick={() => onToggle(t.id)}
      onFocus={() => onActive(itemKey)}
    >
      <Chev size={14} aria-hidden />
      <span className="cm-thread__id mono">{t.id}</span>
      <span className="cm-thread__title">{t.title}</span>
      {t.fails > 0 && (
        <span className="cm-thread__fail" title={`${t.fails} failed or blocked`}>
          <CircleX size={12} aria-hidden /> {t.fails}
        </span>
      )}
      <span className="cm-thread__n mono" title={`Sim time ${spanText(t.firstMs, t.lastMs)}`}>{t.count}</span>
    </button>
  );
});

export function NewDivider({ count }: { count: number }) {
  return (
    <div className="cm-newdiv" role="separator" aria-label={`${count} new message${count === 1 ? '' : 's'} below`} style={{ height: 30 }}>
      <span>{count} new</span>
    </div>
  );
}
