import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useAnchored, type Placement } from './a11y';

/* ───────── Tooltip ───────── */

const mergeRef = <T,>(...refs: Array<Ref<T> | undefined>) => (el: T | null) => refs.forEach((r) => { if (typeof r === 'function') r(el); else if (r) (r as { current: T | null }).current = el; });

/** Hover + keyboard-focus tooltip. Child must be a single element that accepts a ref. `describe` links it as aria-describedby. */
export function Tooltip({ content, children, placement = 'top', delay = 350, describe = false }: { content: ReactNode; children: ReactElement<Record<string, unknown>>; placement?: Placement; delay?: number; describe?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const id = useId();
  const timer = useRef<number | undefined>(undefined);
  const pos = useAnchored(anchor, tip, open, placement, 8);
  const show = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), delay); };
  const hide = () => { window.clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open]);
  if (!isValidElement(children)) return children;
  const c = children.props as Record<string, (e: unknown) => void> & { ref?: Ref<HTMLElement> };
  const child = cloneElement(children, {
    ref: mergeRef(anchor, (children as unknown as { props: { ref?: Ref<HTMLElement> } }).props.ref),
    onPointerEnter: (e: unknown) => { c.onPointerEnter?.(e); show(); },
    onPointerLeave: (e: unknown) => { c.onPointerLeave?.(e); hide(); },
    onFocus: (e: unknown) => { c.onFocus?.(e); show(); },
    onBlur: (e: unknown) => { c.onBlur?.(e); hide(); },
    'aria-describedby': describe || open ? id : undefined,
  });
  return (
    <>
      {child}
      {createPortal(
        <div ref={tip} id={id} role="tooltip" className="lk-tooltip" data-open={open || undefined} data-placement={pos?.p} style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: open && pos ? 'visible' : 'hidden' }}>
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}

