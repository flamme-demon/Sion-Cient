/**
 * Façade du cœur Matrix en Rust (`src-tauri/sion-matrix`, via
 * `src-tauri/src/matrix_pont.rs`). Plan et tranches :
 * `docs/plan-matrix-rust-sdk.md`.
 *
 * T0 : moteur actif, session (connexion, reprise, déconnexion) et état de
 * connexion. T1 : liste des salons, au format `Channel` du moteur JS.
 * Le jeton d'accès ne passe jamais par ici : il reste côté Rust.
 */

import type { Channel } from "../types/matrix";

export type EtatConnexion =
  | { etat: "deconnecte" }
  | { etat: "connexion" }
  | { etat: "connecte"; utilisateur: string; appareil: string }
  | { etat: "erreur"; message: string };

async function invoquer<T>(commande: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(commande, args);
}

/** Moteur Matrix de ce lancement. Hors Tauri, ou si le pont ne répond pas :
 *  le moteur JS, toujours disponible. */
export async function moteurMatrix(): Promise<"js" | "rust"> {
  try {
    return (await invoquer<string>("matrix_moteur")) === "rust" ? "rust" : "js";
  } catch {
    return "js";
  }
}

export const etatConnexion = () => invoquer<EtatConnexion>("matrix_etat");

/** Connexion comme NOUVEL appareil : tout état local précédent est effacé. */
export const connecter = (serveur: string, identifiant: string, motDePasse: string) =>
  invoquer<void>("matrix_connecter", { serveur, identifiant, motDePasse });

/** Reprend la session sauvegardée ; `false` s'il n'y en a pas (ou plus). */
export const reprendre = () => invoquer<boolean>("matrix_reprendre");

/** Supprime l'appareil côté serveur, puis la session et les magasins locaux. */
export const deconnecter = () => invoquer<void>("matrix_deconnecter");

/** Suit l'état de connexion ; renvoie la fonction de désabonnement. */
export async function surEtat(rappel: (etat: EtatConnexion) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EtatConnexion>("matrix-etat", (evenement) => rappel(evenement.payload));
}

/** Liste des salons rejoints, telle que le cœur l'a publiée en dernier. */
export const salons = () => invoquer<Channel[]>("matrix_salons");

/** Écart de l'horloge locale avec le serveur, en minutes (0 sous 5 min). */
export const ecartHorloge = () => invoquer<number>("matrix_ecart_horloge");

/** Suit la liste des salons (republiée seulement quand elle change). */
export async function surSalons(rappel: (liste: Channel[]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<Channel[]>("matrix-salons", (evenement) => rappel(evenement.payload));
}
