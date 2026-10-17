import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

export type SheetState = 'closed' | 'peek' | 'expanded';

/**
 * Tap-operable bottom sheet (closed / peek / expanded). Not swipe-only: the header has explicit expand/collapse and close buttons, Escape closes,
 * focus moves into the sheet on open and returns to the opener on close. Height uses dvh so the browser chrome / soft keyboard never hides it.
 */
export function BottomSheet({ state, onState, title, children, onClose }: { state: SheetState; onState: (s: SheetState) => void; title: string; children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (state === 'closed') return;
    opener.current = (document.activeElement as HTMLElement) ?? null;
    ref.current?.focus();
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [state === 'closed']); // eslint-disable-line react-hooks/exhaustive-deps
  if (state === 'closed') return null;
  const close = () => {
    onState('closed');
    onClose?.();
  };
  return (
    <section ref={ref} tabIndex={-1} className="sheet" data-state={state} role="dialog" aria-modal="false" aria-labelledby={id} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <header className="sheet__head">
        <h2 id={id}>{title}</h2>
        <button className="sheet__btn" onClick={() => onState(state === 'peek' ? 'expanded' : 'peek')} aria-label={state === 'peek' ? 'Expand' : 'Collapse'} aria-expanded={state === 'expanded'}>
          {state === 'peek' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        <button className="sheet__btn" onClick={close} aria-label="Close">
          <X size={20} />
        </button>
      </header>
      <div className="sheet__body">{children}</div>
    </section>
  );
}
