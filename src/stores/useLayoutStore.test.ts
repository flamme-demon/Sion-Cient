import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Le store persisté touche localStorage à chaque écriture : stub minimal
// avant l'import du module (même schéma que appStoreVoice.test.ts).
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
  // Graine de layout v1 (largeur unique de la dock) : la migration v2 doit la
  // transformer en largeurs par panneau, sans perdre la largeur de l'époque.
  store["sion-layout"] = JSON.stringify({
    state: { sidebarWidth: 300, sidebarMode: "full", rightPanelWidth: 280 },
    version: 1,
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useLayoutStore: any;
let K: {
  DEFAULT: number; MIN: number; MAX: number; SNAP_IN: number; SNAP_OUT: number;
  RP_DEFAULT: number; RP_MIN: number; RP_MAX: number;
  SV_DEFAULT: number; SV_MIN: number; SV_MAX: number;
  FL_MIN_W: number; FL_MIN_H: number;
};
/** État issu de la réhydratation au premier import (migration v1 → v2),
 *  capturé ici car les `beforeEach` de test réinitialisent le store. */
let migrated: { widths: Record<string, number>; sidebarWidth: number };

beforeAll(async () => {
  const mod = await import("./useLayoutStore");
  useLayoutStore = mod.useLayoutStore;
  K = {
    DEFAULT: mod.SIDEBAR_DEFAULT_WIDTH,
    MIN: mod.SIDEBAR_MIN_WIDTH,
    MAX: mod.SIDEBAR_MAX_WIDTH,
    SNAP_IN: mod.SIDEBAR_RAIL_SNAP_IN,
    SNAP_OUT: mod.SIDEBAR_RAIL_SNAP_OUT,
    RP_DEFAULT: mod.RIGHT_PANEL_DEFAULT_WIDTH,
    RP_MIN: mod.RIGHT_PANEL_MIN_WIDTH,
    RP_MAX: mod.RIGHT_PANEL_MAX_WIDTH,
    SV_DEFAULT: mod.SHARE_VIEW_DEFAULT_VH,
    SV_MIN: mod.SHARE_VIEW_MIN_VH,
    SV_MAX: mod.SHARE_VIEW_MAX_VH,
    FL_MIN_W: mod.SHARE_FLOATING_MIN_W,
    FL_MIN_H: mod.SHARE_FLOATING_MIN_H,
  };
  const rehydrated = useLayoutStore.getState();
  migrated = { widths: rehydrated.rightPanelWidths, sidebarWidth: rehydrated.sidebarWidth };
});

const reset = () =>
  useLayoutStore.setState({
    sidebarWidth: K.DEFAULT,
    sidebarMode: "full",
    rightPanelWidths: { members: K.RP_DEFAULT, soundboard: K.RP_DEFAULT, transcript: K.RP_DEFAULT },
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

  it("migre un layout v1 (largeur unique de la dock) vers les largeurs par panneau", () => {
    expect(migrated.widths).toEqual({ members: 280, soundboard: 280, transcript: 280 });
    expect(migrated.sidebarWidth).toBe(300);
  });

  it("borne la largeur de chaque panneau de la dock, indépendamment", () => {
    const s = () => useLayoutStore.getState();

    s().setRightPanelWidth("soundboard", 10);
    expect(s().rightPanelWidths.soundboard).toBe(K.RP_MIN);

    s().setRightPanelWidth("transcript", 9999);
    expect(s().rightPanelWidths.transcript).toBe(K.RP_MAX);
    // Indépendance : régler la transcription ne touche pas le soundboard.
    expect(s().rightPanelWidths.soundboard).toBe(K.RP_MIN);

    s().setRightPanelWidth("members", 420);
    expect(s().rightPanelWidths.members).toBe(420);

    s().resetRightPanelWidth("soundboard");
    expect(s().rightPanelWidths.soundboard).toBe(K.RP_DEFAULT);
    // Le reset d'un panneau laisse les autres tranquilles.
    expect(s().rightPanelWidths.transcript).toBe(K.RP_MAX);
    expect(s().rightPanelWidths.members).toBe(420);
  });

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
