import { create } from "zustand";
import { useLiveKitStore } from "./useLiveKitStore";

/**
 * Capacités média des clients (choix automatique du codec de partage).
 *
 * Chaque client sonde sa machine (`voice_media_caps`, VA-API sur Linux) et
 * annonce le résultat aux autres sur le canal data `sion-media-caps`. Au
 * lancement d'un partage, « auto » prend **le meilleur codec décodable par
 * tout le monde, en préférant le matériel** — un partage VP9 logiciel sur une
 * machine qui sait encoder H.264/AV1 en matériel était le goulot mesuré le
 * 2026-09-12 (0,5 im/s reçues).
 */

/** Support d'un codec sur une machine : matériel (`hw`), logiciel (`sw`),
 *  ou inconnu (`null`). */
export type CodecSupport = "hw" | "sw" | null;

/** Capacités publiées entre clients sur `sion-media-caps` (v1). */
export interface MediaCaps {
  v: number;
  enc: Partial<Record<string, CodecSupport>>;
  dec: Partial<Record<string, CodecSupport>>;
}

/** Canal data des capacités média (miroir de `TOPIC_MEDIA_CAPS` côté Rust). */
export const MEDIA_CAPS_TOPIC = "sion-media-caps";

/** Codecs candidats au partage d'écran, du plus efficace au plus sûr. */
export const SHARE_CODEC_ORDER = ["av1", "h264", "vp9", "vp8"] as const;
export type ShareCodecCandidate = (typeof SHARE_CODEC_ORDER)[number];

/** Ce qu'on suppose chez un client muet (ancienne version, plateforme sans
 *  sonde…) : uniquement l'universel. */
const SAFE_UNKNOWN: readonly ShareCodecCandidate[] = ["h264", "vp8"];

/** Codec préféré quand on ne sait rien de personne. */
export const FALLBACK_SHARE_CODEC: ShareCodecCandidate = "h264";

/**
 * Meilleur codec de partage — **matériel d'abord**.
 *
 * Règles, dans l'ordre : (1) il faut que **tout le monde** décode le codec —
 * un participant sans capacités connues ne compte que pour h264/vp8 ; (2)
 * l'encodage doit exister chez moi (le matériel préféré au logiciel) ; (3)
 * entre candidats viables, celui que tout le monde décode **en matériel**
 * passe devant ; (4) à égalité, l'ordre d'efficacité tranche
 * (av1 > h264 > vp9 > vp8).
 */
export function pickBestShareCodec(
  self: MediaCaps | null,
  peers: Record<string, MediaCaps>,
  participants: string[],
): ShareCodecCandidate {
  const score = (codec: ShareCodecCandidate): number => {
    const myEnc = self?.enc?.[codec] ?? null;
    if (!myEnc) return -1; // je ne peux pas encoder ce codec → exclu
    const total = myEnc === "hw" ? 2 : 1;
    let allHardware = true;
    for (const id of participants) {
      const caps = peers[id];
      if (!caps) {
        if (!SAFE_UNKNOWN.includes(codec)) return -1;
        allHardware = false;
        continue;
      }
      const dec = caps.dec?.[codec] ?? null;
      if (!dec) return -1; // ce pair ne peut pas décoder → exclu
      if (dec !== "hw") allHardware = false;
    }
    return total + (allHardware ? 4 : 0);
  };

  let best: ShareCodecCandidate = FALLBACK_SHARE_CODEC;
  let bestScore = -1;
  for (const codec of SHARE_CODEC_ORDER) {
    const s = score(codec);
    if (s > bestScore) {
      bestScore = s;
      best = codec;
    }
  }
  return bestScore < 0 ? FALLBACK_SHARE_CODEC : best;
}

/** Résout le réglage (`auto` compris) en codec publié. */
export function resolveShareVideoCodec(pref: string): ShareCodecCandidate {
  const participants = useLiveKitStore.getState().participants.map((p) => p.identity);
  const { self, peers } = useMediaCapsStore.getState();
  if (pref !== "auto") {
    const requested = pref as ShareCodecCandidate;
    // Never force AV1 unless this build has a confirmed encoder and every
    // current peer has advertised a decoder. A manual AV1 preference must not
    // create a negotiated-but-undecodable black share.
    if (requested !== "av1" || (self?.enc?.av1 && participants.every((id) => peers[id]?.dec?.av1))) {
      return requested;
    }
    console.warn("[Sion][caps] AV1 demandé mais non confirmé partout, repli H264");
    return "h264";
  }
  return pickBestShareCodec(self, peers, participants);
}

interface MediaCapsState {
  /** Mes capacités (sonde matérielle), une fois sondées. */
  self: MediaCaps | null;
  /** Capacités reçues des autres participants, indexées par identité. */
  peers: Record<string, MediaCaps>;
  /** Une sonde/publication est en cours. */
  publishing: boolean;
  /** Sonde ma machine (une fois) et publie mes capacités aux autres. */
  refreshAndPublish: () => Promise<void>;
  /** Ingère un paquet data reçu (`voice-native-data`) — ignore les autres
   *  sujets. Le paquet vérolé est ignoré, jamais propagé. */
  ingest: (topic: string | null, payloadB64: string, sender: string | null) => void;
  /** Retire un participant (déconnexion). */
  dropPeer: (identity: string) => void;
  /** Fin de session vocale. */
  clear: () => void;
}

export const useMediaCapsStore = create<MediaCapsState>((set, get) => ({
  self: null,
  peers: {},
  publishing: false,

  refreshAndPublish: async () => {
    if (get().publishing) return;
    set({ publishing: true });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const caps = await invoke<MediaCaps>("voice_media_caps");
      set({ self: caps, publishing: false });
      const { voiceNativePublishData, bytesToB64 } = await import(
        "../services/voiceNativeService"
      );
      const bytes = new TextEncoder().encode(JSON.stringify(caps));
      await voiceNativePublishData(MEDIA_CAPS_TOPIC, bytesToB64(bytes), true);
    } catch (err) {
      set({ publishing: false });
      console.warn("[Sion][caps] sonde matérielle impossible:", err);
    }
  },

  ingest: (topic, payloadB64, sender) => {
    if (topic !== MEDIA_CAPS_TOPIC || !sender) return;
    try {
      const bin = atob(payloadB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const caps = JSON.parse(new TextDecoder().decode(bytes)) as MediaCaps;
      if (!caps || typeof caps !== "object" || caps.v !== 1) return;
      set((s) => ({ peers: { ...s.peers, [sender]: caps } }));
    } catch {
      /* paquet illisible : ignoré (un vieux client, un sujet voisin…) */
    }
  },

  dropPeer: (identity) =>
    set((s) => {
      if (!(identity in s.peers)) return s;
      const peers = { ...s.peers };
      delete peers[identity];
      return { peers };
    }),

  clear: () => set({ peers: {}, publishing: false }),
}));
