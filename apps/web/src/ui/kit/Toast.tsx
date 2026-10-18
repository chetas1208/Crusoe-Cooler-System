import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { Button } from './Button';
import { TONE_ICON, type Tone } from './tone';

export interface ToastSpec { id?: string; tone?: Tone; title: string; body?: ReactNode; action?: { label: string; onClick: () => void }; /** ms; 0 = sticky (errors default to sticky) */ duration?: number }
interface Item extends ToastSpec { id: string }

let items: Item[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
let n = 0;
const timers = new Map<string, number>();

export function dismissToast(id: string) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.filter((t) => t.id !== id);
  emit();
}
/** Imperative API: toast({ tone:'nominal', title:'Scenario launched' }). Requires one <Toaster/> mounted. */
export function toast(spec: ToastSpec): string {
  const id = spec.id ?? `t${++n}`;
  items = [...items.filter((t) => t.id !== id), { ...spec, id }].slice(-4);
  emit();
  const d = spec.duration ?? (spec.tone === 'critical' ? 0 : 5000);
  if (d > 0 && typeof window !== 'undefined') { window.clearTimeout(timers.get(id)); timers.set(id, window.setTimeout(() => dismissToast(id), d)); }
  return id;
}
const sub = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Polite live region (assertive for critical). Mount once near the app root. `inline` renders in flow for the gallery. */
export function Toaster({ inline }: { inline?: boolean }) {
  const list = useSyncExternalStore(sub, () => items, () => items);
  const view = (
    <div className="lk-toaster" data-inline={inline || undefined} aria-live="polite" aria-relevant="additions" role="region" aria-label="Notifications">
      {list.map((t) => <ToastCard key={t.id} t={t} />)}
    </div>
  );
  return inline ? view : createPortal(view, document.body);
}

export function ToastCard({ t, onClose }: { t: ToastSpec; onClose?: () => void }) {
  const tone = t.tone ?? 'neutral';
  const Icon = TONE_ICON[tone];
  return (
    <div className="lk-toast" data-tone={tone} role={tone === 'critical' ? 'alert' : 'status'}>
      {Icon && <Icon size={18} className="lk-toast__icon" aria-hidden="true" />}
      <div className="lk-toast__text">
        <div className="lk-toast__title">{t.title}</div>
        {t.body && <div className="lk-toast__body">{t.body}</div>}
        {t.action && <Button size="sm" variant="secondary" onClick={t.action.onClick}>{t.action.label}</Button>}
      </div>
      <IconButton size="sm" aria-label="Dismiss notification" icon={<X size={14} />} onClick={() => (onClose ? onClose() : t.id && dismissToast(t.id))} />
    </div>
  );
}
