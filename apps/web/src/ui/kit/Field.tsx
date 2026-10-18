import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import { cx } from './tone';

interface Ctx { id: string; describedBy?: string; invalid?: boolean; required?: boolean }
const FieldCtx = createContext<Ctx | null>(null);

/** Label + control + hint/error. Child controls (Input, Select, Slider, Textarea) pick up id / aria-describedby / aria-invalid automatically. */
export function Field({ label, hint, error, required, children, inline }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; inline?: boolean }) {
  const id = useId();
  const hid = hint ? `${id}-hint` : undefined;
  const eid = error ? `${id}-err` : undefined;
  return (
    <FieldCtx.Provider value={{ id, describedBy: [eid, hid].filter(Boolean).join(' ') || undefined, invalid: !!error, required }}>
      <div className="lk-field" data-invalid={!!error || undefined} data-inline={inline || undefined}>
        <label className="lk-field__label" htmlFor={id}>{label}{required && <span className="lk-field__req" aria-hidden="true"> *</span>}</label>
        {children}
        {hint && !error && <div id={hid} className="lk-field__hint">{hint}</div>}
        {error && <div id={eid} className="lk-field__err" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{error}</span></div>}
      </div>
    </FieldCtx.Provider>
  );
}
const useField = () => useContext(FieldCtx);

type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; leading?: ReactNode; force?: 'hover' | 'focus' };
export function Input({ invalid, leading, className, force, ...p }: InputProps) {
  const f = useField();
  return (
    <span className={cx('lk-input', className)} data-invalid={invalid || f?.invalid || undefined} data-disabled={p.disabled || undefined} data-force={force}>
      {leading && <span className="lk-input__lead" aria-hidden="true">{leading}</span>}
      <input id={f?.id} aria-describedby={f?.describedBy} aria-invalid={invalid || f?.invalid || undefined} required={f?.required} {...p} />
    </span>
  );
}

export function Textarea({ invalid, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const f = useField();
  return <textarea id={f?.id} className={cx('lk-textarea', className)} aria-describedby={f?.describedBy} aria-invalid={invalid || f?.invalid || undefined} data-invalid={invalid || f?.invalid || undefined} {...p} />;
}

export function Select({ invalid, className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const f = useField();
  return (
    <span className={cx('lk-select', className)} data-invalid={invalid || f?.invalid || undefined} data-disabled={p.disabled || undefined}>
      <select id={f?.id} aria-describedby={f?.describedBy} aria-invalid={invalid || f?.invalid || undefined} {...p}>{children}</select>
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, unit, disabled, label, format }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; disabled?: boolean; /** aria-label when not inside a Field */ label?: string; format?: (v: number) => string }) {
  const f = useField();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <span className="lk-slider" data-disabled={disabled || undefined}>
      <input id={f?.id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={f ? undefined : label} aria-describedby={f?.describedBy} aria-valuetext={`${format ? format(value) : value}${unit ?? ''}`} style={{ ['--lk-pct' as string]: `${pct}%` }} onChange={(e) => onChange(Number(e.target.value))} />
      <output className="lk-slider__out">{format ? format(value) : value}{unit && <span className="lk-slider__unit">{unit}</span>}</output>
    </span>
  );
}

/** role=switch toggle with a visible label (never colour/position alone: label states are On/Off in the gallery). */
export function Switch({ checked, onChange, label, disabled, disabledReason, force }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; disabledReason?: string; force?: 'hover' | 'focus' }) {
  const blocked = disabled || !!disabledReason;
  return (
    <button type="button" role="switch" aria-checked={checked} className="lk-switch" aria-disabled={blocked || undefined} title={disabledReason} data-force={force} onClick={() => !blocked && onChange(!checked)}>
      <span className="lk-switch__track" aria-hidden="true"><span className="lk-switch__thumb" /></span>
      <span className="lk-switch__label">{label}</span>
      <span className="lk-switch__state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}
