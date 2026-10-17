import { create } from 'zustand';

export interface Bookmark {
  id: string;
  run_id: string;
  tick: number;
  sim_time_s: number;
  note: string;
  created_at: string;
}

const KEY = 'lk.bookmarks.v1';

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.filter((b) => b && typeof b.run_id === 'string' && Number.isFinite(b.tick)).slice(0, 500) as Bookmark[];
  } catch {
    return [];
  }
}
function save(b: Bookmark[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    /* private mode or quota: bookmarks stay in memory for this session */
  }
}

/** Operator bookmarks. Deliberately NOT part of the run's recorded history (they never enter hashes, exports of the ledger, or forks). */
export const useBookmarks = create<{ items: Bookmark[]; add(runId: string, tick: number, simTimeS: number, note?: string): void; remove(id: string): void; rename(id: string, note: string): void }>()((set, get) => ({
  items: load(),
  add: (run_id, tick, sim_time_s, note = '') => {
    const items = [...get().items, { id: `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, run_id, tick, sim_time_s, note: note.slice(0, 120), created_at: new Date().toISOString() }];
    save(items);
    set({ items });
  },
  remove: (id) => {
    const items = get().items.filter((b) => b.id !== id);
    save(items);
    set({ items });
  },
  rename: (id, note) => {
    const items = get().items.map((b) => (b.id === id ? { ...b, note: note.slice(0, 120) } : b));
    save(items);
    set({ items });
  },
}));
