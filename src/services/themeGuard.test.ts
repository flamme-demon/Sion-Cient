import { describe, expect, it } from "vitest";

/**
 * Garde anti-couleurs-en-dur (§3.3 de `docs/roadmap-2.0.0.md`).
 *
 * Une couleur écrite en dur court-circuite le système de thèmes : elle reste
 * identique quelle que soit la palette choisie. Ce test échoue si un nouveau
 * `#hex` apparaît sous `src/` — `src/themes/` excepté, puisque c'est là que
 * les couleurs ont le droit d'exister.
 *
 * Deux échappatoires, volontairement explicites :
 *
 * 1. `themeColor("--token", "#repli")` — le repli n'est qu'un filet si le
 *    token manque (canvas 2D, test), la couleur réelle vient du thème.
 * 2. Une ligne marquée `theme-exempt` — couleurs volontairement hors thème
 *    (esthétique Matrix, habillages posés sur des pixels média : letterbox
 *    du partage, contrôles du visualiseur plein écran).
 */

/** Marqueur d'exemption : présent sur la ligne, il la sort du garde. */
const EXEMPTION_MARKER = "theme-exempt";

/** `themeColor("--color-x", "#fallback")` — repli autorisé (pas de capture). */
const THEME_COLOR_CALL = /themeColor\(\s*["'`][^"'`]*["'`]\s*,\s*["'`][^"'`]*["'`]\s*\)/g;

/** Toute couleur hexadécimale : #fff, #a8c7fa, #11223344. */
const HARDCODED_HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** Sources balayées : tout `src/`, moins les tests et les thèmes eux-mêmes. */
const SOURCES = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../themes/**"],
  { query: "?raw", import: "default", eager: true },
);

export interface Offender {
  file: string;
  line: number;
  text: string;
}

/** Remplace les commentaires par des espaces — numéros de ligne préservés. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

export function findHardcodedColors(files: Record<string, string>): Offender[] {
  const offenders: Offender[] = [];
  for (const [file, source] of Object.entries(files)) {
    const rawLines = source.split("\n");
    const codeLines = stripComments(source).split("\n");
    rawLines.forEach((raw, i) => {
      if (raw.includes(EXEMPTION_MARKER)) return;
      const code = (codeLines[i] ?? "").replace(THEME_COLOR_CALL, "");
      for (const match of code.matchAll(HARDCODED_HEX)) {
        offenders.push({ file, line: i + 1, text: match[0] });
      }
    });
  }
  return offenders;
}

describe("garde anti-couleurs-en-dur", () => {
  it("repère les hex en dur et tolère uniquement les formes prévues", () => {
    const offenders = findHardcodedColors({
      "exemple.tsx": [
        "const interdit = '#ff0000';", // → violation
        "const repli = themeColor('--color-amber', '#fbbf24');", // repli autorisé
        "const matrix = '#0f0'; // theme-exempt — esthétique Matrix", // exempté
        "// un commentaire qui mentionne #abcdef ne compte pas",
        "/* bloc : #123456 */ const ok = 1;",
      ].join("\n"),
    });
    expect(offenders).toEqual([{ file: "exemple.tsx", line: 1, text: "#ff0000" }]);
  });

  it("le balayage voit bien les sources de l'app", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(80);
  });

  it("aucune couleur en dur sous src/ (hors src/themes/)", () => {
    const offenders = findHardcodedColors(SOURCES).map(
      (o) => `${o.file.replace(/^.*\/src\//, "")}:${o.line} — ${o.text}`,
    );
    expect(offenders).toEqual([]);
  });
});
