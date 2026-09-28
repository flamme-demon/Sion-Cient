/**
 * Entre membres (moteur Rust) : qui écrit, « vu par », utilisateurs ignorés.
 * À part de `useMatrixStore` : un accusé de lecture ou une frappe arrive
 * toutes les quelques secondes, et ne doit pas redessiner le fil.
 */
import { create } from "zustand";
import type { Frappe, LecturesSalon, Personne } from "../services/matrixCore";

interface EntreMembresState {
  /** Salon → qui y écrit (moi et les ignorés exceptés). */
  frappes: Record<string, Personne[]>;
  /** Salon → message (`eventId`) → membres dont la lecture s'arrête là. */
  lectures: Record<string, Record<string, Personne[]>>;
  /** Utilisateurs ignorés (`m.ignored_user_list`). */
  ignores: string[];
  definirFrappe: (f: Frappe) => void;
  definirLectures: (l: LecturesSalon) => void;
  definirIgnores: (liste: string[]) => void;
  vider: () => void;
}

/** Garde les tableaux inchangés (même contenu) : un message dont les lecteurs
 *  n'ont pas bougé n'est pas redessiné. */
export function fusionnerLectures(
  avant: Record<string, Personne[]> | undefined,
  apres: Record<string, Personne[]>,
): Record<string, Personne[]> {
  if (!avant) return apres;
  const fusion: Record<string, Personne[]> = {};
  let identique = Object.keys(avant).length === Object.keys(apres).length;
  for (const [ev, lecteurs] of Object.entries(apres)) {
    const ancien = avant[ev];
    const garde = ancien && JSON.stringify(ancien) === JSON.stringify(lecteurs) ? ancien : lecteurs;
    if (garde !== ancien) identique = false;
    fusion[ev] = garde;
  }
  return identique ? avant : fusion;
}

export const useEntreMembresStore = create<EntreMembresState>((set) => ({
  frappes: {},
  lectures: {},
  ignores: [],
  definirFrappe: (f) =>
    set((s) => {
      const avant = s.frappes[f.salon] ?? [];
      if (JSON.stringify(avant) === JSON.stringify(f.personnes)) return s;
      return { frappes: { ...s.frappes, [f.salon]: f.personnes } };
    }),
  definirLectures: (l) =>
    set((s) => {
      const avant = s.lectures[l.salon];
      const fusion = fusionnerLectures(avant, l.lectures);
      return fusion === avant ? s : { lectures: { ...s.lectures, [l.salon]: fusion } };
    }),
  definirIgnores: (liste) => set({ ignores: [...liste].sort() }),
  vider: () => set({ frappes: {}, lectures: {}, ignores: [] }),
}));

/** Relit la liste des ignorés sur le serveur. */
export async function rafraichirIgnores(): Promise<void> {
  const core = await import("../services/matrixCore");
  useEntreMembresStore.getState().definirIgnores(await core.ignores());
}
