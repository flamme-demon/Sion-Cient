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
  /** Remote participant has explicitly toggled deafen ("AFK"); broadcast via LiveKit metadata. */
  isDeafened: boolean;
  audioLevel: number;
  connectionQuality: ConnectionQuality;
}
