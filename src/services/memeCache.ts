/**
 * Téléphone : les vidéos des memes gardées en mémoire (blob).
 *
 * Lue par son adresse `sion-media`, une vidéo repasse à chaque lecture par
 * l'interception des requêtes du WebView : 240 à 390 ms avant la première
 * image, contre ~60 ms depuis un blob (mesuré le 29/09 sur un Xiaomi 12, pour
 * un meme de 738 Ko). Un meme joué une fois reste donc en mémoire, et ceux du
 * salon sont préchargés en entrant en vocal — en Wi-Fi seulement : en données
 * mobiles, ils ne sont chargés qu'à la demande.
 */
import * as core from "./matrixCore";
import { mxcToHttp } from "./matrixService";
import { moteurRust } from "./moteur";
import { useAppStore } from "../stores/useAppStore";
import { SUR_ANDROID } from "../utils/plateforme";

/** Au-delà, les memes joués le moins récemment sortent du cache. */
const OCTETS_MAX = 25 * 1024 * 1024;

const cache = new Map<string, { url: string; octets: number }>();
const enCours = new Map<string, Promise<string | null>>();
let total = 0;

async function adresse(mxc: string): Promise<string | null> {
  return moteurRust() ? core.urlMedia(mxc) : mxcToHttp(mxc);
}

function ranger(mxc: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  cache.set(mxc, { url, octets: blob.size });
  total += blob.size;
  // Map : ordre d'insertion = du plus ancien au plus récent.
  for (const [cle, entree] of cache) {
    if (total <= OCTETS_MAX || cle === mxc) break;
    URL.revokeObjectURL(entree.url);
    cache.delete(cle);
    total -= entree.octets;
  }
  return url;
}

/** URL `blob:` du meme, téléchargé au besoin (une seule fois à la fois). */
export async function urlMeme(mxc: string): Promise<string | null> {
  const deja = cache.get(mxc);
  if (deja) {
    // Remis en tête : c'est le plus récemment joué.
    cache.delete(mxc);
    cache.set(mxc, deja);
    return deja.url;
  }
  const attente = enCours.get(mxc);
  if (attente) return attente;
  const promesse = (async () => {
    const source = await adresse(mxc);
    if (!source) return null;
    const reponse = await fetch(source);
    if (!reponse.ok) return null;
    return ranger(mxc, await reponse.blob());
  })()
    .catch(() => null)
    .finally(() => enCours.delete(mxc));
  enCours.set(mxc, promesse);
  return promesse;
}

/** Données mobiles (4G/5G) plutôt que Wi-Fi : Chromium le dit sur Android. */
function surReseauMobile(): boolean {
  const connexion = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return connexion?.type === "cellular";
}

async function precharger(): Promise<void> {
  if (surReseauMobile()) return;
  const { listMemes } = await import("./memeboardService");
  const memes = await listMemes().catch(() => []);
  let octets = 0;
  // Un à la fois : le préchargement ne doit pas gêner la voix.
  for (const meme of memes) {
    if (!useAppStore.getState().connectedVoiceChannel) return;
    const url = await urlMeme(meme.mxcUrl);
    octets += url ? cache.get(meme.mxcUrl)?.octets ?? 0 : 0;
    if (octets >= OCTETS_MAX * 0.8) return;
  }
}

if (SUR_ANDROID) {
  useAppStore.subscribe((etat, avant) => {
    if (etat.connectedVoiceChannel && !avant.connectedVoiceChannel) void precharger();
  });
}
