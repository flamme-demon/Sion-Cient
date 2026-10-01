import { beforeEach, describe, expect, it, vi } from "vitest";

// Le magasin de l'appli lit localStorage dès son chargement : remplacé avant
// tout import (vi.hoisted passe avant eux).
vi.hoisted(() => {
  const donnees: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => donnees[k] ?? null,
      setItem: (k: string, v: string) => { donnees[k] = v; },
      removeItem: (k: string) => { delete donnees[k]; },
      clear: () => {},
    },
  });
});

const sons = vi.hoisted(() => ({ playKickCue: vi.fn(), playMemberKickedCue: vi.fn(), noteKicked: vi.fn() }));
const voix = vi.hoisted(() => ({ cleanupVoiceOnKick: vi.fn(async () => {}) }));
const transcription = vi.hoisted(() => ({ addEntry: vi.fn(), handleSessionEvent: vi.fn() }));

vi.mock("./voiceChannelSounds", () => sons);
vi.mock("../hooks/useVoiceChannel", () => voix);
vi.mock("../stores/useTranscriptStore", () => ({
  useTranscriptStore: { getState: () => ({ addEntry: transcription.addEntry }) },
}));
vi.mock("./transcriptionService", () => ({ handleSessionEvent: transcription.handleSessionEvent }));

import { traiterEvenementSion, oublierEjections, type ContexteSion } from "./evenementsSion";
import { useAppStore } from "../stores/useAppStore";

const SALON = "!vocal:hs";
const niveaux: Record<string, number> = { "@modo:hs": 50, "@moi:hs": 0, "@narkow:hs": 0 };
const ctx = (asynchrone = false): ContexteSion => ({
  moi: () => "@moi:hs",
  // Le moteur Rust répond de façon asynchrone (détails du salon rechargés).
  niveau: (_s, u) => (asynchrone ? Promise.resolve(niveaux[u] ?? 0) : (niveaux[u] ?? 0)),
  nom: (_s, u) => (u === "@modo:hs" ? "Modo" : undefined),
});
const ejection = (vise: string, de = "@modo:hs", ts = Date.now()) => ({
  salon: SALON, type: "com.sion.voice_kick", sender: de, ts, content: { kicked_user: vise, reason: "trop fort" },
});

beforeEach(() => {
  vi.clearAllMocks();
  oublierEjections();
  useAppStore.setState({ connectedVoiceChannel: SALON, kickMessage: null, kickedFromRoom: null });
});

describe("éjection du vocal (com.sion.voice_kick)", () => {
  it("nous visant, par un modérateur : son, départ de l'appel, message", async () => {
    await traiterEvenementSion(ejection("@moi:hs"), ctx());
    expect(sons.playKickCue).toHaveBeenCalledOnce();
    expect(voix.cleanupVoiceOnKick).toHaveBeenCalledOnce();
    expect(useAppStore.getState().kickMessage).toBe("Kick par Modo — trop fort");
    expect(useAppStore.getState().kickedFromRoom).toBe(SALON);
  });

  it("moteur Rust : niveau de l'expéditeur obtenu de façon asynchrone", async () => {
    await traiterEvenementSion(ejection("@moi:hs"), ctx(true));
    expect(voix.cleanupVoiceOnKick).toHaveBeenCalledOnce();
  });

  it("visant un autre membre de notre appel : seulement le son des témoins", async () => {
    await traiterEvenementSion(ejection("@narkow:hs"), ctx());
    expect(sons.noteKicked).toHaveBeenCalledWith("@narkow:hs");
    expect(sons.playMemberKickedCue).toHaveBeenCalledOnce();
    expect(voix.cleanupVoiceOnKick).not.toHaveBeenCalled();
  });

  it("ignorée : expéditeur non modérateur, rejeu périmé, doublon", async () => {
    await traiterEvenementSion(ejection("@moi:hs", "@narkow:hs"), ctx());
    await traiterEvenementSion(ejection("@moi:hs", "@modo:hs", Date.now() - 120_000), ctx());
    expect(voix.cleanupVoiceOnKick).not.toHaveBeenCalled();
    await traiterEvenementSion(ejection("@moi:hs"), ctx());
    await traiterEvenementSion(ejection("@moi:hs"), ctx()); // écho local puis serveur
    expect(voix.cleanupVoiceOnKick).toHaveBeenCalledOnce();
  });
});

describe("transcription (com.sion.transcript)", () => {
  it("segment ajouté, nom du membre ou sa partie locale", async () => {
    await traiterEvenementSion(
      { salon: SALON, type: "com.sion.transcript", sender: "@narkow:hs", ts: 1000, id: "$1", content: { text: "salut", t0: 5, t1: 9, session: "s1" } },
      ctx(),
    );
    expect(transcription.addEntry).toHaveBeenCalledWith({
      id: "$1", roomId: SALON, senderId: "@narkow:hs", senderName: "narkow", text: "salut", t0: 5, t1: 9, sessionId: "s1",
    });
  });

  it("début de session transmis au service", async () => {
    await traiterEvenementSion(
      { salon: SALON, type: "com.sion.transcript.session", sender: "@modo:hs", ts: 7, content: { action: "start", id: "s1" } },
      ctx(),
    );
    expect(transcription.handleSessionEvent).toHaveBeenCalledWith(SALON, "start", "s1", 7, "@modo:hs");
  });
});
