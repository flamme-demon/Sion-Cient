import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const reglages = { memeboardEnabled: true, memeboardVolume: 0.5, ffmpegPath: "" };
const app = { isDeafened: false, connectedVoiceChannel: "!vocal:exemple" as string | null };
vi.mock("../stores/useSettingsStore", () => ({ useSettingsStore: { getState: () => reglages } }));
vi.mock("../stores/useAppStore", () => ({ useAppStore: { getState: () => app } }));
vi.mock("./matrixService", () => ({
  findSoundboardRoom: async () => "!sb:exemple",
  getMatrixClient: () => null,
  mxcToHttp: (mxc: string) => `https://exemple/media/${mxc.slice(6)}`,
  uploadFile: async () => "mxc://exemple/x",
}));
vi.mock("./soundboardService", () => ({ fetchSoundboardMessages: async () => [] }));
vi.mock("./voiceNativeService", () => ({
  bytesToB64: () => "",
  extendVoiceNativeSoundboardBadge: async () => undefined,
  voiceNativePublishData: async () => undefined,
}));
vi.mock("./videoPrepare", () => ({ readMediaBytes: async () => new Uint8Array() }));

const { recevoirMeme, __reinitialiserDelais } = await import("./memeboardService");

const paquet = (donnees: unknown) => new TextEncoder().encode(JSON.stringify(donnees));
const meme = paquet({ mxc: "mxc://exemple/chat", gain: 1.5, duration: 4000 });

describe("réception d'un meme", () => {
  beforeEach(() => {
    invoke.mockClear();
    __reinitialiserDelais();
    reglages.memeboardEnabled = true;
    app.isDeafened = false;
  });

  it("fait surgir le meme avec le volume réglé et le nom de l'expéditeur", async () => {
    await recevoirMeme(meme, "@picsou:exemple", "Picsou");
    expect(invoke).toHaveBeenCalledWith("memeboard_jouer", expect.objectContaining({
      source: "https://exemple/media/exemple/chat",
      gain: 0.75,
      emetteur: "Picsou",
    }));
  });

  it("ne fait rien quand la memeboard est coupée", async () => {
    reglages.memeboardEnabled = false;
    await recevoirMeme(meme, "@picsou:exemple", "Picsou");
    expect(invoke).not.toHaveBeenCalled();
  });

  // Choix du 23/09 : en sourdine, ni image ni son.
  it("ne fait rien en sourdine", async () => {
    app.isDeafened = true;
    await recevoirMeme(meme, "@picsou:exemple", "Picsou");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignore une rafale d'une même personne, pas les autres", async () => {
    await recevoirMeme(meme, "@picsou:exemple", "Picsou");
    await recevoirMeme(meme, "@picsou:exemple", "Picsou");
    await recevoirMeme(meme, "@donald:exemple", "Donald");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("ignore un paquet illisible ou sans média Matrix", async () => {
    await recevoirMeme(new TextEncoder().encode("pas du json"), "@a:exemple", "A");
    await recevoirMeme(paquet({ mxc: "https://ailleurs/x.mp4" }), "@b:exemple", "B");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("borne un gain aberrant envoyé par un pair", async () => {
    await recevoirMeme(paquet({ mxc: "mxc://exemple/chat", gain: 50 }), "@c:exemple", "C");
    expect(invoke).toHaveBeenCalledWith("memeboard_jouer", expect.objectContaining({ gain: 1.5 }));
  });
});
