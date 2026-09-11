import type { Theme, ThemeTokenName } from "./types";

/** Sion Dark — le thème historique, valeurs EXACTES de `index.css` : c'est
 *  aussi le jeu de base sur lequel les thèmes partiels sont fusionnés. */
export const SION_DARK_TOKENS: Record<ThemeTokenName, string> = {
  "color-surface": "#111318",
  "color-surface-container-lowest": "#0d0e13",
  "color-surface-container-low": "#191c20",
  "color-surface-container": "#1d2024",
  "color-surface-container-high": "#272a2f",
  "color-surface-container-highest": "#32353a",
  "color-surface-variant": "#43474e",
  "color-inverse-surface": "#e2e2e6",
  "color-on-surface": "#e2e2e6",
  "color-on-surface-variant": "#c3c6cf",
  "color-outline": "#8d9199",
  "color-outline-variant": "#43474e",
  "color-border": "rgba(255, 255, 255, 0.08)",
  "color-primary": "#a8c7fa",
  "color-on-primary": "#0b3d91",
  "color-primary-container": "#284777",
  "color-on-primary-container": "#d3e3fd",
  "color-secondary": "#bbc6dc",
  "color-on-secondary": "#263141",
  "color-secondary-container": "#3c4858",
  "color-on-secondary-container": "#d7e3f8",
  "color-tertiary": "#d6bee4",
  "color-on-tertiary": "#3b2948",
  "color-tertiary-container": "#523e5f",
  "color-on-tertiary-container": "#f2daff",
  "color-error": "#f2b8b5",
  "color-on-error": "#601410",
  "color-error-container": "#8c1d18",
  "color-green": "#7ddc87",
  "color-red": "#f2b8b5",
  "color-yellow": "#e2c76a",
  "color-orange": "#f0a869",
  "color-accent": "#a8c7fa",
  "color-warning": "#ffb74d",
  "color-pending": "#ff9800",
  "color-amber": "#fbbf24",
  "color-success": "#4caf50",
  "color-success-hover": "#66bb6a",
  "color-glow-strong": "rgba(125, 220, 135, 0.3)",
  "color-glow": "rgba(125, 220, 135, 0.12)",
  "font-family-sans": "\"Google Sans\", \"Roboto\", ui-sans-serif, system-ui, -apple-system, sans-serif",
  "font-family-mono": "\"JetBrains Mono\", \"Roboto Mono\", \"Fira Code\", ui-monospace, monospace",
};

export const SION_DARK: Theme = {
  id: "sion-dark",
  name: "Sion Dark",
  format: 1,
  mode: "dark",
  tokens: SION_DARK_TOKENS,
};

/** AMOLED — noirs purs (écrans OLED) : surfaces à #000 et conteneurs très
 *  sombres, accents identiques à Sion Dark (contraste déjà calibré). */
export const SION_AMOLED: Theme = {
  id: "sion-amoled",
  name: "Sion AMOLED",
  format: 1,
  mode: "dark",
  tokens: {
    "color-surface": "#000000",
    "color-surface-container-lowest": "#000000",
    "color-surface-container-low": "#08080a",
    "color-surface-container": "#0e0e11",
    "color-surface-container-high": "#16161a",
    "color-surface-container-highest": "#1f1f24",
    "color-surface-variant": "#2c2c33",
    "color-inverse-surface": "#e2e2e6",
    "color-on-surface": "#ececf0",
    "color-on-surface-variant": "#c8cad1",
    "color-outline": "#83878e",
    "color-outline-variant": "#34373d",
    "color-border": "rgba(255, 255, 255, 0.07)",
  },
};

export const BUILTIN_THEMES: Theme[] = [SION_DARK, SION_AMOLED];
