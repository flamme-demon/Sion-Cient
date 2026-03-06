export interface LiveKitConfig {
  url: string;
  token: string;
  roomName: string;
}

export interface ParticipantInfo {
  identity: string;
  name: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
  audioLevel: number;
}
