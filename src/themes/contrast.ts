/**
 * Contraste WCAG 2.1 des thèmes.
 *
 * Un thème — livré ou importé — doit rester lisible. On vérifie les paires
 * (couleur de texte, fond) que l'interface emploie réellement, avec le
 * minimum WCAG qui leur revient : 4,5:1 pour du texte (niveau AA), 3:1 pour
 * un élément d'interface ou une couleur d'état (critère 1.4.11).
 *
 * Seules les couleurs opaques se comparent : une couleur translucide
 * (bordures, halos) dépend de ce qu'elle recouvre, elle est ignorée.
 */
import type { ThemeTokenName } from "./types";

/** Texte courant (AA). */
export const CONTRASTE_TEXTE = 4.5;
/** Élément d'interface ou couleur d'état (AA, 1.4.11). */
export const CONTRASTE_INTERFACE = 3;

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(…)` ou `rgba(…, 1)` → composantes 0-255 ; `null`
 *  pour tout le reste, translucide compris. */
export function couleurOpaque(valeur: string): Rgb | null {
  const v = valeur.trim().toLowerCase();
  const court = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (court) return [court[1], court[2], court[3]].map((c) => parseInt(c + c, 16)) as Rgb;
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v);
  if (long) return [long[1], long[2], long[3]].map((c) => parseInt(c, 16)) as Rgb;
  const fonction = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (fonction) {
    if (fonction[4] !== undefined && Number(fonction[4]) < 1) return null;
    const rgb = [fonction[1], fonction[2], fonction[3]].map(Number);
    return rgb.every((c) => c <= 255) ? (rgb as Rgb) : null;
  }
  return null;
}

/** Luminance relative WCAG. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapport de contraste, de 1 à 21. */
export function rapportContraste(a: Rgb, b: Rgb): number {
  const [clair, sombre] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (clair + 0.05) / (sombre + 0.05);
}

interface Paire {
  texte: ThemeTokenName;
  fond: ThemeTokenName;
  minimum: number;
}

const SURFACES: ThemeTokenName[] = [
  "color-surface",
  "color-surface-container-low",
  "color-surface-container",
  "color-surface-container-high",
  "color-surface-container-highest",
];

/** Les paires que l'interface emploie. `outline` sert aussi de texte
 *  secondaire (horodatages, indications) : il doit se lire comme tel. */
export const PAIRES_CONTROLEES: Paire[] = [
  ...SURFACES.flatMap((fond): Paire[] => [
    { texte: "color-on-surface", fond, minimum: CONTRASTE_TEXTE },
    { texte: "color-on-surface-variant", fond, minimum: CONTRASTE_TEXTE },
    { texte: "color-outline", fond, minimum: CONTRASTE_INTERFACE },
    { texte: "color-primary", fond, minimum: CONTRASTE_INTERFACE },
    { texte: "color-error", fond, minimum: CONTRASTE_INTERFACE },
    { texte: "color-green", fond, minimum: CONTRASTE_INTERFACE },
  ]),
  { texte: "color-on-primary", fond: "color-primary", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-primary-container", fond: "color-primary-container", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-secondary", fond: "color-secondary", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-secondary-container", fond: "color-secondary-container", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-tertiary", fond: "color-tertiary", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-tertiary-container", fond: "color-tertiary-container", minimum: CONTRASTE_TEXTE },
  { texte: "color-on-error", fond: "color-error", minimum: CONTRASTE_TEXTE },
];

export interface DefautContraste {
  texte: ThemeTokenName;
  fond: ThemeTokenName;
  rapport: number;
  minimum: number;
}

/** Les paires sous leur minimum, de la pire à la moins grave. Une paire dont
 *  une couleur n'est pas opaque n'est pas jugée. */
export function defautsDeContraste(tokens: Record<ThemeTokenName, string>): DefautContraste[] {
  const defauts: DefautContraste[] = [];
  for (const { texte, fond, minimum } of PAIRES_CONTROLEES) {
    const a = couleurOpaque(tokens[texte]);
    const b = couleurOpaque(tokens[fond]);
    if (!a || !b) continue;
    const rapport = rapportContraste(a, b);
    if (rapport < minimum) defauts.push({ texte, fond, rapport, minimum });
  }
  return defauts.sort((x, y) => x.rapport / x.minimum - y.rapport / y.minimum);
}
