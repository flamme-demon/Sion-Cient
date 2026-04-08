export type UserRole = "admin" | "mod" | "user";

export interface MatrixUser {
  id: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
  presence?: "online" | "offline" | "unavailable";
}

export interface VoiceChannelUser extends MatrixUser {
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  /** LiveKit-reported connection quality. Undefined when offline / not in voice. */
  connectionQuality?: "excellent" | "good" | "poor" | "lost" | "unknown";
}

export interface Channel {
  id: string;
  name: string;
  topic?: string;
  icon?: string;
  hasVoice: boolean;
  voiceUsers: VoiceChannelUser[];
  createdAt: number;
  lastActivity: number;
  isDM?: boolean;
  dmUserId?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** URL HTTP directe (non-chiffré) ou URL HTTP du contenu chiffré (si encryptedFile présent) */
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Présent si le fichier est chiffré E2EE — nécessite décryption avant affichage */
  encryptedFile?: {
    url: string;
    key: { alg: string; key_ops: string[]; kty: string; k: string; ext: boolean };
    iv: string;
    hashes: Record<string, string>;
    v: string;
  };
}

export interface ChatMessage {
  id: number | string;
  /** Matrix event ID */
  eventId?: string;
  /** Matrix user ID (e.g., @user:server.com) */
  senderId?: string;
  /** Display name for the user */
  user: string;
  role: UserRole;
  avatarUrl?: string;
  time: string;
  /** Original event timestamp in milliseconds — used for day separators */
  ts?: number;
  text: string;
  /** HTML formatted body (org.matrix.custom.html) */
  formattedBody?: string;
  /** Message type (m.text, m.notice, m.emote) */
  msgtype?: string;
  attachments?: FileAttachment[];
  /** Whether this message has been edited */
  edited?: boolean;
  /** Reply reference */
  replyTo?: { eventId: string; senderId?: string; user?: string; text?: string };
  /** Reactions on this message */
  reactions?: { emoji: string; count: number; userIds: string[]; eventIds: Record<string, string> }[];
}

export interface ServerData {
  name: string;
  channels: Channel[];
}

export interface AdminSection {
  id: string;
  label: string;
  items: AdminItem[];
}

export interface AdminItem {
  label: string;
  value: string;
  color?: string;
}

export interface AdminAction {
  label: string;
  icon: string;
}
