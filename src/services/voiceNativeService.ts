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

export interface VoiceNativeSpeaking {
  identity: string;
  speaking: boolean;
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
