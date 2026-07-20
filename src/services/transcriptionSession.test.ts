/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";

// handleSessionEvent is pure store logic + a couple of livekit signals; the
// heavy engine paths (Tauri invoke, mic tap) are never reached in this suite
// because we never arm. Stub every side-effectful import.
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
vi.mock("./matrixService", () => ({
  sendTranscriptSegment: vi.fn(),
  sendTranscriptSession: vi.fn().mockResolvedValue(undefined),
  sendSummaryMessage: vi.fn(),
}));

import { handleSessionEvent } from "./transcriptionService";
import { useTranscriptStore } from "../stores/useTranscriptStore";

const ROOM = "!voice:hs";
const NOW = Date.now();
const H12 = 12 * 3600 * 1000;

beforeEach(() => {
  useTranscriptStore.setState({ entries: {}, sessions: {}, history: {}, summaries: {} });
});

const liveSession = () => useTranscriptStore.getState().sessions[ROOM];
const historyOf = () => useTranscriptStore.getState().history[ROOM] || [];

describe("handleSessionEvent — adoption d'un start", () => {
  it("adopte un start frais comme session live et alimente l'historique", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 1000, "@alice:hs");
    expect(liveSession()).toMatchObject({ id: "aaa", ts: NOW - 1000, startedBy: "@alice:hs" });
    expect(historyOf()).toHaveLength(1);
  });

  it("est idempotent sur l'écho du même start", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 1000, "@alice:hs");
    const before = liveSession();
    handleSessionEvent(ROOM, "start", "aaa", NOW - 1000, "@alice:hs");
    expect(liveSession()).toEqual(before);
    expect(historyOf()).toHaveLength(1);
  });

  it("course : le ts le plus ancien gagne, quel que soit l'ordre d'arrivée", () => {
    // Le plus ancien arrive en premier → le plus récent est ignoré.
    handleSessionEvent(ROOM, "start", "aaa", NOW - 5000, "@alice:hs");
    handleSessionEvent(ROOM, "start", "bbb", NOW - 1000, "@bob:hs");
    expect(liveSession()?.id).toBe("aaa");

    // Ordre inverse → le plus ancien remplace.
    useTranscriptStore.setState({ sessions: {}, history: {} });
    handleSessionEvent(ROOM, "start", "bbb", NOW - 1000, "@bob:hs");
    handleSessionEvent(ROOM, "start", "aaa", NOW - 5000, "@alice:hs");
    expect(liveSession()?.id).toBe("aaa");
  });

  it("course à ts égal : l'uuid le plus bas gagne (les deux ordres)", () => {
    handleSessionEvent(ROOM, "start", "bbb", NOW - 1000, "@bob:hs");
    handleSessionEvent(ROOM, "start", "aaa", NOW - 1000, "@alice:hs");
    expect(liveSession()?.id).toBe("aaa");

    useTranscriptStore.setState({ sessions: {}, history: {} });
    handleSessionEvent(ROOM, "start", "aaa", NOW - 1000, "@alice:hs");
    handleSessionEvent(ROOM, "start", "bbb", NOW - 1000, "@bob:hs");
    expect(liveSession()?.id).toBe("aaa");
  });

  it("gate 12 h : un start périmé ne ressuscite PAS la session mais nourrit l'historique", () => {
    // Session dont le client a crashé sans envoyer `end` : au replay de
    // l'historique elle ne doit pas repartir en live.
    handleSessionEvent(ROOM, "start", "old", NOW - H12 - 60_000, "@alice:hs");
    expect(liveSession()).toBeUndefined();
    expect(historyOf()).toHaveLength(1);
    expect(historyOf()[0].id).toBe("old");
  });

  it("un nouveau start après la fin de l'ancienne session est adopté", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 60_000, "@alice:hs");
    handleSessionEvent(ROOM, "end", "aaa", NOW - 30_000, "@bob:hs");
    handleSessionEvent(ROOM, "start", "zzz", NOW - 1000, "@carol:hs");
    expect(liveSession()?.id).toBe("zzz");
    expect(liveSession()?.endedAt).toBeUndefined();
  });
});

describe("handleSessionEvent — fin de session", () => {
  it("pose endedAt sur la session courante et l'enregistre dans l'historique", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 60_000, "@alice:hs");
    handleSessionEvent(ROOM, "end", "aaa", NOW - 1000, "@bob:hs");
    expect(liveSession()).toMatchObject({ id: "aaa", endedAt: NOW - 1000 });
    expect(historyOf()[0]).toMatchObject({ id: "aaa", endedAt: NOW - 1000 });
  });

  it("ignore un end pour une autre session que la courante", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 60_000, "@alice:hs");
    handleSessionEvent(ROOM, "end", "autre", NOW - 1000, "@bob:hs");
    expect(liveSession()?.endedAt).toBeUndefined();
    // Mais l'historique enregistre quand même la fin de l'autre session.
    expect(historyOf().find((h) => h.id === "autre")?.endedAt).toBe(NOW - 1000);
  });

  it("dédoublonne l'écho d'un end (le premier ts gagne)", () => {
    handleSessionEvent(ROOM, "start", "aaa", NOW - 60_000, "@alice:hs");
    handleSessionEvent(ROOM, "end", "aaa", NOW - 2000, "@bob:hs");
    handleSessionEvent(ROOM, "end", "aaa", NOW - 1000, "@bob:hs");
    expect(liveSession()?.endedAt).toBe(NOW - 2000);
  });

  it("un end sans session courante n'affecte que l'historique", () => {
    handleSessionEvent(ROOM, "end", "aaa", NOW - 1000, "@bob:hs");
    expect(liveSession()).toBeUndefined();
    expect(historyOf()[0]).toMatchObject({ id: "aaa", endedAt: NOW - 1000 });
  });
});
