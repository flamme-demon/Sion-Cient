import { describe, expect, it } from "vitest";
import fr from "../../public/locales/fr/translation.json";
import en from "../../public/locales/en/translation.json";

/**
 * Garde i18n : toute clé utilisée dans le code (`t("ns.clé")`) doit exister
 * dans fr **et** en. Les clés plurielles (`{ count }`) sont résolues via
 * `clé_one`/`clé_other` (i18next v4) — on accepte donc soit la clé exacte,
 * soit la paire de suffixes. Les clés construites dynamiquement (gabarits)
 * ne sont pas détectables ici : ce test couvre les littéraux, qui sont
 * l'immense majorité.
 *
 * Les sources sont ramassées par `import.meta.glob` (Vite) : pas de fs, le
 * test reste identique en local et en CI.
 */

const SOURCES = import.meta.glob(["../**/*.ts", "../**/*.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function flatten(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const nested of flatten(v as Record<string, unknown>, `${path}.`)) out.add(nested);
    } else {
      out.add(path);
    }
  }
  return out;
}

function usedKeys(): Map<string, string> {
  const pat = /\bt\(\s*["']([A-Za-z0-9_.]+)["']/g;
  const used = new Map<string, string>();
  for (const [file, text] of Object.entries(SOURCES)) {
    if (file.includes(".test.")) continue;
    for (const m of text.matchAll(pat)) {
      if (m[1].includes(".")) used.set(m[1], file);
    }
  }
  return used;
}

describe("i18n — clés utilisées", () => {
  const used = usedKeys();
  const frKeys = flatten(fr as Record<string, unknown>);
  const enKeys = flatten(en as Record<string, unknown>);

  const resolves = (keys: Set<string>, key: string) =>
    keys.has(key) || (keys.has(`${key}_one`) && keys.has(`${key}_other`));

  it("toutes les clés littérales existent en fr", () => {
    const missing = [...used.entries()].filter(([key]) => !resolves(frKeys, key));
    expect(missing.map(([key, file]) => `${key} (${file})`)).toEqual([]);
  });

  it("toutes les clés littérales existent en en", () => {
    const missing = [...used.entries()].filter(([key]) => !resolves(enKeys, key));
    expect(missing.map(([key, file]) => `${key} (${file})`)).toEqual([]);
  });

  it("fr et en ont le même jeu de clés", () => {
    const onlyFr = [...frKeys].filter((k) => !enKeys.has(k)).sort();
    const onlyEn = [...enKeys].filter((k) => !frKeys.has(k)).sort();
    expect({ onlyFr, onlyEn }).toEqual({ onlyFr: [], onlyEn: [] });
  });
});
