import { THEME_TOKEN_NAMES, type Theme, type ThemeTokenName, type ThemeTokens } from "../themes/types";
import { BUILTIN_THEMES, SION_DARK, SION_DARK_TOKENS } from "../themes/builtin";
import { useThemeStore } from "../stores/useThemeStore";
import { tokensAccent } from "../themes/accent";

/**
 * Fusionne les tokens du thème sur le jeu de base (Sion Dark) : un thème
 * communautaire partiel n'a besoin de redéfinir que ce qu'il change. Une
 * couleur d'accent, si l'utilisateur en a choisi une, passe par-dessus.
 */
export function resolveThemeTokens(theme: Theme, accent: string | null = null): Record<ThemeTokenName, string> {
  return { ...SION_DARK_TOKENS, ...theme.tokens, ...(accent ? tokensAccent(accent, theme.mode) : null) };
}

/**
 * Applique un thème : chaque token est posé en custom property inline sur
 * `:root` (prioritaire sur les valeurs compilées du `@theme` Tailwind), plus
 * `data-theme` (crochet CSS futur) et `color-scheme` (pilotage des widgets
 * natifs WebKitGTK : selects, scrollbars).
 */
export function applyTheme(theme: Theme, accent: string | null = useThemeStore.getState().accent): void {
  const root = document.documentElement;
  const tokens = resolveThemeTokens(theme, accent);
  for (const name of THEME_TOKEN_NAMES) {
    root.style.setProperty(`--${name}`, tokens[name]);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
}

export function findTheme(id: string): Theme {
  const { customThemes } = useThemeStore.getState();
  return [...BUILTIN_THEMES, ...customThemes].find((t) => t.id === id) ?? SION_DARK;
}

export function getActiveTheme(): Theme {
  return findTheme(useThemeStore.getState().themeId);
}

/**
 * Aperçu d'un thème sans le choisir — survol de sa vignette dans les
 * Réglages. `null` rétablit le thème choisi. Rien n'est enregistré : le
 * prochain changement du store réapplique de toute façon le thème actif.
 *
 * `accent` : omis, celui choisi ; `null`, aucun — aperçu de la pastille « du
 * thème » ; une couleur, aperçu de cette pastille.
 */
export function previewTheme(theme: Theme | null, accent?: string | null): void {
  applyTheme(theme ?? getActiveTheme(), accent === undefined ? useThemeStore.getState().accent : accent);
}

/**
 * Applique le thème courant puis à chaque changement du store. À appeler au
 * boot, avant le premier rendu React (pas de flash de thème par défaut).
 */
export function installThemeSync(): void {
  applyTheme(getActiveTheme());
  useThemeStore.subscribe(() => applyTheme(getActiveTheme()));
}

/** Longueur maximale d'une valeur de token — garde-fou sur les imports. */
const MAX_VALUE_LEN = 200;

/**
 * Nettoie les tokens d'un thème importé. Seuls les noms de la liste blanche
 * passent ; les valeurs sont bornées et refusent `url()`, `;`, `{}` et `<>`
 * (les déclarations posées via `setProperty` ne peuvent pas s'échapper, mais
 * on garde des fichiers sains et sans chargement distant).
 */
export function sanitizeThemeTokens(raw: unknown): ThemeTokens {
  const out: ThemeTokens = {};
  if (!raw || typeof raw !== "object") return out;
  const whitelist = THEME_TOKEN_NAMES as readonly string[];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!whitelist.includes(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LEN) continue;
    if (/[;{}<>]/.test(trimmed) || /url\s*\(/i.test(trimmed)) continue;
    out[key as ThemeTokenName] = trimmed;
  }
  return out;
}

/**
 * Parse et valide un fichier de thème (JSON). Tolère les thèmes partiels
 * (fusionnés sur Sion Dark à l'application) — c'est ce qui rend la création
 * communautaire simple : copier-export, changer trois couleurs, partager.
 */
export function parseThemeFile(text: string): { theme: Theme } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "invalidJson" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "invalidFormat" };
  }
  const d = data as Record<string, unknown>;
  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 60) : null;
  if (!name) return { error: "missingName" };
  if (typeof d.format === "number" && d.format > 1) return { error: "tooRecent" };
  const tokens = sanitizeThemeTokens(d.tokens);
  if (Object.keys(tokens).length === 0) return { error: "noTokens" };
  const mode: Theme["mode"] = d.mode === "light" ? "light" : "dark";
  const author =
    typeof d.author === "string" && d.author.trim() ? d.author.trim().slice(0, 40) : undefined;
  const rawId = typeof d.id === "string" && d.id.trim() ? d.id : name;
  const slug =
    rawId
      .toLowerCase()
      .replace(/^custom-/, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "theme";
  return {
    theme: { id: `custom-${slug}`, name, author, format: 1, mode, tokens },
  };
}

/**
 * Sérialise un thème en JSON autonome (tous les tokens résolus) : c'est le
 * fichier à partager. Le préfixe `custom-` est retiré de l'id pour que
 * réimport et partage restent stables.
 */
export function themeToJson(theme: Theme): string {
  return JSON.stringify(
    {
      id: theme.id.replace(/^custom-/, ""),
      name: theme.name,
      author: theme.author,
      format: 1,
      mode: theme.mode,
      tokens: resolveThemeTokens(theme),
    },
    null,
    2,
  );
}
