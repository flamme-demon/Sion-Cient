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
import type { ParticipantInfo } from "../types/livekit";
import { useSettingsStore, type AudioQualityPreset } from "../stores/useSettingsStore";


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

function attachAudioTrack(track: RemoteTrack, publication: RemoteTrackPublication, _participant: RemoteParticipant) {
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
}

function detachAudioTrack(track: RemoteTrack, publication: RemoteTrackPublication, _participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const sid = publication.trackSid;
  const el = audioElements.get(sid);
  if (el) {
    track.detach(el);
    el.remove();
    audioElements.delete(sid);
  }
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
    detachAllAudio();
    await currentRoom.disconnect();
    currentRoom = null;
  }
}

export async function toggleMicrophone(enabled: boolean) {
  if (!currentRoom) return;
  await currentRoom.localParticipant.setMicrophoneEnabled(enabled);
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
    isSpeaking: p.isSpeaking,
    isMuted: !p.isMicrophoneEnabled,
    isScreenSharing: p.isScreenShareEnabled,
    audioLevel: p.audioLevel,
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

  // Remote participant events
  currentRoom.on(RoomEvent.ParticipantConnected, update);
  currentRoom.on(RoomEvent.ParticipantDisconnected, update);
  currentRoom.on(RoomEvent.ActiveSpeakersChanged, update);
  currentRoom.on(RoomEvent.TrackSubscribed, update);
  currentRoom.on(RoomEvent.TrackUnsubscribed, update);
  currentRoom.on(RoomEvent.TrackMuted, update);
  currentRoom.on(RoomEvent.TrackUnmuted, update);

  // Local participant events
  currentRoom.on(RoomEvent.LocalTrackPublished, update);
  currentRoom.on(RoomEvent.LocalTrackUnpublished, update);

  // Initial update
  update();

  return () => {
    if (!currentRoom) return;
    currentRoom.off(RoomEvent.ParticipantConnected, update);
    currentRoom.off(RoomEvent.ParticipantDisconnected, update);
    currentRoom.off(RoomEvent.ActiveSpeakersChanged, update);
    currentRoom.off(RoomEvent.TrackSubscribed, update);
    currentRoom.off(RoomEvent.TrackUnsubscribed, update);
    currentRoom.off(RoomEvent.TrackMuted, update);
    currentRoom.off(RoomEvent.TrackUnmuted, update);
    currentRoom.off(RoomEvent.LocalTrackPublished, update);
    currentRoom.off(RoomEvent.LocalTrackUnpublished, update);
  };
}
