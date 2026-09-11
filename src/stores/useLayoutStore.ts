import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dimensions du layout desktop. La sidebar est la première pièce modulable :
// déployée librement entre MIN et MAX, repliée en rail d'icônes, ou masquée.
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

/** Déployé, rail d'icônes, ou masqué (le bord gauche garde une poignée de
 *  révélation, et Ctrl+B cycle les trois états). */
export type SidebarMode = "full" | "rail" | "hidden";

/** Ordre du cycle Ctrl+B : déployé → rail → masqué → déployé. */
const SIDEBAR_MODE_CYCLE: readonly SidebarMode[] = ["full", "rail", "hidden"];

// ───────────────────────────── Dock (panneaux déplaçables) ─────────────────
// Les trois panneaux de la dock (membres, soundboard, transcription) se
// placent dans deux zones : à droite (colonne) ou en bas (bandeau). Une zone
// peut contenir plusieurs panneaux — ils deviennent alors des onglets, comme
// dans un éditeur. Le chat reste épinglé au centre (jamais déplaçable).

export type DockPanelId = "members" | "soundboard" | "transcript";
export type DockZoneId = "right" | "bottom";

export const DOCK_ZONE_IDS: readonly DockZoneId[] = ["right", "bottom"];

/** Zone où un panneau s'ouvre par défaut (l'utilisateur peut le déplacer). */
export const DOCK_PANEL_DEFAULT_ZONE: Record<DockPanelId, DockZoneId> = {
  members: "right",
  soundboard: "right",
  transcript: "right",
};

/** Zone droite : même plage que l'ancienne largeur par panneau. */
export const DOCK_SIDE_MIN_SIZE = 220;
export const DOCK_SIDE_MAX_SIZE = 520;
export const DOCK_SIDE_DEFAULT_SIZE = 360;
/** Zone basse : hauteur du bandeau. */
export const DOCK_BOTTOM_MIN_SIZE = 140;
export const DOCK_BOTTOM_MAX_SIZE = 520;
export const DOCK_BOTTOM_DEFAULT_SIZE = 240;

export interface DockZoneState {
  /** Onglets de la zone, dans l'ordre d'affichage. */
  panels: DockPanelId[];
  /** Onglet actif — toujours membre de `panels`, sinon null (zone vide). */
  active: DockPanelId | null;
  /** Largeur (zone droite) ou hauteur (zone basse), en px. */
  size: number;
}

const clampDockSize = (zone: DockZoneId, size: number) =>
  zone === "right"
    ? Math.min(DOCK_SIDE_MAX_SIZE, Math.max(DOCK_SIDE_MIN_SIZE, size))
    : Math.min(DOCK_BOTTOM_MAX_SIZE, Math.max(DOCK_BOTTOM_MIN_SIZE, size));

const defaultDockZones = (): Record<DockZoneId, DockZoneState> => ({
  right: { panels: [], active: null, size: DOCK_SIDE_DEFAULT_SIZE },
  bottom: { panels: [], active: null, size: DOCK_BOTTOM_DEFAULT_SIZE },
});

/** Zone qui contient le panneau, ou null s'il est fermé. */
function zoneOf(zones: Record<DockZoneId, DockZoneState>, panel: DockPanelId): DockZoneId | null {
  return DOCK_ZONE_IDS.find((id) => zones[id].panels.includes(panel)) ?? null;
}

/** Retire un panneau d'une zone en choisissant le nouvel onglet actif. */
function removeFromZone(zone: DockZoneState, panel: DockPanelId): DockZoneState {
  if (!zone.panels.includes(panel)) return zone;
  const panels = zone.panels.filter((p) => p !== panel);
  const active = zone.active === panel ? (panels[0] ?? null) : zone.active;
  return { ...zone, panels, active };
}

/**
 * Mémorise l'ouverture du soundboard pour le prochain lancement (relu au boot
 * par App.tsx). Import paresseux : le store de layout ne dépend pas du store
 * de réglages au chargement.
 */
function persistSoundboardAtLaunch(open: boolean): void {
  import("./useSettingsStore")
    .then(({ useSettingsStore }) => useSettingsStore.getState().setSoundboardOpenAtLaunch(open))
    .catch(() => { /* hors Tauri : sans conséquence */ });
}

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

const clampWidth = (w: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));

interface LayoutState {
  /** Dernière largeur déployée, conservée pendant le mode rail pour que le
   *  déploiement suivant retrouve la taille choisie par l'utilisateur. */
  sidebarWidth: number;
  sidebarMode: SidebarMode;
  /** Les deux zones de la dock (panneaux + onglet actif + taille de zone). */
  dockZones: Record<DockZoneId, DockZoneState>;
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
   * Sans effet en mode masqué (aucune poignée à tirer).
   */
  setSidebarWidth: (raw: number) => void;
  /** Fixe le mode explicitement — presets de layout et poignée de révélation. */
  setSidebarMode: (mode: SidebarMode) => void;
  /** Ctrl+B : cycle déployé → rail → masqué → déployé. */
  toggleSidebar: () => void;
  /** Retour à la largeur par défaut, déployé (double-clic sur la poignée). */
  resetSidebar: () => void;
  /** Ouvre un panneau dans sa zone par défaut (ou l'active s'il est ouvert). */
  openDockPanel: (panel: DockPanelId) => void;
  /** Clic sur le bouton du header : ouvre, active, ou ferme s'il est déjà actif. */
  toggleDockPanel: (panel: DockPanelId) => void;
  /** Ferme un panneau (croix du panneau ou de la zone). */
  closeDockPanel: (panel: DockPanelId) => void;
  /** Déplace un panneau vers l'autre zone (menu de la zone). */
  moveDockPanel: (panel: DockPanelId, zone: DockZoneId) => void;
  /** Sélectionne l'onglet actif d'une zone. */
  setDockZoneActive: (zone: DockZoneId, panel: DockPanelId) => void;
  /** Redimensionne une zone (drag/clavier sur sa poignée). */
  setDockZoneSize: (zone: DockZoneId, size: number) => void;
  /** Ferme tous les panneaux (les tailles de zone sont conservées). */
  closeAllDockPanels: () => void;
  /** Remet TOUT le layout à zéro : sidebar, zones, panneaux, partage. */
  resetLayout: () => void;
  /** Drag en cours : panneau saisi et zone survolée (état éphémère, jamais
   *  persisté) — alimente les bandes de dépôt et le surlignage. */
  draggingPanel: DockPanelId | null;
  dragOverZone: DockZoneId | null;
  setPanelDrag: (panel: DockPanelId | null, zone?: DockZoneId | null) => void;
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
      dockZones: defaultDockZones(),
      shareViewMaxVh: SHARE_VIEW_DEFAULT_VH,
      setSidebarWidth: (raw) =>
        set((s) => {
          if (s.sidebarMode === "hidden") return {};
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
      setSidebarMode: (mode) => set({ sidebarMode: mode }),
      toggleSidebar: () =>
        set((s) => {
          const next = SIDEBAR_MODE_CYCLE[(SIDEBAR_MODE_CYCLE.indexOf(s.sidebarMode) + 1) % SIDEBAR_MODE_CYCLE.length];
          return { sidebarMode: next };
        }),
      resetSidebar: () => set({ sidebarMode: "full" as SidebarMode, sidebarWidth: SIDEBAR_DEFAULT_WIDTH }),
      openDockPanel: (panel) =>
        set((s) => {
          const current = zoneOf(s.dockZones, panel);
          if (panel === "soundboard") persistSoundboardAtLaunch(true);
          if (current) {
            return { dockZones: { ...s.dockZones, [current]: { ...s.dockZones[current], active: panel } } };
          }
          const zone = DOCK_PANEL_DEFAULT_ZONE[panel];
          return {
            dockZones: {
              ...s.dockZones,
              [zone]: {
                ...s.dockZones[zone],
                panels: [...s.dockZones[zone].panels, panel],
                active: panel,
              },
            },
          };
        }),
      toggleDockPanel: (panel) =>
        set((s) => {
          const current = zoneOf(s.dockZones, panel);
          if (!current) {
            if (panel === "soundboard") persistSoundboardAtLaunch(true);
            const zone = DOCK_PANEL_DEFAULT_ZONE[panel];
            return {
              dockZones: {
                ...s.dockZones,
                [zone]: {
                  ...s.dockZones[zone],
                  panels: [...s.dockZones[zone].panels, panel],
                  active: panel,
                },
              },
            };
          }
          // Déjà actif : le bouton referme. Ouvert mais en arrière-plan : il
          // passe devant (comportement d'un onglet).
          if (s.dockZones[current].active === panel) {
            if (panel === "soundboard") persistSoundboardAtLaunch(false);
            return { dockZones: { ...s.dockZones, [current]: removeFromZone(s.dockZones[current], panel) } };
          }
          return { dockZones: { ...s.dockZones, [current]: { ...s.dockZones[current], active: panel } } };
        }),
      closeDockPanel: (panel) =>
        set((s) => {
          const current = zoneOf(s.dockZones, panel);
          if (!current) return {};
          if (panel === "soundboard") persistSoundboardAtLaunch(false);
          return { dockZones: { ...s.dockZones, [current]: removeFromZone(s.dockZones[current], panel) } };
        }),
      moveDockPanel: (panel, zone) =>
        set((s) => {
          const from = zoneOf(s.dockZones, panel);
          if (from === zone) {
            return { dockZones: { ...s.dockZones, [zone]: { ...s.dockZones[zone], active: panel } } };
          }
          const zones = { ...s.dockZones };
          if (from) zones[from] = removeFromZone(zones[from], panel);
          zones[zone] = { ...zones[zone], panels: [...zones[zone].panels, panel], active: panel };
          return { dockZones: zones };
        }),
      setDockZoneActive: (zone, panel) =>
        set((s) =>
          s.dockZones[zone].panels.includes(panel)
            ? { dockZones: { ...s.dockZones, [zone]: { ...s.dockZones[zone], active: panel } } }
            : {},
        ),
      setDockZoneSize: (zone, size) =>
        set((s) => ({
          dockZones: { ...s.dockZones, [zone]: { ...s.dockZones[zone], size: clampDockSize(zone, size) } },
        })),
      closeAllDockPanels: () =>
        set((s) => {
          if (s.dockZones.right.panels.includes("soundboard") || s.dockZones.bottom.panels.includes("soundboard")) {
            persistSoundboardAtLaunch(false);
          }
          return {
            dockZones: {
              right: { ...s.dockZones.right, panels: [], active: null },
              bottom: { ...s.dockZones.bottom, panels: [], active: null },
            },
          };
        }),
      resetLayout: () =>
        set({
          sidebarMode: "full" as SidebarMode,
          sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
          dockZones: defaultDockZones(),
          shareViewMaxVh: SHARE_VIEW_DEFAULT_VH,
          shareDock: "inline" as ShareDock,
          shareFloating: { ...SHARE_FLOATING_DEFAULT },
        }),
      draggingPanel: null,
      dragOverZone: null,
      setPanelDrag: (panel, zone = null) => set({ draggingPanel: panel, dragOverZone: panel ? zone : null }),
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
      version: 3,
      // L'état de drag (panneau saisi / zone survolée) est éphémère : il ne
      // doit jamais être réhydraté au lancement.
      partialize: (s) => ({
        sidebarWidth: s.sidebarWidth,
        sidebarMode: s.sidebarMode,
        dockZones: s.dockZones,
        shareViewMaxVh: s.shareViewMaxVh,
        shareDock: s.shareDock,
        shareFloating: s.shareFloating,
      }),
      // v1 → v2 : largeur unique de la dock → largeur par panneau.
      // v2 → v3 : les trois largeurs par panneau → une taille pour la zone
      // droite (la plus large des trois, pour ne rien rétrécir), et les zones
      // d'onglets remplacent les drapeaux d'ouverture.
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<LayoutState> & {
          rightPanelWidth?: number;
          rightPanelWidths?: Record<string, number>;
        };
        if (version < 2 && typeof state.rightPanelWidth === "number") {
          state.rightPanelWidths = {
            members: state.rightPanelWidth,
            soundboard: state.rightPanelWidth,
            transcript: state.rightPanelWidth,
          };
        }
        if (version < 3) {
          const legacy = state.rightPanelWidths;
          const widest = legacy
            ? Math.max(legacy.members ?? 0, legacy.soundboard ?? 0, legacy.transcript ?? 0)
            : 0;
          state.dockZones = {
            right: {
              panels: [],
              active: null,
              size: clampDockSize("right", widest || DOCK_SIDE_DEFAULT_SIZE),
            },
            bottom: { panels: [], active: null, size: DOCK_BOTTOM_DEFAULT_SIZE },
          };
        }
        delete state.rightPanelWidth;
        delete state.rightPanelWidths;
        return state as LayoutState;
      },
    },
  ),
);
