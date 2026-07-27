import { describe, it, expect } from "vitest";
import { checkRefDuration, VOICE_CATEGORY, REF_MIN_SEC, REF_MAX_SEC, TTS_MODEL_LABELS, bufferToWav, GENERATED_CATEGORY, REF_SAMPLE_RATE } from "./ttsService";

describe("checkRefDuration", () => {
  it("accepte la plage recommandée", () => {
    expect(checkRefDuration(REF_MIN_SEC)).toBeNull();
    expect(checkRefDuration(6)).toBeNull();
    expect(checkRefDuration(REF_MAX_SEC)).toBeNull();
  });

  it("signale un extrait trop court", () => {
    expect(checkRefDuration(1.5)).toBe("tooShort");
  });

  it("signale un extrait trop long", () => {
    expect(checkRefDuration(30)).toBe("tooLong");
  });

  // L'avertissement ne doit jamais bloquer : audio.cpp accepte des extraits
  // hors plage, y compris des montages de fragments (vérifié au POC). Un
  // garde-fou dur priverait l'utilisateur de références imparfaites mais
  // utilisables.
  it("ne renvoie qu'un code d'avertissement, jamais une erreur", () => {
    for (const d of [0, 0.1, 1, 5, 60, 600]) {
      const r = checkRefDuration(d);
      expect(r === null || r === "tooShort" || r === "tooLong").toBe(true);
    }
  });
});

describe("catalogue", () => {
  it("libelle les trois modèles du backend", () => {
    expect(Object.keys(TTS_MODEL_LABELS).sort()).toEqual(["chatterbox", "higgs_v3", "qwen3_tts"]);
  });

  // Les voix sont rangées dans une catégorie soundboard dédiée plutôt que dans
  // un namespace Matrix séparé : listSounds/uploadSound les gèrent déjà.
  it("expose une catégorie de voix non vide", () => {
    expect(VOICE_CATEGORY.trim().length).toBeGreaterThan(0);
  });

  // Confondre les deux faisait apparaître chaque son généré dans le sélecteur
  // d'extrait de référence, qui se remplissait au fil des essais.
  it("sépare les extraits de référence des sons générés", () => {
    expect(GENERATED_CATEGORY.trim().length).toBeGreaterThan(0);
    expect(GENERATED_CATEGORY).not.toBe(VOICE_CATEGORY);
  });
});

describe("bufferToWav", () => {
  /** Fabrique un AudioBuffer minimal sans Web Audio (indisponible en test). */
  const fakeBuffer = (samples: number[][], sampleRate = 48000): AudioBuffer =>
    ({
      sampleRate,
      length: samples[0].length,
      duration: samples[0].length / sampleRate,
      numberOfChannels: samples.length,
      getChannelData: (c: number) => Float32Array.from(samples[c]),
    }) as unknown as AudioBuffer;

  const header = async (f: File) => new Uint8Array(await f.arrayBuffer());

  // audio.cpp rejette tout ce qui n'est pas du WAV sur --voice-ref
  // (« invalid WAV RIFF header ») : l'en-tête est donc la garantie critique.
  it("produit un en-tête RIFF/WAVE valide", async () => {
    const b = await header(bufferToWav(fakeBuffer([[0, 0.5, -0.5, 0]])));
    expect(String.fromCharCode(...b.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...b.slice(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...b.slice(12, 16))).toBe("fmt ");
    expect(String.fromCharCode(...b.slice(36, 40))).toBe("data");
  });

  it("annonce du PCM 16 bits mono au bon débit", async () => {
    const b = await header(bufferToWav(fakeBuffer([[0, 0, 0, 0]], 24000)));
    const v = new DataView(b.buffer);
    expect(v.getUint16(20, true)).toBe(1); // PCM entier
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint16(34, true)).toBe(16);
  });

  it("ne garde que la sélection demandée", async () => {
    const buf = fakeBuffer([Array.from({ length: 48000 }, () => 0)], 48000);
    const whole = await header(bufferToWav(buf));
    const half = await header(bufferToWav(buf, 0, 0.5));
    expect(half.length).toBeLessThan(whole.length);
    expect(new DataView(half.buffer).getUint32(40, true)).toBe(24000 * 2);
  });

  // Un buffer peut sortir de [-1, 1] après un gain ; le repli entier
  // produirait un craquement au lieu d'une saturation propre.
  it("écrête au lieu de replier les échantillons hors plage", async () => {
    const b = await header(bufferToWav(fakeBuffer([[5, -5]])));
    const v = new DataView(b.buffer);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });

  it("mixe les canaux en mono", async () => {
    const b = await header(bufferToWav(fakeBuffer([[1], [-1]])));
    expect(new DataView(b.buffer).getInt16(44, true)).toBe(0);
  });
});

describe("taille des extraits de référence", () => {
  const SOUNDBOARD_CAP = 1024 * 1024;

  const silence = (seconds: number, rate: number): AudioBuffer =>
    ({
      sampleRate: rate,
      length: seconds * rate,
      duration: seconds,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(seconds * rate),
    }) as unknown as AudioBuffer;

  /**
   * Régression : le WAV était encodé au taux du décodage (48 kHz), soit
   * ~96 Ko/s — au-delà de 11 s l'upload échouait sur « Fichier trop lourd ».
   * À 24 kHz, la fenêtre recommandée passe très largement.
   */
  it("un extrait de 10 s à 24 kHz tient sous le plafond de la soundboard", () => {
    expect(bufferToWav(silence(10, REF_SAMPLE_RATE)).size).toBeLessThan(SOUNDBOARD_CAP);
  });

  it("même la durée maximale d'un son tient", () => {
    expect(bufferToWav(silence(20, REF_SAMPLE_RATE)).size).toBeLessThan(SOUNDBOARD_CAP);
  });

  it("le taux d'origine 48 kHz, lui, débordait", () => {
    expect(bufferToWav(silence(12, 48000)).size).toBeGreaterThan(SOUNDBOARD_CAP);
  });
});
