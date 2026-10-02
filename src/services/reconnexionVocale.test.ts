import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn() }));

// localStorage simulé (les stores persistés y touchent au chargement).
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

const { useAppStore } = await import("../stores/useAppStore");
const reprise = await import("./reconnexionVocale");

const SALON = "!vocal:sionchat.fr";
let reussir = false;
const rejoindre = vi.fn(async (salon: string) => {
  if (!reussir) throw new Error("serveur injoignable");
  useAppStore.setState({ connectedVoiceChannel: salon });
});
const toggleMute = vi.fn(async () => { useAppStore.setState({ isMuted: !useAppStore.getState().isMuted }); });
const toggleDeafen = vi.fn(async () => { useAppStore.setState({ isDeafened: !useAppStore.getState().isDeafened }); });

describe("reconnexion vocale après une session perdue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reussir = false;
    rejoindre.mockClear();
    toggleMute.mockClear();
    toggleDeafen.mockClear();
    useAppStore.setState({
      connectedVoiceChannel: null, connectingVoiceChannel: null, isMuted: false, isDeafened: false,
      reconnexionVocale: null, toggleMute, toggleDeafen,
    });
    reprise.enregistrerRejoindre(rejoindre);
  });
  afterEach(() => {
    reprise.arreterReconnexion();
    vi.useRealTimers();
  });

  it("retente de plus en plus espacé jusqu'à rejoindre, puis s'arrête", async () => {
    reprise.demarrerReconnexion(SALON, false, false);
    expect(useAppStore.getState().reconnexionVocale).toEqual({ salon: SALON, essai: 0 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rejoindre).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rejoindre).toHaveBeenCalledTimes(1);
    reussir = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(rejoindre).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().reconnexionVocale).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejoindre).toHaveBeenCalledTimes(2);
  });

  it("revient micro coupé et en sourdine si on l'était", async () => {
    reprise.demarrerReconnexion(SALON, true, true);
    reussir = true;
    await vi.advanceTimersByTimeAsync(3_000);
    // Micro coupé AVANT de rejoindre, sourdine une fois dans l'appel.
    expect(toggleMute.mock.invocationCallOrder[0]).toBeLessThan(rejoindre.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().isMuted).toBe(true);
    expect(useAppStore.getState().isDeafened).toBe(true);
  });

  it("s'arrête si l'on abandonne, ou si l'on rejoint un autre salon", async () => {
    reprise.demarrerReconnexion(SALON, false, false);
    reprise.arreterReconnexion();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejoindre).not.toHaveBeenCalled();

    reprise.demarrerReconnexion(SALON, false, false);
    reprise.salonRejointALaMain("!autre:sionchat.fr");
    expect(useAppStore.getState().reconnexionVocale).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejoindre).not.toHaveBeenCalled();
  });

  it("abandonne après 30 minutes", async () => {
    reprise.demarrerReconnexion(SALON, false, false);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const essais = rejoindre.mock.calls.length;
    expect(useAppStore.getState().reconnexionVocale).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rejoindre).toHaveBeenCalledTimes(essais);
  });
});
