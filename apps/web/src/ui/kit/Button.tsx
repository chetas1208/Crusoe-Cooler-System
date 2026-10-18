import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './tone';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** shows a spinner, sets aria-busy, blocks clicks, keeps width */
  loading?: boolean;
  /** disabled-with-reason: the button stays focusable (aria-disabled) and a tooltip explains why */
  disabledReason?: string;
  /** toggle button: sets aria-pressed */
  pressed?: boolean;
  /** data-force="hover|active|focus" is for the design gallery only */
  force?: 'hover' | 'active' | 'focus';
}

export interface ButtonProps extends BaseProps {
  icon?: ReactNode;
  iconRight?: ReactNode;
  children: ReactNode;
}

const Spinner = () => <span className="lk-spinner" aria-hidden="true" />;

function useBtn({ variant = 'secondary', size = 'md', loading, disabled, disabledReason, pressed, force, className, onClick, ...rest }: BaseProps, extra?: string) {
  const blocked = !!(loading || disabled || disabledReason);
  const props = {
    ...rest,
    type: rest.type ?? 'button',
    className: cx('lk-btn', extra, className),
    'data-variant': variant,
    'data-size': size,
    'data-loading': loading || undefined,
    'data-force': force,
    'aria-pressed': pressed,
    'aria-busy': loading || undefined,
    // reason or loading keeps focusability; a plain `disabled` is the native attribute
    'aria-disabled': disabledReason || loading ? true : undefined,
    disabled: disabled && !disabledReason ? true : undefined,
    onClick: blocked ? (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault() : onClick,
  };
  return props;
}

/** Text button. variant: primary | secondary | ghost | danger | warn; size: sm 28 / md 34 / lg 42 (44 on coarse pointers). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(p, ref) {
  const { icon, iconRight, children, ...rest } = p;
  const props = useBtn(rest);
  const btn = (
    <button ref={ref} {...props}>
      {p.loading ? <Spinner /> : icon ? <span className="lk-btn__icon" aria-hidden="true">{icon}</span> : null}
      <span className="lk-btn__label">{children}</span>
      {iconRight && !p.loading && <span className="lk-btn__icon" aria-hidden="true">{iconRight}</span>}
    </button>
  );
  return p.disabledReason ? <Tooltip content={p.disabledReason} describe>{btn}</Tooltip> : btn;
});

export interface IconButtonProps extends BaseProps {
  /** required: icon-only controls have no visible name */
  'aria-label': string;
  icon: ReactNode;
  /** tooltip text; defaults to the aria-label */
  tip?: string | false;
}

/** Icon-only button. `aria-label` is required by the type system. 32/28/40 visual, 44 hit target on coarse pointers. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(p, ref) {
  const { icon, tip, ...rest } = p;
  const props = useBtn({ variant: 'ghost', ...rest }, 'lk-btn--icon');
  const btn = (
    <button ref={ref} {...props}>
      {p.loading ? <Spinner /> : <span className="lk-btn__icon" aria-hidden="true">{icon}</span>}
    </button>
  );
  const text = p.disabledReason ?? (tip === false ? '' : tip ?? p['aria-label']);
  return text ? <Tooltip content={text} describe={!!p.disabledReason}>{btn}</Tooltip> : btn;
});
