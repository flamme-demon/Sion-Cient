import { describe, it, expect, beforeAll } from "vitest";
import { BUILTIN_THEMES, SION_LIGHT } from "../themes/builtin";
import { THEME_TOKEN_NAMES } from "../themes/types";

// Le store de thèmes (persisté) touche localStorage dès l'évaluation : stub
// avant l'import dynamique (même schéma que appStoreVoice.test.ts).
const store: Record<string, string> = {};
beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    },
  });
});

let mod: typeof import("./themeService");
beforeAll(async () => {
  mod = await import("./themeService");
});

const themeFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "nuit-rouge",
    name: "Nuit Rouge",
    author: "Kevin",
    format: 1,
    mode: "dark",
    tokens: { "color-primary": "#ff0000", "color-surface": "#100000" },
    ...over,
  });

describe("thèmes intégrés", () => {
  it("fournit Sion Light avec tous les tokens et le color-scheme clair", () => {
    expect(BUILTIN_THEMES).toContain(SION_LIGHT);
    expect(SION_LIGHT.mode).toBe("light");
    expect(Object.keys(SION_LIGHT.tokens).sort()).toEqual([...THEME_TOKEN_NAMES].sort());
  });
});

describe("parseThemeFile — import communautaire", () => {
  it("accepte un thème valide et préfixe l'id en custom-", () => {
    const r = mod.parseThemeFile(themeFile());
    if (!("theme" in r)) throw new Error("thème refusé");
    expect(r.theme.id).toBe("custom-nuit-rouge");
    expect(r.theme.name).toBe("Nuit Rouge");
    expect(r.theme.author).toBe("Kevin");
    expect(r.theme.tokens["color-primary"]).toBe("#ff0000");
  });

  it("tolère un thème partiel : le reste vient de Sion Dark", () => {
    const r = mod.parseThemeFile(themeFile());
    if (!("theme" in r)) throw new Error("thème refusé");
    const resolved = mod.resolveThemeTokens(r.theme);
    expect(resolved["color-primary"]).toBe("#ff0000");
    expect(resolved["color-surface"]).toBe("#100000");
    // Non fournis → base Sion Dark.
    expect(resolved["color-error"]).toBe("#f2b8b5");
    expect(resolved["font-family-mono"]).toContain("JetBrains");
  });

  it("rejette JSON invalide, nom manquant, aucun token, format futur", () => {
    expect(mod.parseThemeFile("pas du json")).toEqual({ error: "invalidJson" });
    expect(mod.parseThemeFile(JSON.stringify({ tokens: { "color-primary": "#fff" } }))).toEqual({ error: "missingName" });
    expect(mod.parseThemeFile(JSON.stringify({ name: "X" }))).toEqual({ error: "noTokens" });
    expect(mod.parseThemeFile(themeFile({ format: 2 }))).toEqual({ error: "tooRecent" });
  });

  it("filtre les clés hors whitelist et les valeurs dangereuses", () => {
    const r = mod.parseThemeFile(
      themeFile({
        tokens: {
          "color-primary": "#ff0000",
          "background-image": "url(https://exemple.invalid/x.png)",
          "color-error": "red; } body { display: none",
          "color-amber": "url(https://exemple.invalid/y.png)",
          "color-success": "x".repeat(300),
        },
      }),
    );
    if (!("theme" in r)) throw new Error("thème refusé");
    // Les clés hors whitelist n'existent pas dans le type : lecture brute.
    const raw = r.theme.tokens as Record<string, string | undefined>;
    expect(raw["color-primary"]).toBe("#ff0000");
    expect(raw["background-image"]).toBeUndefined();
    expect(raw["color-error"]).toBeUndefined();
    expect(raw["color-amber"]).toBeUndefined();
    expect(raw["color-success"]).toBeUndefined();
  });

  it("export → re-import : fichier autonome (tous les tokens résolus)", () => {
    const r = mod.parseThemeFile(themeFile());
    if (!("theme" in r)) throw new Error("thème refusé");
    const exported = mod.themeToJson(r.theme);
    const parsedExport = JSON.parse(exported);
    // Fichier complet : bien plus que les deux tokens fournis.
    expect(Object.keys(parsedExport.tokens).length).toBeGreaterThanOrEqual(42);
    // L'id exporté perd le préfixe, le re-import le restaure à l'identique.
    expect(parsedExport.id).toBe("nuit-rouge");
    const again = mod.parseThemeFile(exported);
    if (!("theme" in again)) throw new Error("re-import refusé");
    expect(again.theme.id).toBe("custom-nuit-rouge");
    expect(again.theme.tokens["color-primary"]).toBe("#ff0000");
  });
});
