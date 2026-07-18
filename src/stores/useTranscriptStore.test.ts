import { describe, it, expect, beforeEach } from "vitest";
import { useTranscriptStore, type TranscriptEntry } from "./useTranscriptStore";

const ROOM = "!room:sion";

const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: "$e1",
  roomId: ROOM,
  senderId: "@greg:sion",
  senderName: "Greg",
  text: "bonjour",
  t0: 1000,
  t1: 2000,
  ...over,
});

beforeEach(() => {
  useTranscriptStore.setState({
    entries: {},
    sessions: {},
    history: {},
    summaries: {},
  });
});

describe("addEntry", () => {
  it("dedups the local echo (~id) against the server event by content signature", () => {
    const s = useTranscriptStore.getState();
    s.addEntry(entry({ id: "~local-1" }));
    s.addEntry(entry({ id: "$server-1" })); // same sender|t0|text
    expect(useTranscriptStore.getState().entries[ROOM]).toHaveLength(1);
  });

  it("dedups a decrypt replay by event id", () => {
    const s = useTranscriptStore.getState();
    s.addEntry(entry({ id: "$e1" }));
    s.addEntry(entry({ id: "$e1", text: "edited?" }));
    expect(useTranscriptStore.getState().entries[ROOM]).toHaveLength(1);
  });

  it("keeps distinct utterances and sorts them by t0", () => {
    const s = useTranscriptStore.getState();
    s.addEntry(entry({ id: "$b", t0: 3000, text: "deuxième" }));
    s.addEntry(entry({ id: "$a", t0: 1000, text: "première" }));
    const list = useTranscriptStore.getState().entries[ROOM];
    expect(list.map((e) => e.id)).toEqual(["$a", "$b"]);
  });

  it("caps entries per room at 5000, dropping the oldest", () => {
    const s = useTranscriptStore.getState();
    for (let i = 0; i < 5010; i++) {
      s.addEntry(entry({ id: `$${i}`, t0: i, text: `seg ${i}` }));
    }
    const list = useTranscriptStore.getState().entries[ROOM];
    expect(list).toHaveLength(5000);
    expect(list[0].t0).toBe(10); // the 10 oldest were evicted
  });
});

describe("upsertHistorySession", () => {
  it("merges by id — earliest ts wins (start race resolution)", () => {
    const s = useTranscriptStore.getState();
    s.upsertHistorySession(ROOM, { id: "s1", ts: 2000, startedBy: "@b:sion" });
    s.upsertHistorySession(ROOM, { id: "s1", ts: 1000 });
    const h = useTranscriptStore.getState().history[ROOM];
    expect(h).toHaveLength(1);
    expect(h[0].ts).toBe(1000);
    expect(h[0].startedBy).toBe("@b:sion");
  });

  it("an end seen before its start seeds ts, then the earlier start corrects it", () => {
    const s = useTranscriptStore.getState();
    s.upsertHistorySession(ROOM, { id: "s1", endedAt: 5000, ts: 5000 });
    s.upsertHistorySession(ROOM, { id: "s1", ts: 1000, startedBy: "@a:sion" });
    const h = useTranscriptStore.getState().history[ROOM][0];
    expect(h.ts).toBe(1000);
    expect(h.endedAt).toBe(5000);
    expect(h.startedBy).toBe("@a:sion");
  });

  it("sorts sessions newest first", () => {
    const s = useTranscriptStore.getState();
    s.upsertHistorySession(ROOM, { id: "old", ts: 1000 });
    s.upsertHistorySession(ROOM, { id: "new", ts: 9000 });
    expect(useTranscriptStore.getState().history[ROOM].map((h) => h.id)).toEqual(["new", "old"]);
  });

  it("is idempotent — re-seeing the same event doesn't create a new state object", () => {
    const s = useTranscriptStore.getState();
    s.upsertHistorySession(ROOM, { id: "s1", ts: 1000, startedBy: "@a:sion" });
    const before = useTranscriptStore.getState().history;
    s.upsertHistorySession(ROOM, { id: "s1", ts: 1000, startedBy: "@a:sion" });
    expect(useTranscriptStore.getState().history).toBe(before);
  });
});

describe("setSummary", () => {
  it("keeps the most recent summary when a session is re-summarized", () => {
    const s = useTranscriptStore.getState();
    s.setSummary(ROOM, "s1", "v1", 1000);
    s.setSummary(ROOM, "s1", "v2", 2000);
    s.setSummary(ROOM, "s1", "stale", 500); // older posting must not win
    expect(useTranscriptStore.getState().summaries[ROOM]["s1"]).toEqual({ text: "v2", ts: 2000 });
  });
});

describe("clearRoom", () => {
  it("clears entries for the room only", () => {
    const s = useTranscriptStore.getState();
    s.addEntry(entry());
    s.addEntry(entry({ roomId: "!other:sion", id: "$o" }));
    s.clearRoom(ROOM);
    const st = useTranscriptStore.getState();
    expect(st.entries[ROOM]).toBeUndefined();
    expect(st.entries["!other:sion"]).toHaveLength(1);
  });
});
