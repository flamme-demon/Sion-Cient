import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_RECENT = 24;

interface RecentEmojisState {
  /** Most-recently-used first. */
  recent: string[];
  add: (emoji: string) => void;
  clear: () => void;
}

/**
 * LRU list of recently used emojis, persisted to localStorage.
 * Used by the chat input picker and the reaction picker so users can
 * quickly re-pick emojis they've used recently.
 */
export const useRecentEmojisStore = create<RecentEmojisState>()(
  persist(
    (set) => ({
      recent: [],
      add: (emoji) =>
        set((s) => {
          const filtered = s.recent.filter((e) => e !== emoji);
          const next = [emoji, ...filtered].slice(0, MAX_RECENT);
          return { recent: next };
        }),
      clear: () => set({ recent: [] }),
    }),
    { name: "sion-recent-emojis" },
  ),
);
