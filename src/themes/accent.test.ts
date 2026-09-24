import { describe, expect, it } from "vitest";
import { ACCENTS_PROPOSES, normaliserAccent, TOKENS_ACCENT, tokensAccent } from "./accent";
import { BUILTIN_THEMES, SION_DARK, SION_LIGHT } from "./builtin";
import { defautsDeContraste } from "./contrast";
import { resolveThemeTokens } from "../services/themeService";

describe("couleur d'accent", () => {
  it("n'accepte qu'une couleur #rrggbb", () => {
    expect(normaliserAccent("#3A9D4A")).toBe("#3a9d4a");
    expect(normaliserAccent(" #00897b ")).toBe("#00897b");
    expect(normaliserAccent("#fff")).toBeNull();
    expect(normaliserAccent("rouge")).toBeNull();
    expect(normaliserAccent(42)).toBeNull();
    expect(tokensAccent("pas une couleur", "dark")).toBeNull();
  });

  it("redéfinit les familles d'accent et elles seules", () => {
    const t = tokensAccent("#7e57c2", "dark")!;
    expect(Object.keys(t).sort()).toEqual([...TOKENS_ACCENT].sort());
    const resolus = resolveThemeTokens(SION_DARK, "#7e57c2");
    expect(resolus["color-primary"]).toBe(t["color-primary"]);
    // Surfaces et couleurs d'état : celles du thème.
    expect(resolus["color-surface"]).toBe(SION_DARK.tokens["color-surface"]);
    expect(resolus["color-error"]).toBe(SION_DARK.tokens["color-error"]);
    expect(resolus["color-green"]).toBe(SION_DARK.tokens["color-green"]);
  });

  it("tire des nuances claires en sombre, sombres en clair", () => {
    const sombre = tokensAccent("#00897b", "dark")!;
    const clair = tokensAccent("#00897b", "light")!;
    expect(sombre["color-primary"]).not.toBe(clair["color-primary"]);
    // Le primary d'un thème clair doit être plus foncé que celui d'un sombre.
    const luminosite = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(luminosite(clair["color-primary"])).toBeLessThan(luminosite(sombre["color-primary"]));
  });

  it("sans accent, le thème reste intact", () => {
    expect(resolveThemeTokens(SION_LIGHT, null)).toEqual(resolveThemeTokens(SION_LIGHT));
  });

  // Garde-fou : aucune pastille proposée ne doit rendre un thème livré
  // illisible — c'est la promesse faite à l'utilisateur qui clique.
  const cas = BUILTIN_THEMES.flatMap((theme) => ACCENTS_PROPOSES.map((a) => [theme.name, a.id, theme, a.hex] as const));
  it.each(cas)("%s + %s respecte les seuils de contraste", (_, __, theme, hex) => {
    expect(defautsDeContraste(resolveThemeTokens(theme, hex))).toEqual([]);
  });
});
