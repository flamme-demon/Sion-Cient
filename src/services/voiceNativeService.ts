/**
 * Pont front vers la voix native (chantier suppression CEF).
 *
 * Le chemin JS (`livekitService`, `livekit-client` dans la webview) reste le
 * défaut. Ce service expose l'API Tauri de `voice_native.rs` (état +
 * événements) pour brancher progressivement l'UI dessus sans big-bang :
 * `useLiveKitStore` continuera de consommer la même forme `ParticipantInfo`.
 */

import type { ConnectionQuality, ParticipantInfo } from "../types/livekit";
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

/** Coupe / rétablit le SON du partage d'écran d'un expéditeur (miroir du
 *  toggle 🔊 JS). Retourne `true` si une piste `ScreenshareAudio` existe.
 *  Pas de volume par piste côté natif : le slider reste JS-only. */
export function setVoiceNativeShareAudioMuted(sender: string, muted: boolean): Promise<boolean> {
  return tauriInvoke<boolean>("voice_native_set_screenshare_audio_muted", { sender, muted });
}

/** Démarre / arrête le partage de NOTRE écran en mode natif (miroir de
 *  `toggleScreenShare` JS). `withAudio=false` (case décochée) = vidéo seule,
 *  les viewers voient "sans son". `sourceId` réservé au futur picker. */
export function setVoiceNativeScreensharing(enabled: boolean, sourceId?: number, withAudio = true): Promise<void> {
  return tauriInvoke<void>("voice_native_set_screensharing", { enabled, sourceId: sourceId ?? null, withAudio });
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
): Promise<VoiceNativeStatus> {
  return tauriInvoke<VoiceNativeStatus>("voice_native_connect", {
    url,
    token,
    roomName,
    displayName,
    encrypted,
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

/** JPEG d'une frame de partage d'écran distant (émis ~4 im/s par expéditeur). */
export const VOICE_NATIVE_FRAME_EVENT = "voice-native-frame";
/** `{ sender }` — fin de partage (unsubscribe, leave, fin de piste). */
export const VOICE_NATIVE_FRAME_STOPPED_EVENT = "voice-native-frame-stopped";

export interface VoiceNativeFrame {
  sender: string;
  width: number;
  height: number;
  jpeg_b64: string;
}

export interface VoiceNativeFrameStopped {
  sender: string;
}

export async function onVoiceNativeFrame(
  cb: (ev: VoiceNativeFrame) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeFrame>(VOICE_NATIVE_FRAME_EVENT, (e) => cb(e.payload));
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
        if (memberName) return memberName;
      }
      const globalName = client.getUser(userId)?.displayName;
      if (globalName) return globalName;
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
