import { useId, type ReactNode } from 'react';
import { useRoving } from './a11y';
import { cx } from './tone';

export interface SegItem<T extends string> { id: T; label: ReactNode; icon?: ReactNode; disabled?: boolean; disabledReason?: string; /** accessible name when label is an icon */ aria?: string }

/** Single-select segmented control (radiogroup semantics, roving tabindex, arrow keys, Home/End). */
export function SegmentedControl<T extends string>({ items, value, onChange, label, size = 'md', block, force }: { items: Array<SegItem<T>>; value: T; onChange: (v: T) => void; label: string; size?: 'sm' | 'md'; block?: boolean; force?: Partial<Record<T, 'hover' | 'active'>> }) {
  const idx = Math.max(0, items.findIndex((i) => i.id === value));
  const r = useRoving(items.length, idx, (i) => onChange(items[i].id), 'horizontal', (i) => !!items[i].disabled);
  return (
    <div className={cx('lk-seg', block && 'lk-seg--block')} role="radiogroup" aria-label={label} data-size={size} onKeyDown={r.onKeyDown}>
      {items.map((it, i) => (
        <button key={it.id} {...r.item(i)} type="button" role="radio" aria-checked={value === it.id} aria-label={it.aria} title={it.disabled ? it.disabledReason : it.aria} aria-disabled={it.disabled || undefined} data-force={force?.[it.id]} className="lk-seg__item" onClick={() => !it.disabled && onChange(it.id)}>
          {it.icon && <span className="lk-seg__icon" aria-hidden="true">{it.icon}</span>}
          {it.label !== undefined && it.label !== null && <span>{it.label}</span>}
        </button>
      ))}
    </div>
  );
}

export interface TabItem<T extends string> { id: T; label: ReactNode; icon?: ReactNode; count?: number; disabled?: boolean }

/** Tabs (automatic activation). Pair with <TabPanel>. Roving tabindex; Left/Right/Home/End. */
export function Tabs<T extends string>({ items, value, onChange, label, idBase, force }: { items: Array<TabItem<T>>; value: T; onChange: (v: T) => void; label: string; idBase?: string; force?: Partial<Record<T, 'hover' | 'active'>> }) {
  const auto = useId();
  const base = idBase ?? auto;
  const idx = Math.max(0, items.findIndex((i) => i.id === value));
  const r = useRoving(items.length, idx, (i) => onChange(items[i].id), 'horizontal', (i) => !!items[i].disabled);
  return (
    <div className="lk-tabs" role="tablist" aria-label={label} onKeyDown={r.onKeyDown}>
      {items.map((it, i) => (
        <button key={it.id} {...r.item(i)} type="button" role="tab" id={`${base}-tab-${it.id}`} aria-controls={`${base}-panel-${it.id}`} aria-selected={value === it.id} disabled={it.disabled} data-force={force?.[it.id]} className="lk-tab" onClick={() => onChange(it.id)}>
          {it.icon && <span className="lk-tab__icon" aria-hidden="true">{it.icon}</span>}
          <span>{it.label}</span>
          {it.count !== undefined && <span className="lk-tab__count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, id, value, children }: { idBase: string; id: string; value: string; children: ReactNode }) {
  if (value !== id) return null;
  return <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className="lk-tabpanel">{children}</div>;
}
