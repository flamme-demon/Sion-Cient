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
import { playJoinCue, onParticipantLeft, noteConnectionLost, resetVoiceCues } from "./voiceChannelSounds";


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
// Track SID currently feeding each participant's detector. A republish
// (mute→unmute denoise refresh, reconnect) gives the mic a NEW sid, and the
// new track's TrackSubscribed can fire BEFORE the old track's TrackUnsubscribed.
// Without this guard, the late detach of the dead sid would call
// stopSpeakingDetector(identity) and kill the detector the new attach just
// started — leaving the peer's speaking halo permanently dark.
const speakingDetectorSid = new Map<string, string>();
let participantUpdateCallback: (() => void) | null = null;
let pendingTimerCleanup: (() => void) | null = null;
// Removes every room event listener registered by connectToRoom (via the
// `onRoom` wrapper). Run in disconnectFromRoom so a discarded Room leaves no
// handlers behind — matters for HMR and to stop a tearing-down Room from
// writing to global stores. Null when no room is connected.
let roomListenersCleanup: (() => void) | null = null;

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

function startSpeakingDetectorForStream(identity: string, sid: string, stream: MediaStream) {
  // Replace any previous detector for this participant
  speakingDetectors.get(identity)?.stop();
  const detector = new SpeakingDetector(
    stream,
    (isSpeaking) => setSpeakingState(identity, isSpeaking),
  );
  detector.start();
  speakingDetectors.set(identity, detector);
  speakingDetectorSid.set(identity, sid);
}

function stopSpeakingDetector(identity: string) {
  const detector = speakingDetectors.get(identity);
  if (detector) {
    detector.stop();
    speakingDetectors.delete(identity);
  }
  speakingDetectorSid.delete(identity);
  speakingState.delete(identity);
}

function stopAllSpeakingDetectors() {
  speakingDetectors.forEach((d) => d.stop());
  speakingDetectors.clear();
  speakingDetectorSid.clear();
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

// Drives the store's `e2eeUnhealthy` flag (which gates the manual
// republish-presence button). Raised when MissingKey errors cross the
// protection threshold; lowered after a quiet window with no new errors.
let e2eeHealthClearTimer: ReturnType<typeof setTimeout> | null = null;
const E2EE_HEALTHY_AFTER_MS = 12_000;
function markE2EEUnhealthy() {
  useAppStore.getState().setE2EEUnhealthy(true);
  if (e2eeHealthClearTimer) clearTimeout(e2eeHealthClearTimer);
  e2eeHealthClearTimer = setTimeout(() => {
    e2eeHealthClearTimer = null;
    useAppStore.getState().setE2EEUnhealthy(false);
  }, E2EE_HEALTHY_AFTER_MS);
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
  if (e2eeHealthClearTimer) { clearTimeout(e2eeHealthClearTimer); e2eeHealthClearTimer = null; }
  useAppStore.getState().setE2EEUnhealthy(false);
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
    // E2EE is genuinely struggling for this peer — surface the manual
    // republish-presence recovery in the UI.
    markE2EEUnhealthy();
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

let screenShareCallback: ((shares: ScreenShareInfo[]) => void) | null = null;

// Per-share audio controls, keyed by the sharer's participant identity. These
// are independent of the per-participant *voice* mute (`locallyMutedIdentities`)
// and of global deafen: a viewer can silence the game/video audio of a share
// while still hearing the sharer talk. Default = unmuted, volume 1.
const screenShareAudioMuted = new Set<string>();
const screenShareAudioVolume = new Map<string, number>();

/** Desired output volume (0..1) for a participant's screen-share audio,
 *  honoring the per-share mute toggle. Does NOT account for global deafen —
 *  deafen always wins and is applied separately in `setDeafened`. */
function desiredScreenShareVolume(identity: string): number {
  if (screenShareAudioMuted.has(identity)) return 0;
  return screenShareAudioVolume.get(identity) ?? 1;
}

/** Apply the per-share audio mute/volume to all of a participant's
 *  ScreenShareAudio elements. No-op while deafened — deafen owns el.muted then
 *  and will re-apply this state on un-deafen. */
function applyScreenShareAudioState(identity: string) {
  if (isCurrentlyDeafened) return;
  const vol = desiredScreenShareVolume(identity);
  for (const el of audioElements.values()) {
    if (el.dataset.participantId === identity && el.dataset.trackSource === Track.Source.ScreenShareAudio) {
      cancelFadeIn(el);
      setElementMuted(el, vol === 0);
      el.volume = vol;
    }
  }
}

/** Mute/unmute only the screen-share (system) audio of a given sharer, leaving
 *  their microphone untouched. Local perception only. */
export function setScreenShareAudioMuted(identity: string, muted: boolean) {
  if (muted) screenShareAudioMuted.add(identity);
  else screenShareAudioMuted.delete(identity);
  applyScreenShareAudioState(identity);
}

/** Set the local playback volume (0..1) of a sharer's screen-share audio. */
export function setScreenShareAudioVolume(identity: string, volume: number) {
  screenShareAudioVolume.set(identity, Math.max(0, Math.min(1, volume)));
  applyScreenShareAudioState(identity);
}

export function getScreenShareAudioState(identity: string): { muted: boolean; volume: number } {
  return {
    muted: screenShareAudioMuted.has(identity),
    volume: screenShareAudioVolume.get(identity) ?? 1,
  };
}

// Linux-only: publication of the system-audio track captured via Rust/parec
// and injected into a MediaStreamAudioDestinationNode. Separate from the
// video publication because on Linux the portal can't give us system audio,
// so we publish audio independently and must clean it up on our own.
let systemAudioPublication: LocalTrackPublication | null = null;

// Windows/CEF only: publication of the screen-share VIDEO track when we capture
// a single monitor ourselves (legacy getUserMedia desktop constraint) instead
// of going through LiveKit's setScreenShareEnabled/getDisplayMedia. The Chrome
// source-picker UI crashes in this CEF embedding (stop/focus), and the
// auto-grant fallback captures ALL monitors at once — so on Windows we pick one
// monitor via `chromeMediaSourceId: "screen:N:0"` and publish the track here.
// Tracked separately because setScreenShareEnabled(false) won't unpublish it.
let manualScreenPublication: LocalTrackPublication | null = null;

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

/** Snapshot every remote participant's currently-subscribed screen-share video
 *  track. Multiple peers can share at once, so the UI gets the full list and
 *  lets the viewer pick which one to watch. */
function collectActiveScreenShares(excludeSid?: string): ScreenShareInfo[] {
  const shares: ScreenShareInfo[] = [];
  if (!currentRoom) return shares;
  for (const [, participant] of currentRoom.remoteParticipants) {
    for (const [, pub] of participant.trackPublications) {
      // `excludeSid` drops a track we KNOW is going away: LiveKit doesn't clear
      // `pub.track`/`isSubscribed` synchronously when it fires TrackUnsubscribed,
      // so a naive recompute would re-list the share that just stopped.
      if (pub.trackSid === excludeSid) continue;
      if (pub.track && pub.track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare && pub.isSubscribed) {
        shares.push({
          track: pub.track as RemoteTrack,
          participantIdentity: participant.identity,
          participantName: resolveDisplayName(participant),
          hasAudio: participantHasScreenShareAudio(participant),
        });
      }
    }
  }
  return shares;
}

function emitScreenShares() {
  screenShareCallback?.(collectActiveScreenShares());
}

function handleScreenShareSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
    console.log(`[Sion][LK] screen share subscribed from ${participant.identity} (trackSid=${publication.trackSid}) — has callback=${!!screenShareCallback}`);
    emitScreenShares();
  } else if (track.kind === Track.Kind.Audio && publication.source === Track.Source.ScreenShareAudio) {
    // ScreenShareAudio subscribed AFTER the video; re-fire so the UI picks up
    // the 🔊 indicator, and re-apply any per-share mute/volume the viewer set
    // on a previous share from this participant.
    console.log(`[Sion][LK] screen share audio arrived from ${participant.identity} — refreshing UI`);
    emitScreenShares();
    applyScreenShareAudioState(participant.identity);
  }
}

function handleScreenShareUnsubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
    console.log(`[Sion][LK] screen share unsubscribed from ${participant.identity} (trackSid=${publication.trackSid})`);
    // Exclude the dying track — its publication may still read as subscribed.
    screenShareCallback?.(collectActiveScreenShares(publication.trackSid));
  }
}

export function onScreenShareChange(cb: (shares: ScreenShareInfo[]) => void): () => void {
  screenShareCallback = cb;
  // Replay the current set so a freshly-mounted view picks up shares already
  // in progress.
  if (currentRoom) cb(collectActiveScreenShares());
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

/** Suppress (or restore) an audio element's OWN output: the `muted` property,
 *  the matching HTML attribute, and volume. Belt-and-suspenders for CEF, which
 *  has let residual audio through when any one of these was missing. */
function setElementMuted(el: HTMLAudioElement, muted: boolean) {
  el.muted = muted;
  if (muted) el.setAttribute("muted", "");
  else el.removeAttribute("muted");
  el.volume = muted ? 0 : 1;
}

/** Gate the underlying remote MediaStreamTrack — the only reliable mute on
 *  CEF, where el.muted/volume don't always silence a MediaStream <audio>.
 *  `el`'s srcObject carries the same track instance LiveKit attached. */
function setElementTrackEnabled(el: HTMLAudioElement | undefined, enabled: boolean) {
  const mst = (el?.srcObject as MediaStream | null)?.getAudioTracks?.()[0];
  if (mst) mst.enabled = enabled;
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
  console.log(`[Sion][deafen] attachAudioTrack pid=${participant.identity} sid=${sid} src=${publication.source} → muted=${el.muted} (isCurrentlyDeafened=${isCurrentlyDeafened})`);
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

  // Screen-share audio honours the viewer's per-share mute/volume; everything
  // else fades to full. Computing the target up-front means a share the viewer
  // previously muted stays silent across re-subscribes — no 500 ms leak.
  const fadeTarget = publication.source === Track.Source.ScreenShareAudio
    ? desiredScreenShareVolume(participant.identity)
    : 1;

  // Fade in to fadeTarget over FADE_IN_MS. No-op when deafened (el.muted
  // already kills output regardless of volume) or when the target is 0 (muted
  // share). The interval handle is stashed on the element so detachAudioTrack
  // can cancel it if the track dies early.
  if (!isCurrentlyDeafened && fadeTarget > 0) {
    const FADE_IN_MS = 500;
    const FADE_STEPS = 20;
    let step = 0;
    const handle = setInterval(() => {
      step++;
      const v = step >= FADE_STEPS ? fadeTarget : (step / FADE_STEPS) * fadeTarget;
      el.volume = v;
      if (step >= FADE_STEPS) {
        clearInterval(handle);
        delete (el as HTMLAudioElement & { _fadeInHandle?: ReturnType<typeof setInterval> })._fadeInHandle;
      }
    }, FADE_IN_MS / FADE_STEPS);
    (el as HTMLAudioElement & { _fadeInHandle?: ReturnType<typeof setInterval> })._fadeInHandle = handle;
  } else if (!isCurrentlyDeafened && fadeTarget === 0) {
    // Muted screen-share audio: keep it silenced (volume already 0 above).
    setElementMuted(el, true);
  }

  // Re-apply per-participant local mute AND global deafen on the track itself.
  // The new MediaStreamTrack starts enabled=true; el.muted alone doesn't
  // reliably silence on CEF (the WebRTC track plays to the output device), so
  // gate the track when we're deafened or this peer is locally muted.
  if (isCurrentlyDeafened || locallyMutedIdentities.has(participant.identity)) {
    track.mediaStreamTrack.enabled = false;
  }

  // Speaking detection wraps the RAW MediaStreamTrack (not captureStream of
  // the rendered element). captureStream ties activity to the element's
  // audible output, which goes silent when the user is deafened (el.muted) —
  // we still want to *see* who is talking to decide whether to undeafen.
  // The SpeakingDetector terminates the graph at a (non-audible)
  // MediaStreamAudioDestinationNode (see speakingDetector.ts) — NOT
  // audioCtx.destination, which leaked the remote mic through deafen on CEF.
  // That sink still pumps samples from a remote RTCRtpReceiver track into Web
  // Audio on Chromium. No clone: we wrap the same track in a
  // fresh MediaStream (cloning a remote track is what was observed to fail,
  // not referencing it). Skip for ScreenShareAudio — game/video audio isn't
  // voice, feeding it would falsely mark the participant as "speaking".
  if (publication.source !== Track.Source.ScreenShareAudio) {
    startSpeakingDetectorForStream(
      participant.identity,
      sid,
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
  // The SpeakingDetector is keyed by participant.identity and was only ever
  // attached to the Microphone track (the attach path skips ScreenShareAudio).
  // Unsubscribing a ScreenShareAudio track must NOT kill the mic's detector —
  // otherwise the remote's halo stays dark after they stop screen-share-with-audio
  // until they republish their mic.
  //
  // Only stop the detector if it's still fed by THIS sid. On a republish
  // (mute→unmute denoise refresh) the new mic track's TrackSubscribed can land
  // before the old track's TrackUnsubscribed; the new attach already started a
  // detector keyed to the new sid. Killing it here by identity would leave the
  // peer's speaking halo permanently dark until their next republish.
  if (
    publication.source !== Track.Source.ScreenShareAudio
    && speakingDetectorSid.get(participant.identity) === sid
  ) {
    stopSpeakingDetector(participant.identity);
  }
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

  // Register every room listener through this wrapper so disconnectFromRoom can
  // remove them all in one shot — a discarded Room must not keep handlers that
  // fire during its teardown (e.g. writing connection state to a global store).
  const listenerOffs: Array<() => void> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onRoom = (event: any, handler: any) => {
    room.on(event, handler);
    listenerOffs.push(() => { try { room.off(event, handler); } catch { /* ignore */ } });
  };
  roomListenersCleanup = () => { for (const off of listenerOffs) off(); listenerOffs.length = 0; };

  // Attach remote audio tracks for playback
  onRoom(RoomEvent.TrackSubscribed, attachAudioTrack);
  onRoom(RoomEvent.TrackUnsubscribed, detachAudioTrack);

  // Re-apply per-participant local mute when the remote peer unmutes. The
  // local `mediaStreamTrack.enabled` flag is DOM-local (LiveKit shouldn't
  // touch it), but this is the belt-and-suspenders guarantee that a remote
  // unmute can't silently flip a locally muted peer back to audible.
  onRoom(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
    if (publication.kind !== Track.Kind.Audio) return;
    const sid = (publication as RemoteTrackPublication).trackSid;
    const el = sid ? audioElements.get(sid) : undefined;
    console.log(`[Sion][deafen] TrackUnmuted pid=${participant.identity} sid=${sid} src=${publication.source} — isCurrentlyDeafened=${isCurrentlyDeafened} elMuted=${el?.muted} elVol=${el?.volume}`);
    // A remote un-mute (e.g. they were muted when we deafened, then un-mute)
    // must NOT become audible while we're deafened OR while we've locally
    // muted this peer. el.muted is unreliable on CEF — the WebRTC track keeps
    // playing — so gate the track itself. Re-enabling the track is owned by
    // setDeafened / muteRemoteParticipant, never here.
    if (isCurrentlyDeafened || locallyMutedIdentities.has(participant.identity)) {
      if (el) setElementMuted(el, true);
      setElementTrackEnabled(el, false);
    }
  });
  onRoom(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
    if (publication.kind !== Track.Kind.Audio) return;
    const sid = (publication as RemoteTrackPublication).trackSid;
    const el = sid ? audioElements.get(sid) : undefined;
    console.log(`[Sion][deafen] TrackMuted   pid=${participant.identity} sid=${sid} src=${publication.source} — isCurrentlyDeafened=${isCurrentlyDeafened} elMuted=${el?.muted} elVol=${el?.volume}`);
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
  onRoom(RoomEvent.TrackPublished, forceSubscribeAudio);

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
  onRoom(RoomEvent.TrackPublished, forceSubscribeScreenShare);

  // When a participant reconnects (e.g. Ctrl+R), LiveKit may skip their new
  // tracks with "already ended". Clean up stale audio on disconnect, then
  // re-attach tracks on reconnect after a short delay.
  onRoom(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    // TeamSpeak-style cue: leave vs timeout (inferred from prior ConnectionQuality).
    onParticipantLeft(participant.identity);
    // Clean up all audio elements for this participant
    for (const [, pub] of participant.trackPublications) {
      if (pub.track && pub.track.kind === Track.Kind.Audio) {
        detachAudioTrack(pub.track as RemoteTrack, pub as RemoteTrackPublication, participant);
      }
    }
  });
  // Track each remote peer's connection quality so a disconnect preceded by
  // `lost` is treated as a timeout cue rather than a clean leave.
  onRoom(RoomEvent.ConnectionQualityChanged, (quality: unknown, participant?: Participant) => {
    if (participant && !participant.isLocal) {
      noteConnectionLost(participant.identity, String(quality) === "lost");
    }
  });
  onRoom(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    playJoinCue();
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
  onRoom(RoomEvent.TrackSubscribed, handleScreenShareSubscribed);
  onRoom(RoomEvent.TrackUnsubscribed, handleScreenShareUnsubscribed);

  // Connection state — propagated to useLiveKitStore for the global banner.
  // RoomEvent.Reconnecting only fires when the SDK escalates to a full
  // reconnect; the signal-resume phase (which is what happens first on a
  // server restart, and often the only phase needed when the outage is
  // brief) is silent. ConnectionStateChanged fires on EVERY transition,
  // including signal-resume drops, so it's the only path that surfaces a
  // 5-second LiveKit restart to the user. We keep the explicit Reconnecting/
  // Reconnected/Disconnected handlers as a belt-and-suspenders fallback in
  // case ConnectionStateChanged emits race below the room state being settled.
  const propagateConnectionState = () => {
    import("../stores/useLiveKitStore").then(({ useLiveKitStore }) => {
      // ConnectionState enum values from livekit-client: "disconnected",
      // "connecting", "connected", "reconnecting", "signal_reconnecting".
      // We collapse "connecting" and "signal_reconnecting" into our 3-state
      // model: anything not "connected" or "disconnected" is shown as
      // "reconnecting" in the banner.
      const state = room.state as string;
      if (state === "connected") {
        useLiveKitStore.getState().setConnectionState("connected");
      } else if (state === "disconnected") {
        useLiveKitStore.getState().setConnectionState("disconnected");
      } else {
        useLiveKitStore.getState().setConnectionState("reconnecting");
      }
    });
  };
  onRoom(RoomEvent.ConnectionStateChanged, propagateConnectionState);
  onRoom(RoomEvent.Reconnecting, propagateConnectionState);
  onRoom(RoomEvent.Reconnected, propagateConnectionState);
  onRoom(RoomEvent.Disconnected, propagateConnectionState);

  await room.connect(url, token);
  currentRoom = room;
  // Expose for in-DevTools debugging — re-set on every reconnect since
  // `connectToRoom` may be called multiple times during a session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__SION_ROOM = room;

  if (e2eeKeyProvider) {
    await room.setE2EEEnabled(true);
    onRoom(EncryptionEvent.EncryptionError, onE2EEError);
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
      startSpeakingDetectorForStream(room.localParticipant.identity, micPub!.trackSid, new MediaStream([mst]));
    } else {
      stopSpeakingDetector(room.localParticipant.identity);
    }
  };
  onRoom(RoomEvent.LocalTrackPublished, refreshLocalDetector);
  onRoom(RoomEvent.LocalTrackUnpublished, refreshLocalDetector);
  onRoom(RoomEvent.TrackMuted, refreshLocalDetector);
  onRoom(RoomEvent.TrackUnmuted, refreshLocalDetector);
  refreshLocalDetector();

  // Re-broadcast our E2EE key whenever our own mic (re)publishes. A local mic
  // republish — un-mute/un-deafen re-acquiring the track (denoise re-wrap), a
  // device switch, or a reconnect — rotates our media key, but MatrixRTC only
  // auto-resends keys on MEMBERSHIP changes. Without a membership change peers
  // never receive the rotated key and can't decrypt us → one-way audio (the
  // classic "I came out of deafen and now they can't hear me"). A couple of
  // re-emits cover the key-provider wiring race.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reemitOnLocalMicPublish = (pub: any) => {
    if (pub?.source !== Track.Source.Microphone || !reemitKeysFn) return;
    console.log("[Sion][E2EE] local mic (re)published → re-broadcasting encryption key");
    setTimeout(() => reemitKeysFn?.(), 300);
    setTimeout(() => reemitKeysFn?.(), 1500);
  };
  onRoom(RoomEvent.LocalTrackPublished, reemitOnLocalMicPublish);

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
  onRoom(RoomEvent.LocalTrackUnpublished, onLocalScreenShareUnpub);

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
    // Remove ALL room listeners registered via onRoom (not just the few that
    // used to be off'd here) so the discarded Room leaks no handlers.
    roomListenersCleanup?.();
    roomListenersCleanup = null;
    // Tell the UI there's no active share now — but keep the callback
    // registered. ScreenShareView is mounted in MainArea and is NOT tied to
    // voice-connection state; its useEffect runs once and never re-fires,
    // so nulling the global ref here would orphan it forever and silently
    // break the next voice session's screen share. The cleanup that
    // ScreenShareView's own unmount returns is the only path allowed to
    // null this — it fires when the user logs out / leaves the app.
    screenShareCallback?.([]);
    resetAllE2EEState();
    pendingTimerCleanup?.();
    pendingTimerCleanup = null;
    stopAllSpeakingDetectors();
    detachAllAudio();
    locallyMutedIdentities.clear();
    resetVoiceCues();
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
  const denoiseOn = useSettingsStore.getState().aiNoiseSuppression;
  // Re-acquiring getUserMedia needs the foreground, so mobile keeps the
  // kept-alive-track unmute path. Everything else is "desktop".
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (enabled) {
    // CEF (esp. Windows) bug: when the published mic is the denoise pipeline's
    // Web Audio output, resuming after a mute (or deafen-mute) leaves the track
    // SILENT — the re-wrapped track doesn't resume in the existing sender, so
    // peers stop hearing us (confirmed: disabling denoise fixes it). Recreate a
    // fresh denoise track + publication (the known-good initial-publish path)
    // on resume when denoise is on, desktop. Covers BOTH the muted-track and
    // no-track cases. Gated on !mobile (not a UA platform sniff, which is
    // unreliable in CEF).
    if (denoiseOn && !isMobile) {
      console.log(`[Sion][mic] enable → denoise refresh (hadTrack=${!!micPub?.track})`);
      await refreshMicrophoneForDenoise(true);
    } else if (micPub?.track) {
      console.log("[Sion][mic] enable → track.unmute()");
      await micPub.track.unmute();
    } else {
      console.log("[Sion][mic] enable → setMicrophoneEnabled(true)");
      await currentRoom.localParticipant.setMicrophoneEnabled(true);
    }
  } else if (micPub?.track) {
    // mute keeps the track alive (works in Android background)
    await micPub.track.mute();
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
    startSpeakingDetectorForStream(currentRoom.localParticipant.identity, micPub!.trackSid, new MediaStream([mst]));
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
  const prev = isCurrentlyDeafened;
  isCurrentlyDeafened = deafened;
  console.log(`[Sion][deafen] setDeafened(${deafened}) — was=${prev}, elements=${audioElements.size}`);
  // Mute/unmute all existing audio elements. Mirror the attach-time
  // suppression (property + attribute + volume) so runtime toggles match
  // the guarantees applied at track-attach time.
  audioElements.forEach((el, sid) => {
    setElementMuted(el, deafened);
    // CEF/Chromium does NOT reliably silence a MediaStream <audio> via
    // el.muted/volume=0 — the WebRTC track keeps playing. Gate the track too
    // (as per-participant mute does). On un-deafen, only re-enable if the user
    // hasn't locally muted this peer.
    const pid = el.dataset.participantId;
    setElementTrackEnabled(el, deafened ? false : !(pid && locallyMutedIdentities.has(pid)));
    // setElementMuted forced volume→1 / muted→false on un-deafen; restore the
    // viewer's per-share audio choice for screen-share-audio elements.
    if (!deafened && pid && el.dataset.trackSource === Track.Source.ScreenShareAudio) {
      const vol = desiredScreenShareVolume(pid);
      setElementMuted(el, vol === 0);
      el.volume = vol;
    }
    console.log(`[Sion][deafen]   → sid=${sid} pid=${pid} src=${el.dataset.trackSource} muted=${el.muted} vol=${el.volume}`);
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
    if (cursorCallback === callback) {
      cursorCallback = null;
      if (cursorSweepTimer) {
        clearInterval(cursorSweepTimer);
        cursorSweepTimer = null;
      }
    }
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
 *  stops wrapping) based on the current aiNoiseSuppression setting.
 *
 *  Why not `setMicrophoneEnabled(false)` → `(true)` like updateAudioProcessing?
 *  That works only when `audioCaptureDefaults` changed first — LK uses the
 *  diff to decide whether to invoke getUserMedia again. Toggling AI denoise
 *  doesn't change any Chromium-level constraint (the wrap happens in JS via
 *  our cefAudioShim hook on getUserMedia), so LK's cached track is reused
 *  and getUserMedia is never re-called → the shim never re-wraps → RNNoise
 *  stays passthrough. Confirmed in prod by identical track UUIDs across the
 *  toggle cycle.
 *
 *  Force the issue: explicitly `unpublishTrack(track, stopOnUnpublish=true)`,
 *  which actually stops the underlying MediaStreamTrack and frees the
 *  device. Then `createLocalAudioTrack` invokes getUserMedia from scratch,
 *  the shim runs, and `publishTrack` sends the fresh track up. The
 *  generator's `ended` event from the stop cascades into the previous
 *  denoise pump's `cancel()` (safety net landed in v1.0.0), so no pump
 *  leak. */
export async function refreshMicrophoneForDenoise(force = false) {
  if (!currentRoom) return;
  const lp = currentRoom.localParticipant;
  // `force` is used by the un-mute path (the mic may read as disabled while
  // muted) — there we explicitly WANT to (re)publish a fresh track.
  if (!force && !lp.isMicrophoneEnabled) return;
  try {
    const micPub = lp.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track) {
      await lp.unpublishTrack(micPub.track, true);
    }
    const { createLocalAudioTrack } = await import("livekit-client");
    const newTrack = await createLocalAudioTrack(currentRoom.options.audioCaptureDefaults);
    await lp.publishTrack(newTrack, {
      source: Track.Source.Microphone,
      audioPreset: currentRoom.options.publishDefaults?.audioPreset,
    });
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

export async function toggleScreenShare(enabled: boolean, opts?: { sourceId?: string }) {
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

  // Capture system audio via our own Rust path (and publish a separate
  // ScreenShareAudio LocalTrack) on BOTH Linux and Windows, instead of
  // Chromium's `systemAudio: "include"`:
  //  - Linux: xdg-desktop-portal-kde has no "include audio" checkbox and
  //    Chromium filters PulseAudio monitors → `include` yields silence. We
  //    capture via parec (null-sink, excludes Sion).
  //  - Windows: `include` captures ALL render audio INCLUDING Sion's own
  //    voice chat → echo/doublon for peers. Our WASAPI process-loopback path
  //    (AUDCLNT_PROCESSLOOPBACK_EXCLUDE) excludes Sion's process → no echo.
  // macOS keeps the native `include` path (works, no echo issue there).
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const useOwnSystemAudio = wantAudio && (ua.includes("Linux") || ua.includes("Windows"));

  // AEC/NS/AGC must be OFF for screen-share audio on platforms where it is
  // handled by Chromium (Windows). With default constraints Chromium applies
  // echo cancellation which, on a loopback capture, cancels the signal
  // against itself. Passing an object is fine — what matters is the three
  // flags. On Linux we pass `audio: false` and handle audio ourselves.
  const audioCaptureConstraints: boolean | MediaTrackConstraints =
    wantAudio && !useOwnSystemAudio
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
  // On Windows/CEF the Chrome source-picker UI crashes (stop/focus) and the
  // auto-grant fallback captures EVERY monitor at once. So on Windows we capture
  // a single chosen monitor ourselves via the legacy getUserMedia desktop
  // constraint (`chromeMediaSourceId: "screen:N:0"`) and publish the track
  // directly. Linux (xdg portal), macOS (native picker) and web keep
  // getDisplayMedia via setScreenShareEnabled.
  const isWindows = ua.includes("Windows");
  const isTauriDesktop =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const useManualSource = enabled && isWindows && isTauriDesktop;

  const appStore = (await import("../stores/useAppStore")).useAppStore;
  if (enabled) {
    if (useManualSource) {
      const sourceId = opts?.sourceId ?? settings.screenShareSourceId ?? "screen:0:0";
      const { LocalVideoTrack } = await import("livekit-client");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = preset as any;
      const maxWidth = p.width ?? 1920;
      const maxHeight = p.height ?? 1080;
      const maxFrameRate = p.encoding?.maxFramerate ?? settings.screenShareFramerate;
      // Legacy Chromium desktop constraint — the only way in CEF to target ONE
      // source (a specific media ID); without it CEF "shares everything".
      // Capture VIDEO only — system audio still rides our WASAPI path below.
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxWidth,
            maxHeight,
            maxFrameRate,
          },
        },
      } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mst = stream.getVideoTracks()[0];
      const videoTrack = new LocalVideoTrack(mst);
      manualScreenPublication = await currentRoom.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        name: "screen",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        videoEncoding: p.encoding,
        simulcast: false,
        degradationPreference: "maintain-resolution",
      });
      // Clean up if the capture ends on its own (monitor unplugged). Guard
      // against re-entry: the stop path nulls the publication before stopping
      // the track, so this fires harmlessly there.
      const onEnded = () => {
        mst.removeEventListener("ended", onEnded);
        if (manualScreenPublication) {
          toggleScreenShare(false).catch(() => { /* best-effort */ });
          appStore.setState({ isScreenSharing: false });
        }
      };
      mst.addEventListener("ended", onEnded);
      console.log(`[Sion][Share] manual desktop capture published (${sourceId} ${maxWidth}x${maxHeight}@${maxFrameRate})`);
    } else {
      await currentRoom.localParticipant.setScreenShareEnabled(
        enabled,
        {
          audio: audioCaptureConstraints,
          ...(wantAudio && !useOwnSystemAudio ? { systemAudio: "include" as const } : {}),
          resolution: preset,
        },
        {
          audioPreset,
          red: false,
          dtx: false,
        },
      );
    }

    // Own system-audio publish (Linux parec / Windows WASAPI), after the video
    // share is up. We do this AFTER setScreenShareEnabled so the SDP already
    // has the screen-share video m-line — adding the audio track now
    // renegotiates cleanly with the correct Opus fmtp.
    if (useOwnSystemAudio) {
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
        // otherwise the capture keeps running and the publication stays alive
        // while the user thinks the share is over.
        // The manual Windows path attaches its own "ended" listener above; only
        // the native (setScreenShareEnabled) path needs one wired here.
        if (!useManualSource) {
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
        }
      } catch (e) {
        // On Windows this is most often build < 20348 (no process-loopback
        // exclude). We don't fall back to systemAudio:"include" — that would
        // re-introduce the Sion echo the user is trying to avoid.
        console.warn("[Sion][Share] system-audio capture failed:", e);
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
    if (manualScreenPublication) {
      // Manual Windows capture: setScreenShareEnabled(false) doesn't know about
      // this track. Null the handle FIRST so the track's "ended" listener won't
      // re-enter, then unpublish (and stop the capture).
      const pub = manualScreenPublication;
      manualScreenPublication = null;
      try {
        if (pub.track) await currentRoom.localParticipant.unpublishTrack(pub.track, true);
      } catch (e) {
        console.warn("[Sion][Share] unpublish manual screen track failed:", e);
      }
    } else {
      await currentRoom.localParticipant.setScreenShareEnabled(false);
    }
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
        const remoteDeaf = parsed.deafened === true;
        remoteDeafenState.set(participant.identity, remoteDeaf);
        let snapshot = "";
        for (const [sid, el] of audioElements) {
          if (el.dataset.participantId === participant.identity) {
            snapshot += ` [sid=${sid} src=${el.dataset.trackSource} muted=${el.muted} vol=${el.volume}]`;
          }
        }
        console.log(`[Sion][deafen] AFK rx pid=${participant.identity} remoteDeafened=${remoteDeaf} — selfDeafened=${isCurrentlyDeafened} elements:${snapshot || " (none)"}`);
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
    // Per-participant local mute is the only per-peer Set not otherwise purged
    // on leave — a peer who left should not keep a stale local-mute entry.
    locallyMutedIdentities.delete(p.identity);
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
