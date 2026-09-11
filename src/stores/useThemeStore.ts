import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SION_DARK } from "../themes/builtin";
import type { Theme } from "../themes/types";

interface ThemeState {
  /** Thème actif (id d'un thème fourni ou importé). */
  themeId: string;
  /** Thèmes importés (fichiers JSON communautaires). */
  customThemes: Theme[];
  setThemeId: (id: string) => void;
  /** Ajoute l'importé — même id = remplacement (réimport d'une mise à jour). */
  upsertCustomTheme: (theme: Theme) => void;
  removeCustomTheme: (id: string) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      themeId: SION_DARK.id,
      customThemes: [],
      setThemeId: (id) => set({ themeId: id }),
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
