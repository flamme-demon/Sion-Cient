/**
 * Partages d'écran dont la vidéo est masquée : le serveur cesse de l'envoyer
 * (ni données ni décodage). Utile en données mobiles, sur batterie, ou quand
 * on ne regarde pas — le son du partage, lui, continue. Le moteur Rust garde
 * la même liste (il l'applique aux réinscriptions) et l'oublie en quittant le
 * vocal : ici aussi.
 */
import { create } from "zustand";
import { useAppStore } from "./useAppStore";

interface VideoMasqueeState {
  masquees: ReadonlySet<string>;
  /** Masque ou réaffiche la vidéo du partage de `expediteur`. */
  basculer: (expediteur: string) => void;
}

export const useVideoMasqueeStore = create<VideoMasqueeState>((set, get) => ({
  masquees: new Set(),
  basculer: (expediteur) => {
    const masquer = !get().masquees.has(expediteur);
    const suivantes = new Set(get().masquees);
    if (masquer) suivantes.add(expediteur);
    else suivantes.delete(expediteur);
    set({ masquees: suivantes });
    void import("../services/voiceNativeService")
      .then((m) => m.setVoiceNativeShareVideoVisible(expediteur, !masquer))
      .catch((err) => console.warn("[Sion][partage] vidéo masquée : échec", err));
  },
}));

// Quitter le vocal : le moteur oublie les vidéos masquées, l'interface aussi.
useAppStore.subscribe((etat, avant) => {
  if (avant.connectedVoiceChannel && !etat.connectedVoiceChannel && useVideoMasqueeStore.getState().masquees.size > 0) {
    useVideoMasqueeStore.setState({ masquees: new Set() });
  }
});
