import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

/** next index for roving-tabindex widgets. Skips disabled; wraps. */
export function nextIndex(key: string, cur: number, count: number, orientation: 'horizontal' | 'vertical' | 'both', isDisabled: (i: number) => boolean = () => false): number | null {
  const fwd = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'horizontal' ? ['ArrowRight'] : ['ArrowRight', 'ArrowDown'];
  const back = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'horizontal' ? ['ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
  let step = 0;
  let start = cur;
  if (fwd.includes(key)) step = 1;
  else if (back.includes(key)) step = -1;
  else if (key === 'Home') { step = 1; start = -1; }
  else if (key === 'End') { step = -1; start = count; }
  else return null;
  let i = start;
  for (let n = 0; n < count; n++) {
    i = (i + step + count) % count;
    if (!isDisabled(i)) return i;
  }
  return null;
}

/** Roving tabindex: returns props for the container and a per-item helper. */
export function useRoving(count: number, active: number, onMove: (i: number) => void, orientation: 'horizontal' | 'vertical' | 'both' = 'horizontal', isDisabled?: (i: number) => boolean) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const ni = nextIndex(e.key, active, count, orientation, isDisabled);
    if (ni === null) return;
    e.preventDefault();
    onMove(ni);
    refs.current[ni]?.focus();
  };
  const item = (i: number) => ({ ref: (el: HTMLElement | null) => { refs.current[i] = el; }, tabIndex: i === active ? 0 : -1 });
  return { onKeyDown, item };
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Traps Tab inside `ref`, moves focus in on open, restores it on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    if (first === root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
    first.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!els.length) { e.preventDefault(); return; }
      const a = els[0];
      const z = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === root)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

/** Esc and outside-press dismissal. */
export function useDismiss(active: boolean, onDismiss: () => void, refs: Array<RefObject<HTMLElement | null>>, opts: { outside?: boolean } = {}) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cb.current(); } };
    const down = (e: PointerEvent) => {
      if (opts.outside === false) return;
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'bottom-start' | 'bottom-end';

/** Fixed-position coordinates for a floating element anchored to `anchor`, flipped/clamped to the viewport. */
export function useAnchored(anchor: RefObject<HTMLElement | null>, floating: RefObject<HTMLElement | null>, open: boolean, placement: Placement = 'bottom-start', gap = 8) {
  const [pos, setPos] = useState<{ x: number; y: number; p: Placement } | null>(null);
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const f = floating.current?.getBoundingClientRect();
    if (!a || !f) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let p = placement;
    if (p === 'top' && a.top - f.height - gap < 4) p = 'bottom';
    else if (p === 'bottom' && a.bottom + f.height + gap > vh - 4) p = 'top';
    else if (p.startsWith('bottom-') && a.bottom + f.height + gap > vh - 4 && a.top - f.height - gap > 4) p = 'top';
    let x = 0;
    let y = 0;
    if (p === 'top') { x = a.left + a.width / 2 - f.width / 2; y = a.top - f.height - gap; }
    else if (p === 'bottom') { x = a.left + a.width / 2 - f.width / 2; y = a.bottom + gap; }
    else if (p === 'left') { x = a.left - f.width - gap; y = a.top + a.height / 2 - f.height / 2; }
    else if (p === 'right') { x = a.right + gap; y = a.top + a.height / 2 - f.height / 2; }
    else if (p === 'bottom-end') { x = a.right - f.width; y = a.bottom + gap; }
    else { x = a.left; y = a.bottom + gap; }
    if (placement.startsWith('bottom-') && p === 'top') y = a.top - f.height - gap;
    x = Math.max(8, Math.min(x, vw - f.width - 8));
    y = Math.max(8, Math.min(y, vh - f.height - 8));
    setPos({ x: Math.round(x), y: Math.round(y), p });
  }, [anchor, floating, placement, gap]);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, place]);
  return pos;
}

let uid = 0;
export const nextId = (p = 'lk') => `${p}-${++uid}`;

/* ───────── numeric contrast (WCAG 2.x), used by tests and the gallery's contrast table ───────── */
export type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA {
  const s = c.trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`bad colour ${c}`);
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0], p[1], p[2], p[3] ?? 1];
}
export function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
export function luminance([r, g, b]: RGBA) {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** contrast ratio of fg over bg (fg may be translucent; layers composite over `under`). */
export function contrast(fg: string | RGBA, bg: string | RGBA, under: string | RGBA = '#090b0f'): number {
  const u = typeof under === 'string' ? parseColor(under) : under;
  const b = over(typeof bg === 'string' ? parseColor(bg) : bg, u);
  const f = over(typeof fg === 'string' ? parseColor(fg) : fg, b);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
