import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { indexAt } from './listModel';

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

/**
 * The scroll offset the window is computed from can be stale for one frame (a filter just shrank the list, or the panel reopened with an offset from a longer
 * list). Clamp it to what the current list can actually scroll to, so the visible window is never past the end (= 0 rows) while the browser catches up.
 */
export function clampTop(count: number, rowHeight: number, scrollTop: number, viewport: number): number {
  return Math.max(0, Math.min(scrollTop, count * rowHeight - viewport));
}

/** distance from the bottom below which the reader counts as "at the live edge" */
export const AT_BOTTOM_PX = 48;
export const isAtBottom = (scrollTop: number, viewport: number, total: number) => total - (scrollTop + viewport) <= AT_BOTTOM_PX;

/** Window over variable-height items from prefix sums (offsets[n] = total height). */
export function computeVarWindow(offsets: number[], scrollTop: number, viewport: number, overscan = 6): Window {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, indexAt(offsets, scrollTop) - overscan);
  const last = Math.min(count, indexAt(offsets, scrollTop + viewport) + 1 + overscan);
  return { start: first, end: Math.max(first, last), padTop: offsets[first], padBottom: Math.max(0, offsets[count] - offsets[Math.max(first, last)]) };
}

/**
 * Scroll container hook: tracks scrollTop/viewport (rAF-coalesced), exposes the render window and lets the caller pin to the
 * bottom. It never scrolls on its own unless `pinned` is true.
 */
export function useVirtualScroll(offsets: number[], pinned: boolean, onUserScroll: (atBottom: boolean, top: number) => void, restoreTop: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ top: restoreTop, height: 400 });
  const raf = useRef(0);
  const total = offsets[offsets.length - 1] ?? 0;

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
    if (!el) return;
    if (pinned) el.scrollTop = el.scrollHeight;
    // re-read the real offset in the same commit (the browser has already clamped it to the new content height)
    setState((s) => (s.top === el.scrollTop && s.height === el.clientHeight ? s : { top: el.scrollTop, height: el.clientHeight }));
  }, [total, pinned]);

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
  const scrollTo = (top: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = top;
    setState({ top: el.scrollTop, height: el.clientHeight });
  };

  const clamped = Math.max(0, Math.min(state.top, total - state.height));
  return { ref, window: computeVarWindow(offsets, clamped, state.height), jumpToBottom, scrollTo, top: clamped, height: state.height };
}
