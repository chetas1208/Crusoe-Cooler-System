import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { IconButton } from './Button';
import { useDismiss } from './a11y';
import { cx } from './tone';

export interface PanelProps {
  /** value of the data-panel attribute: layout/overlap checks key on it */
  panelId?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** leading glyph in the header */
  icon?: ReactNode;
  /** header actions (IconButtons, Menu triggers…) */
  actions?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  collapsible?: boolean;
  /** controlled collapse */
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (c: boolean) => void;
  /** 'glass' (default, over the canvas) | 'solid' | 'card' (flat, inside a panel) */
  surface?: 'glass' | 'solid' | 'card';
  /** remove body padding (lists, tables, canvases) */
  flush?: boolean;
  /** body scrolls when the panel has a bounded height */
  scroll?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: 'section' | 'aside' | 'div' | 'article';
  'aria-label'?: string;
  /** gallery only */
  forceCollapsed?: boolean;
}

/** Panel / card chrome: header (title + actions + close), body, footer; collapsible. Carries data-panel for overlap checks. */
export function Panel({ panelId, title, subtitle, icon, actions, footer, onClose, closeLabel = 'Close', collapsible, collapsed, defaultCollapsed, onCollapsedChange, surface = 'glass', flush, scroll, children, className, style, as: As = 'section', ...rest }: PanelProps) {
  const [inner, setInner] = useState(!!defaultCollapsed);
  const isCollapsed = collapsible ? (collapsed ?? inner) : false;
  const bodyId = useId();
  const tid = useId();
  const toggle = () => { const n = !isCollapsed; setInner(n); onCollapsedChange?.(n); };
  const hasHead = title || actions || onClose || collapsible;
  return (
    <As className={cx('lk-panel', className)} data-panel={panelId} data-surface={surface} data-collapsed={isCollapsed || undefined} style={style} aria-labelledby={title ? tid : undefined} aria-label={rest['aria-label']}>
      {hasHead && (
        <header className="lk-panel__head">
          {collapsible ? (
            <button type="button" className="lk-panel__toggle" aria-expanded={!isCollapsed} aria-controls={bodyId} onClick={toggle}>
              <ChevronDown size={16} className="lk-panel__chev" aria-hidden="true" />
              {icon && <span className="lk-panel__icon" aria-hidden="true">{icon}</span>}
              <span id={tid} className="lk-panel__title">{title}</span>
              {subtitle && <span className="lk-panel__sub">{subtitle}</span>}
            </button>
          ) : (
            <div className="lk-panel__titles">
              {icon && <span className="lk-panel__icon" aria-hidden="true">{icon}</span>}
              <h3 id={tid} className="lk-panel__title">{title}</h3>
              {subtitle && <span className="lk-panel__sub">{subtitle}</span>}
            </div>
          )}
          {(actions || onClose) && (
            <div className="lk-panel__actions">
              {actions}
              {onClose && <IconButton size="sm" aria-label={closeLabel} icon={<X size={16} />} onClick={onClose} />}
            </div>
          )}
        </header>
      )}
      <div id={bodyId} className="lk-panel__collapse" data-open={!isCollapsed} inert={isCollapsed || undefined}>
        <div className="lk-panel__clip">
          <div className={cx('lk-panel__body', flush && 'lk-panel__body--flush', scroll && 'scroll')}>{children}</div>
          {footer && <footer className="lk-panel__foot">{footer}</footer>}
        </div>
      </div>
    </As>
  );
}

/** Edge drawer (left | right), non-modal by default; Esc closes. Renders its own fixed position; z below dialogs. */
export function Drawer({ open, onClose, side = 'right', width = 360, modal, inline, ...panel }: Omit<PanelProps, 'onClose'> & { open: boolean; onClose: () => void; side?: 'left' | 'right'; width?: number; /** show a scrim and trap clicks outside */ modal?: boolean; /** gallery: render in flow instead of fixed */ inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open && !inline, onClose, [ref], { outside: false });
  if (!open) return null;
  const body = (
    <div ref={ref} className="lk-drawer" data-side={side} data-inline={inline || undefined} style={{ width: `min(${width}px, calc(100vw - 16px))` }}>
      <Panel {...panel} surface={panel.surface ?? 'solid'} onClose={onClose} scroll className="lk-drawer__panel" />
    </div>
  );
  if (inline) return body;
  return createPortal(<>{modal && <div className="lk-scrim lk-scrim--soft" onPointerDown={onClose} />}{body}</>, document.body);
}

/** Bottom sheet with grab handle (mobile). Esc closes. */
export function Sheet({ open, onClose, height = '62vh', inline, ...panel }: Omit<PanelProps, 'onClose'> & { open: boolean; onClose: () => void; height?: string; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open && !inline, onClose, [ref], { outside: false });
  useEffect(() => undefined, []);
  if (!open) return null;
  const body = (
    <div ref={ref} className="lk-sheet" data-inline={inline || undefined} style={{ maxHeight: height }}>
      <span className="lk-sheet__grab" aria-hidden="true" />
      <Panel {...panel} surface={panel.surface ?? 'solid'} onClose={onClose} scroll className="lk-sheet__panel" />
    </div>
  );
  return inline ? body : createPortal(body, document.body);
}
