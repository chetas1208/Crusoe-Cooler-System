import { create } from 'zustand';

/** Client-only Live-screen state: which incident the sheet pins (null = auto: most severe open). */
interface LiveUi {
  pinned: string | null;
  pin: (id: string | null) => void;
}

export const useLiveUi = create<LiveUi>()((set) => ({ pinned: null, pin: (pinned) => set({ pinned }) }));
