/**
 * Façade du cœur Matrix en Rust (`src-tauri/sion-matrix`, via
 * `src-tauri/src/matrix_pont.rs`). Plan et tranches :
 * `docs/plan-matrix-rust-sdk.md`.
 *
 * T0 : moteur actif, session (connexion, reprise, déconnexion) et état de
 * connexion. T1 : liste des salons, au format `Channel` du moteur JS.
 * T2 : fil de messages de chaque salon, au format `ChatMessage` ; les médias
 * arrivent en URL `sion-media`, servies (et déchiffrées) par Rust.
 * Le jeton d'accès ne passe jamais par ici : il reste côté Rust.
 */

import type { Channel, ChatMessage } from "../types/matrix";
import type { PinnedSummary } from "./matrixService";

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

/** Les messages d'un salon, tels que le cœur les publie. */
export interface FilSalon {
  salon: string;
  messages: ChatMessage[];
  /** Reste-t-il de l'historique à charger ? */
  aPlus: boolean;
  /** Identifiants des messages épinglés (`getPinnedEventIds`). */
  epingles: string[];
}

/** Le cœur ne fournit pas `time` : l'heure affichée est celle de CETTE
 *  machine, calculée ici comme le faisait le moteur JS. */
function avecHeure(fil: Omit<FilSalon, "messages"> & { messages: Omit<ChatMessage, "time">[] }): FilSalon {
  return {
    ...fil,
    messages: fil.messages.map((m) => ({
      ...m,
      time: new Date(m.ts ?? 0).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    })),
  };
}

/** Dernière version publiée de tous les fils. */
export const fils = async () => (await invoquer<FilSalon[]>("matrix_fils")).map(avecHeure);

/** Suit les fils : un appel par salon dont les messages ont changé. */
export async function surMessages(rappel: (fil: FilSalon) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<FilSalon>("matrix-messages", (evenement) => rappel(avecHeure(evenement.payload)));
}

/** Remonte ~30 messages d'historique (et envoie l'accusé de lecture) ;
 *  renvoie « il en reste ». Le fil mis à jour arrive par `surMessages`. */
export const chargerHistorique = (salon: string) => invoquer<boolean>("matrix_charger_historique", { salon });

/** Accusé de lecture sur le dernier événement du salon. */
export const marquerLu = (salon: string) => invoquer<void>("matrix_marquer_lu", { salon });

/** Résumés des épinglés, du plus récent au plus ancien (`getPinnedSummaries`) :
 *  un épinglé hors du fil chargé est demandé au serveur (`loaded: false`). */
export const epingles = (salon: string) => invoquer<PinnedSummary[]>("matrix_epingles", { salon });

const URL_SION_MEDIA = /^(?:sion-media:\/\/localhost|http:\/\/sion-media\.localhost)\/([0-9a-f]{16})(?:\?|$)/;

/** URL qu'un `<audio>` ou une `<video>` savent lire. Sous WebKitGTK, ces
 *  éléments passent par GStreamer, qui ignore `sion-media://` : le média est
 *  alors servi par le serveur média local (`/matrix/<clé>`, requêtes par
 *  plage). Une autre URL est rendue telle quelle ; `null` si le serveur local
 *  est indisponible. */
export async function urlLecture(url: string): Promise<string | null> {
  const cle = URL_SION_MEDIA.exec(url)?.[1];
  if (!cle) return url;
  const port = await invoquer<number>("media_server_port");
  return port ? `http://127.0.0.1:${port}/matrix/${cle}` : null;
}
