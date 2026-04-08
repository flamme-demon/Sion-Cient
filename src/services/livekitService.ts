import {
  Room,
  RoomEvent,
  Track,
  AudioPresets,
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
function ensureAutoplayUnlock() {
  if (autoplayUnlocked) return;
  const unlock = () => {
    autoplayUnlocked = true;
    audioElements.forEach((el) => {
      if (el.paused) el.play().catch(() => {});
    });
    document.removeEventListener("click", unlock);
    document.removeEventListener("touchstart", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("click", unlock, { once: false });
  document.addEventListener("touchstart", unlock, { once: false });
  document.addEventListener("keydown", unlock, { once: false });
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
  }

  // Attach audio tracks from participants already in the room
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      if (pub.track && pub.track.kind === Track.Kind.Audio && pub.isSubscribed) {
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
    screenShareCallback?.(null);
    screenShareCallback = null;
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
  await currentRoom.switchActiveDevice("audioinput", deviceId);
}

export async function switchAudioOutput(deviceId: string) {
  if (!currentRoom) return;
  await currentRoom.switchActiveDevice("audiooutput", deviceId);
}

export function setDeafened(deafened: boolean) {
  isCurrentlyDeafened = deafened;
  // Mute/unmute all existing audio elements
  audioElements.forEach((el) => {
    el.muted = deafened;
  });
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
  await currentRoom.localParticipant.setScreenShareEnabled(enabled);
}

export function getParticipants(): ParticipantInfo[] {
  if (!currentRoom) return [];

  const participants: ParticipantInfo[] = [];

  const mapParticipant = (p: RemoteParticipant | LocalParticipant): ParticipantInfo => ({
    identity: p.identity,
    name: p.name || p.identity,
    // Use our client-side speaking detector instead of LiveKit SFU's smoothed
    // server-side state, which has ~1.6s of debounce.
    isSpeaking: speakingState.get(p.identity) || false,
    isMuted: !p.isMicrophoneEnabled,
    isScreenSharing: p.isScreenShareEnabled,
    audioLevel: p.audioLevel,
    connectionQuality: mapConnectionQuality(p.connectionQuality),
  });

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
    currentRoom.off(RoomEvent.LocalTrackPublished, update);
    currentRoom.off(RoomEvent.LocalTrackUnpublished, update);
  };
}
