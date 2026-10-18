import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useAnchored, useDismiss, useFocusTrap, useRoving, type Placement } from './a11y';
import { cx, type Tone, TONE_ICON } from './tone';
import { IconButton } from './Button';

/* ───────── Popover ───────── */

export function Popover({ trigger, children, label, placement = 'bottom-start', open: controlled, onOpenChange, className }: { trigger: (p: { ref: Ref<HTMLButtonElement>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog'; 'aria-controls': string }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); label: string; placement?: Placement; open?: boolean; onOpenChange?: (o: boolean) => void; className?: string }) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const set = (o: boolean) => { setInner(o); onOpenChange?.(o); };
  const anchor = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const pos = useAnchored(anchor, box, open, placement, 8);
  useDismiss(open, () => { set(false); anchor.current?.focus(); }, [box, anchor]);
  useEffect(() => { if (open && pos) box.current?.focus({ preventScroll: true }); }, [open, !!pos]);
  return (
    <>
      {trigger({ ref: anchor, onClick: () => set(!open), 'aria-expanded': open, 'aria-haspopup': 'dialog', 'aria-controls': id })}
      {open && createPortal(
        <div ref={box} id={id} role="dialog" aria-label={label} tabIndex={-1} className={cx('lk-popover', className)} data-placement={pos?.p} style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
          {typeof children === 'function' ? children(() => set(false)) : children}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ───────── Menu ───────── */

export interface MenuItem { id: string; label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; disabledReason?: string; onSelect?: () => void }

export function Menu({ trigger, items, label, placement = 'bottom-start' }: { trigger: (p: { ref: Ref<HTMLButtonElement>; onClick: () => void; onKeyDown: (e: React.KeyboardEvent) => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; 'aria-controls': string }) => ReactNode; items: MenuItem[]; label: string; placement?: Placement }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const pos = useAnchored(anchor, box, open, placement, 6);
  const close = (refocus = true) => { setOpen(false); if (refocus) anchor.current?.focus(); };
  useDismiss(open, () => close(), [box, anchor]);
  const roving = useRoving(items.length, active, setActive, 'vertical', (i) => !!items[i].disabled);
  useEffect(() => { if (open) { const first = items.findIndex((i) => !i.disabled); setActive(first < 0 ? 0 : first); } }, [open]);
  useEffect(() => { if (open && pos) box.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true }); }, [open, !!pos]);
  const choose = (it: MenuItem) => { if (it.disabled) return; close(); it.onSelect?.(); };
  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } },
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-controls': id,
      })}
      {open && createPortal(
        <div ref={box} id={id} role="menu" aria-label={label} className="lk-menu" data-placement={pos?.p} style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }} onKeyDown={(e) => { roving.onKeyDown(e); if (e.key === 'Tab') close(false); }}>
          {items.map((it, i) => (
            <button key={it.id} {...roving.item(i)} role="menuitem" type="button" className="lk-menu__item" data-danger={it.danger || undefined} aria-disabled={it.disabled || undefined} title={it.disabled ? it.disabledReason : undefined} onClick={() => choose(it)} onPointerEnter={() => !it.disabled && setActive(i)}>
              {it.icon && <span className="lk-menu__icon" aria-hidden="true">{it.icon}</span>}
              <span className="lk-menu__label">{it.label}</span>
              {it.hint && <kbd className="lk-kbd">{it.hint}</kbd>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ───────── Dialog ───────── */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** tone adds an icon + accent edge (destructive confirmations: 'critical') */
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  /** click on the backdrop closes; default true. Esc always closes unless `dismissible` is false. */
  dismissible?: boolean;
  /** for overlap checks */
  panelId?: string;
}

/** Modal dialog: focus moves in, Tab is trapped, Esc closes, focus is restored to the opener. Mark an element `data-autofocus` to choose the initial focus. */
export function Dialog({ open, onClose, title, description, children, footer, tone, size = 'md', dismissible = true, panelId }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const tid = useId();
  const did = useId();
  useFocusTrap(box, open);
  useDismiss(open && dismissible, onClose, [box], { outside: false });
  if (!open) return null;
  const Icon = tone ? TONE_ICON[tone] : null;
  return createPortal(
    <div className="lk-scrim" data-dialog-scrim onPointerDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={tid} aria-describedby={description ? did : undefined} className="lk-dialog" data-size={size} data-tone={tone} data-panel={panelId}>
        <header className="lk-dialog__head">
          {Icon && <Icon size={18} aria-hidden="true" className="lk-dialog__icon" />}
          <h2 id={tid} className="lk-dialog__title">{title}</h2>
          {dismissible && <IconButton aria-label="Close dialog" size="sm" icon={<X size={16} />} onClick={onClose} />}
        </header>
        {description && <p id={did} className="lk-dialog__desc">{description}</p>}
        {children && <div className="lk-dialog__body">{children}</div>}
        {footer && <footer className="lk-dialog__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
