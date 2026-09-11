import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Les trois stores touchés touchent localStorage dès l'évaluation : stub avant
// les imports dynamiques (même schéma que appStoreVoice.test.ts).
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
let useAppStore: typeof import("../stores/useAppStore").useAppStore;
let useTranscriptStore: typeof import("../stores/useTranscriptStore").useTranscriptStore;
let VH: { DEFAULT: number; MAX: number };

beforeAll(async () => {
  const layout = await import("../stores/useLayoutStore");
  mod = await import("./layoutPresets");
  useLayoutStore = layout.useLayoutStore;
  useAppStore = (await import("../stores/useAppStore")).useAppStore;
  useTranscriptStore = (await import("../stores/useTranscriptStore")).useTranscriptStore;
  VH = { DEFAULT: layout.SHARE_VIEW_DEFAULT_VH, MAX: layout.SHARE_VIEW_MAX_VH };
});

/** État de départ : déployée, largeur personnalisée, tout fermé, partage en ligne. */
const reset = () => {
  useLayoutStore.setState({
    sidebarMode: "full",
    sidebarWidth: 300,
    shareDock: "inline",
    shareViewMaxVh: VH.DEFAULT,
  });
  useAppStore.setState({ showMemberPanel: false, showSoundboardPanel: false });
  useTranscriptStore.getState().setPanelOpen(false);
};

describe("presets de layout (§1.4)", () => {
  beforeEach(reset);

  it("« Chat » : sidebar déployée, soundboard ouvert, partage en ligne moyen", () => {
    useLayoutStore.setState({ sidebarMode: "rail" });
    useAppStore.setState({ showMemberPanel: true });

    mod.applyLayoutPreset("chat");

    expect(useLayoutStore.getState().sidebarMode).toBe("full");
    expect(useAppStore.getState().showSoundboardPanel).toBe(true);
    expect(useAppStore.getState().showMemberPanel).toBe(false);
    expect(useTranscriptStore.getState().panelOpen).toBe(false);
    expect(useLayoutStore.getState().shareDock).toBe("inline");
    expect(useLayoutStore.getState().shareViewMaxVh).toBe(VH.DEFAULT);
    // La largeur choisie par l'utilisateur n'est jamais écrasée.
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
  });

  it("« Voix » : rail, dock fermée, partage en grand", () => {
    useLayoutStore.setState({ shareViewMaxVh: 20 });
    useAppStore.setState({ showSoundboardPanel: true });
    useTranscriptStore.getState().setPanelOpen(true);

    mod.applyLayoutPreset("voice");

    expect(useLayoutStore.getState().sidebarMode).toBe("rail");
    expect(useAppStore.getState().showSoundboardPanel).toBe(false);
    expect(useTranscriptStore.getState().panelOpen).toBe(false);
    expect(useLayoutStore.getState().shareViewMaxVh).toBe(VH.MAX);
    expect(useLayoutStore.getState().shareDock).toBe("inline");
  });

  it("« Streaming » : sidebar masquée, partage flottant, dock fermée", () => {
    useAppStore.setState({ showSoundboardPanel: true });

    mod.applyLayoutPreset("stream");

    expect(useLayoutStore.getState().sidebarMode).toBe("hidden");
    expect(useLayoutStore.getState().shareDock).toBe("floating");
    expect(useAppStore.getState().showSoundboardPanel).toBe(false);
    expect(useAppStore.getState().showMemberPanel).toBe(false);
    expect(useTranscriptStore.getState().panelOpen).toBe(false);
  });
});
