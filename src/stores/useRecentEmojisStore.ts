import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_RECENT = 8;

interface Usage {
  count: number;
  lastUsed: number;
}

interface RecentEmojisState {
  /** Internal usage map — never read directly by consumers. */
  _usage: Record<string, Usage>;
  /** Derived top-N emojis sorted by usage count, ties broken by recency. */
  recent: string[];
  add: (emoji: string) => void;
  clear: () => void;
}

function topN(usage: Record<string, Usage>): string[] {
  return Object.entries(usage)
    .sort((a, b) => {
      // Higher count first; tie-break by more recent lastUsed.
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      return b[1].lastUsed - a[1].lastUsed;
    })
    .slice(0, MAX_RECENT)
    .map(([emoji]) => emoji);
}

/**
 * Emojis picker "frequent" list — most-used first with recency as tie-breaker.
 * Consumers read `state.recent` as a stable string[]; the internal usage
 * counter is kept in `_usage` and updated via `add`.
 */
export const useRecentEmojisStore = create<RecentEmojisState>()(
  persist(
    (set) => ({
      _usage: {},
      recent: [],
      add: (emoji) =>
        set((s) => {
          const prev = s._usage[emoji];
          const nextUsage: Record<string, Usage> = {
            ...s._usage,
            [emoji]: {
              count: (prev?.count ?? 0) + 1,
              lastUsed: Date.now(),
            },
          };
          return { _usage: nextUsage, recent: topN(nextUsage) };
        }),
      clear: () => set({ _usage: {}, recent: [] }),
    }),
    {
      name: "sion-recent-emojis",
      version: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate: (persisted: any, version: number) => {
        // v1 was `{ recent: string[] }` (LRU). Seed counts from the order so
        // users keep a sensible ranking instead of starting from scratch.
        if (version < 2 && Array.isArray(persisted?.recent)) {
          const now = Date.now();
          const usage: Record<string, Usage> = {};
          persisted.recent.forEach((emoji: string, i: number) => {
            usage[emoji] = {
              // Give older entries higher count so the previous ordering
              // is preserved; new `add` calls will quickly reshape the list.
              count: persisted.recent.length - i,
              lastUsed: now - i,
            };
          });
          return { _usage: usage, recent: topN(usage) };
        }
        return persisted;
      },
    },
  ),
);
