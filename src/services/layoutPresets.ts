import { useLayoutStore, SHARE_VIEW_DEFAULT_VH, SHARE_VIEW_MAX_VH } from "../stores/useLayoutStore";

/**
 * Dispositions rapides (roadmap §1.4) : trois usages types appliqués en un
 * clic depuis le menu du header. Chaque preset ne touche que ce qui définit
 * sa mise en page — les tailles personnalisées (sidebar, zones de la dock)
 * sont conservées, jamais écrasées.
 *
 * Depuis le §1.6, l'ouverture des panneaux vit dans `useLayoutStore`
 * (`dockZones`) : les presets n'ont plus qu'un seul store à piloter.
 *
 *  - `chat`   : tout le confort du salon — sidebar déployée, soundboard
 *    ouvert, partage en ligne à hauteur moyenne.
 *  - `voice`  : la voix d'abord — sidebar en rail, dock fermée, partage en
 *    ligne à sa hauteur maximale.
 *  - `stream` : regarder/streamer — sidebar masquée, dock fermée, partage
 *    détaché en carte flottante.
 */
export type LayoutPresetId = "chat" | "voice" | "stream";

export function applyLayoutPreset(id: LayoutPresetId): void {
  const layout = useLayoutStore.getState();
  switch (id) {
    case "chat":
      layout.closeAllDockPanels();
      useLayoutStore.setState({
        sidebarMode: "full",
        shareDock: "inline",
        shareViewMaxVh: SHARE_VIEW_DEFAULT_VH,
      });
      // Le soundboard rouvre après la fermeture globale (ordre volontaire :
      // un seul chemin de fermeture, le preset décide de ce qu'il rallume).
      useLayoutStore.getState().openDockPanel("soundboard");
      break;
    case "voice":
      layout.closeAllDockPanels();
      useLayoutStore.setState({
        sidebarMode: "rail",
        shareDock: "inline",
        shareViewMaxVh: SHARE_VIEW_MAX_VH,
      });
      break;
    case "stream":
      layout.closeAllDockPanels();
      useLayoutStore.setState({ sidebarMode: "hidden", shareDock: "floating" });
      break;
  }
}
