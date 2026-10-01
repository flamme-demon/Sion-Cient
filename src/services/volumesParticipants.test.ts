import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

// localStorage simulé (l'environnement de test n'en fournit pas ici).
const stockage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stockage[k] ?? null,
    setItem: (k: string, v: string) => { stockage[k] = v; },
    removeItem: (k: string) => { delete stockage[k]; },
    clear: () => { for (const k of Object.keys(stockage)) delete stockage[k]; },
  },
});

const { volumeEffectif, appliquerTousLesVolumes } = await import("./volumesParticipants");
const { useSettingsStore } = await import("../stores/useSettingsStore");

describe("volume d'écoute par personne", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useSettingsStore.setState({ volumesParticipants: {} });
  });

  it("envoie 0 pour une personne coupée, et borne le volume entre 0 et 200 %", () => {
    expect(volumeEffectif(undefined)).toBe(1);
    expect(volumeEffectif({ volume: 1.5, coupe: false })).toBe(1.5);
    expect(volumeEffectif({ volume: 1.5, coupe: true })).toBe(0);
    expect(volumeEffectif({ volume: 3, coupe: false })).toBe(2);
    expect(volumeEffectif({ volume: -1, coupe: false })).toBe(0);
  });

  it("garde le réglage, l'oublie revenu à 100 %, et le transmet au moteur", async () => {
    const regler = useSettingsStore.getState().setVolumeParticipant;
    regler("@picsou:sionchat.fr", { volume: 0.5, coupe: true });
    expect(useSettingsStore.getState().volumesParticipants["@picsou:sionchat.fr"]).toEqual({ volume: 0.5, coupe: true });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("voice_native_set_participant_volume", { utilisateur: "@picsou:sionchat.fr", volume: 0 }),
    );
    regler("@picsou:sionchat.fr", { volume: 1, coupe: false });
    expect(useSettingsStore.getState().volumesParticipants).toEqual({});
  });

  it("réapplique tous les réglages au démarrage", () => {
    useSettingsStore.setState({ volumesParticipants: { "@a:hs": { volume: 0.3, coupe: false }, "@b:hs": { volume: 1, coupe: true } } });
    appliquerTousLesVolumes();
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_participant_volume", { utilisateur: "@a:hs", volume: 0.3 });
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_participant_volume", { utilisateur: "@b:hs", volume: 0 });
  });
});
