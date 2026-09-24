/**
 * Couleur d'accent personnalisée (roadmap §3.4, phase 4).
 *
 * Une couleur choisie par l'utilisateur est déclinée en nuances lisibles par
 * la bibliothèque de Google qui fait « Material You » : même espace de
 * couleur perceptuel (HCT), même schéma « tonal spot ». Écrire ce calcul
 * nous-mêmes aurait voulu dire des centaines de lignes de colorimétrie, pour
 * un moins bon résultat.
 *
 * L'accent ne touche QUE les familles primary / secondary / tertiary et
 * `accent` : boutons, liens, sélection, onglets actifs. Les surfaces restent
 * celles du thème — Dark, Light et AMOLED gardent leur caractère — et les
 * couleurs d'état (erreur, vert de parole…) ne bougent pas.
 */
import { argbFromHex, hexFromArgb, Hct, SchemeTonalSpot } from "@material/material-color-utilities";
import type { ThemeTokenName } from "./types";

/** Pastilles proposées ; `null` = l'accent du thème lui-même. */
export const ACCENTS_PROPOSES: { id: string; hex: string }[] = [
  { id: "green", hex: "#3a9d4a" },
  { id: "teal", hex: "#00897b" },
  { id: "purple", hex: "#7e57c2" },
  { id: "pink", hex: "#d81b60" },
  { id: "orange", hex: "#f57c00" },
  { id: "red", hex: "#e53935" },
  { id: "yellow", hex: "#fbc02d" },
];

/** Tokens que l'accent redéfinit. */
export const TOKENS_ACCENT = [
  "color-primary",
  "color-on-primary",
  "color-primary-container",
  "color-on-primary-container",
  "color-secondary",
  "color-on-secondary",
  "color-secondary-container",
  "color-on-secondary-container",
  "color-tertiary",
  "color-on-tertiary",
  "color-tertiary-container",
  "color-on-tertiary-container",
  "color-accent",
] as const satisfies readonly ThemeTokenName[];

type TokensAccent = Record<(typeof TOKENS_ACCENT)[number], string>;

/** `#rrggbb` en minuscules, ou `null` si la valeur n'en est pas une. */
export function normaliserAccent(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const v = valeur.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

const cache = new Map<string, TokensAccent>();

/** Les tokens d'accent tirés d'une couleur, pour un thème clair ou sombre. */
export function tokensAccent(hex: string, mode: "dark" | "light"): TokensAccent | null {
  const source = normaliserAccent(hex);
  if (!source) return null;
  const cle = `${source}/${mode}`;
  const connu = cache.get(cle);
  if (connu) return connu;
  const s = new SchemeTonalSpot(Hct.fromInt(argbFromHex(source)), mode === "dark", 0);
  const h = (argb: number) => hexFromArgb(argb);
  const tokens: TokensAccent = {
    "color-primary": h(s.primary),
    "color-on-primary": h(s.onPrimary),
    "color-primary-container": h(s.primaryContainer),
    "color-on-primary-container": h(s.onPrimaryContainer),
    "color-secondary": h(s.secondary),
    "color-on-secondary": h(s.onSecondary),
    "color-secondary-container": h(s.secondaryContainer),
    "color-on-secondary-container": h(s.onSecondaryContainer),
    "color-tertiary": h(s.tertiary),
    "color-on-tertiary": h(s.onTertiary),
    "color-tertiary-container": h(s.tertiaryContainer),
    "color-on-tertiary-container": h(s.onTertiaryContainer),
    "color-accent": h(s.primary),
  };
  // Un sélecteur de couleur glissé produit des dizaines de teintes : le cache
  // ne garde que les dernières.
  if (cache.size >= 32) cache.clear();
  cache.set(cle, tokens);
  return tokens;
}
