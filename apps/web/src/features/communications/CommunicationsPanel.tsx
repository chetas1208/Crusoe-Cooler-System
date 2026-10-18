import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Layers, Rows2, Rows4, SearchX, WifiOff, X, MessageSquareDashed, RotateCw } from 'lucide-react';
import { Button, EmptyState, ErrorState, IconButton, Skeleton } from '../../ui/kit/index';
import { useCommunications } from './communicationStore';
import { Feed, type FeedHandle } from './Feed';
import { Filters } from './Filters';
import { Detail } from './Detail';
import { CopyButton } from './badges';
import { closePanel } from '../responsive/panels';
import { useCommunicationsIngest, useVisibleCommunications } from './useRunCommunications';
import { retryCommunications } from './runtime';
import { CLEAR_ALL, filterCount } from './chips';
import { fmtSim } from './format';
import './communications.css';

const CONN_TEXT: Record<string, string> = { CONNECTING: 'Connecting', LIVE: 'Live', RECONNECTING: 'Reconnecting', REPLAY: 'Replay', STALE: 'Stale', OFFLINE: 'Offline', ERROR: 'Error' };

/** throttled polite announcements + a rare alert; the log itself stays aria-live="off" so a burst cannot flood a screen reader */
function Announcer({ visible }: { visible: number }) {
  const events = useCommunications((s) => s.events);
  const alert = useCommunications((s) => s.alert);
  const [text, setText] = useState('');
  const last = useRef({ n: 0, at: 0 });
  useEffect(() => {
    const now = Date.now();
    if (!last.current.n) {
      last.current = { n: events.length, at: now };
      return;
    }
    if (events.length <= last.current.n || now - last.current.at < 5000) return;
    const e = events[events.length - 1];
    setText(`${events.length - last.current.n} new messages. Latest from ${e.sender.id}: ${e.summary}`);
    last.current = { n: events.length, at: now };
  }, [events, visible]);
  return (
    <>
      <div className="cm-sr" role="status" aria-live="polite" aria-atomic="true">{text}</div>
      <div className="cm-sr" role="alert" aria-atomic="true">{alert?.text ?? ''}</div>
    </>
  );
}

function PreviewBanner() {
  const at = useCommunications((s) => s.previewAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  if (!at || now - at > 6000) return null;
  return <div className="cm-banner" role="status">Preview only; backend robot unchanged</div>;
}

function Retry({ busy }: { busy: boolean }) {
  return (
    <Button size="sm" variant="primary" icon={<RotateCw size={13} />} loading={busy} disabledReason={busy ? 'Already asking the backend for messages' : undefined} onClick={() => retryCommunications()}>
      Retry
    </Button>
  );
}

function Rows() {
  return (
    <div className="cm-skel" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="cm-skel__row">
          <Skeleton w={36} h={12} />
          <Skeleton w={64} h={12} />
          <Skeleton w={64} h={12} />
          <Skeleton w={`${90 - i * 10}%`} h={10} />
        </div>
      ))}
    </div>
  );
}

/**
 * The Communications panel. Layout-agnostic: it fills whatever hosts it (the Execution dock on desktop, C's bottom sheet on
 * phones via variant="sheet"). Closing it only hides it: ingestion, filters, scroll position and run context live in the store.
 */
export function CommunicationsPanel({ variant = 'host', onClose }: { variant?: 'dock' | 'sheet' | 'host'; onClose?: () => void }) {
  useCommunicationsIngest();
  const visible = useVisibleCommunications();
  const total = useCommunications((s) => s.events.length);
  const conn = useCommunications((s) => s.conn);
  const mode = useCommunications((s) => s.mode);
  const cursor = useCommunications((s) => s.cursorTick);
  const unread = useCommunications((s) => s.unread);
  const runId = useCommunications((s) => s.runId);
  const selectedId = useCommunications((s) => s.selectedId);
  const select = useCommunications((s) => s.select);
  const backfill = useCommunications((s) => s.backfill);
  const density = useCommunications((s) => s.density);
  const grouped = useCommunications((s) => s.grouped);
  const setDensity = useCommunications((s) => s.setDensity);
  const setGrouped = useCommunications((s) => s.setGrouped);
  const nFilters = useCommunications((s) => filterCount(s));
  const root = useRef<HTMLElement>(null);
  const feed = useRef<FeedHandle>(null);
  const feedWrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  // the detail drawer starts right under the header so it covers the filter bar too (one thing at a time)
  useLayoutEffect(() => {
    const h = head.current;
    if (h) root.current?.style.setProperty('--cm-head-h', `${h.offsetHeight}px`);
  });
  const focusRequest = useCommunications((s) => s.focusRequest);
  // opened on purpose -> the panel takes focus (ESC then works from the keyboard)
  useEffect(() => {
    if (focusRequest) root.current?.focus();
  }, [focusRequest]);
  const selected = useMemo(() => (selectedId ? visible.find((e) => e.event_id === selectedId) ?? useCommunications.getState().events.find((e) => e.event_id === selectedId) : undefined), [selectedId, visible]);
  const selIndex = selected ? visible.findIndex((e) => e.event_id === selected.event_id) : -1;

  // the list behind the drawer must not take focus or be read by a screen reader while the drawer is open
  useEffect(() => {
    const el = feedWrap.current;
    if (el) el.inert = Boolean(selected);
  }, [selected]);
  // closing the drawer hands focus back to the message it was opened from
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (selected) {
      lastKey.current = `${selected.run_id}:${selected.seq}`;
      return;
    }
    if (lastKey.current) {
      const k = lastKey.current;
      lastKey.current = null;
      const id = requestAnimationFrame(() => {
        if (!root.current?.contains(document.activeElement) || document.activeElement === document.body || document.activeElement === root.current) feed.current?.focusRow(k);
      });
      return () => cancelAnimationFrame(id);
    }
  }, [selected]);

  const close = () => {
    if (onClose) onClose();
    else closePanel('comms'); // also returns keyboard focus to whatever opened the panel
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
      // Escape peels one layer at a time: filter popover (Filters) -> detail -> search text -> the panel
      const st = useCommunications.getState();
      if (selected) select(null);
      else if (st.query.trim() !== '' || (t instanceof HTMLInputElement && t.value !== '')) st.setQuery('');
      else close();
      return;
    }
    if (e.defaultPrevented || typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === '/' && !selected) {
      e.preventDefault();
      window.dispatchEvent(new Event('lk-comms-focus-search'));
    } else if (t === root.current && !selected) {
      if (e.key === 'j' || e.key === 'ArrowDown') (e.preventDefault(), feed.current?.move(1));
      else if (e.key === 'k' || e.key === 'ArrowUp') (e.preventDefault(), feed.current?.move(-1));
    }
  };

  const busy = backfill.state === 'loading';
  let empty: ReactNode;
  if (total === 0 && (conn === 'CONNECTING' || busy)) {
    empty = (
      <>
        <Rows />
        <EmptyState compact icon={<MessageSquareDashed size={18} />} title="Waiting for backend…">Messages appear here as soon as the run reports them.</EmptyState>
      </>
    );
  } else if (total === 0 && conn === 'OFFLINE') {
    empty = (
      <EmptyState icon={<WifiOff size={20} />} title="Backend is unreachable" action={<Retry busy={busy} />}>
        Check that the API is running. Messages load again on their own once it answers.
      </EmptyState>
    );
  } else if (total === 0 && conn === 'ERROR') {
    empty = <ErrorState title="Could not load messages" detail={backfill.error ?? undefined} onRetry={() => retryCommunications()} retryLabel="Retry">The backend answered with an error. Retry, or check the API logs if it keeps failing.</ErrorState>;
  } else if (total > 0 && visible.length === 0 && nFilters > 0) {
    empty = (
      <EmptyState
        icon={<SearchX size={20} />}
        title="No messages match"
        action={
          <Button size="sm" variant="primary" onClick={() => { const s = useCommunications.getState(); s.setFilter(CLEAR_ALL.filter); s.setQuery(CLEAR_ALL.query); s.setAdv(CLEAR_ALL.adv); }}>
            Clear filters
          </Button>
        }
      >
        {total} messages are hidden by the current filters and search.
      </EmptyState>
    );
  } else if (mode === 'replay') {
    empty = <EmptyState icon={<MessageSquareDashed size={20} />} title="Nothing said yet">No agent had spoken by this point of the replay. Move the playhead forward.</EmptyState>;
  } else {
    empty = <EmptyState icon={<MessageSquareDashed size={20} />} title="No messages yet">Agents are idle. Their messages show up here as they happen.</EmptyState>;
  }

  const stateKey = mode === 'replay' ? 'REPLAY' : conn;
  return (
    <aside ref={root} tabIndex={-1} id="lk-comms-panel" className="cm-panel" data-variant={variant} aria-label="Communications" onKeyDown={onKey}>
      <header ref={head} className="cm-head">
        <h2>Communications</h2>
        <span className="cm-state" data-conn={stateKey} data-mode={mode}>
          <i aria-hidden /> {mode === 'replay' ? 'Replay' : CONN_TEXT[conn]}
        </span>
        {mode === 'replay' && cursor !== null && <span className="cm-cursor mono" title="Only messages up to the playhead are shown">up to {fmtSim(cursor * 500)}</span>}
        {runId ? (
          <span className="cm-run" title="Run context is kept while this panel is closed">
            <span className="mono cm-run__id">{runId}</span>
            <CopyButton value={runId} label="run id" />
          </span>
        ) : (
          <span className="cm-grow" />
        )}
        {unread > 0 && <span className="cm-new" aria-label={`${unread} new messages`} title={`${unread} messages arrived while you were away from the live edge`}>{unread > 99 ? '99+' : unread} new</span>}
        <IconButton size="sm" className="cm-hbtn" pressed={grouped} onClick={() => setGrouped(!grouped)} aria-label="Group by thread" tip={grouped ? 'Threads are grouped under collapsible headers. Click for a flat list.' : 'Group messages by thread under collapsible headers'} icon={<Layers size={15} />} />
        <IconButton size="sm" className="cm-hbtn" pressed={density === 'compact'} onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} aria-label="Compact rows" tip={density === 'compact' ? 'Compact rows. Click for full rows with tool and model chips.' : 'Switch to compact rows to see more messages'} icon={density === 'compact' ? <Rows4 size={15} /> : <Rows2 size={15} />} />
        <IconButton size="sm" className="cm-x" aria-label="Close communications" tip="Close (Esc)" onClick={close} icon={<X size={15} />} />
      </header>
      <PreviewBanner />
      {conn === 'STALE' && <div className="cm-note" role="status">No data for a while. Showing the last messages received.</div>}
      {conn === 'RECONNECTING' && <div className="cm-note" role="status">Reconnecting. Missed messages are filled in on reconnect.</div>}
      {total > 0 && (conn === 'OFFLINE' || conn === 'ERROR') && (
        <div className="cm-note" data-bad role="status">
          <span>{conn === 'OFFLINE' ? 'Backend is unreachable. Showing the last messages received.' : `Could not refresh messages${backfill.error ? `: ${backfill.error}` : ''}.`}</span>
          <Retry busy={busy} />
        </div>
      )}
      <div ref={feedWrap} className="cm-main">
        <Filters shown={visible.length} total={total} />
        <div className="cm-body">
          <div className="cm-body__feed">
            <Feed visible={visible} empty={empty} onOpen={select} handle={feed} />
          </div>
        </div>
      </div>
      {selected && (
        <Detail
          e={selected}
          position={{ index: selIndex, total: visible.length }}
          onBack={() => select(null)}
          onSelect={select}
          onStep={(d) => {
            const n = visible[selIndex + d];
            if (n) select(n.event_id);
          }}
        />
      )}
      <Announcer visible={visible.length} />
    </aside>
  );
}
