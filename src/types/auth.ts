export interface AuthCredentials {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  displayName?: string;
  avatarUrl?: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}