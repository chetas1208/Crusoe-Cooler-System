import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ListFilter, Search, X } from 'lucide-react';
import { Button, IconButton, Popover, Select } from '../../ui/kit/index';
import { advActive, NO_ADV, useCommunications } from './communicationStore';
import { activeChips, filterCount } from './chips';
import { eventKind, kindLabel } from './format';
import { ROLE_FILTERS } from './types';

const fmtS = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
export const parseS = (t: string): number | null => {
  const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(t);
  return m ? Number(m[1]) * (m[2] === undefined ? 1 : 60) + (m[2] === undefined ? 0 : Number(m[2])) : null;
};

function Sel({ label, value, options, onChange, fmt }: { label: string; value: string; options: string[]; onChange: (v: string) => void; fmt?: (v: string) => string }) {
  const id = useId();
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="cm-sel">
      <label htmlFor={id}>{label}</label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {fmt ? fmt(o) : o}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function Filters({ shown, total }: { shown: number; total: number }) {
  const filter = useCommunications((s) => s.filter);
  const query = useCommunications((s) => s.query);
  const adv = useCommunications((s) => s.adv);
  const setFilter = useCommunications((s) => s.setFilter);
  const setQuery = useCommunications((s) => s.setQuery);
  const setAdv = useCommunications((s) => s.setAdv);
  const events = useCommunications((s) => s.events);
  const [text, setText] = useState(query);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 150);
    return () => clearTimeout(t);
  }, [text, setQuery]);
  useEffect(() => setText(query), [query]);

  // "/" jumps to search from anywhere in the panel (the panel root forwards it)
  useEffect(() => {
    const f = () => input.current?.focus();
    window.addEventListener('lk-comms-focus-search', f);
    return () => window.removeEventListener('lk-comms-focus-search', f);
  }, []);

  // option lists come from what was actually said (capped), never from a fixed roster
  const opts = useMemo(() => {
    if (!open) return null;
    const sets = { sender: new Set<string>(), recipient: new Set<string>(), robot: new Set<string>(), incident: new Set<string>(), type: new Set<string>() };
    for (const e of events) {
      sets.sender.add(e.sender.id);
      if (e.recipient) sets.recipient.add(e.recipient.id);
      if (e.robot_id) sets.robot.add(e.robot_id);
      if (e.incident_id) sets.incident.add(e.incident_id);
      sets.type.add(eventKind(e));
    }
    const arr = (s: Set<string>) => [...s].sort().slice(0, 80);
    return { sender: arr(sets.sender), recipient: arr(sets.recipient), robot: arr(sets.robot), incident: arr(sets.incident), type: arr(sets.type) };
  }, [events, open]);

  const state = { filter, query, adv };
  const chips = activeChips(state);
  const nAdv = chips.length;
  const nAll = filterCount(state);
  const clearAll = () => {
    setFilter('all');
    setQuery('');
    setText('');
    setAdv(NO_ADV);
  };

  return (
    <div className="cm-filters">
      <div role="group" aria-label="Filter messages" className="cm-chips">
        {ROLE_FILTERS.map((f) => (
          <Fragment key={f.id}>
            <Button size="sm" className="cm-chip" data-role={f.id} pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </Button>
            {f.id === 'outrig' && <span className="cm-chips__br" aria-hidden />}
          </Fragment>
        ))}
        <span className="cm-chips__end">
        <Popover
          label="Detailed filters"
          open={open}
          onOpenChange={setOpen}
          className="cm-pop"
          placement="bottom-end"
          trigger={(p) => (
            <Button {...p} size="sm" className="cm-fbtn" variant={nAdv > 0 ? 'primary' : 'secondary'} icon={<ListFilter size={14} />} iconRight={nAdv > 0 ? <b className="cm-fbtn__n">{nAdv}</b> : undefined}>
              Filters
            </Button>
          )}
        >
          {(close) => (
            opts && (
              <>
                <div className="cm-adv">
                  <Sel label="Sender" value={adv.sender} options={opts.sender} onChange={(v) => setAdv({ sender: v })} />
                  <Sel label="Recipient" value={adv.recipient} options={opts.recipient} onChange={(v) => setAdv({ recipient: v })} />
                  <Sel label="Robot" value={adv.robot} options={opts.robot} onChange={(v) => setAdv({ robot: v })} />
                  <Sel label="Incident" value={adv.incident} options={opts.incident} onChange={(v) => setAdv({ incident: v })} />
                  <Sel label="Type" value={adv.type} options={opts.type} fmt={kindLabel} onChange={(v) => setAdv({ type: v })} />
                  <div className="cm-sel">
                    <label htmlFor="cm-period">Period (sim time)</label>
                    <Select id="cm-period" value={adv.period} onChange={(e) => setAdv({ period: e.target.value as typeof adv.period })}>
                      <option value="all">All time</option>
                      <option value="1m">Last 1 min</option>
                      <option value="5m">Last 5 min</option>
                      <option value="custom">Custom range</option>
                    </Select>
                  </div>
                  {adv.period === 'custom' && (
                    <div className="cm-range">
                      <input aria-label="From (minutes:seconds of simulated time)" placeholder="from m:ss" defaultValue={fmtS(adv.from)} onBlur={(e) => setAdv({ from: parseS(e.target.value) })} />
                      <input aria-label="To (minutes:seconds of simulated time)" placeholder="to m:ss" defaultValue={fmtS(adv.to)} onBlur={(e) => setAdv({ to: parseS(e.target.value) })} />
                    </div>
                  )}
                </div>
                <div className="cm-pop__foot">
                  <Button size="sm" disabledReason={nAll === 0 ? 'No filters are active' : undefined} title={nAll === 0 ? undefined : 'Remove every filter and the search text'} onClick={clearAll}>
                    Clear all
                  </Button>
                  <Button size="sm" variant="primary" onClick={close}>
                    Done
                  </Button>
                </div>
              </>
            )
          )}
        </Popover>
        </span>
      </div>
      <div className="cm-searchrow">
        <div className="cm-search">
          <Search size={14} aria-hidden />
          <input
            ref={input}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text !== '') {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation?.(); // the host listens for Escape too: this one only clears the search
                setText('');
                setQuery('');
              }
            }}
            placeholder="Search thread, robot, task, text"
            aria-label="Search messages by thread, robot, task, asset or text"
            maxLength={80}
          />
          {text !== '' && (
            <IconButton size="sm" className="cm-search__x" aria-label="Clear search" icon={<X size={13} />} onClick={() => { setText(''); setQuery(''); input.current?.focus(); }} />
          )}
        </div>
        <span className="cm-count mono" aria-label={shown === total ? `${total} messages` : `${shown} of ${total} messages shown`}>{shown === total ? `${total}` : `${shown} / ${total}`}</span>
      </div>
      {advActive(adv) && (
        <div className="cm-active" role="group" aria-label="Active filters">
          {chips.map((c) => (
            <span key={c.id} className="cm-fchip">
              <span className="cm-fchip__f">{c.field}</span>
              <span className="cm-fchip__v mono">{c.label}</span>
              <IconButton
                size="sm"
                aria-label={`Remove ${c.field} filter ${c.label}`}
                tip={`Remove ${c.field} filter`}
                icon={<X size={12} />}
                onClick={() => {
                  if (c.patch.filter) setFilter(c.patch.filter);
                  if (c.patch.query !== undefined) setQuery(c.patch.query);
                  if (c.patch.adv) setAdv(c.patch.adv);
                }}
              />
            </span>
          ))}
          <Button size="sm" variant="ghost" title="Remove every filter and the search text" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
