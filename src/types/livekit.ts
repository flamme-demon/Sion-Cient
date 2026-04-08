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
  audioLevel: number;
  connectionQuality: ConnectionQuality;
}
