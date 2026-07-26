import { describe, it, expect } from "vitest";
import { checkRefDuration, VOICE_CATEGORY, REF_MIN_SEC, REF_MAX_SEC, TTS_MODEL_LABELS } from "./ttsService";

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
});
