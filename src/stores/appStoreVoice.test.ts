import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Le store lit localStorage dès son évaluation (fichiers téléchargés) : sans ce
// stub préalable, le simple import échoue dans l'environnement node.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useAppStore: any;
beforeAll(async () => {
  ({ useAppStore } = await import("./useAppStore"));
});

describe("disconnectVoice", () => {
  beforeEach(() => {
    useAppStore.setState({
      connectedVoiceChannel: "!salon:example.org",
      isMuted: true,
      isDeafened: true,
      isScreenSharing: true,
      e2eeUnhealthy: true,
    });
  });

  /**
   * Une coupure réseau est réparée par LiveKit, qui republie les pistes : le
   * partage reprend et l'indicateur reste juste. Un kick est au contraire une
   * déconnexion définitive suivie d'une nouvelle session, où rien n'est
   * republié — laisser l'indicateur allumé faisait que le premier clic au
   * retour tentait d'arrêter un partage inexistant au lieu d'en démarrer un.
   */
  it("éteint le partage d'écran", () => {
    useAppStore.getState().disconnectVoice();
    expect(useAppStore.getState().isScreenSharing).toBe(false);
  });

  it("remet à zéro l'état vocal complet", () => {
    useAppStore.getState().disconnectVoice();
    const s = useAppStore.getState();
    expect(s.connectedVoiceChannel).toBeNull();
    expect(s.isMuted).toBe(false);
    expect(s.isDeafened).toBe(false);
    expect(s.e2eeUnhealthy).toBe(false);
  });
});
