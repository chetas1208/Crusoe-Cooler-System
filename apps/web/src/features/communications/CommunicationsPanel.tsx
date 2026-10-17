import { usePhoneLayout } from '../responsive/phone';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useCommunications } from './communicationStore';
import { Feed } from './Feed';
import { Filters } from './Filters';
import { Detail } from './Detail';
import { restoreFocus } from './Launcher';
import { useCommunicationsIngest, useVisibleCommunications } from './useRunCommunications';
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

/**
 * The Communications panel. Layout-agnostic: it fills whatever hosts it (the Execution dock on desktop, C's bottom sheet on
 * phones via variant="sheet"). Closing it only hides it: ingestion, filters, scroll position and run context live in the store.
 */
export function CommunicationsPanel({ variant = 'dock', onClose }: { variant?: 'dock' | 'sheet'; onClose?: () => void }) {
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
  const setOpen = useCommunications((s) => s.setOpen);
  const filtered = useCommunications((s) => s.filter !== 'all' || s.query.trim() !== '');
  const closeBtn = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const focusRequest = useCommunications((s) => s.focusRequest);
  // opened on purpose -> the panel takes focus (ESC then works); leaving the detail view hands focus back to the panel instead of <body>
  useEffect(() => {
    if (focusRequest) root.current?.focus();
  }, [focusRequest]);
  useEffect(() => {
    if (!selectedId) return;
    return () => {
      if (!root.current?.contains(document.activeElement) || document.activeElement === document.body) root.current?.focus();
    };
  }, [selectedId]);
  const selected = useMemo(() => (selectedId ? visible.find((e) => e.event_id === selectedId) ?? useCommunications.getState().events.find((e) => e.event_id === selectedId) : undefined), [selectedId, visible]);

  const close = () => {
    if (onClose) onClose();
    else setOpen(false);
    restoreFocus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();
    if (selected) select(null);
    else close();
  };

  const empty =
    total === 0
      ? conn === 'OFFLINE' || conn === 'CONNECTING' || backfill.state === 'loading'
        ? 'Waiting for backend…'
        : conn === 'ERROR'
          ? `Could not load messages${backfill.error ? `: ${backfill.error}` : ''}.`
          : 'No messages yet. Agents idle.'
      : filtered
        ? 'No messages match these filters.'
        : mode === 'replay'
          ? 'Nothing was said yet at this point of the replay.'
          : 'No messages yet. Agents idle.';

  return (
    <aside ref={root} tabIndex={-1} id="lk-comms-panel" className="cm-panel" data-variant={variant} aria-label="Communications" onKeyDown={onKey}>
      <header className="cm-head">
        <h2>Communications</h2>
        <span className="cm-state" data-conn={mode === 'replay' ? 'REPLAY' : conn} data-mode={mode}>
          <i aria-hidden /> {mode === 'replay' ? 'Replay' : CONN_TEXT[conn]}
        </span>
        {mode === 'replay' && cursor !== null && <span className="cm-cursor mono" title="Only messages up to the playhead are shown">≤ {fmtSim(cursor * 500)}</span>}
        {unread > 0 && <span className="cm-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
        <span className="cm-grow" />
        <button ref={closeBtn} type="button" className="cm-x" onClick={close} aria-label="Close communications">
          <X size={15} aria-hidden />
        </button>
      </header>
      {runId && <div className="cm-run mono" title="Run context is kept while this panel is closed">{runId}</div>}
      <PreviewBanner />
      {conn === 'STALE' && <div className="cm-note" role="status">No data for a while. Showing the last messages received.</div>}
      {conn === 'RECONNECTING' && <div className="cm-note" role="status">Reconnecting. Missed messages are filled in on reconnect.</div>}
      <Filters shown={visible.length} total={total} />
      {selected ? <Detail e={selected} onBack={() => select(null)} /> : null}
      <div hidden={!!selected} className="cm-body">
        <Feed visible={visible} emptyText={empty} onOpen={select} />
      </div>
      <Announcer visible={visible.length} />
    </aside>
  );
}

/** Execution-tab host: docks the panel on the right when open. */
export function CommunicationsDock() {
  const open = useCommunications((s) => s.open);
  const phone = usePhoneLayout();      // phones host the panel in the shell's BottomSheet (features/responsive); never two panels at once
  if (!open || phone) return null;
  return (
    <div className="cm-dock" role="region" aria-label="Communications dock">
      <CommunicationsPanel variant="dock" />
    </div>
  );
}
