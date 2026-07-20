/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";

// matrixService is the module under test (NOT mocked). backfillTranscript
// dynamically imports transcriptionService for handleSessionEvent — stub
// that module's side-effectful imports so the real session logic runs.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../stores/useAppStore", () => ({
  useAppStore: { getState: () => ({}), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock("../stores/useSettingsStore", () => ({
  useSettingsStore: { getState: () => ({}), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock("./livekitService", () => ({
  getLocalMicMediaStreamTrack: vi.fn(),
  getArmedTranscribers: vi.fn(() => []),
  onArmedTranscribersChange: vi.fn(),
  setLocalTranscribeArmed: vi.fn(),
}));

import { backfillTranscript, __setMatrixClientForTest } from "./matrixService";
import { useTranscriptStore } from "../stores/useTranscriptStore";

const ROOM = "!voice:hs";
const NOW = Date.now();
const H = 3600 * 1000;
const SINCE = NOW - 14 * 24 * H;

let seq = 0;
function ev(type: string, content: Record<string, unknown>, ts: number, sender = "@alice:hs") {
  const id = `$bf${++seq}`;
  return {
    getType: () => type,
    getContent: () => content,
    getId: () => id,
    getSender: () => sender,
    getTs: () => ts,
  };
}

const sessionStart = (id: string, ts: number, sender = "@alice:hs") =>
  ev("com.sion.transcript.session", { action: "start", id, ts, v: 1 }, ts, sender);

let decryptCalls: unknown[];

async function runBackfill(events: unknown[]): Promise<void> {
  decryptCalls = [];
  const room = {
    getLiveTimeline: () => ({ getEvents: () => events }),
    getMember: () => null,
  };
  const client = {
    getRoom: () => room,
    paginateEventTimeline: vi.fn().mockResolvedValue(false),
    decryptEventIfNeeded: vi.fn((e: unknown) => { decryptCalls.push(e); return Promise.resolve(); }),
    getUserId: () => "@me:hs",
    getDeviceId: () => "dev1",
  };
  __setMatrixClientForTest(client as never);
  await backfillTranscript(ROOM, SINCE);
}

beforeEach(() => {
  useTranscriptStore.setState({ entries: {}, sessions: {}, history: {}, summaries: {} });
});

const store = () => useTranscriptStore.getState();

describe("backfillTranscript — routage", () => {
  it("route sessions, segments (tagués ou non) et résumés tagués", async () => {
    const T1 = NOW - 3 * H;
    await runBackfill([
      sessionStart("s1", T1),
      ev("com.sion.transcript", { text: "bonjour", t0: T1 + 1000, t1: T1 + 3000, session: "s1" }, T1 + 1000),
      ev("com.sion.transcript", { text: "segment pré-session", t0: T1 + 2000, t1: T1 + 2500 }, T1 + 2000, "@bob:hs"),
      ev("m.room.message", { msgtype: "m.text", body: "résumé taggé", "com.sion.transcript.summary_of": "s1" }, T1 + 10 * 60_000),
      ev("m.room.message", { msgtype: "m.text", body: "salut, message normal" }, T1 + 11 * 60_000),
    ]);

    expect(store().history[ROOM]).toHaveLength(1);
    expect(store().history[ROOM][0]).toMatchObject({ id: "s1", ts: T1 });

    const entries = store().entries[ROOM];
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.text === "bonjour")?.sessionId).toBe("s1");
    expect(entries.find((e) => e.text === "segment pré-session")?.sessionId).toBeUndefined();
    // senderName retombe sur le localpart quand le membre est inconnu.
    expect(entries.find((e) => e.text === "segment pré-session")?.senderName).toBe("bob");

    expect(store().summaries[ROOM]?.["s1"]?.text).toBe("résumé taggé");
  });

  it("ignore les events antérieurs à sinceTs", async () => {
    await runBackfill([
      sessionStart("trop-vieux", SINCE - 1000),
      sessionStart("ok", NOW - H),
    ]);
    expect(store().history[ROOM].map((h) => h.id)).toEqual(["ok"]);
  });

  it("déclenche le déchiffrement des events chiffrés sans les router", async () => {
    await runBackfill([
      ev("m.room.encrypted", { algorithm: "m.megolm.v1.aes-sha2" }, NOW - H),
    ]);
    expect(decryptCalls).toHaveLength(1);
    expect(store().entries[ROOM]).toBeUndefined();
  });
});

describe("backfillTranscript — retro-link des résumés legacy (sans tag)", () => {
  const LEGACY_FR = "## 📝 Résumé de la réunion\n\n- point 1";
  const LEGACY_EN = "## 📝 Meeting summary\n\n- item 1";

  it("rattache un résumé legacy à la session en cours au moment du post", async () => {
    const T1 = NOW - 5 * H;
    const T2 = NOW - 2 * H;
    await runBackfill([
      sessionStart("s1", T1),
      sessionStart("s2", T2),
      // Posté après s2 → c'est s2 (la plus récente ≤ msgTs) qui l'héberge, pas s1.
      ev("m.room.message", { msgtype: "m.text", body: LEGACY_FR }, T2 + 5 * 60_000),
    ]);
    expect(store().summaries[ROOM]?.["s2"]?.text).toBe(LEGACY_FR);
    expect(store().summaries[ROOM]?.["s1"]).toBeUndefined();
  });

  it("reconnaît la variante anglaise", async () => {
    const T1 = NOW - 2 * H;
    await runBackfill([
      sessionStart("s1", T1),
      ev("m.room.message", { msgtype: "m.text", body: LEGACY_EN }, T1 + 60_000),
    ]);
    expect(store().summaries[ROOM]?.["s1"]?.text).toBe(LEGACY_EN);
  });

  it("n'attache rien si le résumé précède toute session", async () => {
    await runBackfill([
      ev("m.room.message", { msgtype: "m.text", body: LEGACY_FR }, NOW - 3 * H),
      sessionStart("s1", NOW - 2 * H),
    ]);
    expect(store().summaries[ROOM]).toBeUndefined();
  });

  it("n'attache rien au-delà de la fenêtre de 12 h après le start", async () => {
    const T1 = NOW - 20 * H; // start hors fenêtre live mais dans l'historique
    await runBackfill([
      sessionStart("s1", T1),
      ev("m.room.message", { msgtype: "m.text", body: LEGACY_FR }, T1 + 13 * H),
    ]);
    expect(store().summaries[ROOM]).toBeUndefined();
  });

  it("ne matche pas un message qui ressemble sans le préfixe exact", async () => {
    const T1 = NOW - 2 * H;
    await runBackfill([
      sessionStart("s1", T1),
      ev("m.room.message", { msgtype: "m.text", body: "Résumé de la réunion : voir plus haut" }, T1 + 60_000),
    ]);
    expect(store().summaries[ROOM]).toBeUndefined();
  });
});
