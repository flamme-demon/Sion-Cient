import { create } from "zustand";

/** One transcribed utterance, as carried by a `com.sion.transcript` event. */
export interface TranscriptEntry {
  /** Matrix event id (or a local placeholder until the echo reconciles). */
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Utterance start/end, epoch ms (from the speaker's clock). */
  t0: number;
  t1: number;
}

/** Engine lifecycle for OUR OWN transcription (remote entries arrive over
 *  Matrix regardless of this state). */
export type TranscribeState = "off" | "starting" | "on" | "error";

/** Cap per room — a 3 h meeting is well under this; beyond it we drop the
 *  oldest entries to bound memory. */
const MAX_ENTRIES_PER_ROOM = 5000;

interface TranscriptStore {
  /** Entries per room, sorted by t0. */
  entries: Record<string, TranscriptEntry[]>;
  /** Whether the transcript panel is visible. */
  panelOpen: boolean;
  /** Our own engine state. */
  state: TranscribeState;
  /** Human-readable error (model load failed, …). */
  error: string | null;
  /** Model download progress 0–100, null when idle. */
  downloadPct: number | null;

  addEntry: (entry: TranscriptEntry) => void;
  setPanelOpen: (open: boolean) => void;
  setState: (state: TranscribeState, error?: string | null) => void;
  setDownloadPct: (pct: number | null) => void;
  clearRoom: (roomId: string) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
  entries: {},
  panelOpen: false,
  state: "off",
  error: null,
  downloadPct: null,

  addEntry: (entry) =>
    set((s) => {
      const list = s.entries[entry.roomId] || [];
      // Dedup: the same utterance can reach us twice (local echo with a "~"
      // id then the server event, or a decrypt replay). The content
      // signature is stable across both deliveries, unlike the event id.
      const sig = `${entry.senderId}|${entry.t0}|${entry.text}`;
      if (list.some((e) => e.id === entry.id || `${e.senderId}|${e.t0}|${e.text}` === sig)) {
        return s;
      }
      let next = [...list, entry].sort((a, b) => a.t0 - b.t0);
      if (next.length > MAX_ENTRIES_PER_ROOM) {
        next = next.slice(next.length - MAX_ENTRIES_PER_ROOM);
      }
      return { entries: { ...s.entries, [entry.roomId]: next } };
    }),

  setPanelOpen: (open) => set({ panelOpen: open }),
  setState: (state, error = null) => set({ state, error }),
  setDownloadPct: (pct) => set({ downloadPct: pct }),
  clearRoom: (roomId) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[roomId];
      return { entries };
    }),
}));
