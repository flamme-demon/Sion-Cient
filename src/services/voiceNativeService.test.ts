import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import {
  getVoiceNativeStatus,
  voiceNativeConnect,
  voiceNativeDisconnect,
  setVoiceNativeMuted,
  setVoiceNativeDeafened,
  onVoiceNativeStatus,
  onVoiceNativeParticipants,
  onVoiceNativeSpeaking,
  onVoiceNativeData,
  voiceNativePublishData,
  toConnectionQuality,
  selectVoiceEngine,
  shouldAutoJoinVoice,
  b64ToBytes,
  bytesToB64,
  getActiveVoiceEngine,
  setActiveVoiceEngine,
  VOICE_NATIVE_STATUS_EVENT,
  VOICE_NATIVE_PARTICIPANTS_EVENT,
  VOICE_NATIVE_SPEAKING_EVENT,
} from "./voiceNativeService";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("voiceNativeService (pont voix native, chantier no-CEF)", () => {
  it("getVoiceNativeStatus relaie le snapshot Rust tel quel", async () => {
    const snapshot = {
      state: "disconnected",
      room_name: "salon",
      muted: false,
      deafened: false,
      identity: null,
    };
    invokeMock.mockResolvedValue(snapshot);
    await expect(getVoiceNativeStatus()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_status", undefined);
  });

  it("connect transmet url/token/roomName (Tauri convertit en room_name côté Rust)", async () => {
    invokeMock.mockResolvedValue({ state: "connecting" });
    await voiceNativeConnect("wss://livekit", "jwt", "salon", "flamme");
    expect(invokeMock).toHaveBeenCalledWith("voice_native_connect", {
      url: "wss://livekit",
      token: "jwt",
      roomName: "salon",
      displayName: "flamme",
    });
  });

  it("disconnect/mute/deafen appellent la bonne commande", async () => {
    invokeMock.mockResolvedValue({ state: "disconnected" });
    await voiceNativeDisconnect();
    expect(invokeMock).toHaveBeenCalledWith("voice_native_disconnect", undefined);

    await setVoiceNativeMuted(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_muted", { muted: true });

    await setVoiceNativeDeafened(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_deafened", { deafened: true });
  });

  it("les erreurs Rust remontent au front (pas d'écrasement silencieux)", async () => {
    invokeMock.mockRejectedValue("URL LiveKit vide");
    await expect(voiceNativeConnect("", "jwt", "salon", "flamme")).rejects.toBe("URL LiveKit vide");
  });

  it("les listeners s'abonnent aux bons événements et relaient le payload", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    listenMock.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(event, cb);
      return Promise.resolve(() => {});
    });

    const onStatus = vi.fn();
    const onParts = vi.fn();
    const onSpeaking = vi.fn();
    await onVoiceNativeStatus(onStatus);
    await onVoiceNativeParticipants(onParts);
    await onVoiceNativeSpeaking(onSpeaking);

    expect(listenMock).toHaveBeenCalledWith(VOICE_NATIVE_STATUS_EVENT, expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith(VOICE_NATIVE_PARTICIPANTS_EVENT, expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith(VOICE_NATIVE_SPEAKING_EVENT, expect.any(Function));

    handlers.get(VOICE_NATIVE_STATUS_EVENT)?.({ payload: { state: "connected" } });
    handlers.get(VOICE_NATIVE_PARTICIPANTS_EVENT)?.({ payload: [{ identity: "@a:b:c" }] });
    handlers.get(VOICE_NATIVE_SPEAKING_EVENT)?.({ payload: { identity: "@a:b:c", speaking: true } });

    expect(onStatus).toHaveBeenCalledWith({ state: "connected" });
    expect(onParts).toHaveBeenCalledWith([{ identity: "@a:b:c" }]);
    expect(onSpeaking).toHaveBeenCalledWith({ identity: "@a:b:c", speaking: true });
  });

  it("toConnectionQuality mappe le vocabulaire LiveKit, inconnu → unknown", () => {
    expect(toConnectionQuality("excellent")).toBe("excellent");
    expect(toConnectionQuality("poor")).toBe("poor");
    expect(toConnectionQuality("n'importe quoi")).toBe("unknown");
  });

  it("shouldAutoJoinVoice ne percute ni session ni connexion en cours", () => {
    expect(shouldAutoJoinVoice("!a", null, null)).toBe(true);
    expect(shouldAutoJoinVoice("!a", "!a", null)).toBe(false);
    expect(shouldAutoJoinVoice("!a", "!b", null)).toBe(false);
    expect(shouldAutoJoinVoice("!a", null, "!a")).toBe(false);
    expect(shouldAutoJoinVoice("", null, null)).toBe(false);
  });

  it("selectVoiceEngine : natif seulement si demandé ET disponible", () => {
    expect(selectVoiceEngine("native", true)).toBe("native");
    expect(selectVoiceEngine("native", false)).toBe("js");
    expect(selectVoiceEngine("js", true)).toBe("js");
    expect(selectVoiceEngine("n'importe quoi", true)).toBe("js");
  });

  it("le tracker de moteur actif pilote les toggles (défaut null = JS)", () => {
    setActiveVoiceEngine(null);
    expect(getActiveVoiceEngine()).toBeNull();
    setActiveVoiceEngine("native");
    expect(getActiveVoiceEngine()).toBe("native");
    setActiveVoiceEngine("js");
    expect(getActiveVoiceEngine()).toBe("js");
    setActiveVoiceEngine(null);
  });

  it("b64ToBytes décode les payloads data-channel natifs", () => {
    // '{"deafened":true}' en base64.
    const bytes = b64ToBytes("eyJkZWFmZW5lZCI6dHJ1ZX0=");
    expect(new TextDecoder().decode(bytes)).toBe('{"deafened":true}');
  });

  it("bytesToB64 encode les payloads sortants (roundtrip soundboard)", () => {
    const payload = new TextEncoder().encode('{"mxc":"mxc://h/snd","emoji":"🔊"}');
    const back = b64ToBytes(bytesToB64(payload));
    expect(new TextDecoder().decode(back)).toBe('{"mxc":"mxc://h/snd","emoji":"🔊"}');
  });

  it("voiceNativePublishData transmet topic + payloadB64 (Tauri convertit en payload_b64)", async () => {
    invokeMock.mockResolvedValue(undefined);
    await voiceNativePublishData("sion-soundboard", "e30=");
    expect(invokeMock).toHaveBeenCalledWith("voice_native_publish_data", {
      topic: "sion-soundboard",
      payloadB64: "e30=",
    });
  });

  it("onVoiceNativeData aplatit topic/payload_b64/sender pour le dispatch front", async () => {
    const calls: Array<(ev: unknown) => void> = [];
    listenMock.mockImplementation((_event: unknown, cb: (ev: unknown) => void) => {
      calls.push(cb);
      return Promise.resolve(() => {});
    });
    const seen: unknown[] = [];
    await onVoiceNativeData((ev) => seen.push(ev));
    expect(listenMock).toHaveBeenCalledWith("voice-native-data", expect.any(Function));
    calls[0]({ payload: { topic: "sion-soundboard", payload_b64: "e30=", sender: "@a:b:c" } });
    expect(seen).toEqual([{ topic: "sion-soundboard", payload_b64: "e30=", sender: "@a:b:c" }]);
  });
});
