export interface LiveKitConfig {
  url: string;
  token: string;
  roomName: string;
}

export type ConnectionQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export interface ParticipantInfo {
  identity: string;
  name: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
  /** The sharer also publishes screen audio (`ScreenshareAudio track).
   *  Drives the 🔊/🔇 control. Undefined (JS path without share) = no audio. */
  isScreenSharingAudio?: boolean;
  /** Remote participant has explicitly toggled deafen ("AFK"); broadcast via LiveKit metadata. */
  isDeafened: boolean;
  audioLevel: number;
  connectionQuality: ConnectionQuality;
  /** Emoji currently displayed on the avatar while a soundboard sound plays.
   *  Falls back to 🔊 when the sound has no emoji. Undefined when idle. */
  playingSoundEmoji?: string;
}
