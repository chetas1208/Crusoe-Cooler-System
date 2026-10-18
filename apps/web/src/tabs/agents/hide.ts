import { create, type UseBoundStore, type StoreApi } from 'zustand';

/**
 * Hide / reopen for a tab's panels. Hiding only unmounts the view: the data lives in its own stores, so reopening
 * shows the same selection, scroll source and run context. The flags persist per browser (best effort: a blocked
 * localStorage just means panels start open).
 */
export interface HideState<K extends string> {
  hidden: Record<K, boolean>;
  set(k: K, hidden: boolean): void;
  toggle(k: K): void;
  showAll(): void;
}

export function makeHideStore<K extends string>(storageKey: string, keys: readonly K[]): UseBoundStore<StoreApi<HideState<K>>> {
  const read = (): Record<K, boolean> => {
    const out = {} as Record<K, boolean>;
    let saved: Record<string, unknown> = {};
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      if (typeof v === 'object' && v !== null) saved = v as Record<string, unknown>;
    } catch {
      /* blocked storage */
    }
    for (const k of keys) out[k] = saved[k] === true;
    return out;
  };
  const write = (h: Record<K, boolean>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(h));
    } catch {
      /* blocked storage */
    }
  };
  return create<HideState<K>>()((set, get) => ({
    hidden: read(),
    set: (k, v) => {
      const hidden = { ...get().hidden, [k]: v };
      write(hidden);
      set({ hidden });
    },
    toggle: (k) => get().set(k, !get().hidden[k]),
    showAll: () => {
      const hidden = {} as Record<K, boolean>;
      for (const k of keys) hidden[k] = false;
      write(hidden);
      set({ hidden });
    },
  }));
}

export const anyHidden = (h: Record<string, boolean>) => Object.values(h).some(Boolean);

export const useAgentsHide = makeHideStore('lk.v12.agents.hide', ['seats', 'roster', 'inspector', 'ribbon'] as const);
