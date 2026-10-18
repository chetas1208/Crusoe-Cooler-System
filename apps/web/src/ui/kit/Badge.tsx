import type { CSSProperties, ReactNode } from 'react';
import { cx, TONE_ICON, type Tone } from './tone';

/** Status badge. Always renders text; semantic tones add a default icon so meaning never rests on colour alone. `icon={null}` suppresses it. */
export function Badge({ tone = 'neutral', icon, children, sm, variant = 'soft', title, style, className }: { tone?: Tone; icon?: ReactNode | null; children: ReactNode; sm?: boolean; variant?: 'soft' | 'solid' | 'outline'; title?: string; style?: CSSProperties; className?: string }) {
  const Def = TONE_ICON[tone];
  const glyph = icon === undefined ? (Def ? <Def size={sm ? 11 : 13} strokeWidth={2.4} /> : null) : icon;
  return (
    <span className={cx('lk-badge', className)} data-tone={tone} data-variant={variant} data-size={sm ? 'sm' : 'md'} title={title} style={style}>
      {glyph && <span className="lk-badge__icon" aria-hidden="true">{glyph}</span>}
      <span>{children}</span>
    </span>
  );
}

/** Status dot with required text (shape varies by severity too: circle, diamond, square). */
export function StatusDot({ tone = 'nominal', label, pulse, hideLabel }: { tone?: Tone; label: string; pulse?: boolean; /** visually hidden but still read by assistive tech */ hideLabel?: boolean }) {
  return (
    <span className="lk-status" data-tone={tone}>
      <span className="lk-status__dot" data-pulse={pulse || undefined} aria-hidden="true" />
      <span className={hideLabel ? 'sr-only' : 'lk-status__label'}>{label}</span>
    </span>
  );
}
