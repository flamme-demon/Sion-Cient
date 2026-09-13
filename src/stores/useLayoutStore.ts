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

/** Déployé, rail d'icônes, ou masqué (le bord garde une poignée de
 *  révélation, et Ctrl+B cycle les trois états). */
export type SidebarMode = "full" | "rail" | "hidden";

/** Côté du menu principal : à gauche (défaut) ou à droite. En bas, jamais —
 *  une liste de salons horizontale n'a aucun sens. */
export type SidebarSide = "left" | "right";

/** Ordre du cycle Ctrl+B : déployé → rail → masqué → déployé. */
const SIDEBAR_MODE_CYCLE: readonly SidebarMode[] = ["full", "rail", "hidden"];

// ───────────────────────────── Dock (panneaux déplaçables) ─────────────────
// Les trois panneaux de la dock (membres, soundboard, transcription) se
// placent dans deux zones : à droite (colonne) ou en bas (bandeau). Une zone
// peut contenir plusieurs panneaux — ils deviennent alors des onglets, comme
// dans un éditeur. Le chat reste épinglé au centre (jamais déplaçable).

export type DockPanelId = "members" | "soundboard" | "transcript" | "voice";
export type DockZoneId = "top" | "right" | "bottom";

export const DOCK_ZONE_IDS: readonly DockZoneId[] = ["top", "right", "bottom"];

/** Zone où un panneau s'ouvre par défaut (l'utilisateur peut le déplacer).
 *  Le bloc « connexion vocale » vient du menu latéral : son défaut logique
 *  quand on le détache est le bandeau bas, à côté de la soundboard. */
export const DOCK_PANEL_DEFAULT_ZONE: Record<DockPanelId, DockZoneId> = {
  members: "right",
  soundboard: "right",
  transcript: "right",
  voice: "bottom",
};

/** Zone droite : même plage que l'ancienne largeur par panneau. */
export const DOCK_SIDE_MIN_SIZE = 220;
export const DOCK_SIDE_MAX_SIZE = 520;
export const DOCK_SIDE_DEFAULT_SIZE = 360;
/** Zone basse : hauteur du bandeau. */
export const DOCK_BOTTOM_MIN_SIZE = 140;
export const DOCK_BOTTOM_MAX_SIZE = 520;
export const DOCK_BOTTOM_DEFAULT_SIZE = 240;
/** Zone haute : bandeau fin (barre vocale, onglets) — une ligne de contenu,
 *  donc court par nature. 96 px laissaient un grand vide sous la barre. */
export const DOCK_TOP_MIN_SIZE = 44;
export const DOCK_TOP_MAX_SIZE = 400;
export const DOCK_TOP_DEFAULT_SIZE = 56;

export interface DockZoneState {
  /** Onglets de la zone, dans l'ordre d'affichage. */
  panels: DockPanelId[];
  /** Onglet actif — toujours membre de `panels`, sinon null (zone vide). */
  active: DockPanelId | null;
  /** Largeur (zone droite) ou hauteur (zone basse), en px. */
  size: number;
}

/** Carte flottante d'un panneau (même primitive que la carte PIP du partage) :
 *  x/y < 0 = « coller en bas à droite », calculé au premier rendu. */
export interface FloatingPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FLOATING_PANEL_DEFAULT = { x: -1, y: -1, w: 360, h: 440 };
export const FLOATING_PANEL_MIN_W = 260;
export const FLOATING_PANEL_MIN_H = 200;

/** Combien de panneaux peuvent flotter en même temps (au-delà, l'écran est un
 *  chantier — et le menu reste simple). */
export const FLOATING_PANEL_MAX = 2;

const clampDockSize = (zone: DockZoneId, size: number) => {
  if (zone === "right") {
    return Math.min(DOCK_SIDE_MAX_SIZE, Math.max(DOCK_SIDE_MIN_SIZE, size));
  }
  const [min, max] = zone === "top"
    ? [DOCK_TOP_MIN_SIZE, DOCK_TOP_MAX_SIZE]
    : [DOCK_BOTTOM_MIN_SIZE, DOCK_BOTTOM_MAX_SIZE];
  return Math.min(max, Math.max(min, size));
};

const defaultDockZones = (): Record<DockZoneId, DockZoneState> => ({
  top: { panels: [], active: null, size: DOCK_TOP_DEFAULT_SIZE },
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

/** Portée d'un fond d'image : le chat, le menu des salons, ou un bloc de dock. */
export type BackgroundScope = "chat" | "channels" | DockPanelId;

/** Fond d'image d'un panneau : chemin local + opacité. L'image est posée SOUS
 *  le fond du thème, donc le contraste du texte ne dépend pas du fond.
 *  `mode` : `veil` (voile de surface sur l'image, par défaut) ou `blur`
 *  (image pleine dans un calque flouté — la lisibilité vient du flou).
 *  `anchor` : zone de l'image conservée quand elle est recadrée (image plus
 *  grande que le panneau, `cover`) — `mc` (centre) par défaut. */
export type BgAnchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

export interface PanelBackgroundCfg {
  path: string;
  opacity: number;
  mode?: "veil" | "blur";
  anchor?: BgAnchor;
}

interface LayoutState {
  /** Dernière largeur déployée, conservée pendant le mode rail pour que le
   *  déploiement suivant retrouve la taille choisie par l'utilisateur. */
  sidebarWidth: number;
  sidebarMode: SidebarMode;
  /** Côté du menu principal (gauche par défaut, droite possible). */
  sidebarSide: SidebarSide;
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
  /** Fixe le côté du menu (gauche / droite). */
  setSidebarSide: (side: SidebarSide) => void;
  /** Bascule gauche ↔ droite. */
  toggleSidebarSide: () => void;
  /** Le bloc « connexion vocale » vit-il dans le menu latéral ? INDICATIF :
   *  la source de vérité est l'appartenance du panneau `voice` à une zone de
   *  la dock (cf. `dockZones`) — c'est elle qui décide où le bloc se rend, et
   *  un drapeau séparé finissait par diverger (bloc affiché des deux côtés). */
  voiceInMenu: boolean;
  /** Détache le bloc voix vers une zone de la dock (défaut : bandeau bas). */
  sendVoiceToDock: (zone?: DockZoneId) => void;
  /** Renvoie le bloc voix dans le menu latéral. */
  returnVoiceToMenu: () => void;
  /** Mode édition de la disposition (façon KDE) : cadre les zones, rend les
   *  blocs saisissables partout — éphémère, jamais persisté. */
  layoutEditing: boolean;
  setLayoutEditing: (editing: boolean) => void;
  /** Fonds d'image par panneau (chemin + opacité) — voir `PanelBackground`. */
  panelBackgrounds: Partial<Record<BackgroundScope, PanelBackgroundCfg>>;
  /** Associe (ou retire avec `null`) le fond d'image d'un panneau. */
  setPanelBackground: (scope: BackgroundScope, cfg: PanelBackgroundCfg | null) => void;
  /** Retour à la largeur par défaut, déployé (double-clic sur la poignée). */
  resetSidebar: () => void;
  /** Ouvre un panneau dans sa zone par défaut (ou l'active s'il est ouvert). */
  openDockPanel: (panel: DockPanelId) => void;
  /** Clic sur le bouton du header : ouvre, active, ou ferme s'il est déjà actif. */
  toggleDockPanel: (panel: DockPanelId) => void;
  /** Ferme un panneau (croix du panneau ou de la zone). */
  closeDockPanel: (panel: DockPanelId) => void;
  /** Déplace un panneau vers une zone — `before` l'insère DEVANT ce bloc
   *  (omis/null = en fin de zone). C'est le glisser qui s'en sert (position du
   *  curseur) et c'est ainsi qu'on réordonne dans une même zone. */
  moveDockPanel: (panel: DockPanelId, zone: DockZoneId, before?: DockPanelId | null) => void;
  /** Sélectionne l'onglet actif d'une zone. */
  setDockZoneActive: (zone: DockZoneId, panel: DockPanelId) => void;
  /** Redimensionne une zone (drag/clavier sur sa poignée). */
  setDockZoneSize: (zone: DockZoneId, size: number) => void;
  /** Cartes flottantes ouvertes (rect par panneau, x/y < 0 = bas-droite). */
  floatingPanels: Partial<Record<DockPanelId, FloatingPanelRect>>;
  /** Détache un panneau de sa zone en carte flottante (plafonné). */
  floatDockPanel: (panel: DockPanelId) => void;
  /** Rattache une carte flottante à une zone (défaut : sa zone d'origine). */
  dockFloatingPanel: (panel: DockPanelId, zone?: DockZoneId) => void;
  /** Position/taille d'une carte flottante (merge partiel, bornes min). */
  setFloatingRect: (panel: DockPanelId, rect: Partial<FloatingPanelRect>) => void;
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
      sidebarSide: "left" as SidebarSide,
      voiceInMenu: true,
      layoutEditing: false,
      panelBackgrounds: {},
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
      setSidebarSide: (side) => set({ sidebarSide: side }),
      toggleSidebarSide: () =>
        set((s) => ({ sidebarSide: s.sidebarSide === "left" ? ("right" as SidebarSide) : ("left" as SidebarSide) })),
      sendVoiceToDock: (zone) =>
        set((s) => {
          const target = zone ?? DOCK_PANEL_DEFAULT_ZONE.voice;
          const from = zoneOf(s.dockZones, "voice");
          const zones = { ...s.dockZones };
          if (from) zones[from] = removeFromZone(zones[from], "voice");
          zones[target] = {
            ...zones[target],
            panels: zones[target].panels.includes("voice") ? zones[target].panels : [...zones[target].panels, "voice"],
            active: "voice",
          };
          return { voiceInMenu: false, dockZones: zones };
        }),
      returnVoiceToMenu: () =>
        set((s) => {
          const from = zoneOf(s.dockZones, "voice");
          return {
            voiceInMenu: true,
            dockZones: from ? { ...s.dockZones, [from]: removeFromZone(s.dockZones[from], "voice") } : s.dockZones,
          };
        }),
      setLayoutEditing: (editing) => set({ layoutEditing: editing }),
      setPanelBackground: (scope, cfg) =>
        set((s) => {
          const next = { ...s.panelBackgrounds };
          if (cfg) next[scope] = cfg;
          else delete next[scope];
          return { panelBackgrounds: next };
        }),
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
          // Flottant : le bouton du header referme la carte.
          if (s.floatingPanels[panel]) {
            if (panel === "soundboard") persistSoundboardAtLaunch(false);
            const next = { ...s.floatingPanels };
            delete next[panel];
            return { floatingPanels: next };
          }
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
          const floating = s.floatingPanels[panel];
          const current = zoneOf(s.dockZones, panel);
          if (!current && !floating) return {};
          if (panel === "soundboard") persistSoundboardAtLaunch(false);
          const nextFloating = { ...s.floatingPanels };
          delete nextFloating[panel];
          return {
            dockZones: current
              ? { ...s.dockZones, [current]: removeFromZone(s.dockZones[current], panel) }
              : s.dockZones,
            floatingPanels: nextFloating,
            // Fermer le bloc voix alors qu'il est détaché le renvoie au menu :
            // sans ça, l'utilisateur perdrait ses commandes vocales.
            ...(panel === "voice" ? { voiceInMenu: true } : {}),
          };
        }),
      moveDockPanel: (panel, zone, before = null) =>
        set((s) => {
          const from = zoneOf(s.dockZones, panel);
          const zones = { ...s.dockZones };
          if (from) zones[from] = removeFromZone(zones[from], panel);
          // Réordonner dans la MÊME zone passe par le même chemin : on retire
          // puis on réinsère à la position demandée.
          const rest = zones[zone].panels.filter((p) => p !== panel);
          const index = before ? Math.max(0, rest.indexOf(before)) : rest.length;
          const panels = [...rest.slice(0, index), panel, ...rest.slice(index)];
          zones[zone] = { ...zones[zone], panels, active: panel };
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
      floatingPanels: {},
      floatDockPanel: (panel) =>
        set((s) => {
          const already = s.floatingPanels[panel];
          // Plafond : au-delà, on refuse poliment plutôt que d'empiler des
          // cartes qui se recouvrent.
          if (!already && Object.keys(s.floatingPanels).length >= FLOATING_PANEL_MAX) return {};
          const from = zoneOf(s.dockZones, panel);
          return {
            dockZones: from
              ? { ...s.dockZones, [from]: removeFromZone(s.dockZones[from], panel) }
              : s.dockZones,
            floatingPanels: already
              ? s.floatingPanels
              : { ...s.floatingPanels, [panel]: { ...FLOATING_PANEL_DEFAULT } },
          };
        }),
      dockFloatingPanel: (panel, zone) =>
        set((s) => {
          if (!s.floatingPanels[panel]) return {};
          const next = { ...s.floatingPanels };
          delete next[panel];
          const target = zone ?? DOCK_PANEL_DEFAULT_ZONE[panel];
          return {
            floatingPanels: next,
            dockZones: {
              ...s.dockZones,
              [target]: {
                ...s.dockZones[target],
                panels: s.dockZones[target].panels.includes(panel)
                  ? s.dockZones[target].panels
                  : [...s.dockZones[target].panels, panel],
                active: panel,
              },
            },
          };
        }),
      setFloatingRect: (panel, rect) =>
        set((s) => {
          const current = s.floatingPanels[panel];
          if (!current) return {};
          return {
            floatingPanels: {
              ...s.floatingPanels,
              [panel]: {
                ...current,
                ...rect,
                w: Math.max(FLOATING_PANEL_MIN_W, rect.w ?? current.w),
                h: Math.max(FLOATING_PANEL_MIN_H, rect.h ?? current.h),
              },
            },
          };
        }),
      closeAllDockPanels: () =>
        set((s) => {
          const soundboardInDock =
            s.dockZones.right.panels.includes("soundboard") || s.dockZones.bottom.panels.includes("soundboard");
          if (soundboardInDock || s.floatingPanels["soundboard"]) {
            persistSoundboardAtLaunch(false);
          }
          return {
            dockZones: {
              top: { ...s.dockZones.top, panels: [], active: null },
              right: { ...s.dockZones.right, panels: [], active: null },
              bottom: { ...s.dockZones.bottom, panels: [], active: null },
            },
            floatingPanels: {},
          };
        }),
      resetLayout: () =>
        set({
          sidebarMode: "full" as SidebarMode,
          sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
          sidebarSide: "left" as SidebarSide,
          voiceInMenu: true,
          dockZones: defaultDockZones(),
          floatingPanels: {},
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
      version: 5,
      // L'état de drag (panneau saisi / zone survolée) est éphémère : il ne
      // doit jamais être réhydraté au lancement.
      partialize: (s) => ({
        sidebarWidth: s.sidebarWidth,
        sidebarMode: s.sidebarMode,
        sidebarSide: s.sidebarSide,
        voiceInMenu: s.voiceInMenu,
        dockZones: s.dockZones,
        floatingPanels: s.floatingPanels,
        panelBackgrounds: s.panelBackgrounds,
        shareViewMaxVh: s.shareViewMaxVh,
        shareDock: s.shareDock,
        shareFloating: s.shareFloating,
      }),
      // Réparation défensive : quel que soit l'état persisté (version
      // intermédiaire, zone ajoutée plus tard…), les trois zones DOIVENT
      // exister — une zone manquante faisait planter la dock au premier rendu
      // (écran blanc). Le `merge` tourne après `migrate`, à chaque
      // réhydratation.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<LayoutState>;
        return {
          ...current,
          ...saved,
          dockZones: {
            ...defaultDockZones(),
            ...(saved.dockZones ?? {}),
          },
          floatingPanels: saved.floatingPanels ?? {},
        } as LayoutState;
      },
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
            top: { panels: [], active: null, size: DOCK_TOP_DEFAULT_SIZE },
            right: {
              panels: [],
              active: null,
              size: clampDockSize("right", widest || DOCK_SIDE_DEFAULT_SIZE),
            },
            bottom: { panels: [], active: null, size: DOCK_BOTTOM_DEFAULT_SIZE },
          };
        }
        if (version < 4) {
          // v3 → v4 : apparition de la zone HAUTE (barre vocale en long).
          // Un état v3 n'a que right/bottom : sans ce bloc, `dockZones.top`
          // serait `undefined` et la dock planterait au premier rendu.
          state.dockZones = {
            top: { panels: [], active: null, size: DOCK_TOP_DEFAULT_SIZE },
            ...(state.dockZones ?? {}),
          } as Record<DockZoneId, DockZoneState>;
        }
        if (version < 5) {
          // v4 → v5 : le défaut de la zone HAUTE (96 px) laissait un grand vide
          // sous la barre vocale. On ne corrige QUE la valeur par défaut
          // d'origine — une taille choisie à la main est respectée.
          if (state.dockZones?.top?.size === 96) {
            state.dockZones = {
              ...state.dockZones,
              top: { ...state.dockZones.top, size: DOCK_TOP_DEFAULT_SIZE },
            };
          }
        }
        delete state.rightPanelWidth;
        delete state.rightPanelWidths;
        return state as LayoutState;
      },
    },
  ),
);
