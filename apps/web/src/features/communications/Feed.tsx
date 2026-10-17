import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ArrowDown } from 'lucide-react';
import { useCommunications, filterEvents } from './communicationStore';
import { Row, ROW_H } from './Row';
import { useVirtualScroll } from './virtualization';
import type { CommunicationEventV1 } from './types';

/**
 * Virtualised message list. ~100-200 rows exist in the DOM whatever the length (5,000+ events browse smoothly), and the list
 * only follows new messages while the reader is at the live edge: scrolling back to read history is never interrupted.
 */
export function Feed({ visible, emptyText, onOpen }: { visible: CommunicationEventV1[]; emptyText: string; onOpen: (id: string) => void }) {
  const follow = useCommunications((s) => s.follow);
  const selected = useCommunications((s) => s.selectedId);
  const unread = useCommunications((s) => s.unread);
  const mode = useCommunications((s) => s.mode);
  const scrollTop = useCommunications((s) => s.scrollTop);
  const runId = useCommunications((s) => s.runId);
  const onScroll = useCallback((atBottom: boolean, top: number) => {
    const st = useCommunications.getState();
    st.setFollow(atBottom);
    st.setScrollTop(top);
    if (atBottom) st.markRead();
  }, []);
  const { ref, window: w, jumpToBottom } = useVirtualScroll(visible.length, ROW_H, follow, onScroll, scrollTop);
  // the feed is hidden (display:none) while a detail is open, which resets its scroll offset: put the reader back where they were
  const hadSelection = useRef(false);
  useEffect(() => {
    if (selected) {
      hadSelection.current = true;
      return;
    }
    if (!hadSelection.current) return;
    hadSelection.current = false;
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const st = useCommunications.getState();
      el.scrollTop = st.follow ? el.scrollHeight : st.scrollTop;
    });
    return () => cancelAnimationFrame(id);
  }, [selected, ref]);
  const rows = useMemo(() => visible.slice(w.start, w.end), [visible, w.start, w.end]);
  const jump = () => {
    useCommunications.getState().setFollow(true);
    useCommunications.getState().markRead();
    jumpToBottom();
  };
  return (
    <div className="cm-feedwrap">
      <div ref={ref} className="cm-feed" role="log" aria-label="Agent communications" aria-live="off" aria-relevant="additions" tabIndex={0}>
        {visible.length === 0 ? (
          <p className="cm-empty">{emptyText}</p>
        ) : (
          <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>
            {rows.map((e, i) => (
              <Row key={e.run_id + ':' + e.seq} e={e} index={w.start + i} total={visible.length} selected={selected === e.event_id} onOpen={onOpen} inherited={!!runId && e.run_id !== runId} />
            ))}
          </div>
        )}
      </div>
      {!follow && visible.length > 0 && (
        <button type="button" className="cm-jump" onClick={jump}>
          <ArrowDown size={13} aria-hidden /> {mode === 'replay' ? 'Jump to playhead' : 'Jump to live'}
          {unread > 0 && <span className="cm-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    </div>
  );
}

export { filterEvents };
