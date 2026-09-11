import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Le store de layout (persisté) touche localStorage dès l'évaluation : stub
// avant l'import dynamique (même schéma que appStoreVoice.test.ts).
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
});

let mod: typeof import("./layoutPresets");
let useLayoutStore: typeof import("../stores/useLayoutStore").useLayoutStore;
let VH: { DEFAULT: number; MAX: number };

beforeAll(async () => {
  const layout = await import("../stores/useLayoutStore");
  mod = await import("./layoutPresets");
  useLayoutStore = layout.useLayoutStore;
  VH = { DEFAULT: layout.SHARE_VIEW_DEFAULT_VH, MAX: layout.SHARE_VIEW_MAX_VH };
});

/** État de départ : déployée, largeur personnalisée, dock vide, partage en ligne. */
const reset = () => {
  useLayoutStore.setState({
    sidebarMode: "full",
    sidebarWidth: 300,
    shareDock: "inline",
    shareViewMaxVh: VH.DEFAULT,
    dockZones: {
      right: { panels: [], active: null, size: 360 },
      bottom: { panels: [], active: null, size: 240 },
    },
  });
};

const soundboardOpen = () => {
  const z = useLayoutStore.getState().dockZones;
  return z.right.panels.includes("soundboard") || z.bottom.panels.includes("soundboard");
};

describe("presets de layout (§1.4)", () => {
  beforeEach(reset);

  it("« Chat » : sidebar déployée, soundboard ouvert, partage en ligne moyen", () => {
    useLayoutStore.setState({ sidebarMode: "rail" });
    useLayoutStore.getState().openDockPanel("members");

    mod.applyLayoutPreset("chat");

    expect(useLayoutStore.getState().sidebarMode).toBe("full");
    expect(soundboardOpen()).toBe(true);
    // Les autres panneaux sont refermés par le preset.
    expect(useLayoutStore.getState().dockZones.right.panels).not.toContain("members");
    expect(useLayoutStore.getState().shareDock).toBe("inline");
    expect(useLayoutStore.getState().shareViewMaxVh).toBe(VH.DEFAULT);
    // La largeur choisie par l'utilisateur n'est jamais écrasée.
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
  });

  it("« Voix » : rail, dock fermée, partage en grand", () => {
    useLayoutStore.setState({ shareViewMaxVh: 20 });
    useLayoutStore.getState().openDockPanel("soundboard");

    mod.applyLayoutPreset("voice");

    expect(useLayoutStore.getState().sidebarMode).toBe("rail");
    expect(soundboardOpen()).toBe(false);
    expect(useLayoutStore.getState().dockZones.right.panels).toEqual([]);
    expect(useLayoutStore.getState().shareViewMaxVh).toBe(VH.MAX);
    expect(useLayoutStore.getState().shareDock).toBe("inline");
  });

  it("« Streaming » : sidebar masquée, partage flottant, dock fermée", () => {
    useLayoutStore.getState().openDockPanel("soundboard");
    useLayoutStore.getState().openDockPanel("members");

    mod.applyLayoutPreset("stream");

    expect(useLayoutStore.getState().sidebarMode).toBe("hidden");
    expect(useLayoutStore.getState().shareDock).toBe("floating");
    expect(soundboardOpen()).toBe(false);
    expect(useLayoutStore.getState().dockZones.right.panels).toEqual([]);
    expect(useLayoutStore.getState().dockZones.bottom.panels).toEqual([]);
  });
});
