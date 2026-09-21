// Une seule vidéo lue à la fois.
//
// La surface native est unique et porte un identifiant de flux fixe : deux
// lecteurs simultanés se disputeraient le même rectangle, et le second
// arrêterait le premier côté Rust sans que sa carte le sache. Ce registre
// donne à chaque carte le moyen de savoir si c'est encore son tour.
import { useSyncExternalStore } from "react";

let actif: string | null = null;
const abonnes = new Set<() => void>();

function prevenir() {
  for (const f of abonnes) f();
}

/** Désigne la vidéo en cours de lecture, ou `null` pour n'en avoir aucune. */
export function definirLecteurActif(id: string | null) {
  if (actif === id) return;
  actif = id;
  prevenir();
}

/** Libère la place, mais seulement si c'est bien cette vidéo qui l'occupe :
 *  une carte qui se démonte après qu'une autre a pris la main ne doit pas
 *  arrêter la nouvelle. */
export function libererLecteurActif(id: string) {
  if (actif === id) definirLecteurActif(null);
}

function sabonner(f: () => void) {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

/** Vrai tant que cette vidéo est celle qui joue. */
export function useEstLecteurActif(id: string): boolean {
  return useSyncExternalStore(
    sabonner,
    () => actif === id,
    () => false,
  );
}
