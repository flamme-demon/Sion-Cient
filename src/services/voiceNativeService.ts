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
  /** Vérité terrain moteur : une piste de partage d'écran est-elle publiée ?
   *  Le store front repart à zéro à chaque rechargement de webview alors que
   *  le moteur, lui, continue de partager — c'est la seule source fiable. */
  screenshare_published: boolean;
  /** Vérité terrain moteur : le partage local publie-t-il aussi le son ?
   *  L'avertissement « partage sans son » était calculé au démarrage et perdu
   *  à tout rechargement de webview. */
  screenshare_audio_published: boolean;
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
export function playVoiceNativeSoundboard(
  pcmB64: string,
  gain: number,
  /** Retour d'action de l'utilisateur lui-même : joué malgré la sourdine, qui
   *  n'est censée faire taire que les pairs. */
  localFeedback = false,
): Promise<void> {
  return tauriInvoke<void>("voice_native_play_soundboard", { pcmB64, gain, localFeedback });
}

/** Repousse l'échéance du rond soundboard d'un expéditeur (`sender` = son
 *  identité LiveKit) sur la durée réellement mesurée au démarrage de la
 *  lecture locale. Le badge natif est posé à l'arrivée du paquet, donc avant
 *  le téléchargement/décodage : sans ce réarmement, il s'éteint de toute la
 *  latence de démarrage. `emoji` rallume un badge déjà expiré (une échéance
 *  n'est jamais raccourcie). À n'utiliser que lorsqu'on joue vraiment le son. */
export function extendVoiceNativeSoundboardBadge(
  sender: string,
  durationMs: number,
  emoji?: string,
): Promise<void> {
  return tauriInvoke<void>("voice_native_extend_soundboard_badge", { sender, durationMs, emoji });
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
    /** Codec d'encodage de la piste publiée : `auto` est résolu AVANT l'appel
     *  (choix inter-clients) ; `av1`/`h264` = VAAPI (CPU quasi nul),
     *  `vp9`/`vp8` = logiciel. */
    videoCodec?: "av1" | "vp9" | "h264" | "vp8";
  } = {},
): Promise<NativeScreenShareResult> {
  return tauriInvoke<NativeScreenShareResult>("voice_native_set_screensharing", {
    enabled,
    sourceId: options.sourceId ?? null,
    withAudio: options.withAudio ?? true,
    resolution: options.resolution ?? "1080p",
    framerate: options.framerate ?? 15,
    videoCodec: options.videoCodec ?? "h264",
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

/** Son du partage (mute/volume) changé côté moteur — la vue et le PIP natif
 *  sont deux fenêtres sur le même état : sans cet événement, un mute fait
 *  dans le PIP laissait la vue « actif » (constaté le 2026-09-12). */
export const VOICE_NATIVE_SHARE_AUDIO_EVENT = "voice-native-share-audio";

export interface VoiceNativeShareAudio {
  sender: string;
  muted: boolean;
  volume: number;
}

export async function onVoiceNativeShareAudio(
  cb: (ev: VoiceNativeShareAudio) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativeShareAudio>(VOICE_NATIVE_SHARE_AUDIO_EVENT, (e) =>
    cb(e.payload),
  );
}

/** État du PIP natif : la fenêtre peut se fermer elle-même (bouton maison,
 *  clic droit, Échap) — l'état du bouton de la vue doit suivre. */
export const VOICE_NATIVE_PIP_EVENT = "voice-native-pip";

export interface VoiceNativePipState {
  open: boolean;
}

export async function onVoiceNativePip(
  cb: (ev: VoiceNativePipState) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VoiceNativePipState>(VOICE_NATIVE_PIP_EVENT, (e) => cb(e.payload));
}

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

export interface VoiceNativeFrameSize {
  sender: string;
  width: number;
  height: number;
}

interface NativeVideoSurfaceRegistration {
  id: string;
  sender: string;
  element: HTMLCanvasElement;
}

interface NativeVideoSurfaceRect {
  id: string;
  sender: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Zones que la page recouvre : Rust y perce la surface. */
  holes: ZonePage[];
}

const nativeSurfaceRegistrations = new Map<string, NativeVideoSurfaceRegistration>();
const nativeSurfaceSizes = new Map<string, { width: number; height: number }>();
let nativeSurfaceSequence = 0;
let nativeSurfaceTimer: number | null = null;
let nativeSurfaceResizeObserver: ResizeObserver | null = null;
let nativeSurfaceWindowObserversActive = false;
let nativeSurfaceLastPayload = "";
let nativeSurfaceAvailablePromise: Promise<boolean> | null = null;
let nativeSurfaceSizeListenerPromise: Promise<void> | null = null;

/** Le renderer intégré n'est disponible que lorsque Rust a effectivement
 *  installé son GtkOverlay. Le résultat est stable pour la durée de la page. */
export function isNativeVideoSurfaceAvailable(): Promise<boolean> {
  if (!nativeSurfaceAvailablePromise) {
    nativeSurfaceAvailablePromise = tauriInvoke<boolean>("native_video_surface_available")
      .catch(() => false);
  }
  return nativeSurfaceAvailablePromise;
}

function applyNativeFrameSize(sender: string, width: number, height: number) {
  // libwebrtc peut livrer brièvement une frame sentinelle 8×8 pendant une
  // republication. Elle est utile au renderer, mais ne doit jamais modifier
  // le ratio du DOM : en mosaïque la tuile passerait 16:9 → 1:1 → 16:9.
  if (width < 64 || height < 64) return;
  nativeSurfaceSizes.set(sender, { width, height });
  for (const registration of nativeSurfaceRegistrations.values()) {
    if (registration.sender !== sender) continue;
    // La surface native porte les pixels : garder un backing-store canvas à
    // la résolution vidéo ferait malgré tout composer plusieurs Mo par
    // WebKit à chaque frame. Le DOM conserve le ratio et les dimensions
    // source en métadonnées, avec un tampon symbolique de 1×1 seulement.
    registration.element.dataset.nativeVideoWidth = String(width);
    registration.element.dataset.nativeVideoHeight = String(height);
    // Une tuile possède déjà son ratio de mise en page (16:9 ou dimensions
    // contraintes). Seule la vue simple, sans ratio inline, est pilotée par
    // le flux. Le marqueur permet ensuite d'actualiser ce ratio si la source
    // change réellement de résolution.
    if (!registration.element.style.aspectRatio || registration.element.dataset.nativeAspectManaged === "true") {
      registration.element.style.aspectRatio = `${width} / ${height}`;
      registration.element.dataset.nativeAspectManaged = "true";
      // L'élément doit épouser l'image, pas la déborder. Avec seulement
      // `width: 100%` et `aspect-ratio`, une hauteur bridée par `max-height`
      // casse le ratio : la boîte reste pleine largeur et laisse des bandes
      // noires latérales qui ressemblent à la vidéo sans en être — le
      // pointeur y produit des coordonnées hors [0,1] et aucun curseur n'est
      // émis. Borner aussi la largeur par « hauteur maximale × ratio » rend
      // la boîte strictement égale à l'image dans les deux orientations.
      registration.element.style.maxWidth =
        `min(100%, calc(var(--sion-share-max-height, 100vh) * ${width / height}))`;
    }
    registration.element.width = 1;
    registration.element.height = 1;
  }
}

function ensureNativeSurfaceSizeListener(): Promise<void> {
  if (!nativeSurfaceSizeListenerPromise) {
    nativeSurfaceSizeListenerPromise = import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        await listen<VoiceNativeFrameSize>("voice-native-frame-size", (event) => {
          const frame = event.payload;
          applyNativeFrameSize(frame.sender, frame.width, frame.height);
        });
      })
      .catch((error) => {
        nativeSurfaceSizeListenerPromise = null;
        throw error;
      });
  }
  return nativeSurfaceSizeListenerPromise;
}

/** Le rectangle réellement visible d'un élément.
 *
 *  getBoundingClientRect() ignore le rognage des ancêtres. Une surface
 *  native n'en sait rien non plus, et peindrait par-dessus les barres
 *  latérales, les cartes arrondies ou les panneaux masqués : on intersecte
 *  chaque ancêtre qui rogne avant de passer le rectangle à Rust. */
function rectVisible(element: Element): DOMRect {
  let visible = element.getBoundingClientRect();
  // Le rognage s'arrête à l'élément affiché en plein écran.
  //
  // Un élément plein écran sort de la composition normale : ses ancêtres ne
  // le contiennent plus visuellement, même s'ils restent ses parents dans
  // le DOM. Sans cette borne, le lecteur passé en plein écran se voyait
  // intersecté avec la liste des messages qui le contient, et sa surface
  // tombait à 1076×61 au milieu d'un écran de 5120×1440 (21/09).
  const plein = document.fullscreenElement;
  const sousPlein = plein?.contains(element) ?? false;
  // Seuls rognent les ancêtres qui contiennent la boîte au sens CSS. Un
  // élément en position fixe échappe à tous — le mini-lecteur vidéo, la carte
  // de survol du rail (23/09 : rognée à la largeur du rail, elle ne perçait
  // plus la vidéo). Un élément absolu échappe à ceux qui ne sont pas
  // positionnés.
  let position = getComputedStyle(element).position;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (sousPlein && (ancestor === plein || !plein!.contains(ancestor))) break;
    const ancestorStyle = getComputedStyle(ancestor);
    const contient = position === "fixed"
      ? contientLesFixes(ancestorStyle)
      : position === "absolute"
        ? ancestorStyle.position !== "static" || contientLesFixes(ancestorStyle)
        : true;
    if (!contient) continue;
    position = ancestorStyle.position;
    const clipsX = ancestorStyle.overflowX !== "visible";
    const clipsY = ancestorStyle.overflowY !== "visible";
    if (!clipsX && !clipsY) continue;
    const clip = ancestor.getBoundingClientRect();
    if (clipsX) {
      visible = new DOMRect(
        Math.max(visible.left, clip.left),
        visible.top,
        Math.min(visible.right, clip.right) - Math.max(visible.left, clip.left),
        visible.height,
      );
    }
    if (clipsY) {
      visible = new DOMRect(
        visible.left,
        Math.max(visible.top, clip.top),
        visible.width,
        Math.min(visible.bottom, clip.bottom) - Math.max(visible.top, clip.top),
      );
    }
    if (visible.width <= 0 || visible.height <= 0) break;
  }
  return visible;
}

/** Cet ancêtre sert-il de bloc contenant aux éléments en position fixe ?
 *  Une transformation, un filtre ou un confinement le font. */
function contientLesFixes(style: CSSStyleDeclaration): boolean {
  return style.transform !== "none"
    || style.filter !== "none"
    || /paint|layout|strict|content/.test(style.contain)
    || /transform|filter/.test(style.willChange);
}

/** Zone de la page, en pixels CSS de la vue. */
interface ZonePage {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ce qui peut passer devant une vidéo : ce qui sort du flux. Sion n'a ni
 *  portail ni feuille de style qui positionne un calque — tout passe par une
 *  classe Tailwind ou un style en ligne. */
const SELECTEUR_CALQUES =
  '[class*="fixed"], [class*="absolute"], [style*="position: fixed"], [style*="position: absolute"]';

/** Même plafond que Rust ; au-delà, un seul trou : leur enveloppe. */
const TROUS_MAX = 16;

/** Cinq points dans une zone : le centre et quatre points intérieurs,
 *  plutôt que les coins, qui tombent sur les bordures arrondies. */
function echantillons(left: number, top: number, width: number, height: number): Array<[number, number]> {
  return [
    [left + width / 2, top + height / 2],
    [left + width * 0.25, top + height * 0.25],
    [left + width * 0.75, top + height * 0.25],
    [left + width * 0.25, top + height * 0.75],
    [left + width * 0.75, top + height * 0.75],
  ];
}

/** Le calque auquel appartient un élément : son plus proche ancêtre sorti
 *  du flux, à défaut lui-même. */
function calqueDe(element: Element, video: Element): Element {
  for (let e: Element | null = element; e && !e.contains(video); e = e.parentElement) {
    const position = getComputedStyle(e).position;
    if (position === "fixed" || position === "absolute") return e;
  }
  return element;
}

/** Les zones de la vidéo que la page recouvre — menus, panneaux flottants,
 *  boîtes de dialogue —, ou `null` si elle est recouverte tout entière.
 *
 *  La surface native est peinte AU-DESSUS de la WebView : aucun `z-index` ne
 *  peut faire passer un élément devant elle. Rust la perce donc là où la page
 *  doit se voir. Avant, on l'effaçait tout entière dès qu'un de cinq points
 *  tombait sur autre chose que la vidéo ; un panneau posé entre ces points
 *  passait dessous — la soundboard flottante, le 23/09.
 *
 *  Tout ce qui appartient au conteneur de la vidéo (boutons, chevrons,
 *  calques du partage) reste légitime. `elementFromPoint` respecte
 *  `pointer-events: none` : un calque décoratif ne perce jamais rien. */
function trousSur(element: HTMLCanvasElement, left: number, top: number, width: number, height: number): ZonePage[] | null {
  const right = left + width;
  const bottom = top + height;
  const conteneur = element.parentElement;
  const plein = document.fullscreenElement;
  const retenus: Element[] = [];
  const trous: ZonePage[] = [];
  const retenir = (calque: Element) => {
    if (retenus.some((r) => r.contains(calque))) return;
    const r = rectVisible(calque);
    const gauche = Math.floor(Math.max(left, r.left));
    const haut = Math.floor(Math.max(top, r.top));
    const droite = Math.ceil(Math.min(right, r.right));
    const bas = Math.ceil(Math.min(bottom, r.bottom));
    if (droite <= gauche || bas <= haut) return;
    for (let i = retenus.length - 1; i >= 0; i--) {
      if (calque.contains(retenus[i])) {
        retenus.splice(i, 1);
        trous.splice(i, 1);
      }
    }
    retenus.push(calque);
    trous.push({ x: gauche, y: haut, width: droite - gauche, height: bas - haut });
  };
  const etranger = (e: Element) => e !== element && !(conteneur?.contains(e) ?? false);

  for (const calque of document.querySelectorAll(SELECTEUR_CALQUES)) {
    if (!etranger(calque) || calque.contains(element)) continue;
    // Hors de l'élément plein écran : invisible, il est dans la couche du
    // dessous.
    if (plein && !plein.contains(calque)) continue;
    const r = calque.getBoundingClientRect();
    const gauche = Math.max(left, r.left);
    const haut = Math.max(top, r.top);
    const droite = Math.min(right, r.right);
    const bas = Math.min(bottom, r.bottom);
    if (droite <= gauche || bas <= haut) continue;
    // Recouvrir la vidéo ne suffit pas : il faut être DEVANT elle. Un calque
    // dessous serait caché par le fond du canvas, et le trou montrerait ce
    // fond noir au lieu de la vidéo.
    const devant = echantillons(gauche, haut, droite - gauche, bas - haut).some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && calque.contains(hit);
    });
    if (devant) retenir(calque);
  }
  // Filet : ce qui est devant la vidéo sans que le sélecteur l'ait vu.
  for (const [x, y] of echantillons(left, top, width, height)) {
    const hit = document.elementFromPoint(x, y);
    // Rien sous le point (hors viewport) : ne pas conclure à une occultation.
    if (!hit || !etranger(hit) || hit.contains(element)) continue;
    retenir(calqueDe(hit, element));
  }

  if (trous.some((t) => t.x <= left && t.y <= top && t.x + t.width >= right && t.y + t.height >= bottom)) {
    return null;
  }
  if (trous.length > TROUS_MAX) {
    const x = Math.min(...trous.map((t) => t.x));
    const y = Math.min(...trous.map((t) => t.y));
    const width = Math.max(...trous.map((t) => t.x + t.width)) - x;
    const height = Math.max(...trous.map((t) => t.y + t.height)) - y;
    return [{ x, y, width, height }];
  }
  return trous;
}

function nativeSurfaceLoop() {
  nativeSurfaceTimer = null;
  const surfaces: NativeVideoSurfaceRect[] = [];
  for (const registration of nativeSurfaceRegistrations.values()) {
    const element = registration.element;
    const style = getComputedStyle(element);
    if (!element.isConnected || style.display === "none" || style.visibility === "hidden") continue;
    const visible = rectVisible(element);
    const left = Math.max(0, visible.left);
    const top = Math.max(0, visible.top);
    const right = Math.min(window.innerWidth, visible.right);
    const bottom = Math.min(window.innerHeight, visible.bottom);
    const width = Math.round(right - left);
    const height = Math.round(bottom - top);
    if (width < 1 || height < 1) continue;
    let holes: ZonePage[] | null;
    try {
      holes = trousSur(element, left, top, width, height);
    } catch (error) {
      // Une exception ici arrêterait la boucle : la vidéo resterait figée
      // à son dernier rectangle, par-dessus tout ce qui s'ouvrirait ensuite.
      console.warn("[Sion][partage-natif] calcul des trous impossible", error);
      holes = [];
    }
    if (!holes) continue;
    surfaces.push({
      id: registration.id,
      sender: registration.sender,
      x: Math.round(left),
      y: Math.round(top),
      width,
      height,
      holes,
    });
  }
  const payload = JSON.stringify(surfaces);
  if (payload !== nativeSurfaceLastPayload) {
    nativeSurfaceLastPayload = payload;
    void tauriInvoke<boolean>("native_video_surfaces_set", { surfaces }).catch(() => false);
  }
  if (nativeSurfaceRegistrations.size > 0) {
    // Une rAF permanente maintenait WebKit et le GtkOverlay en composition
    // continue, même avec une géométrie inchangée. Quatre contrôles par
    // seconde suffisent pour suivre resize/scroll/transitions sans brûler le
    // thread principal pendant toute la durée d'un partage.
    nativeSurfaceTimer = window.setTimeout(nativeSurfaceLoop, 250);
  }
}

function startNativeSurfaceLoop() {
  if (nativeSurfaceRegistrations.size === 0) return;
  if (nativeSurfaceTimer !== null) window.clearTimeout(nativeSurfaceTimer);
  nativeSurfaceTimer = window.setTimeout(nativeSurfaceLoop, 0);
}

/** Un menu s'ouvre ou se ferme sur un clic, une touche : on reprend la
 *  géométrie à l'image suivante — React a alors fini de le monter — plutôt
 *  que d'attendre le prochain contrôle, un quart de seconde plus tard, avec
 *  la vidéo par-dessus le menu. */
function apresInteraction() {
  requestAnimationFrame(startNativeSurfaceLoop);
}

const INTERACTIONS = ["pointerdown", "click", "contextmenu", "keydown"] as const;

function ensureNativeSurfaceGeometryObservers() {
  if (!nativeSurfaceResizeObserver) {
    nativeSurfaceResizeObserver = new ResizeObserver(startNativeSurfaceLoop);
  }
  if (!nativeSurfaceWindowObserversActive) {
    window.addEventListener("resize", startNativeSurfaceLoop, { passive: true });
    window.addEventListener("scroll", startNativeSurfaceLoop, { passive: true, capture: true });
    for (const type of INTERACTIONS) {
      window.addEventListener(type, apresInteraction, { passive: true, capture: true });
    }
    nativeSurfaceWindowObserversActive = true;
  }
}

/** Enregistre le rectangle DOM qui doit recevoir les pixels natifs. La
 *  géométrie est envoyée à Rust seulement lorsqu'elle change ; aucun pixel ne
 *  traverse l'IPC. */
export async function registerNativeVideoSurface(
  element: HTMLCanvasElement,
  sender: string,
): Promise<() => void> {
  if (!sender || !(await isNativeVideoSurfaceAvailable())) return () => {};
  // Le premier changement de taille peut être émis dès que la surface est
  // publiée à Rust. Installer l'écouteur avant cette publication évite de
  // rater l'unique événement d'un partage dont la résolution reste fixe.
  await ensureNativeSurfaceSizeListener();
  const id = `native-video-${++nativeSurfaceSequence}`;
  // Marque l'élément comme placeholder de surface native : son backing-store
  // ne porte aucune résolution, les calculs de letterbox doivent le savoir.
  element.dataset.nativeSurface = "true";
  nativeSurfaceRegistrations.set(id, { id, sender, element });
  ensureNativeSurfaceGeometryObservers();
  nativeSurfaceResizeObserver?.observe(element);
  console.info(`[Sion][partage-natif] surface DOM enregistrée ${id} pour ${sender}`);
  const knownSize = nativeSurfaceSizes.get(sender);
  if (knownSize) applyNativeFrameSize(sender, knownSize.width, knownSize.height);
  startNativeSurfaceLoop();
  return () => {
    nativeSurfaceResizeObserver?.unobserve(element);
    delete element.dataset.nativeSurface;
    nativeSurfaceRegistrations.delete(id);
    console.info(`[Sion][partage-natif] surface DOM retirée ${id} pour ${sender}`);
    if (nativeSurfaceRegistrations.size === 0) {
      if (nativeSurfaceTimer !== null) window.clearTimeout(nativeSurfaceTimer);
      nativeSurfaceTimer = null;
      nativeSurfaceResizeObserver?.disconnect();
      nativeSurfaceResizeObserver = null;
      if (nativeSurfaceWindowObserversActive) {
        window.removeEventListener("resize", startNativeSurfaceLoop);
        window.removeEventListener("scroll", startNativeSurfaceLoop, true);
        for (const type of INTERACTIONS) window.removeEventListener(type, apresInteraction, true);
        nativeSurfaceWindowObserversActive = false;
      }
      nativeSurfaceLastPayload = "[]";
      void tauriInvoke<boolean>("native_video_surfaces_set", { surfaces: [] }).catch(() => false);
    }
  };
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
  // Reject malformed frames before handing them to ImageBitmap. This keeps a
  // bad/partial packet from repeatedly clearing the canvas and makes the
  // black-screen failure mode observable in logs instead of silent.
  const jpeg = bytes.subarray(jpegOffset);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return null;
  return {
    sender,
    width,
    height,
    jpeg: jpeg.slice(),
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
  let loggedFrame = false;
  let invalidPackets = 0;
  socket.onmessage = (event) => {
    // WebKitGTK has shipped versions that return Blob here even after
    // binaryType="arraybuffer". Accept both forms; otherwise Rust sends valid
    // frames but the canvas stays black with no visible error.
    const data = event.data;
    const consume = (bytes: ArrayBuffer) => {
      const frame = parseVoiceNativeVideoPacket(bytes);
      if (frame) {
        if (!loggedFrame) {
          loggedFrame = true;
          console.info(`[Sion][partage-natif] première frame reçue ${frame.sender} ${frame.width}x${frame.height} ${frame.jpeg.byteLength} o`);
        }
        onFrame(frame);
      } else if (invalidPackets++ < 3) {
        console.warn("[Sion][partage-natif] paquet vidéo invalide", bytes.byteLength);
      }
    };
    if (data instanceof ArrayBuffer) {
      consume(data);
    } else if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") {
      // Cross-realm WebKit objects can fail `instanceof Blob`; feature-test
      // arrayBuffer instead so the binary payload is still consumed.
      void (data as Blob).arrayBuffer().then(consume).catch(() => {
        if (invalidPackets++ < 3) console.warn("[Sion][partage-natif] lecture Blob vidéo impossible");
      });
    } else if (invalidPackets++ < 3) {
      console.warn("[Sion][partage-natif] paquet vidéo non-binaire", typeof data);
    }
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

// ── PIP natif (fenêtre OS au-dessus de toutes les applis) ───────────────────
//
// Complète la carte PIP interne : ici, c'est une vraie fenêtre native winit
// (Rust) qui décode le flux JPEG déjà côté Rust — aucun aller-retour webview.

/** Ouvre la fenêtre PIP native sur ce partage. `false` si refusé. */
export async function pipNativeOpen(sender: string): Promise<boolean> {
  try {
    await tauriInvoke<null>("pip_native_open", { sender });
    return true;
  } catch (err) {
    console.warn("[Sion][PIP] ouverture de la fenêtre native refusée:", err);
    return false;
  }
}

export async function pipNativeClose(): Promise<void> {
  try {
    await tauriInvoke<null>("pip_native_close");
  } catch {
    /* hors Tauri : rien à fermer */
  }
}

export async function pipNativeStatus(): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>("pip_native_status");
  } catch {
    return false;
  }
}

/** État du lecteur vidéo natif, tel que le rapporte Rust. */
export interface EtatLecteurVideo {
  actif: boolean;
  largeur: number;
  hauteur: number;
  duree_ms: number;
  position_ms: number;
  en_pause: boolean;
  /** Faux si le média est muet, ou si la machine n'a pas de sortie utilisable. */
  a_du_son: boolean;
  /** Le film est allé au bout : le bouton devient une flèche de relecture. */
  termine: boolean;
}

/** Identifiant de flux du lecteur dans la surface native. Doit rester
 *  identique à `SENDER_LECTEUR` côté Rust. */
export const SENDER_LECTEUR = "sion:lecteur";

/** Avancement d'un téléchargement du lecteur. `total` vaut 0 quand le serveur
 *  n'annonce pas la taille. */
export interface ProgresVideo {
  source: string;
  recus: number;
  total: number;
}

/**
 * Ramène la vidéo sur le disque avant de l'ouvrir, en signalant l'avancement.
 *
 * Indispensable, et pas seulement confortable : le ffmpeg que nous livrons
 * est lié statiquement à la glibc, sa résolution DNS est cassée, et il
 * s'effondre sur la moindre URL. C'est donc Rust qui va chercher le fichier.
 * L'appel est asynchrone côté Rust pour ne pas figer l'interface pendant le
 * transfert, et le résultat est mis en cache : revoir une vidéo ne la
 * retélécharge pas.
 */
export async function precharcherVideo(
  source: string,
  onProgres?: (p: ProgresVideo) => void,
): Promise<string> {
  if (!onProgres) return tauriInvoke<string>("lecteur_video_precharger", { chemin: source });
  const { listen } = await import("@tauri-apps/api/event");
  const stop = await listen<ProgresVideo>("lecteur-video-progres", (e) => {
    if (e.payload.source === source) onProgres(e.payload);
  });
  try {
    return await tauriInvoke<string>("lecteur_video_precharger", { chemin: source });
  } finally {
    stop();
  }
}

/**
 * Ouvre une vidéo dans le lecteur natif.
 *
 * `source` peut être un chemin local ou une URL : dans ce dernier cas le
 * fichier est d'abord ramené sur le disque. Appeler `precharcherVideo` avant
 * rend la main tout de suite ici, le cache étant déjà chaud. Le décodage se
 * fait hors du moteur web et les images sont peintes dans la surface native —
 * voir docs/lecteur-video-natif.md pour la raison de ce détour.
 */
export async function ouvrirLecteurVideo(source: string): Promise<EtatLecteurVideo> {
  const { useSettingsStore } = await import("../stores/useSettingsStore");
  return tauriInvoke<EtatLecteurVideo>("lecteur_video_ouvrir", {
    chemin: source,
    ffmpegPath: useSettingsStore.getState().ffmpegPath || undefined,
  });
}

/** Arrête la lecture et libère la surface. Sans effet s'il n'y a rien à
 *  arrêter : appelable à chaque fermeture sans condition. */
export function fermerLecteurVideo(): Promise<void> {
  return tauriInvoke<void>("lecteur_video_fermer");
}

/** Position et durée courantes, pour la barre de progression. */
export function etatLecteurVideo(): Promise<EtatLecteurVideo> {
  return tauriInvoke<EtatLecteurVideo>("lecteur_video_etat");
}

/**
 * Reprend le film depuis le début, après la dernière image.
 *
 * À la fin du média, le fil de lecture garde l'image à l'écran mais son
 * ffmpeg est mort : la pause ne sert plus à rien, il faut relancer.
 */
export function rejouerLecteurVideo(): Promise<EtatLecteurVideo> {
  return tauriInvoke<EtatLecteurVideo>("lecteur_video_rejouer");
}

/** Met la lecture en pause, ou la reprend. */
export function pauseLecteurVideo(enPause: boolean): Promise<void> {
  return tauriInvoke<void>("lecteur_video_pause", { enPause });
}

/** Volume, de 0 à 1,5 — au-delà de 1 le son est amplifié. */
export function volumeLecteurVideo(valeur: number): Promise<void> {
  return tauriInvoke<void>("lecteur_video_volume", { valeur });
}

/** Se déplace dans le film. Relance ffmpeg à la position demandée : compter
 *  quelques dixièmes de seconde avant la reprise. */
export function seekLecteurVideo(positionMs: number): Promise<EtatLecteurVideo> {
  return tauriInvoke<EtatLecteurVideo>("lecteur_video_seek", { positionMs: Math.max(0, Math.round(positionMs)) });
}

/** Découpe du bandeau incrusté, en pixels du média. Rust dessine, la page
 *  pose ses zones de clic aux mêmes endroits. */
export interface ZonesLecteur {
  bandeau_y: number;
  bandeau_h: number;
  barre_h: number;
  bouton_x: number;
  bouton_l: number;
  barre_x: number;
  barre_l: number;
  volume_x: number;
  volume_l: number;
  compteur_x: number;
  /** "complet" | "court" | "aucun" */
  compteur: string;
  plein_x: number;
  plein_l: number;
  rangee_y: number;
  taille: number;
  avec_jauge: boolean;
}

/**
 * Découpe du bandeau, et déclaration de l'échelle d'affichage.
 *
 * `echelle` vaut « pixels d'écran par pixel de média ». Rust s'en sert pour
 * dimensionner le bandeau afin qu'il reste lisible APRÈS réduction : sans
 * elle, une vidéo verticale affichée au tiers de sa taille donnait des
 * contrôles minuscules.
 */
export function zonesLecteurVideo(
  largeur: number,
  hauteur: number,
  echelle: number,
): Promise<ZonesLecteur> {
  return tauriInvoke<ZonesLecteur>("lecteur_video_zones", { largeur, hauteur, echelle });
}

/**
 * Affiche d'une vidéo, en JPEG encodé en base64.
 *
 * Le serveur n'en produit pas — interrogé sur la route des vignettes, il
 * renvoie la vidéo entière — donc ffmpeg extrait une image, mise en cache sur
 * disque. À n'appeler que pour une carte réellement visible.
 */
export async function afficheLecteurVideo(source: string): Promise<string> {
  const { useSettingsStore } = await import("../stores/useSettingsStore");
  const b64 = await tauriInvoke<string>("lecteur_video_affiche", {
    chemin: source,
    ffmpegPath: useSettingsStore.getState().ffmpegPath || undefined,
  });
  return `data:image/jpeg;base64,${b64}`;
}

/** Position visée pendant un glissement sur la barre, ou `null` à la fin du
 *  geste. Seule la pastille bouge — le déplacement réel attend le
 *  relâchement. */
export function apercuLecteurVideo(positionMs: number | null): Promise<void> {
  return tauriInvoke<void>("lecteur_video_apercu", {
    positionMs: positionMs === null ? null : Math.max(0, Math.round(positionMs)),
  });
}
