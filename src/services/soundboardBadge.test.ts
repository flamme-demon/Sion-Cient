import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contrat du rond soundboard côté JS.
 *
 * Le rond jaune n'est pas piloté par la lecture réelle mais par une échéance
 * dérivée d'une durée : celle qu'annonce le payload (miroir de
 * `sane_badge_ms` / `BADGE_DEFAULT_MS` côté Rust) et celle que ce client
 * mesure quand il joue le son. Ces tests verrouillent les deux — un repli qui
 * change d'un côté sans l'autre rallumerait le bug « le rond s'éteint avant la
 * fin » (cf. `voice_native.rs`, `soundboard_badge_fallback_matches_js_contract`).
 */

const publishData = vi.fn().mockResolvedValue(undefined);
const extendBadge = vi.fn().mockResolvedValue(undefined);
const playNativeSoundboard = vi.fn().mockResolvedValue(undefined);
const decodeAudioData = vi.fn();

/** Base64 minimal, hissé par `vi.hoisted` : les fabriques `vi.mock` sont
 *  elles-mêmes hissées et ne peuvent pas lire un `const` du fichier. Même
 *  implémentation que `bytesToB64` (concaténation, pas de `spread` — un clip
 *  de 4 s fait 400 000 octets et ferait sauter la pile). */
const { b64encode, b64decode } = vi.hoisted(() => ({
  b64encode: (bytes: Uint8Array) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  b64decode: (raw: string) => Array.from(atob(raw), (c) => c.charCodeAt(0)),
}));

vi.mock("./voiceNativeService", () => ({
  voiceNativePublishData: (...args: unknown[]) => publishData(...args),
  extendVoiceNativeSoundboardBadge: (...args: unknown[]) => extendBadge(...args),
  playVoiceNativeSoundboard: (...args: unknown[]) => playNativeSoundboard(...args),
  bytesToB64: (bytes: Uint8Array) => b64encode(bytes),
}));

vi.mock("./matrixService", () => ({
  getMatrixClient: () => ({
    mxcUrlToHttp: () => "https://media.example.org/sound",
    getAccessToken: () => "token",
  }),
  findSoundboardRoom: async () => "!sb:example.org",
  uploadFile: async () => "mxc://x/y",
}));

vi.mock("./audioContext", () => ({
  getSharedAudioContext: () => ({
    state: "running",
    resume: async () => {},
    decodeAudioData: (...args: unknown[]) => decodeAudioData(...args),
  }),
}));

vi.mock("../stores/useAppStore", () => ({
  useAppStore: { getState: () => appState },
}));

vi.mock("../stores/useSettingsStore", () => ({
  useSettingsStore: { getState: () => settingsState },
}));

let appState: Record<string, unknown>;
let settingsState: Record<string, unknown>;

import {
  broadcastSound,
  handleRemoteBroadcast,
  playSoundLocal,
  resolveBadgeDurationMs,
  SOUNDBOARD_BADGE_DEFAULT_MS,
  SOUNDBOARD_BADGE_MAX_MS,
  SOUNDBOARD_TOPIC,
} from "./soundboardService";

/** Buffer audio factice : 4800 frames à 48 kHz → 100 ms décodées. */
function fakeDecoded(durationSec: number) {
  return {
    length: Math.round(durationSec * 48_000),
    sampleRate: 48_000,
    numberOfChannels: 1,
    duration: durationSec,
    getChannelData: () => new Float32Array(Math.round(durationSec * 48_000)),
  };
}

beforeEach(() => {
  publishData.mockClear();
  extendBadge.mockClear();
  playNativeSoundboard.mockClear();
  decodeAudioData.mockReset();
  appState = { isDeafened: false, connectedVoiceChannel: null };
  settingsState = { soundboardEnabled: true };
  // Node n'implémente pas les object URLs : la résolution mxc → blob en a besoin.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
    blob: async () => new Blob([new Uint8Array(8)]),
  }));
});

afterEach(() => vi.unstubAllGlobals());

function announcedPayload() {
  const [, payloadB64] = publishData.mock.calls.at(-1) as [string, string];
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b64decode(payloadB64)))) as {
    mxc: string;
    emoji: string;
    duration: number;
    gain: number;
  };
}

describe("durée annoncée dans le payload de diffusion", () => {
  it("normalise comme le Rust : 0/absente → repli, aberration → plafond", () => {
    expect(SOUNDBOARD_BADGE_DEFAULT_MS).toBe(3_000);
    expect(SOUNDBOARD_BADGE_MAX_MS).toBe(60_000);
    expect(resolveBadgeDurationMs(null)).toBe(3_000);
    expect(resolveBadgeDurationMs(undefined)).toBe(3_000);
    // Le `?? 3000` d'avant laissait passer 0 : rond de 0 ms, éteint aussitôt peint.
    expect(resolveBadgeDurationMs(0)).toBe(3_000);
    expect(resolveBadgeDurationMs(-5)).toBe(3_000);
    expect(resolveBadgeDurationMs(Number.NaN)).toBe(3_000);
    expect(resolveBadgeDurationMs(7_500.4)).toBe(7_500);
    expect(resolveBadgeDurationMs(SOUNDBOARD_BADGE_MAX_MS + 1)).toBe(SOUNDBOARD_BADGE_MAX_MS);
  });

  it("diffuse la durée mesurée, l'emoji et le gain, sous le topic soundboard", () => {
    broadcastSound("mxc://example.org/music", "🎵", 18_400, 1.5);
    expect(publishData.mock.calls[0][0]).toBe(SOUNDBOARD_TOPIC);
    expect(announcedPayload()).toEqual({
      mxc: "mxc://example.org/music",
      emoji: "🎵",
      duration: 18_400,
      gain: 1.5,
    });
  });

  it("replie sur 🔊 et 3 s quand l'emoji ou la durée manquent", () => {
    broadcastSound("mxc://example.org/s", null, null);
    expect(announcedPayload().emoji).toBe("🔊");
    expect(announcedPayload().duration).toBe(3_000);
    broadcastSound("mxc://example.org/s", "🔔", 0);
    expect(announcedPayload().duration).toBe(3_000);
  });
});

describe("durée réellement mesurée à la lecture", () => {
  it("renvoie la durée du clip décodé (et pas la métadonnée du son)", async () => {
    appState = { isDeafened: false, connectedVoiceChannel: "!v:example.org" };
    decodeAudioData.mockResolvedValue(fakeDecoded(4.2));
    await expect(playSoundLocal("mxc://example.org/music", 1)).resolves.toBe(4_200);
    expect(playNativeSoundboard).toHaveBeenCalledTimes(1);
  });

  it("renvoie null sans lecture (sourdine) : l'appelant garde la métadonnée", async () => {
    appState = { isDeafened: true, connectedVoiceChannel: "!v:example.org" };
    await expect(playSoundLocal("mxc://example.org/music", 1)).resolves.toBeNull();
    expect(playNativeSoundboard).not.toHaveBeenCalled();
  });
});

describe("réarmement du badge chez le récepteur", () => {
  const payload = new TextEncoder().encode(
    JSON.stringify({ mxc: "mxc://example.org/music", emoji: "🎵", duration: 15_000, gain: 1 }),
  );

  it("repousse l'échéance de l'expéditeur sur la durée locale", async () => {
    // Sourdine : le son n'est pas joué ici, mais le badge doit rester calé sur
    // la durée annoncée (comportement inchangé), porté par l'identité reçue.
    appState = { isDeafened: true, connectedVoiceChannel: "!v:example.org" };
    await handleRemoteBroadcast(payload, "@picsou:sionchat.fr:DEVICE");
    expect(extendBadge).toHaveBeenCalledWith("@picsou:sionchat.fr:DEVICE", 15_000, "🎵");
  });

  it("préfère la durée mesurée à la durée annoncée", async () => {
    appState = { isDeafened: false, connectedVoiceChannel: "!v:example.org" };
    decodeAudioData.mockResolvedValue(fakeDecoded(4.2));
    await handleRemoteBroadcast(payload, "@picsou:sionchat.fr:DEVICE");
    expect(extendBadge).toHaveBeenCalledWith("@picsou:sionchat.fr:DEVICE", 4_200, "🎵");
  });

  it("ne touche à rien quand la soundboard est coupée localement", async () => {
    settingsState = { soundboardEnabled: false };
    await handleRemoteBroadcast(payload, "@picsou:sionchat.fr:DEVICE");
    expect(extendBadge).not.toHaveBeenCalled();
    expect(playNativeSoundboard).not.toHaveBeenCalled();
  });

  it("survit à un échec du réarmement sans casser la lecture", async () => {
    appState = { isDeafened: false, connectedVoiceChannel: "!v:example.org" };
    decodeAudioData.mockResolvedValue(fakeDecoded(2));
    extendBadge.mockRejectedValueOnce(new Error("pas de session native"));
    await expect(handleRemoteBroadcast(payload, "@picsou:sionchat.fr:DEVICE")).resolves.toBeUndefined();
    expect(playNativeSoundboard).toHaveBeenCalledTimes(1);
  });
});
