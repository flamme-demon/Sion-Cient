import { describe, it, expect, vi, beforeEach } from "vitest";

// Régression (16/09) : WebKitGTK ne lit pas directement le schéma custom
// `tauri://`, et decodeAudioData ne décodait plus que le premier cue après
// l'ouverture du moteur vocal natif. Les assets doivent passer par une URL
// Blob lisible par HTMLAudioElement, sans utiliser le décodeur Web Audio.

const srcStart = vi.fn();
const oscStart = vi.fn();
const decodeAudioData = vi.fn(async () => ({ duration: 1.49 }) as unknown as AudioBuffer);
const audioPlay = vi.fn(async () => undefined);
const audioSources: string[] = [];

function gainNode() {
  return node({
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
  }) as unknown as GainNode;
}

function node(extra: Record<string, unknown> = {}) {
  return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), ...extra };
}

const fakeCtx = {
  state: "running" as AudioContextState,
  currentTime: 0,
  sampleRate: 44100,
  destination: {},
  resume: vi.fn(async () => undefined),
  decodeAudioData,
  createBufferSource: () =>
    node({
      buffer: null as AudioBuffer | null,
      start: srcStart,
    }) as unknown as AudioBufferSourceNode,
  createGain: () => gainNode(),
  createOscillator: () =>
    node({ type: "sine", frequency: { value: 0 }, start: oscStart }) as unknown as OscillatorNode,
};

vi.mock("./audioContext", () => ({ getSharedAudioContext: () => fakeCtx }));
vi.mock("../stores/useSettingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ voiceChannelSounds: true, voiceSounds: {}, muteSoundsWhenDeafened: false }),
  },
}));
vi.mock("../stores/useAppStore", () => ({ useAppStore: { getState: () => ({ isDeafened: false }) } }));

import { previewCue, resetVoiceCues } from "./voiceChannelSounds";

const fetchMock = vi.fn();

beforeEach(() => {
  srcStart.mockClear();
  oscStart.mockClear();
  decodeAudioData.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", class {
    volume = 1;
    constructor(src: string) { audioSources.push(src); }
    addEventListener() {}
    play = audioPlay;
  });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:sion-cue") });
  audioPlay.mockClear();
  audioSources.length = 0;
  resetVoiceCues();
});

describe("cues embarqués (schéma custom de la webview)", () => {
  it("joue le fichier du bundle via une URL Blob, sans décodeur Web Audio", async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(["mp3"]) });

    previewCue("join");

    await vi.waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toMatch(/join[\w-]*\.mp3$/);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(audioSources).toEqual(["blob:sion-cue"]);
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(srcStart).not.toHaveBeenCalled();
    expect(oscStart).not.toHaveBeenCalled();
  });

  it("retombe sur le timbre synthétisé si l'asset est injouable", async () => {
    fetchMock.mockRejectedValue(new Error("404"));

    previewCue("poke");

    await vi.waitFor(() => expect(oscStart).toHaveBeenCalled());
    expect(srcStart).not.toHaveBeenCalled();
  });
});
