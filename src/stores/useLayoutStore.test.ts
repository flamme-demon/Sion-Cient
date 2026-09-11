import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Le store persisté touche localStorage dès l'évaluation : stub minimal avant
// l'import dynamique (même schéma que appStoreVoice.test.ts).
const store: Record<string, string> = {};
beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    },
  });
  // Graine de layout v1 (largeur unique de la dock) : la migration doit la
  // transformer en largeur par panneau (v2), puis en taille de zone (v3).
  store["sion-layout"] = JSON.stringify({
    state: { sidebarWidth: 300, sidebarMode: "full", rightPanelWidth: 280 },
    version: 1,
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useLayoutStore: any;
let K: {
  DEFAULT: number; MIN: number; MAX: number; SNAP_IN: number; SNAP_OUT: number;
  ZONE_MIN: number; ZONE_MAX: number; ZONE_DEFAULT: number;
  BOTTOM_MIN: number; BOTTOM_MAX: number; BOTTOM_DEFAULT: number;
  SV_DEFAULT: number; SV_MIN: number; SV_MAX: number;
  FL_MIN_W: number; FL_MIN_H: number;
};
/** État issu de la réhydratation au premier import (migrations en chaîne),
 *  capturé ici car les `beforeEach` de test réinitialisent le store. */
let migrated: { dockRightSize: number; sidebarWidth: number };

beforeAll(async () => {
  const mod = await import("./useLayoutStore");
  useLayoutStore = mod.useLayoutStore;
  K = {
    DEFAULT: mod.SIDEBAR_DEFAULT_WIDTH,
    MIN: mod.SIDEBAR_MIN_WIDTH,
    MAX: mod.SIDEBAR_MAX_WIDTH,
    SNAP_IN: mod.SIDEBAR_RAIL_SNAP_IN,
    SNAP_OUT: mod.SIDEBAR_RAIL_SNAP_OUT,
    ZONE_MIN: mod.DOCK_SIDE_MIN_SIZE,
    ZONE_MAX: mod.DOCK_SIDE_MAX_SIZE,
    ZONE_DEFAULT: mod.DOCK_SIDE_DEFAULT_SIZE,
    BOTTOM_MIN: mod.DOCK_BOTTOM_MIN_SIZE,
    BOTTOM_MAX: mod.DOCK_BOTTOM_MAX_SIZE,
    BOTTOM_DEFAULT: mod.DOCK_BOTTOM_DEFAULT_SIZE,
    SV_DEFAULT: mod.SHARE_VIEW_DEFAULT_VH,
    SV_MIN: mod.SHARE_VIEW_MIN_VH,
    SV_MAX: mod.SHARE_VIEW_MAX_VH,
    FL_MIN_W: mod.SHARE_FLOATING_MIN_W,
    FL_MIN_H: mod.SHARE_FLOATING_MIN_H,
  };
  const rehydrated = useLayoutStore.getState();
  migrated = { dockRightSize: rehydrated.dockZones.right.size, sidebarWidth: rehydrated.sidebarWidth };
});

const reset = () =>
  useLayoutStore.setState({
    sidebarWidth: K.DEFAULT,
    sidebarMode: "full",
    dockZones: {
      right: { panels: [], active: null, size: K.ZONE_DEFAULT },
      bottom: { panels: [], active: null, size: K.BOTTOM_DEFAULT },
    },
    shareViewMaxVh: K.SV_DEFAULT,
    shareDock: "inline",
    shareFloating: { x: -1, y: -1, w: 440, h: 300 },
  });

describe("useLayoutStore — sidebar modulable", () => {
  beforeEach(reset);

  it("borne la largeur entre MIN et MAX en mode déployé", () => {
    useLayoutStore.getState().setSidebarWidth(1000);
    expect(useLayoutStore.getState().sidebarWidth).toBe(K.MAX);

    useLayoutStore.getState().setSidebarWidth(K.MIN + 20);
    expect(useLayoutStore.getState().sidebarWidth).toBe(K.MIN + 20);
  });

  it("accroche le rail quand le drag descend sous le seuil bas", () => {
    useLayoutStore.getState().setSidebarWidth(K.SNAP_IN - 1);
    expect(useLayoutStore.getState().sidebarMode).toBe("rail");
    // La dernière largeur déployée est conservée pour le redéploiement.
    expect(useLayoutStore.getState().sidebarWidth).toBe(K.DEFAULT);
  });

  it("ne redéploie qu'au-dessus du seuil haut (hystérésis anti-va-et-vient)", () => {
    useLayoutStore.getState().setSidebarWidth(K.SNAP_IN - 1); // → rail
    // Entre les deux seuils : zone morte, on reste en rail.
    useLayoutStore.getState().setSidebarWidth(K.SNAP_OUT - 1);
    expect(useLayoutStore.getState().sidebarMode).toBe("rail");

    // Au seuil haut : redéploiement, largeur bornée au minimum déployé.
    useLayoutStore.getState().setSidebarWidth(K.SNAP_OUT);
    expect(useLayoutStore.getState().sidebarMode).toBe("full");
    expect(useLayoutStore.getState().sidebarWidth).toBe(K.MIN);
  });

  it("Ctrl+B cycle déployé → rail → masqué → déployé (largeur conservée)", () => {
    useLayoutStore.getState().setSidebarWidth(320);
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarMode).toBe("rail");

    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarMode).toBe("hidden");

    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarMode).toBe("full");
    expect(useLayoutStore.getState().sidebarWidth).toBe(320);
  });

  it("mode masqué : le drag n'a plus d'effet, setSidebarMode ramène le rail", () => {
    useLayoutStore.getState().setSidebarWidth(320);
    useLayoutStore.getState().setSidebarMode("hidden");

    // Aucune poignée à tirer quand la sidebar est masquée.
    useLayoutStore.getState().setSidebarWidth(1000);
    expect(useLayoutStore.getState().sidebarMode).toBe("hidden");
    expect(useLayoutStore.getState().sidebarWidth).toBe(320);

    // Poignée de révélation : un clic ramène le rail, la largeur est intacte.
    useLayoutStore.getState().setSidebarMode("rail");
    expect(useLayoutStore.getState().sidebarMode).toBe("rail");
    expect(useLayoutStore.getState().sidebarWidth).toBe(320);
  });

  it("resetSidebar revient à la largeur par défaut, déployé", () => {
    useLayoutStore.getState().setSidebarWidth(K.SNAP_IN - 1);
    useLayoutStore.getState().resetSidebar();
    expect(useLayoutStore.getState().sidebarMode).toBe("full");
    expect(useLayoutStore.getState().sidebarWidth).toBe(K.DEFAULT);
  });

  it("persiste le layout sous la clé sion-layout (mémoire au relaunch)", () => {
    useLayoutStore.getState().setSidebarWidth(320);
    useLayoutStore.getState().toggleSidebar(); // → rail
    const raw = store["sion-layout"];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.state.sidebarWidth).toBe(320);
    expect(parsed.state.sidebarMode).toBe("rail");
  });

  it("migre un layout v1 (largeur unique de la dock) en taille de zone droite", () => {
    expect(migrated.dockRightSize).toBe(280);
    expect(migrated.sidebarWidth).toBe(300);
  });
});

describe("useLayoutStore — dock à zones (§1.6)", () => {
  beforeEach(reset);

  it("borne la taille des zones (droite et basse)", () => {
    const s = () => useLayoutStore.getState();

    s().setDockZoneSize("right", 10);
    expect(s().dockZones.right.size).toBe(K.ZONE_MIN);
    s().setDockZoneSize("right", 9999);
    expect(s().dockZones.right.size).toBe(K.ZONE_MAX);

    s().setDockZoneSize("bottom", 10);
    expect(s().dockZones.bottom.size).toBe(K.BOTTOM_MIN);
    s().setDockZoneSize("bottom", 9999);
    expect(s().dockZones.bottom.size).toBe(K.BOTTOM_MAX);
  });

  it("ouvre, active, déplace et ferme les panneaux de la dock", () => {
    const s = () => useLayoutStore.getState();

    s().openDockPanel("members");
    s().openDockPanel("soundboard");
    expect(s().dockZones.right.panels).toEqual(["members", "soundboard"]);
    expect(s().dockZones.right.active).toBe("soundboard");

    // Re-cliquer un panneau ouvert mais en arrière-plan l'active (onglet).
    s().toggleDockPanel("members");
    expect(s().dockZones.right.active).toBe("members");
    expect(s().dockZones.right.panels).toEqual(["members", "soundboard"]);

    // Re-cliquer le panneau actif le ferme ; l'autre prend la main.
    s().toggleDockPanel("members");
    expect(s().dockZones.right.panels).toEqual(["soundboard"]);
    expect(s().dockZones.right.active).toBe("soundboard");

    // Déplacement vers la zone basse : sort de la droite, devient l'onglet actif.
    s().moveDockPanel("soundboard", "bottom");
    expect(s().dockZones.right.panels).toEqual([]);
    expect(s().dockZones.right.active).toBeNull();
    expect(s().dockZones.bottom.panels).toEqual(["soundboard"]);
    expect(s().dockZones.bottom.active).toBe("soundboard");

    // Fermeture depuis le menu de zone.
    s().closeDockPanel("soundboard");
    expect(s().dockZones.bottom.panels).toEqual([]);
    expect(s().dockZones.bottom.active).toBeNull();
  });

  it("closeAllDockPanels ferme tout sans toucher aux tailles", () => {
    const s = () => useLayoutStore.getState();
    s().setDockZoneSize("right", 480);
    s().openDockPanel("members");
    s().openDockPanel("transcript");
    s().moveDockPanel("transcript", "bottom");
    s().closeAllDockPanels();
    expect(s().dockZones.right.panels).toEqual([]);
    expect(s().dockZones.bottom.panels).toEqual([]);
    expect(s().dockZones.right.size).toBe(480);
  });

  it("déplacer un panneau déjà dans la zone ne le duplique pas", () => {
    const s = () => useLayoutStore.getState();
    s().openDockPanel("members");
    s().moveDockPanel("members", "bottom");
    s().moveDockPanel("members", "bottom");
    expect(s().dockZones.bottom.panels).toEqual(["members"]);
    expect(s().dockZones.right.panels).toEqual([]);
  });

  it("resetLayout remet tout à zéro", () => {
    const s = () => useLayoutStore.getState();
    s().setSidebarWidth(380);
    s().setDockZoneSize("right", 480);
    s().openDockPanel("members");
    s().toggleShareDock();
    s().resetLayout();
    expect(s().sidebarMode).toBe("full");
    expect(s().sidebarWidth).toBe(K.DEFAULT);
    expect(s().dockZones.right.panels).toEqual([]);
    expect(s().dockZones.right.size).toBe(K.ZONE_DEFAULT);
    expect(s().shareDock).toBe("inline");
  });
});

describe("useLayoutStore — zone de partage", () => {
  beforeEach(reset);

  it("borne la hauteur de la zone de partage et la réinitialise", () => {
    const s = () => useLayoutStore.getState();

    s().setShareViewMaxVh(1);
    expect(s().shareViewMaxVh).toBe(K.SV_MIN);

    s().setShareViewMaxVh(500);
    expect(s().shareViewMaxVh).toBe(K.SV_MAX);

    s().setShareViewMaxVh(30);
    expect(s().shareViewMaxVh).toBe(30);

    s().resetShareViewMaxVh();
    expect(s().shareViewMaxVh).toBe(K.SV_DEFAULT);
  });

  it("bascule le dock du partage et mémorise la position flottante", () => {
    const s = () => useLayoutStore.getState();
    expect(s().shareDock).toBe("inline");

    s().toggleShareDock();
    expect(s().shareDock).toBe("floating");

    s().setShareFloating({ x: 120, y: 80 });
    expect(s().shareFloating.x).toBe(120);
    expect(s().shareFloating.y).toBe(80);
    // Merge partiel : la taille par défaut est conservée.
    expect(s().shareFloating.w).toBe(440);

    // Planchers de taille appliqués même via un merge partiel.
    s().setShareFloating({ w: 10, h: 10 });
    expect(s().shareFloating.w).toBe(K.FL_MIN_W);
    expect(s().shareFloating.h).toBe(K.FL_MIN_H);

    s().toggleShareDock();
    expect(s().shareDock).toBe("inline");
  });
});
