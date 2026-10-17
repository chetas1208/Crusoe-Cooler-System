import { useEffect, useMemo, useState } from 'react';
import { advActive, useCommunications } from './communicationStore';
import { eventKind, kindLabel } from './format';
import { ROLE_FILTERS } from './types';

const fmtS = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const parseS = (t: string): number | null => {
  const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(t);
  return m ? Number(m[1]) * (m[2] === undefined ? 1 : 60) + (m[2] === undefined ? 0 : Number(m[2])) : null;
};

function Sel({ label, value, options, onChange, fmt }: { label: string; value: string; options: string[]; onChange: (v: string) => void; fmt?: (v: string) => string }) {
  return (
    <label className="cm-sel">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={`Filter by ${label.toLowerCase()}`}>
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {fmt ? fmt(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Filters({ shown, total }: { shown: number; total: number }) {
  const filter = useCommunications((s) => s.filter);
  const query = useCommunications((s) => s.query);
  const adv = useCommunications((s) => s.adv);
  const setFilter = useCommunications((s) => s.setFilter);
  const setQuery = useCommunications((s) => s.setQuery);
  const setAdv = useCommunications((s) => s.setAdv);
  const clearAdv = useCommunications((s) => s.clearAdv);
  const events = useCommunications((s) => s.events);
  const [text, setText] = useState(query);
  const [open, setOpen] = useState(advActive(adv));
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 150);
    return () => clearTimeout(t);
  }, [text, setQuery]);
  useEffect(() => setText(query), [query]);
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
  const active = advActive(adv);
  return (
    <div className="cm-filters">
      <div role="group" aria-label="Filter messages" className="cm-chips">
        {ROLE_FILTERS.map((f) => (
          <button key={f.id} type="button" className="cm-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
        <button type="button" className="cm-chip" aria-expanded={open} aria-controls="cm-adv" data-on={active || undefined} onClick={() => setOpen((o) => !o)}>
          {active ? 'Filters •' : 'More filters'}
        </button>
      </div>
      {open && opts && (
        <div id="cm-adv" className="cm-adv" role="group" aria-label="Detailed filters">
          <Sel label="Sender" value={adv.sender} options={opts.sender} onChange={(v) => setAdv({ sender: v })} />
          <Sel label="Recipient" value={adv.recipient} options={opts.recipient} onChange={(v) => setAdv({ recipient: v })} />
          <Sel label="Robot" value={adv.robot} options={opts.robot} onChange={(v) => setAdv({ robot: v })} />
          <Sel label="Incident" value={adv.incident} options={opts.incident} onChange={(v) => setAdv({ incident: v })} />
          <Sel label="Type" value={adv.type} options={opts.type} fmt={kindLabel} onChange={(v) => setAdv({ type: v })} />
          <label className="cm-sel">
            <span>Period</span>
            <select value={adv.period} onChange={(e) => setAdv({ period: e.target.value as typeof adv.period })} aria-label="Filter by period">
              <option value="all">All time</option>
              <option value="1m">Last 1 min (sim)</option>
              <option value="5m">Last 5 min (sim)</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          {adv.period === 'custom' && (
            <div className="cm-range">
              <input aria-label="From (minutes:seconds of simulated time)" placeholder="from m:ss" defaultValue={fmtS(adv.from)} onBlur={(e) => setAdv({ from: parseS(e.target.value) })} />
              <input aria-label="To (minutes:seconds of simulated time)" placeholder="to m:ss" defaultValue={fmtS(adv.to)} onBlur={(e) => setAdv({ to: parseS(e.target.value) })} />
            </div>
          )}
          {active && (
            <button type="button" className="cm-chip" onClick={clearAdv}>
              Clear filters
            </button>
          )}
        </div>
      )}
      <div className="cm-search">
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Thread, robot, task or text" aria-label="Search messages by thread, robot, task, asset or text" maxLength={80} />
        <span className="cm-count mono" aria-live="off">{shown === total ? `${total}` : `${shown} / ${total}`}</span>
      </div>
    </div>
  );
}
