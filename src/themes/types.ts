/**
 * Système de thèmes — définitions partagées.
 *
 * La LISTE BLANCHE des tokens fait foi partout : application runtime
 * (`applyTheme` pose chaque `--<nom>` sur `:root`), fichiers d'échange
 * communautaires (import/export JSON) et validation. Ajouter un token = une
 * ligne ici + sa valeur dans les thèmes fournis.
 */

/** Noms des tokens (le préfixe `--` est ajouté à l'application). */
export const THEME_TOKEN_NAMES = [
  // Surfaces (M3)
  "color-surface",
  "color-surface-container-lowest",
  "color-surface-container-low",
  "color-surface-container",
  "color-surface-container-high",
  "color-surface-container-highest",
  "color-surface-variant",
  "color-inverse-surface",
  // On-surface + contours
  "color-on-surface",
  "color-on-surface-variant",
  "color-outline",
  "color-outline-variant",
  /** Séparateurs fins (bordures de zones, menus) — indépendant du texte. */
  "color-border",
  // Primary
  "color-primary",
  "color-on-primary",
  "color-primary-container",
  "color-on-primary-container",
  // Secondary
  "color-secondary",
  "color-on-secondary",
  "color-secondary-container",
  "color-on-secondary-container",
  // Tertiary
  "color-tertiary",
  "color-on-tertiary",
  "color-tertiary-container",
  "color-on-tertiary-container",
  // Error
  "color-error",
  "color-on-error",
  "color-error-container",
  // Sémantiques
  "color-green",
  "color-red",
  "color-yellow",
  "color-orange",
  "color-accent",
  // États étendus
  "color-warning",
  "color-pending",
  "color-amber",
  "color-success",
  "color-success-hover",
  "color-glow-strong",
  "color-glow",
  // Typographie
  "font-family-sans",
  "font-family-mono",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

/** Jeu de tokens — partiel autorisé : fusionné sur Sion Dark à l'application,
 *  pour qu'un thème communautaire puisse ne redéfinir que quelques couleurs. */
export type ThemeTokens = Partial<Record<ThemeTokenName, string>>;

/** Un thème — aussi le format d'échange JSON (voir themeService). */
export interface Theme {
  /** Identifiant unique ; les thèmes importés sont préfixés `custom-`. */
  id: string;
  name: string;
  /** Auteur, affiché dans la galerie pour les thèmes importés. */
  author?: string;
  /** Version du format d'échange — refuser ce qu'on ne sait pas lire. */
  format: 1;
  /** Pilotera `color-scheme` quand Sion Light existera. */
  mode: "dark" | "light";
  tokens: ThemeTokens;
}
