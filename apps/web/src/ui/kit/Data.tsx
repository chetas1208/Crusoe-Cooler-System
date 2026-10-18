import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cx, TONE_ICON, type Tone } from './tone';

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="lk-kbd">{children}</kbd>;
}

export function Divider({ vertical, label, className }: { vertical?: boolean; label?: ReactNode; className?: string }) {
  if (label && !vertical) return <div className={cx('lk-divider lk-divider--label', className)} role="separator"><span>{label}</span></div>;
  return <div className={cx('lk-divider', vertical && 'lk-divider--v', className)} role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} />;
}

export interface KV { k: ReactNode; v: ReactNode; mono?: boolean; tone?: Tone; hint?: string }
/** Definition list: key left, value right (tabular numerals). */
export function KeyValue({ items, dense, stacked }: { items: KV[]; dense?: boolean; stacked?: boolean }) {
  return (
    <dl className="lk-kv" data-dense={dense || undefined} data-stacked={stacked || undefined}>
      {items.map((it, i) => (
        <div key={i} className="lk-kv__row" title={it.hint}>
          <dt>{it.k}</dt>
          <dd className={cx(it.mono && 'lk-kv__mono')} data-tone={it.tone}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatProps {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: string;
  hint?: ReactNode;
  /** direction + text of change, e.g. { dir:'up', text:'+2.1 °C / 5 min' }; shown as arrow + text, never colour alone */
  trend?: { dir: 'up' | 'down' | 'flat'; text: string; /** is this direction bad? colours the delta */ bad?: boolean };
  /** state text next to the value, e.g. "Over limit" (with the tone's icon) */
  state?: { tone: Tone; text: string };
  size?: 'md' | 'lg';
}

/** Value + unit + trend + state. */
export function Stat({ label, value, unit, tone, hint, trend, state, size = 'md' }: StatProps) {
  const T = trend ? (trend.dir === 'up' ? ArrowUp : trend.dir === 'down' ? ArrowDown : Minus) : null;
  const S = state ? TONE_ICON[state.tone] : null;
  return (
    <div className="stat lk-stat" data-size={size}>
      <div className="stat__label">{label}</div>
      <div className={cx('stat__value', tone && `tone-${tone}`)}>
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {(trend || state) && (
        <div className="lk-stat__meta">
          {trend && T && <span className="lk-stat__trend" data-bad={trend.bad || undefined}><T size={12} strokeWidth={2.6} aria-hidden="true" /><span>{trend.text}</span></span>}
          {state && <span className="lk-stat__state" data-tone={state.tone}>{S && <S size={12} strokeWidth={2.6} aria-hidden="true" />}<span>{state.text}</span></span>}
        </div>
      )}
      {hint && <div className="lk-stat__hint">{hint}</div>}
    </div>
  );
}
