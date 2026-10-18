import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ArrowDown } from 'lucide-react';
import { useCommunications } from './communicationStore';
import { NewDivider, Row, ThreadHead } from './Row';
import { buildItems, moveActive, scrollToReveal, type Item } from './listModel';
import { taskDepths } from './format';
import { useVirtualScroll } from './virtualization';
import type { CommunicationEventV1 } from './types';

export interface FeedHandle {
  /** j / k / arrows: move the roving focus by delta, or to the first / last message */
  move(m: number | 'first' | 'last'): void;
  /** put keyboard focus on the current row (used when the detail drawer closes) */
  focusRow(key?: string | null): void;
}

/**
 * Virtualised message list. A bounded number of rows exists in the DOM whatever the length (5,000+ events browse smoothly), and the
 * list only follows new messages while the reader is at the live edge: scrolling back to read history is never interrupted.
 * Keyboard: one row is the tab stop (roving tabindex); j / k and the arrows move it, Enter opens it.
 */
export function Feed({ visible, empty, onOpen, handle }: { visible: CommunicationEventV1[]; empty: ReactNode; onOpen: (id: string) => void; handle?: Ref<FeedHandle> }) {
  const follow = useCommunications((s) => s.follow);
  const selected = useCommunications((s) => s.selectedId);
  const unread = useCommunications((s) => s.unread);
  const readSeq = useCommunications((s) => s.readSeq);
  const mode = useCommunications((s) => s.mode);
  const scrollTop = useCommunications((s) => s.scrollTop);
  const runId = useCommunications((s) => s.runId);
  const density = useCommunications((s) => s.density);
  const grouped = useCommunications((s) => s.grouped);
  const collapsed = useCommunications((s) => s.collapsed);
  const toggleThread = useCommunications((s) => s.toggleThread);

  const onScroll = useCallback((atBottom: boolean, top: number) => {
    const st = useCommunications.getState();
    st.setFollow(atBottom);
    st.setScrollTop(top);
    if (atBottom) st.markRead();
  }, []);

  const depths = useMemo(() => taskDepths(visible), [visible]);
  const newAfter = !follow && unread > 0 ? readSeq : null;
  const built = useMemo(() => buildItems(visible, { grouped, collapsed, density, depths, newAfterSeq: newAfter }), [visible, grouped, collapsed, density, depths, newAfter]);
  const { items, offsets } = built;
  const { ref, window: w, jumpToBottom, scrollTo, top, height } = useVirtualScroll(offsets, follow, onScroll, scrollTop);

  const navKeys = useMemo(() => items.filter((it) => it.t !== 'divider').map((it) => it.key), [items]);
  const indexByKey = useMemo(() => new Map(items.map((it, i) => [it.key, i])), [items]);
  const keyByEvent = useMemo(() => new Map(items.flatMap((it) => (it.t === 'row' ? [[it.e.event_id, it.key] as const] : []))), [items]);
  const rendered = useMemo(() => items.slice(w.start, w.end), [items, w.start, w.end]);

  // roving focus: the active row is the one tab stop; if it has scrolled out of the window the first rendered one takes over
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const firstRendered = rendered.find((it) => it.t !== 'divider')?.key ?? null;
  const tabStop = activeKey && rendered.some((it) => it.key === activeKey) ? activeKey : firstRendered;
  const pendingFocus = useRef<string | null>(null);
  const onActive = useCallback((k: string) => setActiveKey(k), []);

  const reveal = useCallback(
    (key: string) => {
      const i = indexByKey.get(key);
      if (i === undefined) return;
      const next = scrollToReveal(offsets, i, top, height);
      if (next !== top) scrollTo(next);
    },
    [indexByKey, offsets, top, height, scrollTo],
  );
  const focusKey = useCallback(
    (key: string) => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      el?.focus({ preventScroll: true });
    },
    [ref],
  );
  useLayoutEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  useImperativeHandle(
    handle,
    () => ({
      move: (m) => {
        const next = moveActive(navKeys, tabStop, m);
        if (!next) return;
        setActiveKey(next);
        pendingFocus.current = next;
        reveal(next);
      },
      focusRow: (key) => {
        const k = key ?? tabStop;
        if (!k) return;
        setActiveKey(k);
        pendingFocus.current = k;
        reveal(k);
        focusKey(k);
      },
    }),
    [navKeys, tabStop, reveal, focusKey],
  );

  // opening a message from a link inside the drawer (or from elsewhere) brings its row into view behind the drawer
  useEffect(() => {
    if (!selected) return;
    const k = keyByEvent.get(selected);
    if (k) {
      setActiveKey(k);
      reveal(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const jump = () => {
    useCommunications.getState().setFollow(true);
    useCommunications.getState().markRead();
    jumpToBottom();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const m: number | 'first' | 'last' | null = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : e.key === 'PageDown' ? 8 : e.key === 'PageUp' ? -8 : null;
    if (m === null) return;
    e.preventDefault();
    const next = moveActive(navKeys, tabStop, m);
    if (!next) return;
    setActiveKey(next);
    pendingFocus.current = next;
    reveal(next);
  };

  const renderItem = (it: Item) => {
    if (it.t === 'divider') return <NewDivider key={it.key} count={it.count} />;
    if (it.t === 'head') return <ThreadHead key={it.key} t={it.thread} itemKey={it.key} active={tabStop === it.key} onToggle={toggleThread} onActive={onActive} />;
    const idx = visible.length ? it.e.seq : 0;
    return (
      <Row key={it.key} e={it.e} density={density} depth={it.depth} index={rowIndex.get(it.key) ?? idx} total={visible.length} selected={selected === it.e.event_id} active={tabStop === it.key} inherited={!!runId && it.e.run_id !== runId} onOpen={onOpen} onActive={onActive} />
    );
  };
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const it of items) if (it.t === 'row') m.set(it.key, n++);
    return m;
  }, [items]);

  return (
    <div className="cm-feedwrap">
      <div ref={ref} className="cm-feed" role="log" aria-label="Agent communications" aria-live="off" aria-relevant="additions" data-density={density} onKeyDown={onKeyDown}>
        {items.length === 0 ? (
          <div className="cm-empty">{empty}</div>
        ) : (
          <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>{rendered.map(renderItem)}</div>
        )}
      </div>
      {!follow && visible.length > 0 && (
        <button type="button" className="cm-jump" onClick={jump} title={mode === 'replay' ? 'Scroll to the newest message at the playhead' : 'Scroll to the newest message and follow new ones'}>
          <ArrowDown size={14} aria-hidden /> {mode === 'replay' ? 'Jump to playhead' : 'Jump to live'}
          {unread > 0 && <span className="cm-jump__n" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    </div>
  );
}
