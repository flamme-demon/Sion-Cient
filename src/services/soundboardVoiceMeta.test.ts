import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn().mockResolvedValue({ event_id: "$new" });

vi.mock("./matrixService", () => ({
  getMatrixClient: () => ({ sendMessage }),
  findSoundboardRoom: async () => "!sb:example.org",
  uploadFile: async () => "mxc://x/y",
}));
vi.mock("./audioContext", () => ({ getSharedAudioContext: () => null }));
vi.mock("../stores/useAppStore", () => ({ useAppStore: { getState: () => ({}) } }));

import { editSound, type SoundEntry } from "./soundboardService";

const voice: SoundEntry = {
  eventId: "$orig",
  mxcUrl: "mxc://example.org/burgonde",
  label: "Burgonde",
  category: "Voix",
  emoji: "🗣️",
  body: "burgonde.wav",
  mimetype: "audio/wav",
  size: 1234,
  duration: 9000,
  senderId: "@flamme:example.org",
  timestamp: 1,
  gain: 1.0,
  refText: "Sa va saigné",
  avatarUrl: "mxc://example.org/portrait",
  kind: "voice",
  ttsModel: "higgs-v3",
};

/** Contenu de remplacement effectivement envoyé au serveur. */
function sentMeta() {
  const content = sendMessage.mock.calls[0][1] as Record<string, never>;
  return (content["com.sion.soundboard"] ?? content["com.sion.sound"]) as unknown as Record<
    string,
    unknown
  >;
}

describe("editSound sur une voix de référence", () => {
  beforeEach(() => sendMessage.mockClear());

  /**
   * Une édition est un remplacement : ce que le nouveau contenu omet est perdu.
   * Sans reprise explicite du drapeau, renommer une voix la ferait réapparaître
   * parmi les sons jouables — la catégorie ne peut pas servir de repli, elle est
   * librement modifiable.
   */
  it("conserve le drapeau voice quand on renomme", async () => {
    await editSound(voice, "Roi Burgonde", "Voix", "👑");
    expect(sentMeta().kind).toBe("voice");
    expect(sentMeta().label).toBe("Roi Burgonde");
  });

  it("conserve le modèle associé", async () => {
    await editSound(voice, "Roi Burgonde", "Kaamelott", "👑");
    expect(sentMeta().tts_model).toBe("higgs-v3");
  });

  it("ne touche pas à la transcription tant qu'on ne la passe pas", async () => {
    await editSound(voice, "Roi Burgonde", "Voix", "👑");
    // Clé absente = la relecture retombe sur l'événement d'origine.
    expect("ref_text" in sentMeta()).toBe(false);
  });

  it("remplace la transcription quand elle est fournie", async () => {
    await editSound(voice, "Roi Burgonde", "Voix", "👑", 1.0, { refText: "En pommes" });
    expect(sentMeta().ref_text).toBe("En pommes");
  });

  it("efface la transcription sur null, sans la confondre avec une omission", async () => {
    await editSound(voice, "Roi Burgonde", "Voix", "👑", 1.0, { refText: null });
    expect(sentMeta().ref_text).toBe("");
  });
});
