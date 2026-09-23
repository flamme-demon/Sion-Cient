import { beforeAll, describe, expect, it } from "vitest";

// Les stores persistés touchent localStorage dès leur évaluation : stub avant
// l'import dynamique (même schéma que themeService.test.ts).
const stockage: Record<string, string> = {};
let store: typeof import("../stores/useLayoutStore");
let mod: typeof import("./layoutFile");
beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => stockage[k] ?? null,
      setItem: (k: string, v: string) => { stockage[k] = v; },
      removeItem: (k: string) => { delete stockage[k]; },
      clear: () => { for (const k of Object.keys(stockage)) delete stockage[k]; },
    },
  });
  store = await import("../stores/useLayoutStore");
  mod = await import("./layoutFile");
});

const fichier = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 1,
    kind: "sion-layout",
    sidebarWidth: 300,
    sidebarMode: "rail",
    sidebarSide: "right",
    dockZones: {
      top: { panels: ["voice"], active: "voice", size: 60 },
      right: { panels: ["members", "soundboard"], active: "soundboard", size: 400 },
      bottom: { panels: ["transcript"], active: "transcript", size: 200 },
    },
    floatingPanels: { pinned: { x: 10, y: 20, w: 300, h: 250 } },
    shareViewMaxVh: 60,
    shareDock: "floating",
    shareFloating: { x: -1, y: -1, w: 500, h: 320 },
    ...over,
  });

describe("dispositions exportables et importables", () => {
  it("relit ce qu'elle exporte", () => {
    const r = mod.parseLayoutFile(mod.layoutToJson());
    expect("disposition" in r).toBe(true);
    if (!("disposition" in r)) return;
    const s = store.useLayoutStore.getState();
    expect(r.disposition.dockZones).toEqual(s.dockZones);
    expect(r.disposition.sidebarMode).toBe(s.sidebarMode);
  });

  it("refuse ce qui n'est pas une disposition", () => {
    expect(mod.parseLayoutFile("pas du json")).toEqual({ error: "invalidJson" });
    expect(mod.parseLayoutFile(JSON.stringify({ name: "un thème" }))).toEqual({ error: "notALayout" });
    expect(mod.parseLayoutFile(fichier({ format: 2 }))).toEqual({ error: "tooRecent" });
  });

  it("borne, filtre et dédoublonne un fichier étranger", () => {
    const r = mod.parseLayoutFile(fichier({
      sidebarWidth: 5,
      sidebarMode: "géant",
      dockZones: {
        right: { panels: ["members", "inconnu", "members", "soundboard"], active: "inconnu", size: 99999 },
        bottom: { panels: ["soundboard", "transcript"], active: "transcript", size: "grand" },
      },
      floatingPanels: {
        members: { x: 0, y: 0, w: 300, h: 300 },
        voice: { x: 0, y: 0, w: 300, h: 300 },
        pinned: { x: 0, y: 0, w: 1, h: 1 },
        memeboard: { x: 5, y: 5, w: 280, h: 220 },
        pasUnPanneau: { x: 0, y: 0, w: 300, h: 300 },
      },
      shareFloating: { x: "ici" },
    }));
    if (!("disposition" in r)) throw new Error("rejetée");
    const d = r.disposition;
    expect(d.sidebarWidth).toBe(store.SIDEBAR_MIN_WIDTH);
    expect(d.sidebarMode).toBe("full");
    // Inconnu écarté, doublon supprimé, l'onglet actif retombe sur le premier.
    expect(d.dockZones.right).toEqual({ panels: ["members", "soundboard"], active: "members", size: store.DOCK_SIDE_MAX_SIZE });
    // Un panneau déjà placé ne réapparaît pas ailleurs ; zone absente = vide.
    expect(d.dockZones.bottom.panels).toEqual(["transcript"]);
    expect(d.dockZones.top.panels).toEqual([]);
    // Ni panneau déjà docké, ni bloc voix, ni inconnu ; tailles minimales.
    expect(Object.keys(d.floatingPanels)).toEqual(["pinned", "memeboard"]);
    expect(Object.keys(d.floatingPanels).length).toBeLessThanOrEqual(store.FLOATING_PANEL_MAX);
    expect(d.floatingPanels.pinned!.w).toBeGreaterThan(1);
    expect(d.shareFloating.x).toBe(-1);
  });

  it("applique la disposition, bloc voix compris", () => {
    const r = mod.parseLayoutFile(fichier());
    if (!("disposition" in r)) throw new Error("rejetée");
    mod.applyLayout(r.disposition);
    const s = store.useLayoutStore.getState();
    expect(s.sidebarSide).toBe("right");
    expect(s.dockZones.right.active).toBe("soundboard");
    expect(s.shareDock).toBe("floating");
    // La voix est dans la zone haute : elle n'est plus dans le menu.
    expect(s.voiceInMenu).toBe(false);
  });
});
