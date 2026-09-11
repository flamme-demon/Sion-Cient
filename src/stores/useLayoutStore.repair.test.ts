import { describe, it, expect, beforeAll } from "vitest";

// Régression : un état persisté en version 4 SANS la zone « top » (le bump de
// version était parti avant l'écriture de sa migration, dans deux commits
// séparés) faisait planter la dock au premier rendu — écran blanc. Le `merge`
// du store doit réparer ça à la réhydratation, quelle que soit la version.
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
  // État v4 « cassé » : deux zones seulement.
  store["sion-layout"] = JSON.stringify({
    state: {
      sidebarWidth: 280,
      sidebarMode: "full",
      sidebarSide: "left",
      voiceInMenu: true,
      dockZones: {
        right: { panels: ["members"], active: "members", size: 400 },
        bottom: { panels: [], active: null, size: 240 },
      },
      floatingPanels: {},
      shareViewMaxVh: 50,
      shareDock: "inline",
      shareFloating: { x: -1, y: -1, w: 440, h: 300 },
    },
    version: 4,
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useLayoutStore: any;
beforeAll(async () => {
  useLayoutStore = (await import("./useLayoutStore")).useLayoutStore;
});

describe("useLayoutStore — réparation d'un état persisté incomplet", () => {
  it("recrée la zone manquante (top) en gardant le reste intact", () => {
    const s = useLayoutStore.getState();
    expect(s.dockZones.top).toEqual({ panels: [], active: null, size: 56 });
    // Les zones présentes gardent leurs panneaux et leur taille.
    expect(s.dockZones.right).toEqual({ panels: ["members"], active: "members", size: 400 });
    expect(s.dockZones.bottom.size).toBe(240);
    // Le reste de l'état est intact.
    expect(s.sidebarWidth).toBe(280);
  });

  it("les actions qui touchent le bandeau haut ne plantent plus", () => {
    const s = () => useLayoutStore.getState();
    expect(() => s().setDockZoneSize("top", 200)).not.toThrow();
    expect(s().dockZones.top.size).toBe(200);
    expect(() => s().sendVoiceToDock("top")).not.toThrow();
    expect(s().dockZones.top.panels).toEqual(["voice"]);
  });
});
