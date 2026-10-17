import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useWorld } from '@loopkeeper/core/store';
import { READING_META } from '@loopkeeper/core/contracts';

/* ───────── brand ───────── */

export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7af0de" />
          <stop offset="1" stopColor="#2fb7cf" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="11" fill="none" stroke={`url(#${id})`} strokeWidth="3.2" strokeLinecap="round" strokeDasharray="55 14" transform="rotate(-62 16 16)" />
      <circle cx="26.4" cy="11.4" r="3" fill="#ff9a3c" />
    </svg>
  );
}

/* ───────── small atoms ───────── */

export function Chip({ tone, children, sm, style, title }: { tone?: string; children: ReactNode; sm?: boolean; style?: CSSProperties; title?: string }) {
  return (
    <span className={`chip${sm ? ' chip--sm' : ''}`} data-tone={tone} style={style} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, pulse }: { tone?: string; pulse?: boolean }) {
  return <span className={`dot tone-${tone ?? 'nominal'}${pulse ? ' dot--pulse' : ''}`} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="eyebrow" style={style}>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ items, value, onChange, small, group }: { items: Array<{ id: T; label: ReactNode; hint?: string; disabled?: boolean }>; value: T; onChange: (v: T) => void; small?: boolean; group: string }) {
  return (
    <div className={`seg${small ? ' seg--sm' : ''}`} role="tablist">
      {items.map((it) => (
        <button key={it.id} className="seg__item" role="tab" aria-selected={value === it.id} disabled={it.disabled} onClick={() => onChange(it.id)}>
          {value === it.id && <motion.span layoutId={`seg-${group}`} className="seg__thumb" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>{it.label}</span>
          {it.hint && <span className="kbd" style={{ position: 'relative' }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, unit, tone, hint }: { label: string; value: ReactNode; unit?: string; tone?: string; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${tone ? ` tone-${tone}` : ''}`}>
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--t3)' }}>{hint}</div>}
    </div>
  );
}

export function Meter({ value, tone = 'accent', style }: { value: number; tone?: string; style?: CSSProperties }) {
  return (
    <div className={`meter tone-${tone}`} style={style}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/* ───────── progress ring ───────── */

export function Ring({ value, size = 36, stroke = 3.5, tone = 'accent', children, indeterminate }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode; indeterminate?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className={`tone-${tone}`} style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', animation: indeterminate ? 'spin 1.2s linear infinite' : undefined }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.09)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (indeterminate ? 0.28 : Math.max(0.001, Math.min(1, value))))} style={{ transition: 'stroke-dashoffset .4s var(--ease)' }} />
      </svg>
      {children && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: Math.max(9, size * 0.28), fontWeight: 600 }}>{children}</div>}
    </div>
  );
}

/* ───────── sparkline ───────── */

export function Sparkline({ data, w = 120, h = 34, color = 'var(--accent)', band, min, max }: { data: Array<[number, number]>; w?: number; h?: number; color?: string; band?: [number, number]; min?: number; max?: number }) {
  const id = useId();
  const { line, area, last } = useMemo(() => {
    if (data.length < 2) return { line: '', area: '', last: null as null | [number, number] };
    const ys = data.map((d) => d[1]);
    const lo = min ?? Math.min(...ys);
    const hi = max ?? Math.max(...ys);
    const span = Math.max(hi - lo, 1e-6);
    const x0 = data[0][0];
    const x1 = data[data.length - 1][0];
    const xs = Math.max(x1 - x0, 1e-6);
    const pad = 3;
    const px = (t: number) => ((t - x0) / xs) * (w - pad * 2) + pad;
    const py = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);
    const pts = data.map((d) => [px(d[0]), py(d[1])] as const);
    const l = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return { line: l, area: `${l}L${pts[pts.length - 1][0].toFixed(1)},${h}L${pts[0][0].toFixed(1)},${h}Z`, last: pts[pts.length - 1] as unknown as [number, number] };
  }, [data, w, h, min, max]);
  if (!line) return <div style={{ width: w, height: h, display: 'grid', placeItems: 'center', fontSize: 10, color: 'var(--t4)' }}>collecting…</div>;
  void band;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible', color }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.4" fill="currentColor" />}
    </svg>
  );
}

/* ───────── hooks ───────── */

export function useSeries(assetId: string | undefined, metric: string, take = 90): Array<[number, number]> {
  const v = useWorld((s) => s.seriesVersion);
  return useMemo(() => {
    if (!assetId) return [];
    const arr = useWorld.getState().series[`${assetId}.${metric}`] ?? [];
    return arr.slice(-take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, metric, take, v]);
}

export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function fmtReading(metric: string, v: number | undefined) {
  const m = READING_META[metric];
  if (v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(m?.decimals ?? 1);
}
export { READING_META };
