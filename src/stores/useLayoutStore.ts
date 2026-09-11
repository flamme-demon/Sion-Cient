import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dimensions du layout desktop. La sidebar est la première pièce modulable :
// déployée librement entre MIN et MAX, ou repliée en rail d'icônes.
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
/** Largeur du rail d'icônes (mode replié). */
export const SIDEBAR_RAIL_WIDTH = 72;

/**
 * Seuils d'accroche (hystérésis) entre les deux états. Pendant un drag, la
 * largeur redescend sous MIN : c'est le signal du passage au rail. Mais il
 * faut remonter nettement au-dessus pour redéployer — sinon un pointeur qui
 * traîne pile sur le seuil ferait clignoter la sidebar entre les deux états.
 */
export const SIDEBAR_RAIL_SNAP_IN = 160;
export const SIDEBAR_RAIL_SNAP_OUT = 190;

export type SidebarMode = "full" | "rail";

/** Dock droite : chaque panneau garde SA largeur (la poignée de la
 *  transcription ne doit pas bouger le soundboard quand les deux sont ouverts).
 *  Tous démarrent à la même valeur : tant que l'utilisateur n'a rien réglé,
 *  changer de panneau ne re-dimensionne pas la colonne. */
export type RightPanelId = "members" | "soundboard" | "transcript";

export const RIGHT_PANEL_DEFAULT_WIDTH = 360;
export const RIGHT_PANEL_MIN_WIDTH = 220;
export const RIGHT_PANEL_MAX_WIDTH = 520;

/** Zone de partage d'écran en ligne (dans le chat) : hauteur maximale de la
 *  vidéo, en % de la fenêtre. La réduire rend la place au chat. */
export const SHARE_VIEW_DEFAULT_VH = 50;
export const SHARE_VIEW_MIN_VH = 8;
export const SHARE_VIEW_MAX_VH = 85;

const clampShareViewVh = (v: number) =>
  Math.min(SHARE_VIEW_MAX_VH, Math.max(SHARE_VIEW_MIN_VH, v));

/** Affichage du partage : en ligne dans le chat, ou carte flottante
 *  détachable (PIP interne). */
export type ShareDock = "inline" | "floating";
export const SHARE_FLOATING_MIN_W = 260;
export const SHARE_FLOATING_MIN_H = 160;
/** Défaut de la carte flottante : x/y < 0 = « coller en bas à droite » — la
 *  taille de fenêtre n'est pas connue du store, le calcul se fait au rendu. */
const SHARE_FLOATING_DEFAULT = { x: -1, y: -1, w: 440, h: 300 };

const defaultRightPanelWidths = (): Record<RightPanelId, number> => ({
  members: RIGHT_PANEL_DEFAULT_WIDTH,
  soundboard: RIGHT_PANEL_DEFAULT_WIDTH,
  transcript: RIGHT_PANEL_DEFAULT_WIDTH,
});

const clampWidth = (w: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
const clampRightPanelWidth = (w: number) =>
  Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, w));

interface LayoutState {
  /** Dernière largeur déployée, conservée pendant le mode rail pour que le
   *  déploiement suivant retrouve la taille choisie par l'utilisateur. */
  sidebarWidth: number;
  sidebarMode: SidebarMode;
  /** Largeur par panneau de la dock droite. */
  rightPanelWidths: Record<RightPanelId, number>;
  /** Hauteur max de la zone de partage d'écran en ligne (% de la fenêtre). */
  shareViewMaxVh: number;
  /** Affichage du partage : en ligne ou carte flottante (Ctrl+Maj+P). */
  shareDock: ShareDock;
  /** Position/taille de la carte flottante (x/y < 0 = bas-droite auto). */
  shareFloating: { x: number; y: number; w: number; h: number };
  /**
   * Applique une largeur issue d'un drag (ou du clavier). `raw` peut sortir
   * de [MIN, MAX] : sous SNAP_IN on accroche le rail, au-dessus de SNAP_OUT
   * on redéploie, entre les deux on garde l'état courant (zone morte).
   */
  setSidebarWidth: (raw: number) => void;
  /** Bascule déployé ↔ rail (Ctrl+B). */
  toggleSidebar: () => void;
  /** Retour à la largeur par défaut, déployé (double-clic sur la poignée). */
  resetSidebar: () => void;
  /** Largeur d'un panneau de la dock (drag/clavier sur sa poignée). */
  setRightPanelWidth: (panel: RightPanelId, raw: number) => void;
  /** Double-clic sur la poignée d'un panneau de la dock. */
  resetRightPanelWidth: (panel: RightPanelId) => void;
  /** Hauteur de la zone de partage (drag/clavier sur sa poignée). */
  setShareViewMaxVh: (vh: number) => void;
  /** Double-clic sur la poignée de la zone de partage. */
  resetShareViewMaxVh: () => void;
  /** Fixe l'affichage du partage (en ligne / carte flottante). */
  setShareDock: (dock: ShareDock) => void;
  /** Ctrl+Maj+P : bascule en ligne ↔ flottant. */
  toggleShareDock: () => void;
  /** Met à jour position/taille de la carte flottante (merge partiel). */
  setShareFloating: (rect: Partial<{ x: number; y: number; w: number; h: number }>) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarMode: "full",
      rightPanelWidths: defaultRightPanelWidths(),
      shareViewMaxVh: SHARE_VIEW_DEFAULT_VH,
      setSidebarWidth: (raw) =>
        set((s) => {
          if (s.sidebarMode === "full") {
            if (raw < SIDEBAR_RAIL_SNAP_IN) return { sidebarMode: "rail" as SidebarMode };
            return { sidebarWidth: clampWidth(raw) };
          }
          // Mode rail : il faut un geste franc vers la droite pour redéployer.
          if (raw >= SIDEBAR_RAIL_SNAP_OUT) {
            return { sidebarMode: "full" as SidebarMode, sidebarWidth: clampWidth(raw) };
          }
          return {};
        }),
      toggleSidebar: () =>
        set((s) => ({ sidebarMode: s.sidebarMode === "full" ? ("rail" as SidebarMode) : ("full" as SidebarMode) })),
      resetSidebar: () => set({ sidebarMode: "full" as SidebarMode, sidebarWidth: SIDEBAR_DEFAULT_WIDTH }),
      setRightPanelWidth: (panel, raw) =>
        set((s) => ({ rightPanelWidths: { ...s.rightPanelWidths, [panel]: clampRightPanelWidth(raw) } })),
      resetRightPanelWidth: (panel) =>
        set((s) => ({ rightPanelWidths: { ...s.rightPanelWidths, [panel]: RIGHT_PANEL_DEFAULT_WIDTH } })),
      setShareViewMaxVh: (vh) => set({ shareViewMaxVh: clampShareViewVh(vh) }),
      resetShareViewMaxVh: () => set({ shareViewMaxVh: SHARE_VIEW_DEFAULT_VH }),
      shareDock: "inline" as ShareDock,
      shareFloating: { ...SHARE_FLOATING_DEFAULT },
      setShareDock: (dock) => set({ shareDock: dock }),
      toggleShareDock: () =>
        set((s) => ({ shareDock: s.shareDock === "inline" ? ("floating" as ShareDock) : ("inline" as ShareDock) })),
      setShareFloating: (rect) =>
        set((s) => ({
          shareFloating: {
            ...s.shareFloating,
            ...rect,
            w: Math.max(SHARE_FLOATING_MIN_W, rect.w ?? s.shareFloating.w),
            h: Math.max(SHARE_FLOATING_MIN_H, rect.h ?? s.shareFloating.h),
          },
        })),
    }),
    {
      name: "sion-layout",
      version: 2,
      // v1 → v2 : la largeur unique de la dock devient une largeur par
      // panneau ; l'utilisateur alpha repart avec sa valeur actuelle sur les
      // trois, aucune préférence perdue.
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<LayoutState> & { rightPanelWidth?: number };
        if (version < 2 && typeof state.rightPanelWidth === "number") {
          state.rightPanelWidths = {
            members: clampRightPanelWidth(state.rightPanelWidth),
            soundboard: clampRightPanelWidth(state.rightPanelWidth),
            transcript: clampRightPanelWidth(state.rightPanelWidth),
          };
        }
        delete state.rightPanelWidth;
        return state as LayoutState;
      },
    },
  ),
);
