/**
 * Dispositions exportables et importables (roadmap §1.6).
 *
 * Même principe que les thèmes : un fichier JSON qu'on s'échange, validé
 * champ par champ à l'import. Un fichier est une donnée étrangère — rien n'en
 * passe au store sans avoir été borné, filtré ou remplacé par un défaut.
 *
 * Les fonds d'image des panneaux ne voyagent pas : ce sont des chemins de
 * fichiers propres à la machine qui les a choisis.
 */
import {
  DOCK_BOTTOM_MAX_SIZE,
  DOCK_BOTTOM_MIN_SIZE,
  DOCK_PANEL_DEFAULT_ZONE,
  DOCK_SIDE_MAX_SIZE,
  DOCK_SIDE_MIN_SIZE,
  DOCK_TOP_MAX_SIZE,
  DOCK_TOP_MIN_SIZE,
  DOCK_ZONE_IDS,
  FLOATING_PANEL_MAX,
  FLOATING_PANEL_MIN_H,
  FLOATING_PANEL_MIN_W,
  SHARE_FLOATING_MIN_H,
  SHARE_FLOATING_MIN_W,
  SHARE_VIEW_MAX_VH,
  SHARE_VIEW_MIN_VH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutStore,
  type DockPanelId,
  type DockZoneId,
  type DockZoneState,
  type FloatingPanelRect,
  type ShareDock,
  type SidebarMode,
  type SidebarSide,
} from "../stores/useLayoutStore";

/** Version du format d'échange — refuser ce qu'on ne sait pas lire. */
const FORMAT = 1;
const GENRE = "sion-layout";

export interface Disposition {
  sidebarWidth: number;
  sidebarMode: SidebarMode;
  sidebarSide: SidebarSide;
  dockZones: Record<DockZoneId, DockZoneState>;
  floatingPanels: Partial<Record<DockPanelId, FloatingPanelRect>>;
  shareViewMaxVh: number;
  shareDock: ShareDock;
  shareFloating: FloatingPanelRect;
}

export type ErreurDisposition = "invalidJson" | "notALayout" | "tooRecent";

const PANNEAUX = Object.keys(DOCK_PANEL_DEFAULT_ZONE) as DockPanelId[];

const borne = (v: unknown, min: number, max: number, defaut: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : defaut;

const TAILLES_ZONE: Record<DockZoneId, [number, number]> = {
  top: [DOCK_TOP_MIN_SIZE, DOCK_TOP_MAX_SIZE],
  right: [DOCK_SIDE_MIN_SIZE, DOCK_SIDE_MAX_SIZE],
  bottom: [DOCK_BOTTOM_MIN_SIZE, DOCK_BOTTOM_MAX_SIZE],
};

/** Carte flottante : position libre (négative = coin automatique), taille
 *  au moins la minimale. `null` si les nombres manquent. */
function carte(v: unknown, minW: number, minH: number): FloatingPanelRect | null {
  const r = v as Partial<FloatingPanelRect> | null;
  if (!r || typeof r !== "object") return null;
  const nombres = [r.x, r.y, r.w, r.h];
  if (!nombres.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: Math.max(-1, Math.min(10000, r.x!)),
    y: Math.max(-1, Math.min(10000, r.y!)),
    w: Math.max(minW, Math.min(10000, r.w!)),
    h: Math.max(minH, Math.min(10000, r.h!)),
  };
}

/** La disposition courante, prête à partager. */
export function layoutToJson(): string {
  const s = useLayoutStore.getState();
  return JSON.stringify(
    {
      format: FORMAT,
      kind: GENRE,
      sidebarWidth: s.sidebarWidth,
      sidebarMode: s.sidebarMode,
      sidebarSide: s.sidebarSide,
      dockZones: s.dockZones,
      floatingPanels: s.floatingPanels,
      shareViewMaxVh: s.shareViewMaxVh,
      shareDock: s.shareDock,
      shareFloating: s.shareFloating,
    },
    null,
    2,
  );
}

/** Lit un fichier de disposition. Tout ce qui est inconnu ou hors bornes est
 *  écarté ou ramené dans les bornes ; un panneau n'apparaît qu'une fois. */
export function parseLayoutFile(texte: string): { disposition: Disposition } | { error: ErreurDisposition } {
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return { error: "invalidJson" };
  }
  const d = brut as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || d.kind !== GENRE) return { error: "notALayout" };
  if (typeof d.format !== "number" || d.format > FORMAT) return { error: "tooRecent" };

  const vus = new Set<DockPanelId>();
  const zonesBrutes = (d.dockZones ?? {}) as Record<string, Partial<DockZoneState> | undefined>;
  const dockZones = {} as Record<DockZoneId, DockZoneState>;
  for (const id of DOCK_ZONE_IDS) {
    const z = zonesBrutes[id];
    const panels: DockPanelId[] = [];
    for (const p of Array.isArray(z?.panels) ? z!.panels : []) {
      const panneau = p as DockPanelId;
      if (PANNEAUX.includes(panneau) && !vus.has(panneau)) {
        panels.push(panneau);
        vus.add(panneau);
      }
    }
    const active = panels.includes(z?.active as DockPanelId) ? (z!.active as DockPanelId) : (panels[0] ?? null);
    const [min, max] = TAILLES_ZONE[id];
    dockZones[id] = { panels, active, size: borne(z?.size, min, max, min) };
  }

  const floatingPanels: Partial<Record<DockPanelId, FloatingPanelRect>> = {};
  for (const [id, rect] of Object.entries((d.floatingPanels ?? {}) as Record<string, unknown>)) {
    const panneau = id as DockPanelId;
    // Le bloc voix ne flotte jamais : il vit dans le menu ou dans la dock.
    if (!PANNEAUX.includes(panneau) || panneau === "voice" || vus.has(panneau)) continue;
    if (Object.keys(floatingPanels).length >= FLOATING_PANEL_MAX) break;
    const r = carte(rect, FLOATING_PANEL_MIN_W, FLOATING_PANEL_MIN_H);
    if (r) {
      floatingPanels[panneau] = r;
      vus.add(panneau);
    }
  }

  return {
    disposition: {
      sidebarWidth: borne(d.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH),
      sidebarMode: (["full", "rail", "hidden"] as const).find((m) => m === d.sidebarMode) ?? "full",
      sidebarSide: d.sidebarSide === "right" ? "right" : "left",
      dockZones,
      floatingPanels,
      shareViewMaxVh: borne(d.shareViewMaxVh, SHARE_VIEW_MIN_VH, SHARE_VIEW_MAX_VH, SHARE_VIEW_MIN_VH),
      shareDock: d.shareDock === "floating" ? "floating" : "inline",
      shareFloating: carte(d.shareFloating, SHARE_FLOATING_MIN_W, SHARE_FLOATING_MIN_H)
        ?? { x: -1, y: -1, w: SHARE_FLOATING_MIN_W, h: SHARE_FLOATING_MIN_H },
    },
  };
}

/** Applique une disposition importée. Le bloc voix suit sa zone : il est
 *  dans le menu s'il n'est dans aucune — c'est la source de vérité du store. */
export function applyLayout(disposition: Disposition): void {
  const dansLaDock = (panneau: DockPanelId) =>
    DOCK_ZONE_IDS.some((id) => disposition.dockZones[id].panels.includes(panneau));
  useLayoutStore.setState({ ...disposition, voiceInMenu: !dansLaDock("voice") });
  // Comme l'ouverture à la main : la soundboard rouvrira au lancement si la
  // disposition la montre.
  const soundboard = dansLaDock("soundboard") || disposition.floatingPanels.soundboard !== undefined;
  import("../stores/useSettingsStore")
    .then(({ useSettingsStore }) => useSettingsStore.getState().setSoundboardOpenAtLaunch(soundboard))
    .catch(() => { /* hors Tauri : sans conséquence */ });
}
