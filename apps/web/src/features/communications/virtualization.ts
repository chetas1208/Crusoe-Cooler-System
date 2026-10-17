import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Fixed-height windowing: the DOM holds only the visible rows (+ overscan), whatever the list length. */
export interface Window {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
}

export function computeWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 8): Window {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start: first, end: Math.max(first, last), padTop: first * rowHeight, padBottom: Math.max(0, (count - last) * rowHeight) };
}

/** distance from the bottom below which the reader counts as "at the live edge" */
export const AT_BOTTOM_PX = 48;
export const isAtBottom = (scrollTop: number, viewport: number, total: number) => total - (scrollTop + viewport) <= AT_BOTTOM_PX;

/**
 * Scroll container hook: tracks scrollTop/viewport (rAF-coalesced), exposes the render window and lets the caller pin to the
 * bottom. It never scrolls on its own unless `pinned` is true.
 */
export function useVirtualScroll(count: number, rowHeight: number, pinned: boolean, onUserScroll: (atBottom: boolean, top: number) => void, restoreTop: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ top: restoreTop, height: 400 });
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pinned) {
      el.scrollTop = el.scrollHeight;
    } else if (restoreTop) el.scrollTop = restoreTop;
    setState({ top: el.scrollTop, height: el.clientHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned) {
      el.scrollTop = el.scrollHeight;
      setState({ top: el.scrollTop, height: el.clientHeight });
    }
  }, [count, pinned]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      raf.current = 0;
      setState((s) => (s.top === el.scrollTop && s.height === el.clientHeight ? s : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => {
      if (!raf.current) raf.current = requestAnimationFrame(measure);
      onUserScroll(isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight), el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => !raf.current && (raf.current = requestAnimationFrame(measure))) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [onUserScroll]);

  const jumpToBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setState({ top: el.scrollTop, height: el.clientHeight });
  };

  return { ref, window: computeWindow(count, rowHeight, state.top, state.height), jumpToBottom };
}
