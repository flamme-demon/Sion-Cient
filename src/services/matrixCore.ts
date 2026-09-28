/**
 * Façade du cœur Matrix en Rust (`src-tauri/sion-matrix`, via
 * `src-tauri/src/matrix_pont.rs`). Plan et tranches :
 * `docs/plan-matrix-rust-sdk.md`.
 *
 * T0 : moteur actif, session (connexion, reprise, déconnexion) et état de
 * connexion. T1 : liste des salons, au format `Channel` du moteur JS.
 * T2 : fil de messages de chaque salon, au format `ChatMessage` ; les médias
 * arrivent en URL `sion-media`, servies (et déchiffrées) par Rust.
 * T3 : envoi, mêmes contenus que `matrixService.ts` ; chaque envoi rend
 * l'identifiant serveur de l'événement, le message revenant par le fil.
 * T4 : membres, niveaux, gestion des salons, profil, appareils, inscription,
 * administration (API du serveur par un mandataire : le jeton reste en Rust).
 * T5 : vérification par emojis (mêmes étapes que `useMatrixStore`),
 * récupération par clé, restauration de la sauvegarde, amorçage.
 * T6 : soundboard et memeboard, événements et états `com.sion.*` (relayés en
 * direct), versions de client, notifications push, URL de médias mxc.
 * Le jeton d'accès ne passe jamais par ici : il reste côté Rust.
 */

import type { Channel, ChatMessage } from "../types/matrix";
import type { PinnedSummary, RegistrationFlowInfo, SionMemberVersion, SoundboardCreationResult } from "./matrixService";
import type { SoundEntry } from "./soundboardService";
import type { MemeEntry } from "./memeboardService";

export type EtatConnexion =
  | { etat: "deconnecte" }
  | { etat: "connexion" }
  | { etat: "connecte"; utilisateur: string; appareil: string }
  | { etat: "erreur"; message: string };

async function invoquer<T>(commande: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(commande, args);
}

/** Moteur Matrix demandé pour ce lancement : l'appli sur le cœur Rust
 *  (« rust »), l'écran de diagnostic du cœur (« rust-apercu »), ou le moteur
 *  JS. Hors Tauri, ou si le pont ne répond pas : le moteur JS. */
export async function moteurDemande(): Promise<"js" | "rust" | "rust-apercu"> {
  try {
    const m = await invoquer<string>("matrix_moteur");
    return m === "rust" || m === "rust-apercu" ? m : "js";
  } catch {
    return "js";
  }
}

/** Moteur Matrix de ce lancement (le cœur Rust, pour l'appli comme pour
 *  l'écran de diagnostic). */
export async function moteurMatrix(): Promise<"js" | "rust"> {
  return (await moteurDemande()) === "js" ? "js" : "rust";
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

// ── Envoi (T3) ──────────────────────────────────────────────────────────────

/** Message texte, mentions `@Nom` reconnues comme le JS (`sendTextMessage`). */
export const envoyerTexte = (salon: string, corps: string) => invoquer<string>("matrix_envoyer_texte", { salon, corps });

export const repondre = (salon: string, cible: string, corps: string) =>
  invoquer<string>("matrix_repondre", { salon, cible, corps });

/** Édition — chiffrée dans un salon chiffré (le moteur JS l'envoyait en clair). */
export const editer = (salon: string, cible: string, texte: string) =>
  invoquer<string>("matrix_editer", { salon, cible, texte });

/** Suppression d'un message, d'une réaction (son `eventIds[userId]`), d'un vote… */
export const supprimer = (salon: string, cible: string) => invoquer<void>("matrix_supprimer", { salon, cible });

export const reagir = (salon: string, cible: string, cle: string) => invoquer<string>("matrix_reagir", { salon, cible, cle });

export const poker = (salon: string) => invoquer<string>("matrix_poker", { salon });

/** Sondage ; `fin` : échéance Sion en ms depuis l'epoch (`app.sion.poll_ends_ts`). */
export const creerSondage = (
  salon: string,
  question: string,
  options: string[],
  { secret = false, max = 1, fin }: { secret?: boolean; max?: number; fin?: number } = {},
) => invoquer<string>("matrix_creer_sondage", { salon, question, options, secret, max, fin: fin ?? null });

/** Vote ; remplace le précédent, `[]` le retire. */
export const voter = (salon: string, sondage: string, reponses: string[]) =>
  invoquer<string>("matrix_voter", { salon, sondage, reponses });

export const cloreSondage = (salon: string, sondage: string) => invoquer<string>("matrix_clore_sondage", { salon, sondage });

/** Épingle, ou désépingle s'il l'était. */
export const epingler = (salon: string, cible: string) => invoquer<void>("matrix_epingler", { salon, cible });

/** Fichier : déposé par `stage_media` (octets bruts, sans base64), puis
 *  envoyé — chiffré si le salon l'est. Une vidéo doit déjà être préparée
 *  (`prepareVideoForSend`), dimensions et durée fournies ici. */
export async function envoyerFichier(
  salon: string,
  fichier: File,
  infos: { largeur?: number; hauteur?: number; dureeMs?: number } = {},
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const octets = new Uint8Array(await fichier.arrayBuffer());
  const ext = (fichier.name.split(".").pop() || "bin").toLowerCase();
  const chemin = await invoke<string>("stage_media", octets, { headers: { "x-sion-ext": ext } });
  return invoquer<string>("matrix_envoyer_fichier", {
    salon,
    chemin,
    nom: fichier.name,
    mime: fichier.type || "application/octet-stream",
    largeur: infos.largeur ?? null,
    hauteur: infos.hauteur ?? null,
    dureeMs: infos.dureeMs ?? null,
  });
}

/** GIF du sélecteur, téléchargé et téléversé par le cœur (`sendImageUrl`). */
export const envoyerImageUrl = (salon: string, url: string) => invoquer<string>("matrix_envoyer_image_url", { salon, url });

/** Taille maximale d'un envoi annoncée par le serveur (`getMaxUploadSize`). */
export const tailleMaxEnvoi = () => invoquer<number>("matrix_taille_max_envoi");

// ── Membres, salons, compte, administration (T4) ────────────────────────────

export interface MembreSalon {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  powerLevel: number;
}

/** Ce que les écrans de gestion lisent d'un salon (`getRoomMembers`,
 *  `getUserPowerLevel`, `getStatePowerLevel`, `getInvitePowerLevel`,
 *  `canSendMessage`, règle d'accès). */
export interface DetailsSalon {
  membres: MembreSalon[];
  moi: number;
  niveauEtat: number;
  niveauInvitation: number;
  peutEcrire: boolean;
  regleAcces: string | null;
}

/** Le cœur code l'infini (créateur d'un salon v12) par `i64::MAX` ; le JS
 *  donne `Infinity`. */
const niveauJs = (n: number) => (n >= Number.MAX_SAFE_INTEGER ? Infinity : n);

export async function detailsSalon(salon: string): Promise<DetailsSalon> {
  const d = await invoquer<DetailsSalon>("matrix_details_salon", { salon });
  return { ...d, moi: niveauJs(d.moi), membres: d.membres.map((m) => ({ ...m, powerLevel: niveauJs(m.powerLevel) })) };
}
export const adminsServeur = () => invoquer<string[]>("matrix_admins_serveur");
export const nomUtilisateur = (utilisateur: string) => invoquer<string | null>("matrix_nom_utilisateur", { utilisateur });
export const avatarUtilisateur = (utilisateur: string) => invoquer<string | null>("matrix_avatar_utilisateur", { utilisateur });

export const inviter = (salon: string, utilisateur: string) => invoquer<void>("matrix_inviter", { salon, utilisateur });
export const expulser = (salon: string, utilisateur: string, raison?: string) =>
  invoquer<void>("matrix_expulser", { salon, utilisateur, raison: raison ?? null });
export const bannir = (salon: string, utilisateur: string, raison?: string) =>
  invoquer<void>("matrix_bannir", { salon, utilisateur, raison: raison ?? null });
export const changerNiveau = (salon: string, utilisateur: string, niveau: number) =>
  invoquer<void>("matrix_changer_niveau", { salon, utilisateur, niveau });

export const rejoindre = (salon: string) => invoquer<void>("matrix_rejoindre", { salon });
export const quitter = (salon: string) => invoquer<void>("matrix_quitter", { salon });
export const renommerSalon = (salon: string, nom: string) => invoquer<void>("matrix_renommer_salon", { salon, nom });
export const changerSujet = (salon: string, sujet: string) => invoquer<void>("matrix_changer_sujet", { salon, sujet });
/** Règle d'accès ; un salon qui devient public est ouvert à tout le serveur. */
export const changerRegleAcces = (salon: string, publique: boolean) =>
  invoquer<void>("matrix_changer_regle_acces", { salon, publique });
/** Création d'un salon (`createChannel`) ; public, il est ouvert à tout le serveur. */
export const creerSalon = (nom: string, vocal: boolean, publique = true, chiffre = false) =>
  invoquer<string>("matrix_creer_salon", { nom, vocal, publique, chiffre });
/** MP avec un utilisateur, réutilisé s'il existe (`createOrGetDMRoom`). */
export const mpAvec = (utilisateur: string) => invoquer<string>("matrix_mp_avec", { utilisateur });

/** Dépose un fichier (octets bruts) pour une commande qui le lit en Rust. */
async function deposer(fichier: File): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const octets = new Uint8Array(await fichier.arrayBuffer());
  const ext = (fichier.name.split(".").pop() || "bin").toLowerCase();
  return invoke<string>("stage_media", octets, { headers: { "x-sion-ext": ext } });
}

export const changerAvatarSalon = async (salon: string, fichier: File) =>
  invoquer<void>("matrix_changer_avatar_salon", { salon, chemin: await deposer(fichier), mime: fichier.type || "application/octet-stream" });
export const changerNom = (nom: string) => invoquer<void>("matrix_changer_nom", { nom });
/** Avatar du compte ; rend son URL http. */
export const changerAvatar = async (fichier: File) =>
  invoquer<string | null>("matrix_changer_avatar", { chemin: await deposer(fichier), mime: fichier.type || "application/octet-stream" });
export const changerMotDePasse = (ancien: string, nouveau: string) =>
  invoquer<void>("matrix_changer_mot_de_passe", { ancien, nouveau });

export interface Appareil {
  device_id: string;
  display_name?: string;
  last_seen_ts?: number;
  last_seen_ip?: string;
}
/** Même forme que `getDevices` : `{ devices }`. */
export const appareils = async () => ({ devices: await invoquer<Appareil[]>("matrix_appareils") });
export const supprimerAppareil = (appareil: string, motDePasse: string) =>
  invoquer<void>("matrix_supprimer_appareil", { appareil, motDePasse });
/** Compte suspendu ? (sans changer le nom d'affichage, contrairement au JS). */
export const estSuspendu = () => invoquer<boolean>("matrix_est_suspendu");
/** Suppression DÉFINITIVE du compte ; `effacer` retire aussi ses messages.
 *  La session locale est oubliée ensuite, comme à la déconnexion. */
export const supprimerCompte = (motDePasse: string, effacer: boolean) =>
  invoquer<void>("matrix_supprimer_compte", { motDePasse, effacer });

// ── Entre membres : frappe, « vu par », signalement, ignorés, bannière ──────

/** Un membre tel que le salon l'affiche. */
export interface Personne {
  id: string;
  nom: string;
  avatar?: string;
}
/** Qui écrit dans un salon (moi et les ignorés exceptés). */
export interface Frappe {
  salon: string;
  personnes: Personne[];
}
/** « Vu par » : pour chaque message affiché (par `eventId`), les membres
 *  dont la lecture s'arrête là. */
export interface LecturesSalon {
  salon: string;
  lectures: Record<string, Personne[]>;
}

/** J'écris (ou plus) : le cœur ne prévient le serveur qu'au changement, ou
 *  toutes les 3 s au plus. */
export const ecrire = (salon: string, actif: boolean) => invoquer<void>("matrix_ecrire", { salon, actif });
export async function surFrappes(rappel: (f: Frappe) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<Frappe>("matrix-frappe", (e) => rappel(e.payload));
}
export const lectures = () => invoquer<LecturesSalon[]>("matrix_lectures");
export async function surLectures(rappel: (l: LecturesSalon) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LecturesSalon>("matrix-lectures", (e) => rappel(e.payload));
}
/** Signale un message aux administrateurs du serveur. */
export const signaler = (salon: string, evenement: string, raison?: string) =>
  invoquer<void>("matrix_signaler", { salon, evenement, raison: raison ?? null });
export const ignorer = (utilisateur: string) => invoquer<void>("matrix_ignorer", { utilisateur });
export const nePlusIgnorer = (utilisateur: string) => invoquer<void>("matrix_ne_plus_ignorer", { utilisateur });
/** Utilisateurs ignorés, lus sur le serveur. */
export const ignores = () => invoquer<string[]>("matrix_ignores");
/** Salons rejoints où cet utilisateur est aussi. */
export const salonsEnCommun = (utilisateur: string) => invoquer<string[]>("matrix_salons_en_commun", { utilisateur });
/** Bannière de profil (MSC4427), en URL `sion-media`. */
export const banniere = (utilisateur: string) => invoquer<string | null>("matrix_banniere", { utilisateur });
/** Ma bannière ; sans fichier, elle est retirée. Rend sa nouvelle URL. */
export const changerBanniere = async (fichier: File | null) =>
  invoquer<string | null>(
    "matrix_changer_banniere",
    fichier ? { chemin: await deposer(fichier), mime: fichier.type || "image/png" } : { chemin: null, mime: null },
  );

/** Étapes d'inscription (`getRegistrationFlows`), sans session. */
export const etapesInscription = (serveur: string) => invoquer<RegistrationFlowInfo>("matrix_etapes_inscription", { serveur });
/** Inscription puis connexion comme nouvel appareil (`registerUser` + `login`). */
export const inscrire = (serveur: string, identifiant: string, motDePasse: string, jeton?: string, captcha?: string) =>
  invoquer<void>("matrix_inscrire", { serveur, identifiant, motDePasse, jeton: jeton ?? null, captcha: captcha ?? null });

/** Même erreur que `adminService.ts`, pour que les écrans d'administration
 *  n'aient rien à changer. */
export class ErreurApiAdmin extends Error {
  status: number;
  errcode?: string;
  constructor(status: number, errcode?: string) {
    super(`Admin API error: ${status}${errcode ? ` (${errcode})` : ""}`);
    this.status = status;
    this.errcode = errcode;
  }
}

/** Mandataire de l'API d'administration du serveur (`/_continuwuity/…`,
 *  suspension MSC4323) : la requête part de Rust, jeton compris. */
export async function requeteAdmin<T>(
  chemin: string,
  { methode = "GET", corps, authentifiee = false }: { methode?: string; corps?: unknown; authentifiee?: boolean } = {},
): Promise<T> {
  const r = await invoquer<{ status: number; corps: unknown }>("matrix_requete_admin", {
    methode, chemin, corps: corps ?? null, authentifiee,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new ErreurApiAdmin(r.status, (r.corps as { errcode?: string } | null)?.errcode);
  }
  return r.corps as T;
}

/** Salon d'administration (`findAdminRoom`). */
export const salonAdmin = () => invoquer<string | null>("matrix_salon_admin");
/** Commande au robot d'administration ; rend sa réponse (`sendAdminCommand`). */
export const commandeAdmin = (commande: string) => invoquer<string>("matrix_commande_admin", { commande });

// ── Chiffrement et confiance (T5) ───────────────────────────────────────────

/** Étapes de la vérification, identiques à `verificationStep` du store JS. */
export type EtapeVerification = "idle" | "requesting" | "waiting" | "comparing" | "confirmed" | "done" | "cancelled" | "error";

export interface EtatVerification {
  etape: EtapeVerification;
  /** Les 7 emojis à comparer (`EmojiData` : `{ emoji, name }`). */
  emojis: { emoji: string; name: string }[];
  erreur?: string;
}

export const verification = () => invoquer<EtatVerification>("matrix_verification");

/** Suit la vérification (demande reçue d'un autre appareil comprise). */
export async function surVerification(rappel: (etat: EtatVerification) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EtatVerification>("matrix-verification", (evenement) => rappel(evenement.payload));
}

/** Vérifier cet appareil par un autre appareil du compte (`startCrossDeviceVerification`). */
export const demarrerVerification = () => invoquer<void>("matrix_demarrer_verification");
export const confirmerEmojis = () => invoquer<void>("matrix_confirmer_emojis");
export const refuserEmojis = () => invoquer<void>("matrix_refuser_emojis");
export const annulerVerification = () => invoquer<void>("matrix_annuler_verification");

/** `checkDeviceVerified`. */
export const appareilVerifie = () => invoquer<boolean>("matrix_appareil_verifie");
/** `hasUndecryptableMessages`. */
export const messagesIndechiffrables = () => invoquer<boolean>("matrix_messages_indechiffrables");
/** Clé de récupération → appareil vérifié et clés restaurées ; rend le nombre
 *  de salons restaurés. Les fils se re-déchiffrent d'eux-mêmes. */
export const restaurerParCle = (cle: string) => invoquer<number>("matrix_restaurer_par_cle", { cle });
/** `tryAutoRestoreKeyBackup`, après une vérification. */
export const restaurerAutomatiquement = () => invoquer<number>("matrix_restaurer_automatiquement");
/** `checkNeedsBootstrap`. */
export const aBesoinAmorcage = () => invoquer<boolean>("matrix_a_besoin_amorcage");
/** Amorçage d'un compte neuf (`bootstrapAll`) ; rend la clé de récupération.
 *  Refusé par le cœur si le compte a déjà une identité ou un stockage de secrets. */
export const amorcer = (motDePasse?: string) => invoquer<string>("matrix_amorcer", { motDePasse: motDePasse ?? null });
/** `regenerateRecoveryKey` (la sauvegarde est gardée, seule la clé change). */
export const nouvelleCleRecuperation = () => invoquer<string>("matrix_nouvelle_cle_recuperation");

// ── Fonctions propres à Sion (T6) ───────────────────────────────────────────

/** Salon de la soundboard (`findSoundboardRoom`). */
export const salonSoundboard = () => invoquer<string | null>("matrix_salon_soundboard");
/** `createOrSyncSoundboardRoom`. */
export const creerOuSynchroniserSoundboard = () => invoquer<SoundboardCreationResult>("matrix_creer_ou_synchroniser_soundboard");
/** `listSounds`, au format `SoundEntry`. */
export const sons = () => invoquer<SoundEntry[]>("matrix_sons");
/** `listMemes`, au format `MemeEntry`. */
export const memes = () => invoquer<MemeEntry[]>("matrix_memes");

/** `uploadSound` : même contrôles (audio, 1 Mo, 20 s ; la durée est mesurée ici). */
export async function ajouterSon(
  fichier: File,
  label: string,
  categorie: string,
  emoji: string | null,
  gain = 1.0,
  voix?: { refText?: string; avatar?: string },
  modele?: string,
  duree?: number | null,
): Promise<{ eventId: string; mxcUrl: string; duration: number | null }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const octets = new Uint8Array(await fichier.arrayBuffer());
  const ext = (fichier.name.split(".").pop() || "bin").toLowerCase();
  const chemin = await invoke<string>("stage_media", octets, { headers: { "x-sion-ext": ext } });
  return invoquer("matrix_ajouter_son", {
    chemin, nomFichier: fichier.name, mime: fichier.type, duree: duree ?? null, label, categorie,
    emoji, gain, voix: voix ? { refText: voix.refText ?? null, avatar: voix.avatar ?? null } : null, modele: modele ?? null,
  });
}

/** `editSound` ; dans `voix`, une clé absente laisse le champ, `null` l'efface. */
export const modifierSon = (
  eventId: string,
  label: string,
  categorie: string,
  emoji: string | null,
  gain: number,
  voix: { refText?: string | null; avatar?: string | null } = {},
) => invoquer<void>("matrix_modifier_son", { eventId, label, categorie, emoji, gain, changements: voix });

/** `deleteSound` / `supprimerMeme`. */
export const supprimerDuSoundboard = (eventId: string) => invoquer<void>("matrix_supprimer_du_soundboard", { eventId });

/** `envoyerMeme`, à partir de ce que rend `memeboard_preparer`. */
export const envoyerMeme = (
  prepare: { video: string; mime: string; largeur: number; hauteur: number; duree_ms: number; apercu?: string | null; apercu_mime?: string | null },
  label: string,
  emoji: string | null,
) =>
  invoquer<string>("matrix_envoyer_meme", {
    chemin: prepare.video, mime: prepare.mime, largeur: prepare.largeur, hauteur: prepare.hauteur, dureeMs: prepare.duree_ms,
    apercu: prepare.apercu ?? null, apercuMime: prepare.apercu_mime ?? null, label, emoji,
  });

/** Un événement `com.sion.*` du fil, tel que le cœur le relaie. */
export interface EvenementSion {
  salon: string;
  eventId: string;
  type: string;
  sender: string;
  ts: number;
  content: Record<string, unknown>;
}

/** Suit les événements `com.sion.*` (transcriptions, éjection vocale…). */
export async function surEvenementsSion(rappel: (ev: EvenementSion) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EvenementSion>("matrix-evenement-sion", (evenement) => rappel(evenement.payload));
}

/** Événement quelconque (`com.sion.transcript`, `com.sion.voice_kick`…). */
export const envoyerEvenement = (salon: string, typeEvenement: string, contenu: Record<string, unknown>) =>
  invoquer<string>("matrix_envoyer_evenement", { salon, typeEvenement, contenu });
export const envoyerEtat = (salon: string, typeEvenement: string, cle: string, contenu: Record<string, unknown>) =>
  invoquer<void>("matrix_envoyer_etat", { salon, typeEvenement, cle, contenu });
export const etats = (salon: string, typeEvenement: string) =>
  invoquer<{ stateKey: string; content: Record<string, unknown> }[]>("matrix_etats", { salon, typeEvenement });
/** Historique filtré par types, du plus ancien au plus récent (`backfillTranscript`). */
export const historiqueFiltre = (salon: string, types: string[]) => invoquer<EvenementSion[]>("matrix_historique_filtre", { salon, types });

/** `getRoomClientVersions`. */
export const versionsSalon = (salon: string) => invoquer<SionMemberVersion[]>("matrix_versions_salon", { salon });
/** `publishClientVersion` ; rend le nombre de salons où la version a été annoncée. */
export const publierVersion = (version: string, os: string) => invoquer<number>("matrix_publier_version", { version, os, ts: Date.now() });
/** `ouvrirDroitAnnonceVersion`. */
export const ouvrirDroitVersion = () => invoquer<number>("matrix_ouvrir_droit_version");
/** `refreshDeviceVersionLabel`. */
export const rafraichirNomAppareil = (nom: string) => invoquer<boolean>("matrix_rafraichir_nom_appareil", { nom });

/** URL `sion-media` d'un mxc (sons, voix, memes), téléchargé authentifié par le cœur. */
export const urlMedia = (mxc: string) => invoquer<string | null>("matrix_url_media", { mxc });

/** `client.setPusher` (JSON du protocole ; `kind: null` retire le pousseur). */
export const definirPousseur = (pousseur: Record<string, unknown>) => invoquer<void>("matrix_definir_pousseur", { pousseur });
/** `client.deletePushRule`. */
export const supprimerReglePush = (portee: string, genre: string, regle: string) =>
  invoquer<void>("matrix_supprimer_regle_push", { portee, genre, regle });

// ── Voix (étape 3) ─────────────────────────────────────────────────────────
// Le cœur tient l'appartenance à l'appel et les clés des médias, qu'il remet
// lui-même au moteur vocal natif : l'interface ne voit que l'adresse et le
// jeton du serveur média.

export interface ConnexionVoix {
  salon: string;
  /** `wss://…` du serveur média. */
  url: string;
  jeton: string;
  /** Salon chiffré : médias chiffrés avec les clés du cœur. */
  chiffre: boolean;
  /** Notre identité sur le serveur média (`@moi:serveur:APPAREIL`). */
  identite: string;
}

/** Rejoint l'appel d'un salon (la session précédente est quittée). */
export const rejoindreVoix = (salon: string) => invoquer<ConnexionVoix>("matrix_rejoindre_voix", { salon });
/** Quitte l'appel (départ publié dans l'état du salon). */
export const quitterVoix = () => invoquer<void>("matrix_quitter_voix");
/** Mute et sourdine annoncés dans l'appartenance ; `false` hors appel. */
export const etatVoix = (muet: boolean, sourd: boolean) => invoquer<boolean>("matrix_etat_voix", { muet, sourd });
/** « On ne m'entend pas » : appartenance republiée, clé renouvelée ; `false` hors appel. */
export const republierVoix = () => invoquer<boolean>("matrix_republier_voix");
// ── Migration de l'ancien moteur (étape 4) ─────────────────────────────────

export interface RapportMigration {
  /** Signature croisée reprise : le nouvel appareil est vérifié d'emblée. */
  secretsImportes: boolean;
  clesImportees: number;
  clesTotal: number;
}

/** Connexion d'un nouvel appareil qui reprend l'export de l'ancien moteur. */
export const connecterMigration = (
  serveur: string,
  identifiant: string,
  motDePasse: string,
  secrets: Record<string, unknown> | null,
  cles: string | null,
) => invoquer<RapportMigration>("matrix_connecter_migration", { serveur, identifiant, motDePasse, secrets, cles });

/** Remet toutes les clés connues au moteur vocal qui vient de se connecter. */
export const rejouerClesVoix = () => invoquer<number>("matrix_rejouer_cles_voix");
