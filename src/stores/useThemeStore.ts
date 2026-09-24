import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SION_DARK } from "../themes/builtin";
import type { Theme } from "../themes/types";
import { normaliserAccent } from "../themes/accent";

interface ThemeState {
  /** Thème actif (id d'un thème fourni ou importé). */
  themeId: string;
  /** Thèmes importés (fichiers JSON communautaires). */
  customThemes: Theme[];
  /** Couleur d'accent choisie (`#rrggbb`), ou `null` pour celle du thème. */
  accent: string | null;
  setThemeId: (id: string) => void;
  setAccent: (accent: string | null) => void;
  /** Ajoute l'importé — même id = remplacement (réimport d'une mise à jour). */
  upsertCustomTheme: (theme: Theme) => void;
  removeCustomTheme: (id: string) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      themeId: SION_DARK.id,
      customThemes: [],
      accent: null,
      setThemeId: (id) => set({ themeId: id }),
      // Une valeur qui n'est pas une couleur retombe sur l'accent du thème.
      setAccent: (accent) => set({ accent: normaliserAccent(accent) }),
      upsertCustomTheme: (theme) =>
        set((s) => ({
          customThemes: [...s.customThemes.filter((t) => t.id !== theme.id), theme],
          themeId: theme.id,
        })),
      removeCustomTheme: (id) =>
        set((s) => ({
          customThemes: s.customThemes.filter((t) => t.id !== id),
          themeId: s.themeId === id ? SION_DARK.id : s.themeId,
        })),
    }),
    { name: "sion-theme", version: 1 },
  ),
);
