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
  /** Every session ever seen per room (live events + history backfill),
   *  sorted newest first — the transcript history. */
  history: Record<string, TranscriptSession[]>;
  /** Posted meeting summaries, per room then per session id (newest kept).
   *  Fed by `com.sion.transcript.summary_of`-tagged chat messages. */
  summaries: Record<string, Record<string, { text: string; ts: number }>>;
  /** Remote participants currently armed ("waiting for a 2nd") in OUR voice
   *  channel — the visible invitation. Rempli par `transcriptionService`
   *  (paquets `sion-transcribe-arm`). */
  armedPeers: { identity: string; name: string }[];
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
  setState: (state: TranscribeState, error?: string | null) => void;
  setDownloadPct: (pct: number | null) => void;
  setSummaryState: (state: "idle" | "downloading" | "running", pct?: number | null) => void;
  setSession: (roomId: string, session: TranscriptSession | null) => void;
  /** Merge a session sighting into the history (by id): earliest ts wins,
   *  endedAt/startedBy fill in as they become known. */
  upsertHistorySession: (roomId: string, session: Partial<TranscriptSession> & { id: string }) => void;
  setSummary: (roomId: string, sessionId: string, text: string, ts: number) => void;
  setArmedPeers: (peers: { identity: string; name: string }[]) => void;
  clearRoom: (roomId: string) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
  entries: {},
  sessions: {},
  history: {},
  summaries: {},
  armedPeers: [],
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
      // (sender, t0, text) is stable across both deliveries, unlike the event
      // id — compared field by field: building a signature string for every
      // stored entry on every add was quadratic (01/10).
      if (list.some((e) => e.id === entry.id
        || (e.senderId === entry.senderId && e.t0 === entry.t0 && e.text === entry.text))) {
        return s;
      }
      // Inserted in place (segments nearly always arrive in order) rather
      // than re-sorting the whole list on every add; after any equal t0, as
      // the stable sort did.
      let i = list.length;
      while (i > 0 && list[i - 1].t0 > entry.t0) i--;
      let next = list.slice();
      next.splice(i, 0, entry);
      if (next.length > MAX_ENTRIES_PER_ROOM) {
        next = next.slice(next.length - MAX_ENTRIES_PER_ROOM);
      }
      return { entries: { ...s.entries, [entry.roomId]: next } };
    }),

  setState: (state, error = null) => set({ state, error }),
  setDownloadPct: (pct) => set({ downloadPct: pct }),
  setSummaryState: (state, pct = null) => set({ summaryState: state, summaryPct: pct }),
  setSession: (roomId, session) =>
    set((s) => ({ sessions: { ...s.sessions, [roomId]: session } })),
  upsertHistorySession: (roomId, incoming) =>
    set((s) => {
      const list = s.history[roomId] || [];
      const existing = list.find((h) => h.id === incoming.id);
      let next: TranscriptSession[];
      if (existing) {
        const merged: TranscriptSession = {
          ...existing,
          // An "end" seen before its "start" seeds ts with the end time —
          // let the real (earlier) start correct it later.
          ts: incoming.ts != null ? Math.min(existing.ts, incoming.ts) : existing.ts,
          startedBy: existing.startedBy || incoming.startedBy || "",
          endedAt: incoming.endedAt ?? existing.endedAt,
        };
        if (
          merged.ts === existing.ts &&
          merged.startedBy === existing.startedBy &&
          merged.endedAt === existing.endedAt
        ) {
          return s;
        }
        next = list.map((h) => (h.id === incoming.id ? merged : h));
      } else {
        next = [
          ...list,
          {
            id: incoming.id,
            ts: incoming.ts ?? incoming.endedAt ?? Date.now(),
            startedBy: incoming.startedBy || "",
            ...(incoming.endedAt != null ? { endedAt: incoming.endedAt } : {}),
          },
        ];
      }
      next.sort((a, b) => b.ts - a.ts);
      return { history: { ...s.history, [roomId]: next } };
    }),
  setSummary: (roomId, sessionId, text, ts) =>
    set((s) => {
      const room = s.summaries[roomId] || {};
      const existing = room[sessionId];
      // A session can be re-summarized — keep the most recent posting.
      if (existing && existing.ts >= ts) return s;
      return {
        summaries: {
          ...s.summaries,
          [roomId]: { ...room, [sessionId]: { text, ts } },
        },
      };
    }),
  setArmedPeers: (peers) => set({ armedPeers: peers }),
  clearRoom: (roomId) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[roomId];
      return { entries };
    }),
}));
