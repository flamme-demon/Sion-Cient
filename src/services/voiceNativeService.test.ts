import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const getMatrixClientMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listenMock(...args) }));
vi.mock("./matrixService", () => ({ getMatrixClient: (...args: unknown[]) => getMatrixClientMock(...args) }));

import {
  getVoiceNativeStatus,
  isVoiceNativeAvailable,
  voiceNativeConnect,
  voiceNativeDisconnect,
  setVoiceNativeMuted,
  setVoiceNativeDeafened,
  setVoiceNativeE2EEKey,
  onVoiceNativeStatus,
  onVoiceNativeParticipants,
  onVoiceNativeData,
  onVoiceNativeLocalShareFailed,
  onVoiceNativeFrameStopped,
  setVoiceNativeShareAudioMuted,
  setVoiceNativeShareAudioVolume,
  setVoiceNativeScreensharing,
  parseVoiceNativeVideoPacket,
  overlayMatrixVoiceState,
  matrixUserIdOf,
  resolveNativeDisplayName,
  voiceNativePublishData,
  playVoiceNativeSoundboard,
  getVoiceNativeAudioLevel,
  startVoiceNativeMicrophoneTest,
  stopVoiceNativeAudioTest,
  testVoiceNativeSpeaker,
  setVoiceNativeAudioQuality,
  toConnectionQuality,
  shouldAutoJoinVoice,
  b64ToBytes,
  bytesToB64,
  VOICE_NATIVE_STATUS_EVENT,
  VOICE_NATIVE_PARTICIPANTS_EVENT,
} from "./voiceNativeService";

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  getMatrixClientMock.mockReset();
  getMatrixClientMock.mockReturnValue(null);
});

describe("voiceNativeService (pont voix native, moteur Rust)", () => {
  it("ne confond pas Tauri et un moteur natif réellement compilé", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", undefined);
    await expect(isVoiceNativeAvailable()).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    invokeMock.mockResolvedValue(false);
    await expect(isVoiceNativeAvailable()).resolves.toBe(false);
    invokeMock.mockResolvedValue(true);
    await expect(isVoiceNativeAvailable()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_available", undefined);
    invokeMock.mockRejectedValue(new Error("ancienne version sans commande"));
    await expect(isVoiceNativeAvailable()).resolves.toBe(false);
  });
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
      encrypted: false,
    });
  });

  it("connect propage le flag salon chiffré (E2EE GCM natif)", async () => {
    invokeMock.mockResolvedValue({ state: "connecting" });
    await voiceNativeConnect("wss://livekit", "jwt", "salon", "flamme", true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_connect", {
      url: "wss://livekit",
      token: "jwt",
      roomName: "salon",
      displayName: "flamme",
      encrypted: true,
    });
  });

  it("connect transmet les périphériques, traitements et qualité native", async () => {
    invokeMock.mockResolvedValue({ state: "connecting" });
    const devices = { inputDevice: "mic", outputDevice: "speaker" };
    const processing = { echoCancellation: true, autoGainControl: true, noiseSuppression: true, mix: 0.5 };
    await voiceNativeConnect("wss://livekit", "jwt", "salon", "flamme", false, devices, processing, "musicStereo");
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_connect", expect.objectContaining({
      inputDevice: "mic", outputDevice: "speaker", processing, audioQuality: "musicStereo",
    }));
  });

  it("relaie les tests audio et le changement de qualité au Rust", async () => {
    invokeMock.mockResolvedValue(undefined);
    await startVoiceNativeMicrophoneTest("mic", "settings");
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_start_microphone_test", { deviceId: "mic", owner: "settings" });
    await stopVoiceNativeAudioTest("settings");
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_stop_audio_test", { owner: "settings" });
    invokeMock.mockResolvedValue({ sequence: 7, rms: 0.04 });
    await expect(getVoiceNativeAudioLevel()).resolves.toEqual({ sequence: 7, rms: 0.04 });
    invokeMock.mockResolvedValue(undefined);
    await testVoiceNativeSpeaker("speaker");
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_test_speaker", { outputDevice: "speaker" });
    await setVoiceNativeAudioQuality("voiceHD");
    expect(invokeMock).toHaveBeenLastCalledWith("voice_native_set_audio_quality", { quality: "voiceHD" });
  });

  it("setVoiceNativeE2EEKey transfère clé brute au provider natif", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(setVoiceNativeE2EEKey("@a:srv:D1", 3, "QUJD")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_e2ee_key", {
      identity: "@a:srv:D1",
      keyIndex: 3,
      keyB64: "QUJD",
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
    await onVoiceNativeStatus(onStatus);
    await onVoiceNativeParticipants(onParts);

    expect(listenMock).toHaveBeenCalledWith(VOICE_NATIVE_STATUS_EVENT, expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith(VOICE_NATIVE_PARTICIPANTS_EVENT, expect.any(Function));

    handlers.get(VOICE_NATIVE_STATUS_EVENT)?.({ payload: { state: "connected" } });
    handlers.get(VOICE_NATIVE_PARTICIPANTS_EVENT)?.({ payload: [{ identity: "@a:b:c" }] });

    expect(onStatus).toHaveBeenCalledWith({ state: "connected" });
    expect(onParts).toHaveBeenCalledWith([{ identity: "@a:b:c" }]);
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

  it("voiceNativePublishData transmet topic + payloadB64 + reliable", async () => {
    invokeMock.mockResolvedValue(undefined);
    await voiceNativePublishData("sion-soundboard", "e30=");
    expect(invokeMock).toHaveBeenCalledWith("voice_native_publish_data", {
      topic: "sion-soundboard",
      payloadB64: "e30=",
      reliable: true,
    });
    await voiceNativePublishData("sion-cursor", "e30=", false);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_publish_data", {
      topic: "sion-cursor",
      payloadB64: "e30=",
      reliable: false,
    });
  });

  it("playVoiceNativeSoundboard transmet le PCM et le gain au mixeur", async () => {
    invokeMock.mockResolvedValue(undefined);
    await playVoiceNativeSoundboard("AQD//w==", 0.35);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_play_soundboard", {
      pcmB64: "AQD//w==",
      gain: 0.35,
      localFeedback: false,
    });
  });

  it("playVoiceNativeSoundboard marque les retours d'action, seuls admis en sourdine", async () => {
    invokeMock.mockResolvedValue(undefined);
    await playVoiceNativeSoundboard("AQD//w==", 0.35, true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_play_soundboard", {
      pcmB64: "AQD//w==",
      gain: 0.35,
      localFeedback: true,
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

  it("onVoiceNativeFrameStopped relaie le sender pour masquer le partage", async () => {
    const calls: Array<(ev: unknown) => void> = [];
    listenMock.mockImplementation((_event: unknown, cb: (ev: unknown) => void) => {
      calls.push(cb);
      return Promise.resolve(() => {});
    });
    const seen: unknown[] = [];
    await onVoiceNativeFrameStopped((ev) => seen.push(ev));
    expect(listenMock).toHaveBeenCalledWith("voice-native-frame-stopped", expect.any(Function));
    calls[0]({ payload: { sender: "@p:h" } });
    expect(seen).toEqual([{ sender: "@p:h" }]);
  });

  it("onVoiceNativeLocalShareFailed relaie la panne de capture locale", async () => {
    const calls: Array<(ev: unknown) => void> = [];
    listenMock.mockImplementation((_event: unknown, cb: (ev: unknown) => void) => {
      calls.push(cb);
      return Promise.resolve(() => {});
    });
    const seen: unknown[] = [];
    await onVoiceNativeLocalShareFailed((ev) => seen.push(ev));
    expect(listenMock).toHaveBeenCalledWith("voice-native-local-share-failed", expect.any(Function));
    calls[0]({ payload: { reason: "capture interrompue" } });
    expect(seen).toEqual([{ reason: "capture interrompue" }]);
  });

  it("setVoiceNativeShareAudioMuted transmet sender + muted (retour = piste trouvée ?)", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(setVoiceNativeShareAudioMuted("@p:h", true)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_screenshare_audio_muted", {
      sender: "@p:h",
      muted: true,
    });
    invokeMock.mockResolvedValue(false);
    await expect(setVoiceNativeShareAudioMuted("@p:h", false)).resolves.toBe(false);
  });

  it("setVoiceNativeShareAudioVolume transmet le gain local", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(setVoiceNativeShareAudioVolume("@p:h", 0.35)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_screenshare_audio_volume", {
      sender: "@p:h",
      volume: 0.35,
    });
  });

  it("setVoiceNativeScreensharing transmet enabled (+ sourceId optionnel)", async () => {
    invokeMock.mockResolvedValue({ audioPublished: true });
    await setVoiceNativeScreensharing(true);
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_screensharing", {
      enabled: true,
      sourceId: null,
      withAudio: true,
      resolution: "1080p",
      framerate: 15,
      // Défaut = h264 (encodage matériel) : `auto` est résolu par l'appelant.
      videoCodec: "h264",
    });
    await setVoiceNativeScreensharing(false, {
      sourceId: 42,
      withAudio: false,
      resolution: "1440p",
      framerate: 60,
      videoCodec: "h264",
    });
    expect(invokeMock).toHaveBeenCalledWith("voice_native_set_screensharing", {
      enabled: false,
      sourceId: 42,
      withAudio: false,
      resolution: "1440p",
      framerate: 60,
      videoCodec: "h264",
    });
  });

  it("parseVoiceNativeVideoPacket décode l'en-tête binaire sans base64", () => {
    const sender = new TextEncoder().encode("@picsou:sion");
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const packet = new Uint8Array(14 + sender.length + jpeg.length);
    packet.set([0x53, 0x56, 0x46, 0x31]);
    const view = new DataView(packet.buffer);
    view.setUint16(4, sender.length, true);
    view.setUint32(6, 1920, true);
    view.setUint32(10, 804, true);
    packet.set(sender, 14);
    packet.set(jpeg, 14 + sender.length);
    const parsed = parseVoiceNativeVideoPacket(packet.buffer);
    expect(parsed?.sender).toBe("@picsou:sion");
    expect(parsed?.width).toBe(1920);
    expect(parsed?.height).toBe(804);
    expect(Array.from(parsed?.jpeg ?? [])).toEqual(Array.from(jpeg));
  });

  it("matrixUserIdOf coupe le suffixe device LiveKit", () => {
    expect(matrixUserIdOf("@narkow:example.org:DEVICE2")).toBe("@narkow:example.org");
    expect(matrixUserIdOf("@a:b")).toBe("@a:b");
    expect(matrixUserIdOf("local")).toBe("local");
  });

  it("overlayMatrixVoiceState remonte le sourdine Matrix manqué en LiveKit", () => {
    const mk = (identity: string, isMuted = false, isDeafened = false) => ({
      identity,
      name: identity,
      isSpeaking: false,
      isMuted,
      isDeafened,
      isScreenSharing: false,
      audioLevel: 0,
      connectionQuality: "unknown" as const,
    });
    const participants = [mk("@picsou:example.org:DEVICE1"), mk("@narkow:example.org:DEVICE2")];
    // Picsou : Matrix dit sourdine, LiveKit ne sait pas → badge AFK.
    const merged = overlayMatrixVoiceState(participants, [
      { id: "@picsou:example.org", muted: false, deafened: true },
    ]);
    expect(merged[0].isDeafened).toBe(true);
    expect(merged[0].isMuted).toBe(false);
    // Narkow : absent de Matrix → inchangé (même référence).
    expect(merged[1]).toBe(participants[1]);
    // Autres champs préservés.
    expect(merged[0].identity).toBe("@picsou:example.org:DEVICE1");
  });

  it("overlayMatrixVoiceState ne ment jamais vers false et rend la réf si inchangé", () => {
    const mk = (identity: string, isMuted: boolean, isDeafened: boolean) => ({
      identity,
      name: identity,
      isSpeaking: false,
      isMuted,
      isDeafened,
      isScreenSharing: false,
      audioLevel: 0,
      connectionQuality: "unknown" as const,
    });
    // LiveKit déjà vrai + Matrix faux → reste vrai (OU logique).
    const participants = [mk("@p:h", true, true)];
    const merged = overlayMatrixVoiceState(participants, [{ id: "@p:h", muted: false, deafened: false }]);
    expect(merged).toBe(participants);
    // Liste Matrix vide → même référence (pas de re-render inutile).
    expect(overlayMatrixVoiceState(participants, [])).toBe(participants);
  });

  it("resolveNativeDisplayName préfère le pseudo Matrix au localpart", () => {
    // Sans client : repli localpart, jamais l'identité longue.
    expect(resolveNativeDisplayName("@narkow:example.org:xyz", "!room")).toBe("narkow");
    expect(resolveNativeDisplayName("local", "!room")).toBe("local");
    // Membre de la room : son pseudo.
    getMatrixClientMock.mockReturnValue({
      getRoom: () => ({ getMember: () => ({ name: "Narkow le Magnifique" }) }),
      getUser: () => null,
    });
    expect(resolveNativeDisplayName("@narkow:example.org:xyz", "!room")).toBe("Narkow le Magnifique");
    // Le nom de membre peut être son MXID brut : il ne doit pas masquer le
    // vrai pseudo du profil global.
    getMatrixClientMock.mockReturnValue({
      getRoom: () => ({ getMember: () => ({ name: "@narkow:example.org" }) }),
      getUser: () => ({ displayName: "Narkow" }),
    });
    expect(resolveNativeDisplayName("@narkow:example.org:xyz", "!room")).toBe("Narkow");
    // Pas de membre, displayname global : repli global.
    getMatrixClientMock.mockReturnValue({
      getRoom: () => null,
      getUser: () => ({ displayName: "Narkow" }),
    });
    expect(resolveNativeDisplayName("@narkow:example.org:xyz", "!room")).toBe("Narkow");
    // Rien nulle part : localpart.
    getMatrixClientMock.mockReturnValue({ getRoom: () => null, getUser: () => null });
    expect(resolveNativeDisplayName("@narkow:example.org:xyz", "!room")).toBe("narkow");
  });
});
