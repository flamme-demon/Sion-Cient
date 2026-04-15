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
  type BaseKeyProvider,
  type AudioPreset,
} from "livekit-client";
import type { ParticipantInfo, ConnectionQuality as SionConnectionQuality } from "../types/livekit";
import { useSettingsStore, type AudioQualityPreset } from "../stores/useSettingsStore";
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
let isCurrentlyDeafened = false;
// Map of remote audio elements: trackSid -> HTMLAudioElement
const audioElements = new Map<string, HTMLAudioElement>();

// Client-side speaking detection (bypasses SFU smoothing for low-latency
// speaker indicator). Keyed by participant identity.
const speakingDetectors = new Map<string, SpeakingDetector>();
const speakingState = new Map<string, boolean>();
let participantUpdateCallback: (() => void) | null = null;
let pendingTimerCleanup: (() => void) | null = null;

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

// ── E2EE MissingKey auto-recovery ──────────────────────────────────────
// When a participant's encryption key is missing (stale session, reconnect,
// long-running connection), we detect the repeated MissingKey errors and
// trigger a recovery: first re-emit keys, then if that fails, a full
// LiveKit reconnect cycle.
// We no longer do any application-level "recovery" on MissingKey: aligning
// with Element Call's approach, we trust LiveKit's ratchet window and
// matrix-js-sdk's to-device retry semantics to absorb transient drift.
// This handler only logs for diagnostics — do NOT trigger leave/rejoin or
// any other action, otherwise we build feedback loops where each rejoin
// rotates the peer's key and creates a new MissingKey.
let missingKeyCount = 0;

function resetMissingKeyState() {
  missingKeyCount = 0;
}

function onE2EEError(error: Error) {
  if (!error.message?.includes("missing key") && !error.message?.includes("MissingKey")) return;
  missingKeyCount++;
  // Only surface the warning every few errors to avoid spamming the console.
  if (missingKeyCount === 1 || missingKeyCount % 20 === 0) {
    console.warn(`[Sion][E2EE] MissingKey #${missingKeyCount}: ${error.message}`);
  }
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
}

let screenShareCallback: ((info: ScreenShareInfo | null) => void) | null = null;

function handleScreenShareSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
    screenShareCallback?.({
      track,
      participantIdentity: participant.identity,
      participantName: participant.name || participant.identity,
    });
  }
}

function handleScreenShareUnsubscribed(track: RemoteTrack, publication: RemoteTrackPublication, _participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
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
            participantName: participant.name || participant.identity,
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
  if (audioElements.has(sid)) return;

  const el = track.attach();
  el.id = `sion-audio-${sid}`;
  el.style.display = "none";
  // Respect current deafen state
  el.muted = isCurrentlyDeafened;
  document.body.appendChild(el);
  audioElements.set(sid, el);

  const setupSpeakingDetectorOnce = () => {
    // Client-side speaking detection — bypasses SFU smoothing.
    // CRITICAL: cloning a remote RTCRtpReceiver track does NOT produce a
    // functional independent track in Chromium — the clone reports readyState
    // "live" but never delivers samples to the AnalyserNode (verified in CEF
    // logs). The correct approach is HTMLMediaElement.captureStream(), which
    // taps the audio element's RENDERED output and returns a fresh MediaStream
    // whose samples actually flow through Web Audio.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured: MediaStream | undefined = (el as any).captureStream?.()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      || (el as any).mozCaptureStream?.();
    if (captured && captured.getAudioTracks().length > 0) {
      startSpeakingDetectorForStream(participant.identity, captured);
    } else {
      console.warn("[Sion] captureStream() returned no audio tracks for", participant.identity);
    }
  };

  // Try to play, then set up the detector once playback has actually started.
  // captureStream() before the element is playing returns a stream with no
  // audio tracks in Chromium.
  el.play()
    .then(setupSpeakingDetectorOnce)
    .catch(() => {
      ensureAutoplayUnlock();
      // Fall back: try to set up the detector anyway after a short delay,
      // in case the play() rejection was non-fatal.
      setTimeout(setupSpeakingDetectorOnce, 500);
    });
}

function detachAudioTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const sid = publication.trackSid;
  const el = audioElements.get(sid);
  if (el) {
    track.detach(el);
    el.remove();
    audioElements.delete(sid);
  }
  stopSpeakingDetector(participant.identity);
}

function detachAllAudio() {
  audioElements.forEach((el) => el.remove());
  audioElements.clear();
}

export async function connectToRoom(
  url: string,
  token: string,
  e2eeKeyProvider?: BaseKeyProvider,
): Promise<Room> {
  const { noiseSuppression, echoCancellation, autoGainControl, audioQuality, audioInputDevice, audioOutputDevice } = useSettingsStore.getState();
  const audioPreset = getAudioPreset(audioQuality);
  const stereo = isStereoPreset(audioQuality);

  const roomOptions: ConstructorParameters<typeof Room>[0] = {
    audioCaptureDefaults: {
      noiseSuppression,
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
    roomOptions.e2ee = {
      keyProvider: e2eeKeyProvider,
      worker: new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url),
        { type: "module" },
      ),
    };
  }

  const room = new Room(roomOptions);

  // Attach remote audio tracks for playback
  room.on(RoomEvent.TrackSubscribed, attachAudioTrack);
  room.on(RoomEvent.TrackUnsubscribed, detachAudioTrack);

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
      if (pub.kind !== Track.Kind.Audio) return;
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
    });
  });

  // Activer le microphone par défaut (comme TeamSpeak)
  try {
    await room.localParticipant.setMicrophoneEnabled(true);
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

  return room;
}

export function getCurrentRoom(): Room | null {
  return currentRoom;
}

export function muteRemoteParticipant(participantIdentity: string, mute: boolean): boolean {
  if (!currentRoom) return false;
  const participant = currentRoom.remoteParticipants.get(participantIdentity);
  if (!participant) return false;
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
    resetMissingKeyState();
    pendingTimerCleanup?.();
    pendingTimerCleanup = null;
    stopAllSpeakingDetectors();
    detachAllAudio();
    await currentRoom.disconnect();
    currentRoom = null;
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
  // Mute/unmute all existing audio elements
  audioElements.forEach((el) => {
    el.muted = deafened;
  });
  // Propagate the deafened (AFK) state to other participants via LiveKit
  // participant metadata. Subscribers display this as an AFK indicator
  // distinct from the regular "muted mic" icon.
  if (currentRoom) {
    try {
      const meta = JSON.stringify({ deafened });
      currentRoom.localParticipant.setMetadata(meta).catch((err) => {
        console.warn("[Sion] Failed to broadcast deafened state:", err);
      });
    } catch (err) {
      console.warn("[Sion] setMetadata threw:", err);
    }
  }
}

export async function updateAudioProcessing(options: {
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}) {
  if (!currentRoom) return;

  const micTrack = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!micTrack?.track?.mediaStreamTrack) return;

  const constraints: MediaTrackConstraints = {};
  if (options.noiseSuppression !== undefined) constraints.noiseSuppression = options.noiseSuppression;
  if (options.echoCancellation !== undefined) constraints.echoCancellation = options.echoCancellation;
  if (options.autoGainControl !== undefined) constraints.autoGainControl = options.autoGainControl;

  try {
    await micTrack.track.mediaStreamTrack.applyConstraints(constraints);
  } catch (err) {
    console.warn("[Sion] Failed to update audio constraints:", err);
  }
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
  // audio: true enables capture of the shared stream's audio (tab audio).
  // systemAudio: 'include' asks the browser/portal to offer system audio as an
  // option in the picker — without it, Chromium-based runtimes (including CEF)
  // default to tab-audio-only, and on Linux KDE Wayland the portal never
  // exposes an audio checkbox to the user at all.
  await currentRoom.localParticipant.setScreenShareEnabled(enabled, {
    audio: true,
    systemAudio: "include",
  });
}

export function getParticipants(): ParticipantInfo[] {
  if (!currentRoom) return [];

  const participants: ParticipantInfo[] = [];

  const mapParticipant = (p: RemoteParticipant | LocalParticipant): ParticipantInfo => {
    // Read deafen/AFK state from participant metadata (broadcast via setMetadata).
    let isDeafened = false;
    if (p.metadata) {
      try {
        const parsed = JSON.parse(p.metadata) as { deafened?: boolean };
        isDeafened = parsed.deafened === true;
      } catch { /* metadata is non-JSON; ignore */ }
    }
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
  // Metadata changes — used to broadcast the AFK/deafened state across peers
  currentRoom.on(RoomEvent.ParticipantMetadataChanged, update);

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
    currentRoom.off(RoomEvent.ParticipantMetadataChanged, update);
    currentRoom.off(RoomEvent.LocalTrackPublished, update);
    currentRoom.off(RoomEvent.LocalTrackUnpublished, update);
  };
}
