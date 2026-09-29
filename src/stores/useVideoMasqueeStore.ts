/**
 * Partages d'écran dont la vidéo est masquée : le serveur cesse de l'envoyer
 * (ni données ni décodage). Utile en données mobiles, sur batterie, ou quand
 * on ne regarde pas — le son du partage, lui, continue. Le moteur Rust garde
 * la même liste (il l'applique aux réinscriptions) et l'oublie en quittant le
 * vocal : ici aussi.
 */
import { create } from "zustand";
import { useAppStore } from "./useAppStore";
import { useLiveKitStore } from "./useLiveKitStore";
import { useSettingsStore } from "./useSettingsStore";
import { SUR_ANDROID } from "../utils/plateforme";

interface VideoMasqueeState {
  masquees: ReadonlySet<string>;
  /** Masque ou réaffiche la vidéo du partage de `expediteur`. */
  basculer: (expediteur: string) => void;
  /** Masque sans bascule (réseau mobile) : l'encart propose de l'afficher. */
  masquer: (expediteur: string) => void;
}

function appliquer(expediteur: string, visible: boolean): void {
  void import("../services/voiceNativeService")
    .then((m) => m.setVoiceNativeShareVideoVisible(expediteur, visible))
    .catch((err) => console.warn("[Sion][partage] vidéo masquée : échec", err));
}

export const useVideoMasqueeStore = create<VideoMasqueeState>((set, get) => ({
  masquees: new Set(),
  basculer: (expediteur) => {
    const masquer = !get().masquees.has(expediteur);
    const suivantes = new Set(get().masquees);
    if (masquer) suivantes.add(expediteur);
    else suivantes.delete(expediteur);
    set({ masquees: suivantes });
    appliquer(expediteur, !masquer);
  },
  masquer: (expediteur) => {
    if (get().masquees.has(expediteur)) return;
    set({ masquees: new Set(get().masquees).add(expediteur) });
    appliquer(expediteur, false);
  },
}));

// Quitter le vocal : le moteur oublie les vidéos masquées, l'interface aussi.
useAppStore.subscribe((etat, avant) => {
  if (avant.connectedVoiceChannel && !etat.connectedVoiceChannel && useVideoMasqueeStore.getState().masquees.size > 0) {
    useVideoMasqueeStore.setState({ masquees: new Set() });
  }
});

// ── Téléphone ──────────────────────────────────────────────────────────────

/** Partages d'écran reçus en cours (identités LiveKit). */
function partagesRecus(): string[] {
  return useLiveKitStore.getState().participants.filter((p) => p.isScreenSharing).map((p) => p.identity);
}

/** Données mobiles (4G/5G) plutôt que Wi-Fi : Chromium le dit sur Android. */
function surReseauMobile(): boolean {
  const connexion = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return connexion?.type === "cellular";
}

if (SUR_ANDROID && typeof document !== "undefined") {
  // Sion en arrière-plan ou écran éteint : recevoir la vidéo ne sert à rien
  // et coûte batterie et données. Masquée d'office, réaffichée au retour —
  // sauf celles que l'on avait masquées soi-même.
  const enArrierePlan = new Set<string>();
  document.addEventListener("visibilitychange", () => {
    const { masquees } = useVideoMasqueeStore.getState();
    if (document.visibilityState !== "visible") {
      for (const id of partagesRecus()) {
        if (masquees.has(id) || enArrierePlan.has(id)) continue;
        enArrierePlan.add(id);
        appliquer(id, false);
      }
    } else {
      for (const id of enArrierePlan) {
        if (!masquees.has(id)) appliquer(id, true);
      }
      enArrierePlan.clear();
    }
  });

  // Données mobiles : un nouveau partage arrive vidéo masquée (réglage
  // « Partages d'écran sur réseau mobile »), l'encart propose de l'afficher.
  let connus = new Set<string>();
  useLiveKitStore.subscribe((etat) => {
    const actuels = new Set(etat.participants.filter((p) => p.isScreenSharing).map((p) => p.identity));
    const nouveaux = [...actuels].filter((id) => !connus.has(id));
    connus = actuels;
    if (nouveaux.length === 0 || useSettingsStore.getState().partagesVideoReseauMobile || !surReseauMobile()) return;
    for (const id of nouveaux) useVideoMasqueeStore.getState().masquer(id);
  });
}
