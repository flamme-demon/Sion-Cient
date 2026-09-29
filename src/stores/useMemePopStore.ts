/**
 * Memes reçus sur téléphone : affichés DANS Sion, et seulement quand elle est
 * au premier plan. Sur PC, une fenêtre système les pose par-dessus tout (jeux
 * compris) ; Android demanderait l'autorisation « superposition » —
 * intrusive, et souvent refusée. En arrière-plan, un meme est ignoré.
 */
import { create } from "zustand";

export interface MemeAffiche {
  id: number;
  url: string;
  volume: number;
  emetteur: string | null;
  /** Coin haut-gauche, en % de l'écran (position au hasard, comme sur PC). */
  x: number;
  y: number;
}

interface MemePopState {
  memes: MemeAffiche[];
  montrer: (m: Omit<MemeAffiche, "id" | "x" | "y">) => void;
  retirer: (id: number) => void;
  vider: () => void;
}

let suivant = 1;

export const useMemePopStore = create<MemePopState>((set) => ({
  memes: [],
  montrer: (m) => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const meme: MemeAffiche = { ...m, id: suivant++, x: 4 + Math.random() * 36, y: 8 + Math.random() * 42 };
    // Trois à l'écran au plus : le plus ancien laisse sa place.
    set((s) => ({ memes: [...s.memes.slice(-2), meme] }));
  },
  retirer: (id) => set((s) => ({ memes: s.memes.filter((m) => m.id !== id) })),
  vider: () => set({ memes: [] }),
}));

// Sion passe en arrière-plan : les memes à l'écran s'en vont.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") useMemePopStore.getState().vider();
  });
}
