import { useLayoutStore, SHARE_VIEW_DEFAULT_VH, SHARE_VIEW_MAX_VH } from "../stores/useLayoutStore";
import { useAppStore } from "../stores/useAppStore";
import { useTranscriptStore } from "../stores/useTranscriptStore";

/**
 * Dispositions rapides (roadmap §1.4) : trois usages types appliqués en un
 * clic depuis le menu du header. Chaque preset ne touche que ce qui définit
 * sa mise en page — les largeurs personnalisées de l'utilisateur (sidebar,
 * dock) sont conservées, jamais écrasées.
 *
 *  - `chat`   : tout le confort du salon — sidebar déployée, soundboard
 *    ouvert, partage en ligne à hauteur moyenne.
 *  - `voice`  : la voix d'abord — sidebar en rail, dock fermée, partage en
 *    ligne à sa hauteur maximale.
 *  - `stream` : regarder/streamer — sidebar masquée, dock fermée, partage
 *    détaché en carte flottante.
 */
export type LayoutPresetId = "chat" | "voice" | "stream";

/** Ferme les trois panneaux de la dock droite (membres, soundboard, transcription). */
function closeRightDock(): void {
  useAppStore.setState({ showMemberPanel: false, showSoundboardPanel: false });
  useTranscriptStore.getState().setPanelOpen(false);
}

export function applyLayoutPreset(id: LayoutPresetId): void {
  switch (id) {
    case "chat":
      closeRightDock();
      useLayoutStore.setState({
        sidebarMode: "full",
        shareDock: "inline",
        shareViewMaxVh: SHARE_VIEW_DEFAULT_VH,
      });
      // Le soundboard rouvre après closeRightDock (ordre volontaire : un seul
      // chemin de fermeture, le preset décide de ce qu'il rallume).
      useAppStore.setState({ showSoundboardPanel: true });
      break;
    case "voice":
      closeRightDock();
      useLayoutStore.setState({
        sidebarMode: "rail",
        shareDock: "inline",
        shareViewMaxVh: SHARE_VIEW_MAX_VH,
      });
      break;
    case "stream":
      closeRightDock();
      useLayoutStore.setState({ sidebarMode: "hidden", shareDock: "floating" });
      break;
  }
}
