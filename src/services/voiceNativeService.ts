/**
 * Pont front vers la voix native (chantier suppression CEF).
 *
 * Le chemin JS (`livekitService`, `livekit-client` dans la webview) reste le
 * défaut. Ce service expose l'API Tauri de `voice_native.rs` (état +
 * événements) pour brancher progressivement l'UI dessus sans big-bang :
 * `useLiveKitStore` continuera de consommer la même forme `ParticipantInfo`.
 */

import type { ConnectionQuality, ParticipantInfo } from "../types/livekit";

export type VoiceNativeState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface VoiceNativeStatus {
  state: VoiceNativeState;
  room_name: string | null;
  muted: boolean;
  deafened: boolean;
  identity: string | null;
}

/** Événement Tauri émis par le Rust à chaque changement d'état natif. */
export const VOICE_NATIVE_STATUS_EVENT = "voice-native-status";
/** Liste des participants natifs (même forme que `ParticipantInfo`). */
export const VOICE_NATIVE_PARTICIPANTS_EVENT = "voice-native-participants";
/** `{ identity, speaking }` — alimente le rond vert. */
export const VOICE_NATIVE_SPEAKING_EVENT = "voice-native-speaking";
/** Relais data-channel brut `{ topic, payload_b64, sender }` (sérialisé avec
 *  tag `type: "data_received"`) — dispatché par le front vers les handlers
 *  existants (soundboard, AFK, curseurs…) au fil de la migration. */
export const VOICE_NATIVE_DATA_EVENT = "voice-native-data";

export interface VoiceNativeSpeaking {
  identity: string;
  speaking: boolean;
}

export interface VoiceNativeData {
  topic: string | null;
  payload_b64: string;
  sender: string | null;
}

/** Moteur effectivement utilisé par la session en cours (pas la préférence
 *  settings). Piloté par `useVoiceChannel` au join/leave — les toggles
 *  mute/deafen/screen-share s'y réfèrent pour choisir JS vs natif. */
let activeVoiceEngine: "js" | "native" | null = null;

export function getActiveVoiceEngine(): "js" | "native" | null {
  return activeVoiceEngine;
}

export function setActiveVoiceEngine(engine: "js" | "native" | null): void {
  activeVoiceEngine = engine;
}

/** Résout le moteur à utiliser : "native" seulement si demandé dans les
 *  settings ET disponible (Tauri). Sinon "js" — le défaut stable. */
export function selectVoiceEngine(
  preference: string,
  available: boolean,
): "js" | "native" {
  return preference === "native" && available ? "native" : "js";
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

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function isVoiceNativeAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

export function getVoiceNativeStatus(): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_status");
}

export function voiceNativeConnect(
  url: string,
  token: string,
  roomName: string,
): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_connect", {
    url,
    token,
    roomName,
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

export async function onVoiceNativeSpeaking(
  cb: (ev: VoiceNativeSpeaking) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeSpeaking>(VOICE_NATIVE_SPEAKING_EVENT, (e) => cb(e.payload));
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
