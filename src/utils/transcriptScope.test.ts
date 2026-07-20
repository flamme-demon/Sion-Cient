import { describe, it, expect } from "vitest";
import { scopeTranscriptEntries } from "./transcriptScope";
import type { TranscriptEntry } from "../stores/useTranscriptStore";

const entry = (id: string, sessionId?: string): TranscriptEntry => ({
  id, roomId: "!r:hs", senderId: "@a:hs", senderName: "A",
  text: id, t0: 0, t1: 1, ...(sessionId ? { sessionId } : {}),
});

const legacy = entry("legacy"); // segment pré-session, sans sessionId
const s1a = entry("s1a", "s1");
const s1b = entry("s1b", "s1");
const s2a = entry("s2a", "s2");
const all = [legacy, s1a, s1b, s2a];

describe("scopeTranscriptEntries", () => {
  it("vue historique : uniquement les segments de la session consultée", () => {
    expect(scopeTranscriptEntries(all, { id: "s1" }, null)).toEqual([s1a, s1b]);
    // Les segments legacy sans tag n'apparaissent PAS dans une session passée.
    expect(scopeTranscriptEntries(all, { id: "s2" }, { id: "s1" })).toEqual([s2a]);
  });

  it("vue directe avec session live : ses segments + les legacy non tagués", () => {
    expect(scopeTranscriptEntries(all, null, { id: "s1" })).toEqual([legacy, s1a, s1b]);
  });

  it("vue directe SANS session : rien — régression de la fuite Direct↔Historique", () => {
    // Le backfill profond de l'onglet Historique charge les segments des
    // sessions passées ; revenir sur Direct sans session active ne doit
    // JAMAIS les afficher (ni les segments legacy pré-session).
    expect(scopeTranscriptEntries(all, null, null)).toEqual([]);
    expect(scopeTranscriptEntries(all, null, undefined)).toEqual([]);
  });

  it("session consultée vide : liste vide, pas de fallback", () => {
    expect(scopeTranscriptEntries(all, { id: "s-inconnue" }, null)).toEqual([]);
  });
});
