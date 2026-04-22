import {
  Room,
  RoomEvent,
  Track,
  AudioPresets,
  EncryptionEvent,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalParticipant,
  type TrackPublication,
  type Participant,
  type BaseKeyProvider,
  type AudioPreset,
  type LocalTrackPublication,
} from "livekit-client";
import type { ParticipantInfo, ConnectionQuality as SionConnectionQuality } from "../types/livekit";
import { useSettingsStore, type AudioQualityPreset } from "../stores/useSettingsStore";
import { useAppStore } from "../stores/useAppStore";
import * as matrixService from "./matrixService";
import { SpeakingDetector } from "./speakingDetector";


function getAudioPreset(quality: AudioQualityPreset): AudioPreset {
  switch (quality) {
    case "voiceHD": return AudioPresets.music;              // 48kbps mono
    case "musicStereo": return AudioPresets.musicHighQualityStereo; // 128kbps stereo
    default: return AudioPresets.speech;                    // 24kbps mono
  }
}

function isStereoPreset(quality: AudioQualityPreset): boolean {
  return quality === "musicStereo";
}

let currentRoom: Room | null = null;
// Module-owned reference to the E2EE Web Worker so disconnectFromRoom can
// terminate it. LiveKit passes this worker into roomOptions but doesn't
// always terminate it on room.disconnect() (SDK version-dependent); each
// undone connect/disconnect cycle otherwise leaks a module-type worker.
let e2eeWorker: Worker | null = null;
let isCurrentlyDeafened = false;
// AFK/deafened state of remote participants — received via data channel.
// We don't use LiveKit participant metadata because the Matrix RTC focus
// issues JWTs without canUpdateOwnMetadata, so setMetadata silently fails.
const remoteDeafenState = new Map<string, boolean>();
// Per-participant local mute (right-click → "mute user"). Stored by identity
// so the mute survives republish/reconnect: a remote peer reloading creates a
// new track with enabled=true by default, which would silently drop the
// local-only mute. We re-apply on every new subscription and on TrackUnmuted.
const locallyMutedIdentities = new Set<string>();
const AFK_TOPIC = "sion-afk";
// Cursor overlay on screen share — viewers broadcast their normalised cursor
// position in [0, 1] relative to the shared video rect. Stored per-identity
// and auto-expired so stale cursors disappear when a viewer stops moving or
// closes the share view.
const CURSOR_TOPIC = "sion-cursor";
const CURSOR_CLICK_TOPIC = "sion-cursor-click";
const CURSOR_TTL_MS = 2000;

// Diagnostic for cursor receive — lightweight per-peer counter that logs
// the first packet (so we know broadcasts are arriving) and a pulse every
// 200 packets thereafter (~7s of 30Hz traffic). Removed once the overlay
// flow is verified end-to-end.
const cursorRecvCounts = new Map<string, number>();
function cursorRecvDiag(identity: string, localIsSharing: boolean) {
  const next = (cursorRecvCounts.get(identity) || 0) + 1;
  cursorRecvCounts.set(identity, next);
  if (next === 1 || next % 200 === 0) {
    console.log(`[Sion][CursorRecv] ${identity} count=${next} sharing=${localIsSharing}`);
  }
}
/** Expiry for click ripples — the effect itself animates for ~600 ms, so
 *  beyond 800 ms the stored entry is just stale state. */
const CLICK_TTL_MS = 800;
export interface RemoteCursor {
  identity: string;
  name: string;
  x: number; // 0..1 relative to video rect
  y: number; // 0..1
  expiresAt: number;
}
/** One-shot click ripple broadcast by a viewer. */
export interface RemoteCursorClick {
  id: string; // unique per emission so React keys stay stable
  identity: string;
  name: string;
  x: number;
  y: number;
  expiresAt: number;
}
const remoteCursors = new Map<string, RemoteCursor>();
let cursorCallback: ((cursors: RemoteCursor[]) => void) | null = null;
let cursorClickCallback: ((click: RemoteCursorClick) => void) | null = null;
let cursorSweepTimer: ReturnType<typeof setInterval> | null = null;
const afkEncoder = new TextEncoder();
const afkDecoder = new TextDecoder();
// Map of remote audio elements: trackSid -> HTMLAudioElement
const audioElements = new Map<string, HTMLAudioElement>();

// Client-side speaking detection (bypasses SFU smoothing for low-latency
// speaker indicator). Keyed by participant identity.
const speakingDetectors = new Map<string, SpeakingDetector>();
const speakingState = new Map<string, boolean>();
let participantUpdateCallback: (() => void) | null = null;
let pendingTimerCleanup: (() => void) | null = null;

// Soundboard "now playing" state per participant. Last-wins semantics: a new
// trigger replaces the previous emoji and resets the expiry timer. The UI
// reads this via ParticipantInfo.playingSoundEmoji to render a badge on the
// avatar for the sound's duration.
const playingSoundState = new Map<string, { emoji: string; timer: ReturnType<typeof setTimeout> }>();

export function setPlayingSound(identity: string, emoji: string, durationMs: number) {
  const prev = playingSoundState.get(identity);
  if (prev) clearTimeout(prev.timer);
  // Clamp to reasonable bounds — soundboard caps at 20s (SOUNDBOARD_MAX_DURATION_MS)
  // but accept missing/invalid durations by falling back to 3s.
  const ttl = Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, 20_000) : 3000;
  const timer = setTimeout(() => {
    playingSoundState.delete(identity);
    participantUpdateCallback?.();
  }, ttl);
  playingSoundState.set(identity, { emoji, timer });
  participantUpdateCallback?.();
}

function clearAllPlayingSounds() {
  playingSoundState.forEach((s) => clearTimeout(s.timer));
  playingSoundState.clear();
}

function setSpeakingState(identity: string, isSpeaking: boolean) {
  const prev = speakingState.get(identity) || false;
  if (prev === isSpeaking) return;
  speakingState.set(identity, isSpeaking);
  participantUpdateCallback?.();
}

function startSpeakingDetectorForStream(identity: string, stream: MediaStream) {
  // Replace any previous detector for this participant
  speakingDetectors.get(identity)?.stop();
  const detector = new SpeakingDetector(
    stream,
    (isSpeaking) => setSpeakingState(identity, isSpeaking),
  );
  detector.start();
  speakingDetectors.set(identity, detector);
}

function stopSpeakingDetector(identity: string) {
  const detector = speakingDetectors.get(identity);
  if (detector) {
    detector.stop();
    speakingDetectors.delete(identity);
  }
  speakingState.delete(identity);
}

function stopAllSpeakingDetectors() {
  speakingDetectors.forEach((d) => d.stop());
  speakingDetectors.clear();
  speakingState.clear();
}

// ── E2EE MissingKey handling ────────────────────────────────────────────
// When a participant's encryption key hasn't arrived yet (fresh join, slow
// to-device delivery, key rotation drift), LiveKit's decryptor occasionally
// lets ciphertext bytes reach the Opus decoder, which synthesises loud
// uniform noise. Aligning with Element Call we don't trigger full
// session leave/rejoin — that path caused feedback loops (rejoin → peer
// rotates key → new MissingKey → new rejoin).
//
// Instead we apply two targeted mitigations per participant:
//  1. MUTE PROTECTION: after N MissingKey errors from the same peer within
//     a short window, mute that peer's `<audio>` element for a few seconds
//     so the decode noise never reaches the speaker. Extended on each
//     additional error, released cleanly when the window closes.
//  2. ON-DEMAND REEMIT: schedule a `reemitEncryptionKeys()` via the voice
//     channel with exponential backoff, so local decryptor state catches up
//     if the key actually arrived but the handler wasn't wired yet. Replaces
//     the old 15 s × 5 fixed timer that fired blindly.
interface E2EEParticipantState {
  errorCount: number;
  firstErrorAt: number;
  lastErrorAt: number;
  reemitBackoffMs: number;
  reemitTimer: ReturnType<typeof setTimeout> | null;
  protectionTimer: ReturnType<typeof setTimeout> | null;
  protectionActive: boolean;
}
const e2eeParticipantState = new Map<string, E2EEParticipantState>();

// Set by useVoiceChannel after joinRoomSession so livekitService can trigger
// a key re-emit without knowing about the MatrixRTC session directly. Null
// when no voice session is active.
let reemitKeysFn: (() => void) | null = null;
export function setReemitKeysCallback(fn: (() => void) | null) {
  reemitKeysFn = fn;
}

function getOrInitE2EEState(identity: string): E2EEParticipantState {
  let s = e2eeParticipantState.get(identity);
  if (!s) {
    s = {
      errorCount: 0,
      firstErrorAt: 0,
      lastErrorAt: 0,
      reemitBackoffMs: 100,
      reemitTimer: null,
      protectionTimer: null,
      protectionActive: false,
    };
    e2eeParticipantState.set(identity, s);
  }
  return s;
}

function clearE2EEState(identity: string) {
  const s = e2eeParticipantState.get(identity);
  if (!s) return;
  if (s.reemitTimer) clearTimeout(s.reemitTimer);
  if (s.protectionTimer) clearTimeout(s.protectionTimer);
  e2eeParticipantState.delete(identity);
}

/** Mute every audio element tied to `identity` for `durationMs`. Called on
 *  repeated MissingKey to hide decode noise. Idempotent/extending: successive
 *  calls push the unmute deadline further out. */
function muteParticipantForE2EEProtection(identity: string, durationMs: number) {
  const s = getOrInitE2EEState(identity);

  let affected = 0;
  for (const [, el] of audioElements) {
    if (el.dataset.participantId === identity) {
      if (!el.dataset.e2eeProtect) el.dataset.e2eeProtect = "1";
      el.muted = true;
      affected++;
    }
  }
  if (affected > 0 && !s.protectionActive) {
    console.log(`[Sion][E2EE] muting ${identity} audio for ${durationMs} ms (decode protection, ${affected} element(s))`);
  }
  s.protectionActive = affected > 0;

  // Reset the release timer: while errors keep coming we keep extending.
  if (s.protectionTimer) clearTimeout(s.protectionTimer);
  s.protectionTimer = setTimeout(() => {
    s.protectionTimer = null;
    s.protectionActive = false;
    let restored = 0;
    for (const [, el] of audioElements) {
      if (el.dataset.participantId === identity && el.dataset.e2eeProtect) {
        delete el.dataset.e2eeProtect;
        // Respect the user's deafen state — never force-unmute over it.
        el.muted = isCurrentlyDeafened;
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[Sion][E2EE] unmuting ${identity} audio — protection window ended (${restored} element(s))`);
    }
  }, durationMs);
}

/** Schedule a MatrixRTCSession.reemitEncryptionKeys() with exponential
 *  backoff. Used when we see MissingKey errors — if the key landed before
 *  the provider finished wiring, re-emit picks it up without waiting for
 *  the next participant/membership event. */
function scheduleKeyReemit(identity: string) {
  const s = getOrInitE2EEState(identity);
  if (s.reemitTimer) return; // already scheduled — next tick handles it
  if (!reemitKeysFn) return;

  const delay = s.reemitBackoffMs;
  s.reemitTimer = setTimeout(() => {
    s.reemitTimer = null;
    try {
      reemitKeysFn?.();
      console.log(`[Sion][E2EE] re-emit triggered for ${identity} (backoff=${delay}ms)`);
    } catch (err) {
      console.warn(`[Sion][E2EE] reemit failed:`, err);
    }
    // Exponential backoff capped at 5 s — gives the to-device + homeserver
    // stack plenty of time before we give up on this error window.
    s.reemitBackoffMs = Math.min(s.reemitBackoffMs * 2, 5000);
  }, delay);
}

function resetAllE2EEState() {
  for (const [, s] of e2eeParticipantState) {
    if (s.reemitTimer) clearTimeout(s.reemitTimer);
    if (s.protectionTimer) clearTimeout(s.protectionTimer);
  }
  e2eeParticipantState.clear();
  reemitKeysFn = null;
}

function onE2EEError(error: Error, participant?: Participant) {
  if (!error.message?.includes("missing key") && !error.message?.includes("MissingKey")) return;

  // Participant attribution lets us mute the right element and schedule a
  // targeted reemit. Without it we can only log — which older LiveKit
  // versions would occasionally do, hence the guard.
  const participantIdentity = participant?.identity;
  if (!participantIdentity) {
    console.warn(`[Sion][E2EE] MissingKey (no participant attribution): ${error.message}`);
    return;
  }

  const now = performance.now();
  const s = getOrInitE2EEState(participantIdentity);

  // Fresh window if last error > 5 s ago: reset the counter so a transient
  // error from yesterday doesn't inflate today's count.
  if (now - s.lastErrorAt > 5000) {
    s.errorCount = 0;
    s.firstErrorAt = now;
    s.reemitBackoffMs = 100;
  }
  s.errorCount++;
  s.lastErrorAt = now;

  if (s.errorCount === 1 || s.errorCount % 20 === 0) {
    console.warn(`[Sion][E2EE] MissingKey from ${participantIdentity} #${s.errorCount}: ${error.message}`);
  }

  // Threshold chosen empirically: 3 errors in 5 s means the key genuinely
  // hasn't landed (a single stale frame doesn't trip it). 2 s of protection
  // covers most to-device round-trips; extended by each subsequent error.
  const PROTECTION_THRESHOLD = 3;
  const PROTECTION_MS = 2000;
  if (s.errorCount >= PROTECTION_THRESHOLD) {
    muteParticipantForE2EEProtection(participantIdentity, PROTECTION_MS);
  }

  scheduleKeyReemit(participantIdentity);
}

/**
 * Map LiveKit's ConnectionQuality (string enum: "excellent" | "good" | "poor"
 * | "lost" | "unknown") onto our own union type. Defensive: covers SDK
 * additions and unset values.
 */
function mapConnectionQuality(q: unknown): SionConnectionQuality {
  switch (q) {
    case "excellent": return "excellent";
    case "good":      return "good";
    case "poor":      return "poor";
    case "lost":      return "lost";
    default:          return "unknown";
  }
}

// Screen share tracking
export interface ScreenShareInfo {
  track: RemoteTrack;
  participantIdentity: string;
  participantName: string;
  /** True when the sharer's publication also includes a `ScreenShareAudio`
   *  track (system audio). Lets the UI render a 🔊 indicator next to the
   *  share label so viewers know the audio is coming from the stream, not
   *  the sharer's mic. */
  hasAudio: boolean;
}

let screenShareCallback: ((info: ScreenShareInfo | null) => void) | null = null;

// Linux-only: publication of the system-audio track captured via Rust/parec
// and injected into a MediaStreamAudioDestinationNode. Separate from the
// video publication because on Linux the portal can't give us system audio,
// so we publish audio independently and must clean it up on our own.
let systemAudioPublication: LocalTrackPublication | null = null;

/** Resolve a displayable name from a LiveKit participant identity. The
 *  matrix-rtc backend identities are shaped `@user:homeserver:deviceID` —
 *  useless to show as-is. We look up the Matrix room member for the
 *  corresponding user and prefer their display name; otherwise fall back
 *  to the localpart of the Matrix ID (e.g. `flamme` for
 *  `@flamme:sionchat.fr:2EysRqdqUj`). */
function resolveDisplayName(participant: RemoteParticipant | LocalParticipant): string {
  const identity = participant.identity;
  // Extract the Matrix user ID (@user:server) from the rtc-backend identity.
  const mxidMatch = identity.match(/^(@[^:]+:[^:]+)/);
  const mxid = mxidMatch ? mxidMatch[1] : null;
  if (!mxid) return participant.name || identity;

  try {
    const client = matrixService.getMatrixClient();
    if (client) {
      // Active voice room first (the cursor/share happens in voice context);
      // fall back to the Matrix room with the same canonical alias.
      const joinedRoomId = useAppStore.getState().connectedVoiceChannel;
      const matrixRoom = joinedRoomId ? client.getRoom(joinedRoomId) : null;
      const member = matrixRoom?.getMember?.(mxid);
      if (member?.name) return member.name;
      const user = client.getUser?.(mxid);
      if (user?.displayName) return user.displayName;
    }
  } catch { /* fall through to localpart */ }
  const localpart = mxid.slice(1).split(":")[0];
  return localpart || participant.name || identity;
}

function participantHasScreenShareAudio(participant: RemoteParticipant): boolean {
  for (const [, pub] of participant.trackPublications) {
    if (pub.source === Track.Source.ScreenShareAudio && pub.isSubscribed) return true;
  }
  return false;
}

function handleScreenShareSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
    const hasAudio = participantHasScreenShareAudio(participant);
    console.log(`[Sion][LK] screen share subscribed from ${participant.identity} (trackSid=${publication.trackSid}, hasAudio=${hasAudio}) — has callback=${!!screenShareCallback}`);
    screenShareCallback?.({
      track,
      participantIdentity: participant.identity,
      participantName: resolveDisplayName(participant),
      hasAudio,
    });
  } else if (track.kind === Track.Kind.Audio && publication.source === Track.Source.ScreenShareAudio) {
    // ScreenShareAudio subscribed AFTER the video; re-fire callback so the UI
    // picks up the 🔊 indicator.
    const videoSub = Array.from(participant.trackPublications.values())
      .find(p => p.source === Track.Source.ScreenShare && p.track);
    if (videoSub?.track) {
      console.log(`[Sion][LK] screen share audio arrived from ${participant.identity} — refreshing UI`);
      screenShareCallback?.({
        track: videoSub.track as RemoteTrack,
        participantIdentity: participant.identity,
        participantName: resolveDisplayName(participant),
        hasAudio: true,
      });
    }
  }
}

function handleScreenShareUnsubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
    console.log(`[Sion][LK] screen share unsubscribed from ${participant.identity}`);
    screenShareCallback?.(null);
  }
}

export function onScreenShareChange(cb: (info: ScreenShareInfo | null) => void): () => void {
  screenShareCallback = cb;

  // Check if there's already an active screen share
  if (currentRoom) {
    for (const [, participant] of currentRoom.remoteParticipants) {
      for (const [, pub] of participant.trackPublications) {
        if (pub.track && pub.track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare && pub.isSubscribed) {
          cb({
            track: pub.track as RemoteTrack,
            participantIdentity: participant.identity,
            participantName: resolveDisplayName(participant),
            hasAudio: participantHasScreenShareAudio(participant),
          });
          return () => { screenShareCallback = null; };
        }
      }
    }
  }

  return () => { screenShareCallback = null; };
}

// Resume all paused audio elements on first user interaction (fixes autoplay policy)
let autoplayUnlocked = false;
let autoplayListenersAdded = false;
function ensureAutoplayUnlock() {
  if (autoplayUnlocked || autoplayListenersAdded) return;
  autoplayListenersAdded = true;
  const unlock = () => {
    autoplayUnlocked = true;
    autoplayListenersAdded = false;
    audioElements.forEach((el) => {
      if (el.paused) el.play().catch(() => {});
    });
    document.removeEventListener("click", unlock);
    document.removeEventListener("touchstart", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("click", unlock, { once: true });
  document.addEventListener("touchstart", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
}

function attachAudioTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const sid = publication.trackSid;

  // Idempotent on the same sid.
  if (audioElements.has(sid)) return;

  // LiveKit republishes tracks with NEW sids after simulateScenario("full-reconnect")
  // or when a peer reloads. The previous `<audio>` element is tied to a now-dead
  // MediaStream but the DOM element stays attached and can keep buffering, causing
  // layered / looping / extremely-loud playback. Detach any stale element for the
  // *same source* on this participant before attaching the new one. Matching by
  // source is critical: a participant can legitimately have multiple concurrent
  // audio tracks (microphone + screen_share_audio), so we must not wipe their mic
  // element when their screen_share_audio arrives, or vice versa.
  for (const [oldSid, oldEl] of audioElements) {
    if (
      oldEl.dataset.participantId === participant.identity
      && oldEl.dataset.trackSource === publication.source
      && oldSid !== sid
    ) {
      cancelFadeIn(oldEl);
      oldEl.pause();
      oldEl.srcObject = null;
      oldEl.remove();
      audioElements.delete(oldSid);
    }
  }

  // CRITICAL: set muted BEFORE track.attach(). attach() sets srcObject +
  // autoplay=true, which can start playback on the audio thread before a
  // later `el.muted = true` assignment takes effect. If the local user is
  // already deafened when a remote peer publishes (e.g. Narkow joined muted,
  // then unmutes), the default muted=false leaks ~100ms of audio before we
  // mute it. Pre-creating the element lets us set muted before attach.
  const el = document.createElement("audio");
  // Belt-and-suspenders: set the `muted` DOM property, the HTML attribute,
  // and force volume to 0 so every code path the browser's media pipeline
  // checks before producing output is already suppressed when attach() wires
  // in srcObject + autoplay. Missing any one of these has been observed to
  // let a residual audio quantum (~10–20ms) through on some Chromium builds.
  el.muted = isCurrentlyDeafened;
  if (isCurrentlyDeafened) el.setAttribute("muted", "");
  // Always start at 0: a short fade-in (below) protects listeners from a
  // loud noise burst while E2EE key exchange completes. When flamme rejoins
  // a room where picsou is already connected, the Opus frames land over UDP
  // in ~5 ms while the matrix-rtc key exchange travels via to-device and
  // can lag 100–500 ms. During that window LiveKit's decryptor occasionally
  // lets ciphertext bytes reach the Opus decoder, which synthesises random
  // uniform noise at near-full scale — picsou hears a short but extremely
  // loud hiss. The fade hides that window entirely.
  el.volume = 0;
  track.attach(el);
  el.id = `sion-audio-${sid}`;
  el.style.display = "none";
  el.dataset.participantId = participant.identity;
  // Tag the source on the element so future per-source handling (if any) can
  // distinguish mic vs screen-share-audio. Used today only by the stale-
  // element cleanup loop.
  el.dataset.trackSource = publication.source;
  document.body.appendChild(el);
  audioElements.set(sid, el);

  // Fade in to 1.0 over FADE_IN_MS. No-op when deafened (el.muted already
  // kills output regardless of volume). The interval handle is stashed on
  // the element so detachAudioTrack can cancel it if the track dies early.
  if (!isCurrentlyDeafened) {
    const FADE_IN_MS = 500;
    const FADE_STEPS = 20;
    let step = 0;
    const handle = setInterval(() => {
      step++;
      const v = step >= FADE_STEPS ? 1 : step / FADE_STEPS;
      el.volume = v;
      if (step >= FADE_STEPS) {
        clearInterval(handle);
        delete (el as HTMLAudioElement & { _fadeInHandle?: ReturnType<typeof setInterval> })._fadeInHandle;
      }
    }, FADE_IN_MS / FADE_STEPS);
    (el as HTMLAudioElement & { _fadeInHandle?: ReturnType<typeof setInterval> })._fadeInHandle = handle;
  }

  // Re-apply per-participant local mute — the new MediaStreamTrack starts
  // with enabled=true, so a peer that reloads would bypass the local mute
  // until the user re-toggled it manually.
  if (locallyMutedIdentities.has(participant.identity)) {
    track.mediaStreamTrack.enabled = false;
  }

  // Speaking detection wraps the RAW MediaStreamTrack (not captureStream of
  // the rendered element). captureStream ties activity to the element's
  // audible output, which goes silent when the user is deafened (el.muted) —
  // we still want to *see* who is talking to decide whether to undeafen.
  // The SpeakingDetector terminates the graph at audioCtx.destination via a
  // 0-gain node, which is what pumps samples from a remote RTCRtpReceiver
  // track into Web Audio on Chromium. No clone: we wrap the same track in a
  // fresh MediaStream (cloning a remote track is what was observed to fail,
  // not referencing it). Skip for ScreenShareAudio — game/video audio isn't
  // voice, feeding it would falsely mark the participant as "speaking".
  if (publication.source !== Track.Source.ScreenShareAudio) {
    startSpeakingDetectorForStream(
      participant.identity,
      new MediaStream([track.mediaStreamTrack]),
    );
  }

  el.play().catch(() => {
    ensureAutoplayUnlock();
  });
}

/** Stop the fade-in interval if one is still running. Safe to call on any
 *  audio element — no-op if no fade is active. */
function cancelFadeIn(el: HTMLAudioElement) {
  const ext = el as HTMLAudioElement & { _fadeInHandle?: ReturnType<typeof setInterval> };
  if (ext._fadeInHandle) {
    clearInterval(ext._fadeInHandle);
    delete ext._fadeInHandle;
  }
}

function detachAudioTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const sid = publication.trackSid;
  const el = audioElements.get(sid);
  if (el) {
    cancelFadeIn(el);
    track.detach(el);
    el.remove();
    audioElements.delete(sid);
  }
  stopSpeakingDetector(participant.identity);
}

function detachAllAudio() {
  audioElements.forEach((el) => { cancelFadeIn(el); el.remove(); });
  audioElements.clear();
  remoteDeafenState.clear();
}

export async function connectToRoom(
  url: string,
  token: string,
  e2eeKeyProvider?: BaseKeyProvider,
): Promise<Room> {
  const { echoCancellation, autoGainControl, audioQuality, audioInputDevice, audioOutputDevice } = useSettingsStore.getState();
  const audioPreset = getAudioPreset(audioQuality);
  const stereo = isStereoPreset(audioQuality);

  const roomOptions: ConstructorParameters<typeof Room>[0] = {
    audioCaptureDefaults: {
      // Chromium's native noise suppression is forced off — the RNNoise
      // pipeline in denoiseService replaces it and runs both together would
      // double-filter voice.
      noiseSuppression: false,
      echoCancellation,
      autoGainControl,
      channelCount: stereo ? 2 : 1,
      ...(audioInputDevice ? { deviceId: audioInputDevice } : {}),
    },
    audioOutput: {
      ...(audioOutputDevice ? { deviceId: audioOutputDevice } : {}),
    },
    publishDefaults: {
      dtx: false,
      red: false,
      audioPreset,
      stopMicTrackOnMute: false,
    },
  };

  if (e2eeKeyProvider && roomOptions) {
    // Keep the worker reference so `disconnectFromRoom` can terminate it
    // explicitly. LiveKit's E2EEManager *should* call `.terminate()` via
    // `Room.disconnect()`, but across versions the chain has been flaky —
    // without this, each connect/disconnect cycle leaves a dangling
    // module-type Web Worker attached to the old session.
    e2eeWorker = new Worker(
      new URL("livekit-client/e2ee-worker", import.meta.url),
      { type: "module" },
    );
    roomOptions.e2ee = {
      keyProvider: e2eeKeyProvider,
      worker: e2eeWorker,
    };
  }

  const room = new Room(roomOptions);

  // Expose the room on globalThis for in-DevTools introspection. Cheap and
  // only useful when debugging — left in dev + prod since the LiveKit Room
  // already exposes a public surface (no secrets leak via this reference).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__SION_ROOM = room;

  // Attach remote audio tracks for playback
  room.on(RoomEvent.TrackSubscribed, attachAudioTrack);
  room.on(RoomEvent.TrackUnsubscribed, detachAudioTrack);

  // Re-apply per-participant local mute when the remote peer unmutes. The
  // local `mediaStreamTrack.enabled` flag is DOM-local (LiveKit shouldn't
  // touch it), but this is the belt-and-suspenders guarantee that a remote
  // unmute can't silently flip a locally muted peer back to audible.
  room.on(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
    if (publication.kind !== Track.Kind.Audio) return;
    if (!locallyMutedIdentities.has(participant.identity)) return;
    const mst = (publication as RemoteTrackPublication).track?.mediaStreamTrack;
    if (mst) mst.enabled = false;
  });

  // Force-subscribe to every published audio track. In theory LiveKit
  // auto-subscribes on connect, but when a remote participant reloads and
  // republishes their microphone, the new publication sometimes lands with
  // `isSubscribed = false` on our side — the peer is audible to everyone
  // except us. Calling setSubscribed(true) here makes the behaviour
  // deterministic regardless of auto-subscribe state.
  //
  // Additionally: if the subscription stays stuck in the `desired` state for
  // longer than `STUCK_SUBSCRIPTION_MS`, the track is silently lost because
  // its underlying MediaStreamTrack arrived with `readyState === 'ended'`
  // (a LiveKit SDK bug observed post-reload). The only known recovery is a
  // full-reconnect via `simulateScenario('full-reconnect')`, which we
  // trigger automatically as a self-heal — at most once per recovery
  // cooldown to avoid loops.
  const STUCK_SUBSCRIPTION_MS = 3_000;
  const STUCK_RECONNECT_COOLDOWN_MS = 20_000;
  let lastStuckReconnectAt = 0;
  // Track outstanding watchdog timeouts so we can clear them on disconnect —
  // otherwise they hold references to the (now defunct) Room for up to 3s
  // after disconnect.
  const stuckCheckTimers = new Set<ReturnType<typeof setTimeout>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheduleStuckCheck = (publication: any, participant: RemoteParticipant) => {
    const t = setTimeout(async () => {
      stuckCheckTimers.delete(t);
      if (publication.isSubscribed) return;
      // Still desired but not delivered — likely the "ended track" bug.
      if (Date.now() - lastStuckReconnectAt < STUCK_RECONNECT_COOLDOWN_MS) {
        console.warn(`[Sion][LK] audio ${publication.trackSid} from ${participant.identity} stuck at '${publication.subscriptionStatus}' but in reconnect cooldown`);
        return;
      }
      lastStuckReconnectAt = Date.now();
      console.warn(`[Sion][LK] audio ${publication.trackSid} from ${participant.identity} stuck at '${publication.subscriptionStatus}' — triggering full-reconnect`);
      // Wipe all remote audio elements before the reconnect so we don't
      // leave stale DOM audio tags buffering on a dead MediaStream while the
      // new session republishes. Without this, a cascade of full-reconnects
      // across peers compounds into layered / extremely-loud playback.
      for (const [, oldEl] of audioElements) {
        cancelFadeIn(oldEl);
        oldEl.pause();
        oldEl.srcObject = null;
        oldEl.remove();
      }
      audioElements.clear();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (room as any).simulateScenario("full-reconnect");
      } catch (err) {
        console.error("[Sion][LK] full-reconnect failed:", err);
      }
    }, STUCK_SUBSCRIPTION_MS);
    stuckCheckTimers.add(t);
  };
  // Expose so disconnectFromRoom can clear them — assigned via a module-level
  // ref to avoid closing over the Room from outside this scope.
  pendingTimerCleanup = () => {
    for (const t of stuckCheckTimers) clearTimeout(t);
    stuckCheckTimers.clear();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forceSubscribeAudio = (publication: any, participant: RemoteParticipant) => {
    if (publication?.kind !== Track.Kind.Audio) return;
    if (publication.isSubscribed) {
      return;
    }
    try {
      publication.setSubscribed(true);
    } catch (err) {
      console.warn("[Sion][LK] force-subscribe failed:", err);
    }
    scheduleStuckCheck(publication, participant);
  };
  room.on(RoomEvent.TrackPublished, forceSubscribeAudio);

  // Screen share publications suffer from the same unreliable auto-subscribe
  // behaviour as audio — seen most often after the sharer restarts a share
  // or reloads. Without this, `handleScreenShareSubscribed` never fires and
  // viewers never see the share (no log either, because TrackSubscribed is
  // the only path to `screenShareCallback`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forceSubscribeScreenShare = (publication: any, participant: RemoteParticipant) => {
    if (publication?.kind !== Track.Kind.Video) return;
    if (publication?.source !== Track.Source.ScreenShare) return;
    if (publication.isSubscribed) return;
    console.log(`[Sion][LK] force-subscribing screen share from ${participant.identity} (trackSid=${publication.trackSid})`);
    try {
      publication.setSubscribed(true);
    } catch (err) {
      console.warn("[Sion][LK] screen-share force-subscribe failed:", err);
    }
  };
  room.on(RoomEvent.TrackPublished, forceSubscribeScreenShare);

  // When a participant reconnects (e.g. Ctrl+R), LiveKit may skip their new
  // tracks with "already ended". Clean up stale audio on disconnect, then
  // re-attach tracks on reconnect after a short delay.
  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    // Clean up all audio elements for this participant
    for (const [, pub] of participant.trackPublications) {
      if (pub.track && pub.track.kind === Track.Kind.Audio) {
        detachAudioTrack(pub.track as RemoteTrack, pub as RemoteTrackPublication, participant);
      }
    }
  });
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    // After a short delay, attach any audio tracks the SDK may have skipped
    setTimeout(() => {
      for (const [, pub] of participant.trackPublications) {
        if (pub.kind !== Track.Kind.Audio) continue;
        if (!pub.isSubscribed) {
          // Same republish-after-reload fallback applied to participants
          // that were already in the room when we connected.
          forceSubscribeAudio(pub, participant);
          continue;
        }
        if (pub.track) {
          attachAudioTrack(pub.track as RemoteTrack, pub as RemoteTrackPublication, participant);
        }
      }
      // Re-emit our AFK/deafened state so the newcomer has our current
      // status. The AFK channel is event-based (publishData, not
      // participant metadata — the JWT lacks canUpdateOwnMetadata), so a
      // peer that reloaded after our initial broadcast would otherwise show
      // us as merely muted. This fires once per ParticipantConnected; the
      // 500 ms matches the audio-subscribe grace so the reliable data
      // channel is up when we publish. Re-broadcasting to everyone instead
      // of targeting the newcomer keeps the call simple and is idempotent
      // for the peers that already knew our state.
      broadcastAfk();
    }, 500);
  });

  // Screen share tracks
  room.on(RoomEvent.TrackSubscribed, handleScreenShareSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, handleScreenShareUnsubscribed);

  // Connection state — propagated to useLiveKitStore for the global banner
  room.on(RoomEvent.Reconnecting, () => {
    import("../stores/useLiveKitStore").then(({ useLiveKitStore }) => {
      useLiveKitStore.getState().setConnectionState("reconnecting");
    });
  });
  room.on(RoomEvent.Reconnected, () => {
    import("../stores/useLiveKitStore").then(({ useLiveKitStore }) => {
      useLiveKitStore.getState().setConnectionState("connected");
    });
  });
  room.on(RoomEvent.Disconnected, () => {
    import("../stores/useLiveKitStore").then(({ useLiveKitStore }) => {
      useLiveKitStore.getState().setConnectionState("disconnected");
    });
  });

  await room.connect(url, token);
  currentRoom = room;
  // Expose for in-DevTools debugging — re-set on every reconnect since
  // `connectToRoom` may be called multiple times during a session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__SION_ROOM = room;

  if (e2eeKeyProvider) {
    await room.setE2EEEnabled(true);
    room.on(EncryptionEvent.EncryptionError, onE2EEError);
  }

  // Attach audio tracks from participants already in the room. For any
  // publication that LiveKit did NOT auto-subscribe to (observed after a
  // peer has reloaded and republished), explicitly request subscription —
  // TrackSubscribed will fire once the stream arrives, which in turn
  // attaches the audio element via our main handler.
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      if (pub.kind === Track.Kind.Audio) {
        if (!pub.isSubscribed) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (pub as any).setSubscribed(true);
          } catch (err) {
            console.warn("[Sion][LK] force-subscribe (existing) failed:", err);
          }
          return;
        }
        if (pub.track) {
          attachAudioTrack(pub.track as RemoteTrack, pub as RemoteTrackPublication, participant);
        }
      } else if (pub.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
        // Already-in-progress screen share that flammemob is joining: force
        // subscribe just like audio, and let handleScreenShareSubscribed pick
        // it up via the TrackSubscribed event.
        if (!pub.isSubscribed) {
          console.log(`[Sion][LK] force-subscribing existing screen share from ${participant.identity}`);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (pub as any).setSubscribed(true);
          } catch (err) {
            console.warn("[Sion][LK] screen-share force-subscribe (existing) failed:", err);
          }
        } else if (pub.track) {
          // Rare race: the publication is already subscribed but TrackSubscribed
          // fired before our handler attached. Surface it to the UI directly.
          console.log(`[Sion][LK] screen share already subscribed from ${participant.identity} — surfacing directly`);
          handleScreenShareSubscribed(pub.track as RemoteTrack, pub as RemoteTrackPublication, participant);
        }
      }
    });
  });

  // Activer le microphone par défaut (comme TeamSpeak)
  try {
    await room.localParticipant.setMicrophoneEnabled(true);
    logAudioProcessingSettings("connect");
  } catch (err) {
    console.warn("[Sion] Impossible d'activer le microphone automatiquement:", err);
  }

  // Local participant speaking detection — re-attach the detector whenever
  // the local mic publication changes (mute/unmute, device switch, etc.).
  const refreshLocalDetector = () => {
    const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mst = micPub?.track?.mediaStreamTrack;
    if (mst) {
      startSpeakingDetectorForStream(room.localParticipant.identity, new MediaStream([mst]));
    } else {
      stopSpeakingDetector(room.localParticipant.identity);
    }
  };
  room.on(RoomEvent.LocalTrackPublished, refreshLocalDetector);
  room.on(RoomEvent.LocalTrackUnpublished, refreshLocalDetector);
  room.on(RoomEvent.TrackMuted, refreshLocalDetector);
  room.on(RoomEvent.TrackUnmuted, refreshLocalDetector);
  refreshLocalDetector();

  // When we unpublish our own screen share (native browser "Stop sharing"
  // button, tab close, monitor unplug, …) the overlay window would
  // otherwise linger on the sharer's display. Tie its lifecycle here so
  // every tear-down path closes the overlay, not just `toggleScreenShare`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onLocalScreenShareUnpub = (pub: any) => {
    if (pub?.source === Track.Source.ScreenShare) {
      import("./cursorOverlayService").then(({ closeCursorOverlay }) => closeCursorOverlay()).catch(() => {});
    }
  };
  room.on(RoomEvent.LocalTrackUnpublished, onLocalScreenShareUnpub);

  return room;
}

export function getCurrentRoom(): Room | null {
  // Side-effect: keep `globalThis.__SION_ROOM` fresh whenever anyone asks
  // for the room, so DevTools introspection works even if the user joined
  // the room before the expose code was loaded by HMR.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (currentRoom) (globalThis as any).__SION_ROOM = currentRoom;
  return currentRoom;
}

export function muteRemoteParticipant(participantIdentity: string, mute: boolean): boolean {
  if (!currentRoom) return false;
  const participant = currentRoom.remoteParticipants.get(participantIdentity);
  if (!participant) return false;
  if (mute) locallyMutedIdentities.add(participantIdentity);
  else locallyMutedIdentities.delete(participantIdentity);
  // Mute/unmute all audio tracks of the participant (local perception only)
  for (const pub of participant.audioTrackPublications.values()) {
    if (pub.track) {
      pub.track.mediaStreamTrack.enabled = !mute;
    }
  }
  return true;
}

export async function disconnectFromRoom() {
  if (currentRoom) {
    currentRoom.off(RoomEvent.TrackSubscribed, attachAudioTrack);
    currentRoom.off(RoomEvent.TrackUnsubscribed, detachAudioTrack);
    currentRoom.off(RoomEvent.TrackSubscribed, handleScreenShareSubscribed);
    currentRoom.off(RoomEvent.TrackUnsubscribed, handleScreenShareUnsubscribed);
    currentRoom.off(EncryptionEvent.EncryptionError, onE2EEError);
    screenShareCallback?.(null);
    screenShareCallback = null;
    resetAllE2EEState();
    pendingTimerCleanup?.();
    pendingTimerCleanup = null;
    stopAllSpeakingDetectors();
    detachAllAudio();
    locallyMutedIdentities.clear();
    clearAllPlayingSounds();
    remoteCursors.clear();
    if (cursorSweepTimer) { clearInterval(cursorSweepTimer); cursorSweepTimer = null; }
    cursorCallback?.([]);
    await currentRoom.disconnect();
    currentRoom = null;
    // Belt-and-suspenders: LiveKit's E2EEManager may or may not terminate
    // the worker itself depending on SDK version. Terminate explicitly to
    // reclaim the thread on every cycle.
    if (e2eeWorker) {
      try { e2eeWorker.terminate(); } catch { /* ignore */ }
      e2eeWorker = null;
    }
    // Defensive: a sudden disconnect (kick, network loss) skips toggleScreenShare.
    // Close the overlay window so it doesn't linger on the sharer's screen.
    import("./cursorOverlayService").then(({ closeCursorOverlay }) => closeCursorOverlay()).catch(() => {});
  }
}

export async function toggleMicrophone(enabled: boolean) {
  if (!currentRoom) return;
  const micPub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (micPub?.track) {
    // mute/unmute keeps the track alive (works in Android background)
    if (enabled) {
      await micPub.track.unmute();
    } else {
      await micPub.track.mute();
    }
  } else if (enabled) {
    // No track yet — create one (only works in foreground)
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
  }
}

export async function switchAudioInput(deviceId: string) {
  if (!currentRoom) return;
  // The CefAudioShim transparently handles PulseAudio device IDs in
  // getUserMedia, so LiveKit's standard switchActiveDevice just works.
  await currentRoom.switchActiveDevice("audioinput", deviceId);

  // Refresh the local speaking detector
  const micPub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  const mst = micPub?.track?.mediaStreamTrack;
  if (mst) {
    startSpeakingDetectorForStream(currentRoom.localParticipant.identity, new MediaStream([mst]));
  }
}

export async function switchAudioOutput(deviceId: string) {
  if (!currentRoom) return;
  await currentRoom.switchActiveDevice("audiooutput", deviceId);

  // Update sinkId on all manually-created audio elements
  for (const el of audioElements.values()) {
    if ("setSinkId" in el) {
      try {
        await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
      } catch {
        // CefAudioShim handles PulseAudio IDs in setSinkId override
      }
    }
  }
}

export function setDeafened(deafened: boolean) {
  isCurrentlyDeafened = deafened;
  // Mute/unmute all existing audio elements. Mirror the attach-time
  // suppression (property + attribute + volume) so runtime toggles match
  // the guarantees applied at track-attach time.
  audioElements.forEach((el) => {
    el.muted = deafened;
    if (deafened) el.setAttribute("muted", "");
    else el.removeAttribute("muted");
    el.volume = deafened ? 0 : 1;
  });
  broadcastAfk();
}

function broadcastAfk() {
  if (!currentRoom) return;
  try {
    const payload = afkEncoder.encode(JSON.stringify({ deafened: isCurrentlyDeafened }));
    currentRoom.localParticipant.publishData(payload, { reliable: true, topic: AFK_TOPIC }).catch((err) => {
      console.warn("[Sion] Failed to broadcast AFK state:", err);
    });
  } catch (err) {
    console.warn("[Sion] publishData threw:", err);
  }
}

/** Broadcast our cursor position over the screen share. Unreliable delivery
 *  is fine — cursor is throttled to ~30Hz so the next update makes up for
 *  any dropped packet. The caller is responsible for throttling. */
export function broadcastCursor(x: number, y: number) {
  if (!currentRoom) return;
  try {
    const payload = afkEncoder.encode(JSON.stringify({ x, y }));
    // `reliable: false` = DataPacketKind.LOSSY — low-latency, drops allowed.
    currentRoom.localParticipant.publishData(payload, { reliable: false, topic: CURSOR_TOPIC }).catch(() => { /* best-effort */ });
  } catch { /* ignore */ }
}

/** Broadcast a click from the viewer at normalised coords. The sharer (and
 *  all other viewers) render an expanding ripple at that position — lets
 *  one viewer say "look HERE" without hijacking the mouse.
 *  Reliable delivery: drops would miss the single visual cue, unlike the
 *  continuous cursor stream which is idempotent. */
export function broadcastCursorClick(x: number, y: number) {
  if (!currentRoom) return;
  try {
    const payload = afkEncoder.encode(JSON.stringify({ click: true, x, y }));
    currentRoom.localParticipant.publishData(payload, { reliable: true, topic: CURSOR_CLICK_TOPIC }).catch(() => { /* best-effort */ });
  } catch { /* ignore */ }
}

/** Signal to viewers that our cursor is no longer over the share. Sending
 *  `{expire: true}` lets peers remove our cursor immediately instead of
 *  waiting for the TTL to fire. */
export function broadcastCursorHide() {
  if (!currentRoom) return;
  try {
    const payload = afkEncoder.encode(JSON.stringify({ expire: true }));
    currentRoom.localParticipant.publishData(payload, { reliable: true, topic: CURSOR_TOPIC }).catch(() => { /* best-effort */ });
  } catch { /* ignore */ }
}

/** Subscribe to the live list of remote cursors (excludes our own). Fires
 *  whenever a remote cursor moves, appears, or expires. */
export function onCursorsChange(callback: (cursors: RemoteCursor[]) => void): () => void {
  cursorCallback = callback;
  // Periodic sweep to expire stale cursors even when no new data arrives.
  if (!cursorSweepTimer) {
    cursorSweepTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, c] of remoteCursors) {
        if (c.expiresAt <= now) { remoteCursors.delete(id); changed = true; }
      }
      if (changed) cursorCallback?.(Array.from(remoteCursors.values()));
    }, 250);
  }
  callback(Array.from(remoteCursors.values()));
  return () => {
    if (cursorCallback === callback) cursorCallback = null;
  };
}

/** Subscribe to one-shot cursor-click events from viewers — the UI renders
 *  an expanding ripple at (x, y) for each emission, then the entry can be
 *  discarded. No retention map here; clicks are ephemeral. */
export function onCursorClick(callback: (click: RemoteCursorClick) => void): () => void {
  cursorClickCallback = callback;
  return () => {
    if (cursorClickCallback === callback) cursorClickCallback = null;
  };
}

export async function updateAudioProcessing(options: {
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}) {
  if (!currentRoom) return;

  // applyConstraints on an already-published MediaStreamTrack does NOT
  // reliably reconfigure Chromium's audio DSP pipeline for NS/EC/AGC — the
  // browser accepts the constraint silently but the filters stay at whatever
  // was active when getUserMedia was called. The only robust way to flip
  // these is to stop the track and re-acquire it via a fresh getUserMedia,
  // which is what setMicrophoneEnabled(false) → setMicrophoneEnabled(true)
  // does when we update audioCaptureDefaults first.
  const prev = currentRoom.options.audioCaptureDefaults || {};
  currentRoom.options.audioCaptureDefaults = {
    ...prev,
    ...(options.echoCancellation !== undefined ? { echoCancellation: options.echoCancellation } : {}),
    ...(options.autoGainControl !== undefined ? { autoGainControl: options.autoGainControl } : {}),
  };

  const wasEnabled = currentRoom.localParticipant.isMicrophoneEnabled;
  if (!wasEnabled) return;

  try {
    await currentRoom.localParticipant.setMicrophoneEnabled(false);
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
    logAudioProcessingSettings("updateAudioProcessing");
  } catch (err) {
    console.warn("[Sion] Failed to re-acquire microphone with new processing:", err);
  }
}

/** Re-capture the microphone so the denoise shim re-wraps the track (or
 *  stops wrapping) based on the current aiNoiseSuppression setting. Same
 *  mechanism as updateAudioProcessing — unpublish + republish forces a
 *  fresh getUserMedia that our shim intercepts. */
export async function refreshMicrophoneForDenoise() {
  if (!currentRoom) return;
  if (!currentRoom.localParticipant.isMicrophoneEnabled) return;
  try {
    await currentRoom.localParticipant.setMicrophoneEnabled(false);
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
    logAudioProcessingSettings("refreshMicrophoneForDenoise");
  } catch (err) {
    console.warn("[Sion] Failed to refresh microphone for denoise:", err);
  }
}

/** Log what Chromium actually applied for NS/EC/AGC. Browsers can accept
 *  constraints silently while ignoring them, so verifying via getSettings()
 *  is the only way to confirm the DSP pipeline matches user expectations. */
function logAudioProcessingSettings(context: string) {
  const micPub = currentRoom?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const mst = micPub?.track?.mediaStreamTrack;
  if (!mst) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = mst.getSettings() as any;
  console.log(
    `[Sion][Audio/${context}] ns=${s.noiseSuppression} ec=${s.echoCancellation} agc=${s.autoGainControl} ch=${s.channelCount} sr=${s.sampleRate} device=${s.deviceId?.slice?.(0, 16) ?? "?"}`,
  );
}

export async function updateAudioQuality(quality: AudioQualityPreset) {
  if (!currentRoom) return;
  const preset = getAudioPreset(quality);
  const stereo = isStereoPreset(quality);

  const micPub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!micPub?.track?.mediaStreamTrack) return;

  try {
    // Update channel count (mono/stereo)
    await micPub.track.mediaStreamTrack.applyConstraints({ channelCount: stereo ? 2 : 1 });
    // Republish with new bitrate
    await currentRoom.localParticipant.setMicrophoneEnabled(false);
    currentRoom.options.publishDefaults = {
      ...currentRoom.options.publishDefaults,
      audioPreset: preset,
    };
    currentRoom.options.audioCaptureDefaults = {
      ...currentRoom.options.audioCaptureDefaults,
      channelCount: stereo ? 2 : 1,
    };
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    console.warn("[Sion] Failed to update audio quality:", err);
  }
}

export async function toggleScreenShare(enabled: boolean) {
  if (!currentRoom) return;
  const settings = useSettingsStore.getState();
  const wantAudio = settings.screenShareAudio;

  // Map our user-friendly presets to LiveKit's ScreenSharePresets.
  // The SDK ships 5/15/30 fps tiers up to 1080p built-in. 60 fps and 1440p
  // are constructed on the fly via `new VideoPreset(w, h, maxBitrate, fps)`.
  // Bitrates are chosen for screen-share / gaming content (high motion,
  // small text readable) and scale roughly linearly with fps × pixel count.
  const { ScreenSharePresets, VideoPreset } = await import("livekit-client");
  const presetKey = `${settings.screenShareResolution}-${settings.screenShareFramerate}fps` as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presetMap: Record<string, any> = {
    "720p-5fps":   ScreenSharePresets.h720fps5,
    "720p-15fps":  ScreenSharePresets.h720fps15,
    "720p-30fps":  ScreenSharePresets.h720fps30,
    "720p-60fps":  new VideoPreset(1280, 720, 3_500_000, 60),
    "1080p-15fps": ScreenSharePresets.h1080fps15,
    "1080p-30fps": ScreenSharePresets.h1080fps30,
    "1080p-60fps": new VideoPreset(1920, 1080, 6_000_000, 60),
    "1440p-15fps": new VideoPreset(2560, 1440, 5_000_000, 15),
    "1440p-30fps": new VideoPreset(2560, 1440, 8_000_000, 30),
    "1440p-60fps": new VideoPreset(2560, 1440, 14_000_000, 60),
  };
  const mappedPreset = presetMap[presetKey];
  if (!mappedPreset) {
    console.warn(`[Sion] Screen share preset '${presetKey}' not in map, falling back to h1080fps15`);
  }
  const preset = mappedPreset ?? ScreenSharePresets.h1080fps15;

  // Align the screen-share audio publish preset with the mic's preset
  // (same Opus config, same channelCount). Without this, Chromium rejects
  // the SDP renegotiation that adds the ScreenShareAudio track with a
  // "BUNDLE group contains a codec collision for payload_type=111" error
  // because mic and screen-share audio both negotiate PT 111 (Opus) with
  // different fmtp/rtpmap. The PeerConnection wedges: the mic stops
  // flowing to peers and only recovers on a full reload.
  //
  // The LiveKit API splits capture options (audio/video/resolution) and
  // publish options (codec/bitrate/dtx/red) into two separate arguments —
  // audioPreset/red/dtx belong to the second.
  const audioPreset = getAudioPreset(settings.audioQuality);

  // Linux has no usable system-audio path through getDisplayMedia: xdg-
  // desktop-portal-kde doesn't expose the "include audio" checkbox, and
  // Chromium filters PulseAudio monitor sources out of enumerateDevices.
  // Passing `audio: true` yields a tab-loopback track that only contains
  // Chromium's own playback — speaker-test and other apps are silent. On
  // Linux we capture via Rust/parec and publish a separate LocalAudioTrack
  // (see systemAudioService.ts + src-tauri/src/system_audio.rs). Windows
  // and macOS keep the native portal path, which works out of the box.
  const useLinuxSystemAudio =
    wantAudio && typeof navigator !== "undefined" && navigator.userAgent.includes("Linux");

  // AEC/NS/AGC must be OFF for screen-share audio on platforms where it is
  // handled by Chromium (Windows). With default constraints Chromium applies
  // echo cancellation which, on a loopback capture, cancels the signal
  // against itself. Passing an object is fine — what matters is the three
  // flags. On Linux we pass `audio: false` and handle audio ourselves.
  const audioCaptureConstraints: boolean | MediaTrackConstraints =
    wantAudio && !useLinuxSystemAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false;

  // Only pass capture/publish options when STARTING a share — LiveKit's
  // unpublish path is sensitive to these arguments and has been observed
  // to tear down the mic PeerConnection when non-empty capture options
  // flow through on disable (the peer briefly loses our voice and the
  // local user appears to drop from the room). The plain two-arg form
  // for disable is the documented contract.
  const appStore = (await import("../stores/useAppStore")).useAppStore;
  if (enabled) {
    await currentRoom.localParticipant.setScreenShareEnabled(
      enabled,
      {
        audio: audioCaptureConstraints,
        ...(wantAudio && !useLinuxSystemAudio ? { systemAudio: "include" as const } : {}),
        resolution: preset,
      },
      {
        audioPreset,
        red: false,
        dtx: false,
      },
    );

    // Linux system-audio publish, after the video share is up. We do this
    // AFTER setScreenShareEnabled so the SDP already has the screen-share
    // video m-line — adding the audio track now renegotiates cleanly with
    // the correct Opus fmtp.
    if (useLinuxSystemAudio) {
      try {
        const { startSystemAudioCapture } = await import("./systemAudioService");
        const audioTrack = await startSystemAudioCapture();
        systemAudioPublication = await currentRoom.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
          name: "screen_share_audio",
          dtx: false,
          red: false,
          audioPreset,
        });
        // If the video track ends (user hit "Stop sharing" in the native
        // overlay, the shared window closed), clean up the audio too —
        // otherwise parec keeps running and the publication stays alive
        // while the user thinks the share is over.
        const videoPub = Array.from(currentRoom.localParticipant.trackPublications.values())
          .find(p => p.source === Track.Source.ScreenShare);
        const mst = videoPub?.track?.mediaStreamTrack;
        if (mst) {
          const onEnded = () => {
            mst.removeEventListener("ended", onEnded);
            toggleScreenShare(false).catch(() => { /* best-effort */ });
          };
          mst.addEventListener("ended", onEnded);
        }
      } catch (e) {
        console.warn("[Sion][Share] Linux system-audio capture failed:", e);
        appStore.setState({ screenShareAudioWarning: true });
      }
    }
  } else {
    // Stop: unpublish the system-audio track first (if any) so parec dies
    // before the video teardown renegotiates the peer connection.
    if (systemAudioPublication) {
      try {
        const t = systemAudioPublication.track;
        if (t) await currentRoom.localParticipant.unpublishTrack(t);
      } catch (e) {
        console.warn("[Sion][Share] unpublish system-audio failed:", e);
      }
      systemAudioPublication = null;
      try {
        const { stopSystemAudioCapture } = await import("./systemAudioService");
        await stopSystemAudioCapture();
      } catch { /* best-effort */ }
    }
    await currentRoom.localParticipant.setScreenShareEnabled(false);
  }

  // Post-check: did a ScreenShareAudio track actually land on the publication
  // list? On macOS whole-screen, Firefox, and any browser where the user
  // unticked "Share audio" in the native picker, `audio: true` goes through
  // but no audio track arrives. On Linux we publish ourselves, so this check
  // also verifies our own publish succeeded.
  if (enabled && wantAudio) {
    const hasAudioTrack = Array.from(currentRoom.localParticipant.trackPublications.values())
      .some(p => p.source === Track.Source.ScreenShareAudio);
    if (!hasAudioTrack) {
      console.warn("[Sion][Share] Audio requested but no ScreenShareAudio track published — user unchecked 'Share audio' in the picker, or the platform doesn't support system audio for this source");
      appStore.setState({ screenShareAudioWarning: true });
    } else {
      appStore.setState({ screenShareAudioWarning: false });
    }
  } else if (!enabled) {
    // Stop: clear any stale warning from a previous share.
    appStore.setState({ screenShareAudioWarning: false });
  }

  // Open/close the Tauri cursor overlay in sync with the share state. The
  // overlay is a separate webview that sits on top of the sharer's screen
  // and renders viewer cursors so they appear in the captured stream. Lazy
  // imported to avoid pulling Tauri APIs into non-Tauri bundles.
  if (enabled) {
    const surface = Array.from(currentRoom.localParticipant.trackPublications.values())
      .find(p => p.source === Track.Source.ScreenShare)?.track?.mediaStreamTrack?.getSettings?.() as { displaySurface?: string } | undefined;
    if (surface?.displaySurface && surface.displaySurface !== "monitor") {
      // The picker captured a single window/tab, not the whole screen. The
      // overlay would render cursors at screen coords that don't line up
      // with the captured region — skip it. The viewers' client-side
      // overlay in ScreenShareView still works normally.
      console.log(`[Sion][CursorOverlay] displaySurface="${surface.displaySurface}" — skipping overlay (only works for monitor captures)`);
    } else {
      import("./cursorOverlayService").then(({ openCursorOverlay }) => openCursorOverlay()).catch(() => {});
    }
  } else {
    import("./cursorOverlayService").then(({ closeCursorOverlay }) => closeCursorOverlay()).catch(() => {});
  }
}

export function getParticipants(): ParticipantInfo[] {
  if (!currentRoom) return [];

  const participants: ParticipantInfo[] = [];

  const mapParticipant = (p: RemoteParticipant | LocalParticipant): ParticipantInfo => {
    // Self: canonical store state. Remote: state learned via data channel.
    const isLocal = p === currentRoom?.localParticipant;
    const isDeafened = isLocal ? isCurrentlyDeafened : (remoteDeafenState.get(p.identity) ?? false);
    const playingEmoji = playingSoundState.get(p.identity)?.emoji;
    return {
      identity: p.identity,
      name: p.name || p.identity,
      // Use our client-side speaking detector instead of LiveKit SFU's smoothed
      // server-side state, which has ~1.6s of debounce.
      isSpeaking: speakingState.get(p.identity) || false,
      isMuted: !p.isMicrophoneEnabled,
      isScreenSharing: p.isScreenShareEnabled,
      isDeafened,
      audioLevel: p.audioLevel,
      connectionQuality: mapConnectionQuality(p.connectionQuality),
      ...(playingEmoji ? { playingSoundEmoji: playingEmoji } : {}),
    };
  };

  participants.push(mapParticipant(currentRoom.localParticipant));
  currentRoom.remoteParticipants.forEach((p) => {
    participants.push(mapParticipant(p));
  });

  return participants;
}

export function onParticipantChange(callback: (participants: ParticipantInfo[]) => void): () => void {
  if (!currentRoom) return () => {};

  const update = () => callback(getParticipants());

  // Subscribe the speaking-detector callback so any RMS-driven state flip
  // immediately propagates to the UI.
  participantUpdateCallback = update;

  // Remote participant events
  currentRoom.on(RoomEvent.ParticipantConnected, update);
  currentRoom.on(RoomEvent.ParticipantDisconnected, update);
  // ActiveSpeakersChanged kept as a fallback, but our local detector is the
  // primary source of speaking state now.
  currentRoom.on(RoomEvent.ActiveSpeakersChanged, update);
  currentRoom.on(RoomEvent.TrackSubscribed, update);
  currentRoom.on(RoomEvent.TrackUnsubscribed, update);
  currentRoom.on(RoomEvent.TrackMuted, update);
  currentRoom.on(RoomEvent.TrackUnmuted, update);
  // Connection-quality changes for the signal-bars indicator
  currentRoom.on(RoomEvent.ConnectionQualityChanged, update);
  // AFK/deafened state arrives on a reliable data channel (topic = AFK_TOPIC)
  const handleAfkData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (!participant) return;
    if (topic === AFK_TOPIC) {
      try {
        const parsed = JSON.parse(afkDecoder.decode(payload)) as { deafened?: boolean };
        remoteDeafenState.set(participant.identity, parsed.deafened === true);
        update();
      } catch { /* ignore malformed */ }
      return;
    }
    if (topic === CURSOR_CLICK_TOPIC) {
      try {
        const parsed = JSON.parse(afkDecoder.decode(payload)) as { click?: boolean; x?: number; y?: number };
        if (parsed.click && typeof parsed.x === "number" && typeof parsed.y === "number") {
          const click: RemoteCursorClick = {
            id: `${participant.identity}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
            identity: participant.identity,
            name: resolveDisplayName(participant),
            x: parsed.x,
            y: parsed.y,
            expiresAt: Date.now() + CLICK_TTL_MS,
          };
          cursorClickCallback?.(click);
          // Forward to the Tauri overlay too so the ripple appears baked in
          // the stream for all viewers.
          if (currentRoom?.localParticipant.isScreenShareEnabled) {
            import("./cursorOverlayService").then(({ pushCursorClickToOverlay }) => pushCursorClickToOverlay(click)).catch(() => {});
          }
        }
      } catch { /* ignore malformed */ }
      return;
    }
    if (topic === CURSOR_TOPIC) {
      try {
        const parsed = JSON.parse(afkDecoder.decode(payload)) as { x?: number; y?: number; expire?: boolean };
        // If we're the one sharing the screen, forward to the transparent
        // Tauri overlay so the cursor appears on our real display (captured
        // by getDisplayMedia → all viewers see where everyone points).
        const localIsSharing = currentRoom?.localParticipant.isScreenShareEnabled === true;
        // Diag: log first CURSOR_TOPIC arrival from each peer + a periodic
        // pulse so we can see in the log whether broadcasts are coming in.
        cursorRecvDiag(participant.identity, localIsSharing);
        if (parsed.expire) {
          if (remoteCursors.delete(participant.identity)) {
            cursorCallback?.(Array.from(remoteCursors.values()));
          }
          if (localIsSharing) {
            import("./cursorOverlayService").then(({ clearCursorFromOverlay }) => clearCursorFromOverlay(participant.identity)).catch(() => {});
          }
        } else if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          const expiresAt = Date.now() + CURSOR_TTL_MS;
          const entry = {
            identity: participant.identity,
            name: resolveDisplayName(participant),
            x: parsed.x,
            y: parsed.y,
            expiresAt,
          };
          remoteCursors.set(participant.identity, entry);
          cursorCallback?.(Array.from(remoteCursors.values()));
          if (localIsSharing) {
            import("./cursorOverlayService").then(({ pushCursorToOverlay }) => pushCursorToOverlay(entry)).catch(() => {});
          }
        }
      } catch { /* ignore malformed */ }
      return;
    }
    // Soundboard broadcast — lazy-load to avoid circular import at module load
    import("./soundboardService").then(({ SOUNDBOARD_TOPIC, handleRemoteBroadcast }) => {
      if (topic === SOUNDBOARD_TOPIC) handleRemoteBroadcast(payload, participant.identity);
    }).catch(() => {});
  };
  currentRoom.on(RoomEvent.DataReceived, handleAfkData);

  // Re-broadcast our state to newcomers so they learn it, and forget
  // state for disconnected peers.
  const rebroadcastOnJoin = () => { broadcastAfk(); update(); };
  const forgetOnLeave = (p: RemoteParticipant) => {
    remoteDeafenState.delete(p.identity);
    if (remoteCursors.delete(p.identity)) cursorCallback?.(Array.from(remoteCursors.values()));
    clearE2EEState(p.identity);
    update();
  };
  currentRoom.on(RoomEvent.ParticipantConnected, rebroadcastOnJoin);
  currentRoom.on(RoomEvent.ParticipantDisconnected, forgetOnLeave);

  // Local participant events
  currentRoom.on(RoomEvent.LocalTrackPublished, update);
  currentRoom.on(RoomEvent.LocalTrackUnpublished, update);

  // Initial update
  update();

  return () => {
    if (!currentRoom) return;
    if (participantUpdateCallback === update) participantUpdateCallback = null;
    currentRoom.off(RoomEvent.ParticipantConnected, update);
    currentRoom.off(RoomEvent.ParticipantDisconnected, update);
    currentRoom.off(RoomEvent.ActiveSpeakersChanged, update);
    currentRoom.off(RoomEvent.TrackSubscribed, update);
    currentRoom.off(RoomEvent.TrackUnsubscribed, update);
    currentRoom.off(RoomEvent.TrackMuted, update);
    currentRoom.off(RoomEvent.TrackUnmuted, update);
    currentRoom.off(RoomEvent.ConnectionQualityChanged, update);
    currentRoom.off(RoomEvent.DataReceived, handleAfkData);
    currentRoom.off(RoomEvent.ParticipantConnected, rebroadcastOnJoin);
    currentRoom.off(RoomEvent.ParticipantDisconnected, forgetOnLeave);
    currentRoom.off(RoomEvent.LocalTrackPublished, update);
    currentRoom.off(RoomEvent.LocalTrackUnpublished, update);
  };
}
