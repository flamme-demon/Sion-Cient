// Memeboard — de courtes vidéos qui surgissent par-dessus l'écran de tout le
// salon vocal, jeux compris.
//
// Calquée sur la soundboard, dont elle partage le salon Matrix : les memes y
// sont des messages `m.video` (ou `m.image` pour un GIF) marqués
// `com.sion.meme`, que la soundboard — qui ne lit que les `m.audio` — ignore.
// Mêmes invitations, même modération, aucun salon de plus à créer.
//
// Le déclenchement passe par le canal de données de la voix, comme la
// soundboard ; l'affichage est natif (`meme_pop.rs`), dans une petite fenêtre
// au premier plan que la vue web ne pourrait pas offrir.
import { findSoundboardRoom, getMatrixClient, mxcToHttp, uploadFile } from "./matrixService";
import { fetchSoundboardMessages } from "./soundboardService";
import {
  bytesToB64,
  extendVoiceNativeSoundboardBadge,
  voiceNativePublishData,
} from "./voiceNativeService";
import { readMediaBytes } from "./videoPrepare";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";

export const MEMEBOARD_TOPIC = "sion-memeboard";
const NAMESPACE = "com.sion.meme";

/** Durée maximale d'un meme — la même borne qu'impose Rust à l'affichage. */
export const MEME_DUREE_MAX_MS = 10_000;

/** Délai minimal entre deux memes d'une même personne. Appliqué à l'envoi ET
 *  à la réception : un client modifié ne peut pas inonder les autres. */
export const MEME_DELAI_MS = 5_000;

export interface MemeEntry {
  eventId: string;
  mxcUrl: string;
  /** Aperçu animé (WebP) pour la grille ; image fixe à défaut. */
  apercuMxc: string | null;
  label: string;
  emoji: string | null;
  /** Multiplicateur de volume propre au meme, 1 = niveau d'origine. */
  gain: number;
  durationMs: number | null;
  largeur: number | null;
  hauteur: number | null;
  senderId: string;
  timestamp: number;
}

interface ContenuMeme {
  msgtype?: string;
  body?: string;
  url?: string;
  info?: {
    duration?: number;
    w?: number;
    h?: number;
    thumbnail_url?: string;
  };
  [NAMESPACE]?: {
    label?: string;
    emoji?: string | null;
    gain_pct?: number;
  };
  "m.relates_to"?: { rel_type?: string };
}

function lireMeme(ev: {
  getId: () => string | undefined;
  getContent: () => ContenuMeme;
  getSender: () => string | null;
  getTs: () => number;
}): MemeEntry | null {
  const id = ev.getId();
  if (!id) return null;
  const contenu = ev.getContent();
  const meta = contenu[NAMESPACE];
  if (!meta || !contenu.url?.startsWith("mxc://")) return null;
  if (contenu["m.relates_to"]?.rel_type === "m.replace") return null;
  const gain = typeof meta.gain_pct === "number" && Number.isFinite(meta.gain_pct)
    ? Math.max(0, Math.min(3, meta.gain_pct / 100))
    : 1;
  return {
    eventId: id,
    mxcUrl: contenu.url,
    apercuMxc: contenu.info?.thumbnail_url ?? null,
    label: meta.label || contenu.body || "meme",
    emoji: meta.emoji || null,
    gain,
    durationMs: contenu.info?.duration ?? null,
    largeur: contenu.info?.w ?? null,
    hauteur: contenu.info?.h ?? null,
    senderId: ev.getSender() || "",
    timestamp: ev.getTs() || 0,
  };
}

/** Tous les memes du salon, du plus récent au plus ancien. */
export async function listMemes(): Promise<MemeEntry[]> {
  const client = getMatrixClient();
  if (!client) return [];
  const roomId = await findSoundboardRoom();
  if (!roomId) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const evenements = await fetchSoundboardMessages(client, room);
  const memes: MemeEntry[] = [];
  for (const ev of evenements) {
    const meme = lireMeme(ev as never);
    if (meme) memes.push(meme);
  }
  return memes.sort((a, b) => b.timestamp - a.timestamp);
}

/** URL que Rust rapatrie puis donne à ffmpeg — jamais passée à ffmpeg telle
 *  quelle, voir `lecteur_video::ramener_en_local`. */
export function urlMedia(mxc: string): string | null {
  return mxcToHttp(mxc);
}

const ffmpegPath = () => useSettingsStore.getState().ffmpegPath || undefined;

async function jouerLocalement(source: string, gain: number, emetteur: string | null): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("memeboard_jouer", {
    source,
    gain: gain * useSettingsStore.getState().memeboardVolume,
    emetteur,
    ffmpegPath: ffmpegPath(),
  });
}

/** Dernier meme de chaque personne, pour le délai anti-rafale. */
const derniers = new Map<string, number>();

function tropTot(qui: string, maintenant = Date.now()): boolean {
  const avant = derniers.get(qui);
  if (avant !== undefined && maintenant - avant < MEME_DELAI_MS) return true;
  derniers.set(qui, maintenant);
  return false;
}

/** Temps restant avant de pouvoir relancer un meme soi-même, en ms. */
export function delaiRestantMs(maintenant = Date.now()): number {
  const moi = getMatrixClient()?.getUserId() || "moi";
  const avant = derniers.get(moi);
  return avant === undefined ? 0 : Math.max(0, MEME_DELAI_MS - (maintenant - avant));
}

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();

/**
 * Déclenche un meme : chez soi, et chez tout le salon vocal.
 *
 * Rend faux quand le délai anti-rafale n'est pas écoulé — le panneau le dit
 * plutôt que de laisser croire à une panne.
 */
export async function declencherMeme(meme: MemeEntry): Promise<boolean> {
  const client = getMatrixClient();
  const moi = client?.getUserId() || "moi";
  if (tropTot(moi)) return false;
  const source = urlMedia(meme.mxcUrl);
  if (!source) throw new Error("URL du meme introuvable");
  const nom = client?.getUser(moi)?.displayName || moi;
  // Sa propre fenêtre d'abord : le réseau ne doit pas retarder celui qui
  // appuie. Rust ignore la demande en sourdine.
  await jouerLocalement(source, meme.gain, nom);
  if (useAppStore.getState().connectedVoiceChannel) {
    const paquet = encodeur.encode(JSON.stringify({
      mxc: meme.mxcUrl,
      gain: meme.gain,
      duration: meme.durationMs,
    }));
    await voiceNativePublishData(MEMEBOARD_TOPIC, bytesToB64(paquet));
  }
  return true;
}

/**
 * Meme reçu d'un pair par le canal de données.
 *
 * En sourdine, rien du tout — ni image ni son : Rust le vérifie aussi, mais
 * inutile de rapatrier la vidéo pour rien.
 */
export async function recevoirMeme(payload: Uint8Array, emetteur: string, nom: string): Promise<void> {
  const reglages = useSettingsStore.getState();
  if (!reglages.memeboardEnabled || useAppStore.getState().isDeafened) return;
  if (tropTot(emetteur)) return;
  let donnees: { mxc?: string; gain?: number; duration?: number | null };
  try {
    donnees = JSON.parse(decodeur.decode(payload));
  } catch {
    return;
  }
  if (!donnees.mxc?.startsWith("mxc://")) return;
  const source = urlMedia(donnees.mxc);
  if (!source) return;
  const gain = typeof donnees.gain === "number" && Number.isFinite(donnees.gain)
    ? Math.max(0, Math.min(3, donnees.gain))
    : 1;
  await jouerLocalement(source, gain, nom);
  // Le rond de l'expéditeur s'anime dans la liste du salon, comme pour un son.
  const duree = typeof donnees.duration === "number" ? donnees.duration : MEME_DUREE_MAX_MS;
  void extendVoiceNativeSoundboardBadge(emetteur, Math.min(duree, MEME_DUREE_MAX_MS), "🎬")
    .catch(() => { /* badge accessoire */ });
}

/** Ce que rend `memeboard_preparer`. */
export interface MemePrepare {
  video: string;
  mime: string;
  apercu: string | null;
  apercu_mime: string | null;
  largeur: number;
  hauteur: number;
  duree_ms: number;
  taille: number;
}

/** Dépose le fichier choisi sur le disque, une fois pour toutes : analyse,
 *  images et préparation le relisent ensuite par son chemin. */
export async function deposerSource(fichier: File): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const ext = (fichier.name.split(".").pop() || "mp4").toLowerCase();
  const octets = new Uint8Array(await fichier.arrayBuffer());
  return invoke<string>("stage_media", octets, { headers: { "x-sion-ext": ext } });
}

/** Ce que rend `memeboard_analyser`. */
export interface MemeAnalyse {
  duree_ms: number;
}

/** Durée de la source, qui borne les curseurs du découpeur. */
export async function analyserMeme(source: string): Promise<MemeAnalyse> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MemeAnalyse>("memeboard_analyser", { source, ffmpegPath: ffmpegPath() });
}

/** L'image de la source à un instant, en chemin du dossier média. */
export async function imageMeme(source: string, tMs: number): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("memeboard_image", {
    source,
    tMs: Math.max(0, Math.round(tMs)),
    ffmpegPath: ffmpegPath(),
  });
}

/**
 * Découpe et réencode l'extrait choisi, sans l'envoyer : l'utilisateur peut le
 * tester avant de le partager.
 */
export async function preparerMeme(source: string, debutMs: number, dureeMs: number): Promise<MemePrepare> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MemePrepare>("memeboard_preparer", {
    source,
    debutMs: Math.max(0, Math.round(debutMs)),
    dureeMs: Math.max(0, Math.round(dureeMs)),
    ffmpegPath: ffmpegPath(),
  });
}

/** Octets d'un fichier préparé, en `Blob` affichable ou envoyable. */
export async function blobPrepare(chemin: string, type: string): Promise<Blob> {
  return new Blob([await readMediaBytes(chemin, "meme")], { type });
}

/** Envoie un meme préparé dans le salon de la soundboard. */
export async function envoyerMeme(prepare: MemePrepare, label: string, emoji: string | null): Promise<string> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created yet");
  const gif = prepare.mime === "image/gif";
  const nomFichier = `${label.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "meme"}.${gif ? "gif" : "mp4"}`;
  const video = new File([await blobPrepare(prepare.video, prepare.mime)], nomFichier, { type: prepare.mime });
  const mxc = await uploadFile(video);
  let apercu: string | null = null;
  if (prepare.apercu && prepare.apercu_mime) {
    const fichier = new File(
      [await blobPrepare(prepare.apercu, prepare.apercu_mime)],
      `apercu.${prepare.apercu_mime === "image/webp" ? "webp" : "jpg"}`,
      { type: prepare.apercu_mime },
    );
    apercu = await uploadFile(fichier);
  }
  const contenu = {
    msgtype: gif ? "m.image" : "m.video",
    body: nomFichier,
    url: mxc,
    info: {
      mimetype: prepare.mime,
      size: prepare.taille,
      w: prepare.largeur,
      h: prepare.hauteur,
      duration: prepare.duree_ms,
      ...(apercu ? { thumbnail_url: apercu, thumbnail_info: { mimetype: prepare.apercu_mime } } : {}),
    },
    [NAMESPACE]: { label: label.trim() || "meme", emoji: emoji || null, gain_pct: 100 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reponse = await (client as any).sendEvent(roomId, "m.room.message", contenu);
  return reponse.event_id as string;
}

/** Supprime un meme (rédaction Matrix) — l'auteur, ou un modérateur. */
export async function supprimerMeme(eventId: string): Promise<void> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");
  const roomId = await findSoundboardRoom();
  if (!roomId) throw new Error("Soundboard room not created");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).redactEvent(roomId, eventId);
}

/** Retire tous les memes à l'écran — la memeboard vient d'être coupée. */
export async function arreterMemes(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("memeboard_arreter").catch(() => { /* hors Tauri */ });
}

/** Réservé aux tests : oublie les délais anti-rafale. */
export function __reinitialiserDelais(): void {
  derniers.clear();
}
