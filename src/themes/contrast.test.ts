import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, SION_DARK_TOKENS } from "./builtin";
import {
  CONTRASTE_TEXTE,
  couleurOpaque,
  defautsDeContraste,
  rapportContraste,
} from "./contrast";
import { resolveThemeTokens } from "../services/themeService";

describe("contraste WCAG des thèmes", () => {
  it("lit les couleurs opaques et écarte les translucides", () => {
    expect(couleurOpaque("#fff")).toEqual([255, 255, 255]);
    expect(couleurOpaque("#1D2024")).toEqual([29, 32, 36]);
    expect(couleurOpaque("rgb(0, 128, 255)")).toEqual([0, 128, 255]);
    expect(couleurOpaque("rgba(0, 0, 0, 1)")).toEqual([0, 0, 0]);
    expect(couleurOpaque("rgba(255, 255, 255, 0.08)")).toBeNull();
    expect(couleurOpaque("rgb(300, 0, 0)")).toBeNull();
    expect(couleurOpaque("\"Google Sans\", sans-serif")).toBeNull();
  });

  it("mesure le rapport de 1 à 21", () => {
    expect(rapportContraste([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(rapportContraste([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(rapportContraste([120, 120, 120], [120, 120, 120])).toBe(1);
  });

  // Garde-fou : un thème livré qui perd sa lisibilité fait échouer la suite.
  it.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))("%s respecte les seuils", (_, theme) => {
    expect(defautsDeContraste(resolveThemeTokens(theme))).toEqual([]);
  });

  it("signale d'abord la paire la plus loin de son seuil", () => {
    const defauts = defautsDeContraste({
      ...SION_DARK_TOKENS,
      "color-on-surface": "#2a2d31",
      "color-on-surface-variant": "#6b6f76",
    });
    expect(defauts.length).toBeGreaterThan(0);
    expect(defauts[0].texte).toBe("color-on-surface");
    expect(defauts[0].minimum).toBe(CONTRASTE_TEXTE);
    expect(defauts.every((d) => d.rapport < d.minimum)).toBe(true);
  });
});
