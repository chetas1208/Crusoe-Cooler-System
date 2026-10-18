import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { IconButton } from '../../ui/kit/index';

export type SheetState = 'closed' | 'peek' | 'half' | 'expanded';
const SNAPS: SheetState[] = ['peek', 'half', 'expanded'];

/**
 * Tap-operable bottom sheet with three snap points (peek / half / expanded). Not swipe-only: the header has explicit expand/collapse and close
 * buttons (the grabber also drags and snaps), Escape closes, focus moves into the sheet on open and returns to the opener on close.
 * Height uses dvh so the browser chrome / soft keyboard never hides it. In landscape phones the same markup is restyled as a right drawer
 * (see styles/mobile.css), so the chrome is identical in both orientations.
 */
export function BottomSheet({ state, onState, title, head, children, onClose, className, closeClass, closeLabel = 'Close' }: { state: SheetState; onState: (s: SheetState) => void; title: string; head?: ReactNode; children: ReactNode; onClose?: () => void; className?: string; closeClass?: string; closeLabel?: string }) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<{ y: number; at: SheetState } | null>(null);
  const id = useId();
  useEffect(() => {
    if (state === 'closed') return;
    opener.current = (document.activeElement as HTMLElement) ?? null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [state === 'closed']); // eslint-disable-line react-hooks/exhaustive-deps
  if (state === 'closed') return null;
  const close = () => {
    onState('closed');
    onClose?.();
  };
  const i = SNAPS.indexOf(state);
  const up = () => onState(SNAPS[Math.min(SNAPS.length - 1, i + 1)]);
  const down = () => onState(SNAPS[Math.max(0, i - 1)]);
  return (
    <section ref={ref} tabIndex={-1} className={`sheet${className ? ' ' + className : ''}`} data-state={state} role="dialog" aria-modal="false" aria-labelledby={id} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div
        className="sheet__grab"
        aria-hidden
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, at: state };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const dy = e.clientY - d.y;
          if (dy < -40) up();
          else if (dy > 40) (i === 0 ? close() : down());
        }}
        onPointerCancel={() => (drag.current = null)}
      >
        <i />
      </div>
      <header className="sheet__head">
        {head ?? <h2 id={id}>{title}</h2>}
        {head && <span id={id} className="cm-sr">{title}</span>}
        <IconButton className="sheet__btn sheet__btn--size" aria-label="Expand" aria-expanded={state === 'expanded'} disabledReason={state === 'expanded' ? 'Already fully expanded' : undefined} onClick={up} icon={<ChevronUp size={20} />} />
        <IconButton className="sheet__btn sheet__btn--size" aria-label="Collapse" disabledReason={state === 'peek' ? 'Already at the smallest size' : undefined} onClick={down} icon={<ChevronDown size={20} />} />
        <IconButton className={`sheet__btn${closeClass ? ' ' + closeClass : ''}`} aria-label={closeLabel} onClick={close} icon={<X size={20} />} />
      </header>
      <div className="sheet__body">{children}</div>
    </section>
  );
}
