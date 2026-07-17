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
  /** Transcription session this segment belongs to. Missing on segments from
   *  pre-session clients. */
  sessionId?: string;
}

/** One meeting-transcription session: born when a SECOND participant arms
 *  (uuid + date), ended for everyone by any participant. The unit of the
 *  future transcript history. */
export interface TranscriptSession {
  id: string;
  /** Session start, epoch ms (from the starter's clock). */
  ts: number;
  /** Matrix user who emitted the adopted start event. */
  startedBy: string;
  /** Set when an end event arrived — the session is over for everyone. */
  endedAt?: number;
}

/** Engine lifecycle for OUR OWN transcription (remote entries arrive over
 *  Matrix regardless of this state). "armed" = waiting for a second
 *  participant before any audio flows. */
export type TranscribeState = "off" | "armed" | "starting" | "on" | "error";

/** Cap per room — a 3 h meeting is well under this; beyond it we drop the
 *  oldest entries to bound memory. */
const MAX_ENTRIES_PER_ROOM = 5000;

interface TranscriptStore {
  /** Entries per room, sorted by t0. */
  entries: Record<string, TranscriptEntry[]>;
  /** Active (or last) session per room. null/absent = none. */
  sessions: Record<string, TranscriptSession | null>;
  /** Remote participants currently armed ("waiting for a 2nd") in OUR voice
   *  channel — the visible invitation. Fed by livekitService. */
  armedPeers: { identity: string; name: string }[];
  /** Whether the transcript panel is visible. */
  panelOpen: boolean;
  /** Our own engine state. */
  state: TranscribeState;
  /** Human-readable error (model load failed, …). */
  error: string | null;
  /** Model download progress 0–100, null when idle. */
  downloadPct: number | null;
  /** Meeting-summary pipeline state (phase 2, llama.cpp). "downloading"
   *  covers both the llama binary and the LLM model fetches. */
  summaryState: "idle" | "downloading" | "running";
  /** Download progress for the summary assets, 0–100. */
  summaryPct: number | null;

  addEntry: (entry: TranscriptEntry) => void;
  setPanelOpen: (open: boolean) => void;
  setState: (state: TranscribeState, error?: string | null) => void;
  setDownloadPct: (pct: number | null) => void;
  setSummaryState: (state: "idle" | "downloading" | "running", pct?: number | null) => void;
  setSession: (roomId: string, session: TranscriptSession | null) => void;
  setArmedPeers: (peers: { identity: string; name: string }[]) => void;
  clearRoom: (roomId: string) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
  entries: {},
  sessions: {},
  armedPeers: [],
  panelOpen: false,
  state: "off",
  error: null,
  downloadPct: null,
  summaryState: "idle",
  summaryPct: null,

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
  setSummaryState: (state, pct = null) => set({ summaryState: state, summaryPct: pct }),
  setSession: (roomId, session) =>
    set((s) => ({ sessions: { ...s.sessions, [roomId]: session } })),
  setArmedPeers: (peers) => set({ armedPeers: peers }),
  clearRoom: (roomId) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[roomId];
      return { entries };
    }),
}));
