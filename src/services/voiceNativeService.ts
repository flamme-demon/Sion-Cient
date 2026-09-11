/**
 * Pont front vers la voix native (moteur LiveKit Rust, unique moteur).
 *
 * Ce service expose l'API Tauri de `voice_native.rs` (état + événements).
 * `useLiveKitStore` consomme la même forme `ParticipantInfo` que l'ancien
 * moteur JS supprimé ; il ne reste plus aucun `livekit-client` dans la
 * webview.
 */

import type { ConnectionQuality, ParticipantInfo } from "../types/livekit";
import type { AudioQualityPreset } from "../stores/useSettingsStore";
import { getMatrixClient } from "./matrixService";

export type VoiceNativeState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface VoiceNativeStatus {
  state: VoiceNativeState;
  room_name: string | null;
  muted: boolean;
  deafened: boolean;
  /** Vérité terrain moteur : une publication micro existe-t-elle vraiment ?
   *  Peut contredire `muted` après une désync historique. */
  mic_published: boolean;
  identity: string | null;
}

/** Événement Tauri émis par le Rust à chaque changement d'état natif. */
export const VOICE_NATIVE_STATUS_EVENT = "voice-native-status";
/** Liste des participants natifs (même forme que `ParticipantInfo`). */
export const VOICE_NATIVE_PARTICIPANTS_EVENT = "voice-native-participants";
/** Relais data-channel brut `{ topic, payload_b64, sender }` (sérialisé avec
 *  tag `type: "data_received"`) — dispatché par le front vers les handlers
 *  existants (soundboard, AFK, curseurs…) au fil de la migration. */
export const VOICE_NATIVE_DATA_EVENT = "voice-native-data";
/** La capture locale est tombée après publication : le front doit fermer
 * l'overlay et demander la dépublication immédiatement. */
export const VOICE_NATIVE_LOCAL_SHARE_FAILED_EVENT = "voice-native-local-share-failed";

/** État E2EE d'un participant (`Ok`, `MissingKey`, `DecryptionFailed`…).
 *  Diagnostic décisif en salon chiffré (cf. `E2eeStateChanged` Rust). */
export interface VoiceNativeE2eeState {
  identity: string;
  state: string;
}

export interface VoiceNativeData {
  topic: string | null;
  payload_b64: string;
  sender: string | null;
}

export interface VoiceNativeLocalShareFailed {
  reason: string;
}

/** L'auto-join ne doit jamais percuter un join manuel en cours ni voler une
 *  session active : il ne démarre que si personne n'est en ligne ni en
 *  connexion. Fonction pure (testée). */
export function shouldAutoJoinVoice(
  targetRoomId: string,
  connectedVoiceChannel: string | null,
  connectingVoiceChannel: string | null,
): boolean {
  if (!targetRoomId) return false;
  if (connectedVoiceChannel) return false;
  if (connectingVoiceChannel) return false;
  return true;
}

/** base64 → Uint8Array (payloads data-channel natifs). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array → base64 (envoi data-channel natif). */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Envoie un paquet data-channel sur la session native (soundboard, AFK,
 *  curseurs…). Miroir de `publishData` JS — `reliable: false` pour le
 *  curseur (60 Hz), `true` partout ailleurs. */
export function voiceNativePublishData(topic: string, payloadB64: string, reliable = true): Promise<void> {
  return tauriInvoke<void>("voice_native_publish_data", { topic, payloadB64, reliable });
}

/** Envoie un clip déjà décodé (PCM i16 mono, 48 kHz) au mixeur de rendu
 * WebRTC. Le clip traverse l'IPC une fois puis le callback audio le consomme
 * nativement par tranches de 10 ms. */
export function playVoiceNativeSoundboard(pcmB64: string, gain: number): Promise<void> {
  return tauriInvoke<void>("voice_native_play_soundboard", { pcmB64, gain });
}

/** Coupe / rétablit le SON du partage d'écran d'un expéditeur (miroir du
 *  toggle 🔊 JS). Retourne `true` si une piste `ScreenshareAudio` existe.
 *  Le volume local de cette piste se règle séparément ci-dessous. */
export function setVoiceNativeShareAudioMuted(sender: string, muted: boolean): Promise<boolean> {
  return tauriInvoke<boolean>("voice_native_set_screenshare_audio_muted", { sender, muted });
}

/** État local du son d'un partage (mute + volume), relu au moteur — sert au
 *  front pour se recaler après un reload de la webview : le moteur garde ses
 *  réglages par partageur, pas la mémoire JS. */
export function getVoiceNativeShareAudioState(sender: string): Promise<{ muted: boolean; volume: number }> {
  return tauriInvoke<{ muted: boolean; volume: number }>("voice_native_get_screenshare_audio_state", { sender });
}

export function setVoiceNativeShareAudioVolume(sender: string, volume: number): Promise<boolean> {
  return tauriInvoke<boolean>("voice_native_set_screenshare_audio_volume", { sender, volume });
}

/** Démarre / arrête le partage de NOTRE écran en mode natif (miroir de
 *  `toggleScreenShare` JS). `withAudio=false` (case décochée) = vidéo seule,
 *  les viewers voient "sans son". */
export interface NativeScreenShareResult { audioPublished: boolean }
export function setVoiceNativeScreensharing(
  enabled: boolean,
  options: {
    sourceId?: number;
    withAudio?: boolean;
    resolution?: "720p" | "1080p" | "1440p";
    framerate?: 5 | 15 | 30 | 60;
    /** Codec d'encodage de la piste publiée : `vp9` (défaut, le plus net),
     *  `h264` (VAAPI, CPU quasi nul) ou `vp8` (compatibilité). */
    videoCodec?: "vp9" | "h264" | "vp8";
  } = {},
): Promise<NativeScreenShareResult> {
  return tauriInvoke<NativeScreenShareResult>("voice_native_set_screensharing", {
    enabled,
    sourceId: options.sourceId ?? null,
    withAudio: options.withAudio ?? true,
    resolution: options.resolution ?? "1080p",
    framerate: options.framerate ?? 15,
    videoCodec: options.videoCodec ?? "vp9",
  });
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function isVoiceNativeAvailable(): Promise<boolean> {
  if (!(
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  )) return false;
  try {
    return await tauriInvoke<boolean>("voice_native_available");
  } catch {
    return false;
  }
}

export interface NativeAudioDevice { id: string; name: string; index: number }
export interface NativeAudioDevices {
  recording: NativeAudioDevice[];
  playout: NativeAudioDevice[];
}

export function getVoiceNativeAudioDevices(): Promise<NativeAudioDevices> {
  return tauriInvoke("voice_native_audio_devices");
}

export interface NativeAudioProcessing {
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: boolean;
  mix: number;
}

export function setVoiceNativeAudioProcessing(processing: NativeAudioProcessing): Promise<void> {
  return tauriInvoke("voice_native_set_audio_processing", { processing });
}

export function switchVoiceNativeAudioDevice(kind: "input" | "output", deviceId: string): Promise<void> {
  return tauriInvoke("voice_native_switch_audio_device", { kind, deviceId });
}

export interface NativeAudioLevel { sequence: number; rms: number }

export function startVoiceNativeMicrophoneTest(deviceId: string, owner: string): Promise<void> {
  return tauriInvoke("voice_native_start_microphone_test", { deviceId, owner });
}

export function stopVoiceNativeAudioTest(owner: string): Promise<void> {
  return tauriInvoke("voice_native_stop_audio_test", { owner });
}

export function getVoiceNativeAudioLevel(): Promise<NativeAudioLevel> {
  return tauriInvoke("voice_native_audio_level");
}

export function testVoiceNativeSpeaker(outputDevice: string): Promise<void> {
  return tauriInvoke("voice_native_test_speaker", { outputDevice });
}

export function setVoiceNativeAudioQuality(quality: AudioQualityPreset): Promise<void> {
  return tauriInvoke("voice_native_set_audio_quality", { quality });
}

export function getVoiceNativeStatus(): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_status");
}

export interface VoiceNativeDebug {
  state: VoiceNativeState;
  room_name: string | null;
  muted: boolean;
  deafened: boolean;
  identity: string | null;
  has_engine: boolean;
  engine_connected: boolean;
  recording_devices: { id: string; name: string; index: number }[];
  playout_devices: { id: string; name: string; index: number }[];
  attached_tracks: number;
  participants: number;
  processing: { instances: number; echo_cancellation: boolean; auto_gain_control: boolean;
    webrtc_noise_suppression: boolean; rnnoise: boolean; mix: number } | null;
}

/** Diagnostic instantané (DevTools : `await getVoiceNativeDebug()` après
 *  import du service, ou via les réglages quand le panneau debug arrive). */
export function getVoiceNativeDebug(): Promise<VoiceNativeDebug> {
  return tauriInvoke<VoiceNativeDebug>("voice_native_debug");
}

export function voiceNativeConnect(
  url: string,
  token: string,
  roomName: string,
  displayName: string,
  encrypted = false,
  devices?: { inputDevice: string; outputDevice: string },
  processing?: NativeAudioProcessing,
  audioQuality?: AudioQualityPreset,
): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_connect", {
    url,
    token,
    roomName,
    displayName,
    encrypted,
    ...devices,
    ...(processing ? { processing } : {}),
    ...(audioQuality ? { audioQuality } : {}),
  });
}

export function voiceNativeDisconnect(): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_disconnect");
}

export function setVoiceNativeMuted(muted: boolean): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_set_muted", { muted });
}

export function setVoiceNativeDeafened(deafened: boolean): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_set_deafened", { deafened });
}

/** Pont E2EE : transfère une clé MatrixRTC brute au provider natif.
 *  `keyB64` = 32 octets bruts encodés (cf. `validate_e2ee_key` côté Rust). */
export function setVoiceNativeE2EEKey(
  identity: string,
  keyIndex: number,
  keyB64: string,
): Promise<boolean> {
  return tauriInvoke<boolean>("voice_native_set_e2ee_key", {
    identity,
    keyIndex,
    keyB64,
  });
}

export async function onVoiceNativeStatus(
  cb: (status: VoiceNativeStatus) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeStatus>(VOICE_NATIVE_STATUS_EVENT, (e) => cb(e.payload));
}

export async function onVoiceNativeParticipants(
  cb: (participants: ParticipantInfo[]) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ParticipantInfo[]>(VOICE_NATIVE_PARTICIPANTS_EVENT, (e) => cb(e.payload));
}

export async function onVoiceNativeE2eeState(
  cb: (ev: VoiceNativeE2eeState) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeE2eeState>("voice-native-e2ee-state", (e) => cb(e.payload));
}

export async function onVoiceNativeData(
  cb: (ev: VoiceNativeData) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  // Le Rust émet l'enum avec tag `type: "data_received"` + champs à plat.
  return listen<VoiceNativeData & { type?: string }>(VOICE_NATIVE_DATA_EVENT, (e) =>
    cb({ topic: e.payload.topic ?? null, payload_b64: e.payload.payload_b64, sender: e.payload.sender ?? null }),
  );
}

export async function onVoiceNativeLocalShareFailed(
  cb: (ev: VoiceNativeLocalShareFailed) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeLocalShareFailed>(VOICE_NATIVE_LOCAL_SHARE_FAILED_EVENT, (e) =>
    cb(e.payload),
  );
}

/** `{ sender }` — fin de partage (unsubscribe, leave, fin de piste). */
export const VOICE_NATIVE_FRAME_STOPPED_EVENT = "voice-native-frame-stopped";

export interface VoiceNativeFrameStopped {
  sender: string;
}

export interface VoiceNativeBinaryFrame {
  sender: string;
  width: number;
  height: number;
  jpeg: Uint8Array;
  receivedAt: number;
}

export function parseVoiceNativeVideoPacket(data: ArrayBuffer): VoiceNativeBinaryFrame | null {
  if (data.byteLength < 14) return null;
  const bytes = new Uint8Array(data);
  if (bytes[0] !== 0x53 || bytes[1] !== 0x56 || bytes[2] !== 0x46 || bytes[3] !== 0x31) return null;
  const view = new DataView(data);
  const senderLength = view.getUint16(4, true);
  const jpegOffset = 14 + senderLength;
  if (jpegOffset + 4 > data.byteLength) return null;
  const width = view.getUint32(6, true);
  const height = view.getUint32(10, true);
  if (!width || !height) return null;
  const sender = new TextDecoder().decode(bytes.subarray(14, jpegOffset));
  if (!sender) return null;
  return {
    sender,
    width,
    height,
    jpeg: bytes.slice(jpegOffset),
    receivedAt: performance.now(),
  };
}

/** Ouvre le flux vidéo local binaire. Le WebSocket transporte les JPEG sans
 * JSON/base64 et garde l'IPC Tauri réservé aux petits événements de contrôle. */
export async function connectVoiceNativeVideoStream(
  onFrame: (frame: VoiceNativeBinaryFrame) => void,
): Promise<() => void> {
  const port = await tauriInvoke<number>("voice_native_video_port");
  if (!port) throw new Error("transport vidéo natif indisponible");
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = parseVoiceNativeVideoPacket(event.data);
    if (frame) onFrame(frame);
  };
  return () => {
    socket.onmessage = null;
    socket.close();
  };
}

export async function onVoiceNativeFrameStopped(
  cb: (ev: VoiceNativeFrameStopped) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeFrameStopped>(VOICE_NATIVE_FRAME_STOPPED_EVENT, (e) =>
    cb(e.payload),
  );
}

/** Qualité string du natif → type front (même vocabulaire que LiveKit JS). */
export function toConnectionQuality(q: string): ConnectionQuality {
  switch (q) {
    case "excellent":
    case "good":
    case "poor":
    case "lost":
      return q;
    default:
      return "unknown";
  }
}

/** Matrix user-ID extrait d'une identité LiveKit (`@user:server[:device]`).
 *  Même regex que le filtre du panneau vocal (`ChannelItem`). */
export function matrixUserIdOf(identity: string): string {
  return identity.match(/^(@[^:]+:[^:]+)/)?.[1] ?? identity;
}

/** Pseudo d'affichage d'un participant vocal natif : membre Matrix de la
 *  room (pseudo choisi par l'utilisateur), sinon displayname global, sinon
 *  localpart — jamais l'identité longue (`@user:server:device`). Miroir de
 *  `getParticipantInfo` (panneau vocal) pour les pastilles de curseur.
 *  Synchrone et pas cher (lectures de maps) : appelable à chaque paquet. */
export function resolveNativeDisplayName(identity: string, roomId: string | null): string {
  const userId = matrixUserIdOf(identity);
  try {
    const client = getMatrixClient();
    if (client) {
      if (roomId) {
        const memberName = client.getRoom(roomId)?.getMember?.(userId)?.name;
        if (memberName && !/^@[^:]+:[^:]+(?::.+)?$/.test(memberName)) return memberName;
      }
      const globalName = client.getUser(userId)?.displayName;
      if (globalName && !/^@[^:]+:[^:]+(?::.+)?$/.test(globalName)) return globalName;
    }
  } catch { /* ignore — repli localpart ci-dessous */ }
  return userId.replace("@", "").split(":")[0] || identity;
}

export interface MatrixVoiceUserState {
  id: string;
  muted: boolean;
  deafened: boolean;
}

/** Fusionne l'état voix Matrix (`sion_muted` / `sion_deafened` des events
 *  `call.member`) dans la liste des participants natifs.
 *
 *  Pourquoi : l'état LiveKit (data-channel) ne contient que ce qui a été
 *  reçu depuis le join — un broadcast manqué (join en course) laisse un
 *  sourdine affiché "mute" simple pour toute la session. L'état Matrix est
 *  lui persistant (lisible via /sync à tout moment, sans course) : `main`
 *  le fait déjà circuler dans `voiceUsers` pour la sidebar.
 *
 *  Règle : OU logique (soit source à vrai l'emporte). Les faux négatifs
 *  Matrix sont impossibles par construction (champs absents = false, jamais
 *  de stale-false), et un stale-true se nettoie tout seul (expiration du
 *  membership → filtré de la liste, + heartbeat 30 s des nouveaux builds).
 *  Fonction pure (testée). Retourne la liste d'origine si rien ne change
 *  (référence identique → pas de re-render inutile).
 */
export function overlayMatrixVoiceState(
  participants: ParticipantInfo[],
  voiceUsers: MatrixVoiceUserState[],
): ParticipantInfo[] {
  if (voiceUsers.length === 0) return participants;
  const byUser = new Map(voiceUsers.map((u) => [u.id, u]));
  let touched = false;
  const out = participants.map((p) => {
    const u = byUser.get(matrixUserIdOf(p.identity));
    if (!u) return p;
    const isMuted = p.isMuted || u.muted;
    const isDeafened = p.isDeafened || u.deafened;
    if (isMuted === p.isMuted && isDeafened === p.isDeafened) return p;
    touched = true;
    return { ...p, isMuted, isDeafened };
  });
  return touched ? out : participants;
}
