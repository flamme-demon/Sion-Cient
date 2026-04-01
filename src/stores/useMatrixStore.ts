import { create } from "zustand";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, MatrixEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent, RoomStateEvent, HttpApiEvent } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import type { VerificationRequest, ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api/verification";
import { VerificationPhase, VerifierEvent, VerificationRequestEvent } from "matrix-js-sdk/lib/crypto-api/verification";
import type { ChatMessage, Channel, FileAttachment, VoiceChannelUser } from "../types/matrix";
import * as matrixService from "../services/matrixService";
import { useAppStore } from "./useAppStore";
import { useSettingsStore } from "./useSettingsStore";
import { setCachedRoom, appendCachedEventIds, clearCache } from "../utils/messageCache";
import { playMessageReceived } from "../services/soundService";

export type VerificationStep =
  | "idle"           // No verification in progress
  | "requesting"     // Sending request to other devices
  | "waiting"        // Waiting for other device to accept
  | "comparing"      // Emojis shown, waiting for user to confirm
  | "confirmed"      // User confirmed, waiting for other device
  | "done"           // Verification completed
  | "cancelled"      // Verification cancelled
  | "error";         // Error occurred

export interface EmojiData {
  emoji: string;
  name: string;
}

interface MatrixState {
  channels: Channel[];
  messages: Record<string, ChatMessage[]>;
  roomHasMore: Record<string, boolean>;
  roomLoadingHistory: Record<string, boolean>;
  roomPaginationFrom: Record<string, string>;
  connectionStatus: "disconnected" | "connecting" | "connected" | "error";
  currentUserId: string | null;
  needsVerification: boolean;
  isRestoringKeys: boolean;
  hasUndecryptableMessages: boolean;
  pinnedVersion: number;

  // E2EE bootstrap
  bootstrapStep: "idle" | "bootstrapping" | "showRecoveryKey" | "done";
  generatedRecoveryKey: string | null;

  // Cross-device verification
  verificationStep: VerificationStep;
  verificationEmojis: EmojiData[];
  verificationError: string | null;

  bootstrapE2EE: (password?: string) => Promise<void>;
  dismissRecoveryKey: () => void;
  initSync: (client: MatrixClient) => void;
  loadRoomHistory: (roomId: string) => Promise<void>;
  reloadAllMessages: () => void;
  restoreWithRecoveryKey: (recoveryKey: string) => Promise<void>;
  startCrossDeviceVerification: () => Promise<void>;
  confirmVerificationEmojis: () => Promise<void>;
  rejectVerificationEmojis: () => void;
  cancelVerification: () => void;
  sendMessage: (channelId: string, text: string) => Promise<void>;
  sendReply: (channelId: string, inReplyToEventId: string, text: string) => Promise<void>;
  sendFile: (channelId: string, file: File) => Promise<void>;
  editMessage: (channelId: string, eventId: string, newText: string) => Promise<void>;
  deleteMessage: (channelId: string, eventId: string) => Promise<void>;
  setChannels: (channels: Channel[]) => void;
  setConnectionStatus: (status: MatrixState["connectionStatus"]) => void;
  dismissVerification: () => void;
  reset: () => void;
}

// Internal references for the active verification flow
let activeVerificationRequest: VerificationRequest | null = null;
let activeSasCallbacks: ShowSasCallbacks | null = null;

// Strip Matrix reply fallback from body text (lines starting with "> " until first blank line)
function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) i++;
  // Skip the blank line after the fallback
  if (i > 0 && i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

// Strip <mx-reply>...</mx-reply> from formatted HTML
function stripMxReply(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "");
}

// Get display name from user ID, fallback to user ID without @ prefix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDisplayName(sender: string, room: any, client: MatrixClient | null): string {
  // Try to get the room member's display name
  if (room) {
    const member = room.getMember?.(sender);
    if (member?.name) return member.name;
  }
  // Fallback: try to get from user profile
  if (client) {
    const user = client.getUser?.(sender);
    if (user?.displayName) return user.displayName;
  }
  // Last resort: extract localpart from Matrix ID (@user:server.com → user)
  const match = sender.match(/^@([^:]+):/);
  return match ? match[1] : sender;
}

// Get avatar URL from user ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAvatarFromSender(sender: string, room: any, client: MatrixClient | null): string | undefined {
  if (room) {
    const member = room.getMember?.(sender);
    // Try to get avatar from member events
    if (member?.events?.member?.getContent?.()?.avatar_url) {
      const mxc = member.events.member.getContent().avatar_url;
      if (mxc && client) return client.mxcUrlToHttp?.(mxc) || undefined;
    }
  }
  if (client) {
    const user = client.getUser?.(sender);
    if (user?.avatarUrl) return client.mxcUrlToHttp?.(user.avatarUrl) || undefined;
  }
  return undefined;
}

// Extract voice users from MatrixRTC call member state events (visible without joining the call)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractVoiceUsers(room: any, client: MatrixClient | null): VoiceChannelUser[] {
  const callMemberEvents = room.currentState?.getStateEvents?.("org.matrix.msc3401.call.member") || [];
  const events = Array.isArray(callMemberEvents) ? callMemberEvents : [callMemberEvents];
  const seenUserIds = new Set<string>();
  const users: VoiceChannelUser[] = [];

  for (const event of events) {
    if (!event?.getContent) continue;
    const content = event.getContent();
    const stateKey = event.getStateKey?.();

    // Determine if this user is active in the call:
    // - New per-device format (MSC4143): content has {application, device_id, ...} directly — empty {} means left
    // - Old format: content has memberships[] array — empty array means left
    // In both cases, check expiration (expires_ts absolute or origin_server_ts + expires relative)
    const now = Date.now();
    const memberships = content?.memberships;

    let hasOldFormatActive = false;
    if (Array.isArray(memberships) && memberships.length > 0) {
      // Filter out expired memberships
      const originTs: number = event.getTs?.() || 0;
      hasOldFormatActive = memberships.some((m: any) => {
        if (m.expires_ts) return m.expires_ts > now;
        if (m.expires && originTs) return originTs + m.expires > now;
        return true; // No expiry info — assume active
      });
    }

    let hasNewFormatActive = false;
    if (!memberships && !!content?.application && !!content?.device_id) {
      const originTs: number = event.getTs?.() || 0;
      if (content.expires_ts) {
        hasNewFormatActive = content.expires_ts > now;
      } else if (content.expires && originTs) {
        hasNewFormatActive = originTs + content.expires > now;
      } else {
        hasNewFormatActive = true; // No expiry info — assume active
      }
    }

    if (!hasOldFormatActive && !hasNewFormatActive) continue;

    // state_key format: "_@user:server_deviceId_m.call" — use getSender() for userId
    // For per-device format, also extract from state_key as fallback: _@user:server_deviceId_m.call
    const sender = event.getSender?.();
    const stateKeyStr: string = stateKey || "";
    const stateKeyMatch = stateKeyStr.match(/^_(@[^_]+)/);
    const userId = sender || (stateKeyMatch ? stateKeyMatch[1] : null);
    if (!userId || seenUserIds.has(userId)) continue;
    seenUserIds.add(userId);

    users.push({
      id: userId,
      name: getDisplayName(userId, room, client),
      role: "user",
      avatarUrl: getAvatarFromSender(userId, room, client),
      speaking: false,
      muted: false,
      deafened: false,
    });
  }

  return users;
}

/** Filter rooms to only include those where the user has joined membership */
function getJoinedRooms(client: MatrixClient): ReturnType<MatrixClient["getRooms"]> {
  return client.getRooms()
    .filter((room) => {
      const userId = client.getUserId();
      if (!userId) return true;
      const member = room.getMember(userId);
      return member?.membership === "join";
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRoomToChannel(room: any, client: MatrixClient | null = null): Channel {
  const topic = room.currentState?.getStateEvents?.("m.room.topic", "")?.getContent?.()?.topic || "";
  const createEvent = room.currentState?.getStateEvents?.("m.room.create", "");
  const createContent = createEvent?.getContent?.() || {};
  const roomType: string = createContent.type || "";
  const typeEvent = room.currentState?.getStateEvents?.("m.room.type", "");
  const customType: string = typeEvent?.getContent?.()?.type || "";

  // Detect MatrixRTC / Element Call rooms (org.matrix.msc3401.call.member state events)
  // Only consider members with active content (non-empty, with application+device_id or memberships[])
  const callMemberEvents = room.currentState?.getStateEvents?.("org.matrix.msc3401.call.member") || [];
  const callMemberArr = Array.isArray(callMemberEvents) ? callMemberEvents : [callMemberEvents];
  const hasCallMembers = callMemberArr.some((ev: any) => {
    if (!ev?.getContent) return false;
    const c = ev.getContent();
    if (!c || Object.keys(c).length === 0) return false;
    const memberships = c?.memberships;
    return (Array.isArray(memberships) && memberships.length > 0) || (!memberships && !!c?.application && !!c?.device_id);
  });

  // Also check for org.matrix.msc3401.call state event
  const callEvent = room.currentState?.getStateEvents?.("org.matrix.msc3401.call", "");
  const hasCallEvent = !!callEvent;

  const hasVoice =
    roomType.includes("voice") ||
    customType.includes("voice") ||
    topic.toLowerCase().includes("voice") ||
    roomType === "m.voice_channel" ||
    customType === "m.voice_channel" ||
    roomType === "org.matrix.msc3417.call" ||
    hasCallMembers ||
    hasCallEvent;

  // Room avatar (m.room.avatar state event)
  const avatarEvent = room.currentState?.getStateEvents?.("m.room.avatar", "");
  const avatarMxc: string = avatarEvent?.getContent?.()?.url || "";
  const icon = avatarMxc && client ? (client.mxcUrlToHttp(avatarMxc) || undefined) : undefined;

  const createdAt = createEvent?.getTs?.() || 0;
  const timeline = room.getLiveTimeline?.()?.getEvents?.() || [];
  const lastActivity = timeline.length > 0 ? timeline[timeline.length - 1].getTs() : 0;

  // Detect DM rooms via m.direct account data
  let isDM = false;
  let dmUserId: string | undefined;
  if (client) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const directEvent = client.getAccountData("m.direct" as any);
      if (directEvent) {
        const directContent = directEvent.getContent() as Record<string, string[]>;
        for (const [userId, roomIds] of Object.entries(directContent)) {
          if (roomIds.includes(room.roomId)) {
            isDM = true;
            dmUserId = userId;
            break;
          }
        }
      }
    } catch { /* ignore */ }

    // Fallback: si la room a 2 membres, pas de room.type, et pas de nom explicite → c'est un DM
    if (!isDM && room.getJoinedMemberCount() <= 2 && !roomType && !customType) {
      const myUserId = client.getUserId();
      const members = room.getJoinedMembers();
      const otherMember = members.find((m: any) => m.userId !== myUserId);
      if (otherMember && members.length === 2) {
        isDM = true;
        dmUserId = otherMember.userId;
      }
    }
  }

  return {
    id: room.roomId,
    name: room.name || room.getCanonicalAlias?.() || room.roomId,
    topic: topic || undefined,
    icon,
    hasVoice,
    voiceUsers: extractVoiceUsers(room, client),
    createdAt,
    lastActivity,
    isDM,
    dmUserId,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessagesFromEvents(events: any[], room: any, client: any): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const evt of events) {
    const type = evt.getType?.();

    // Show failed-to-decrypt messages as placeholders.
    // Skip still-encrypted events (type "m.room.encrypted") — they may be signaling events
    // (call.member, encryption_keys) not chat messages. They'll either decrypt later or
    // show as isDecryptionFailure once the SDK processes them.
    if (type === "m.room.message" && evt.isDecryptionFailure?.()) {
      const evtId = evt.getId?.() || String(Date.now());
      const senderId = evt.getSender?.() || "unknown";
      const sender = getDisplayName(senderId, room, client);
      const avatarUrl = getAvatarFromSender(senderId, room, client);
      const time = new Date(evt.getTs?.() || Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: "🔒 Message chiffré (clé de déchiffrement manquante)", msgtype: "m.encrypted", avatarUrl });
      continue;
    }

    if (type !== "m.room.message") continue;
    const content = evt.getContent?.();
    if (!content?.msgtype) continue;

    const msgtype: string = content.msgtype;
    const evtId = evt.getId?.() || String(Date.now());
    const senderId = evt.getSender?.() || "unknown";
    const sender = getDisplayName(senderId, room, client);
    const avatarUrl = getAvatarFromSender(senderId, room, client);
    const time = new Date(evt.getTs?.() || Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

    // Messages texte
    if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
      if (!content.body) continue;

      // Handle edit events (m.replace)
      const relatesTo = content["m.relates_to"];
      if (relatesTo?.rel_type === "m.replace" && relatesTo?.event_id) {
        const newContent = content["m.new_content"];
        const editedText = newContent?.body || content.body;
        const targetId = relatesTo.event_id;
        // Update existing message in place
        const existing = msgs.find((m) => m.id === targetId);
        if (existing) {
          existing.text = editedText;
          existing.formattedBody = newContent?.format === "org.matrix.custom.html" ? newContent.formatted_body : undefined;
          existing.edited = true;
        }
        continue;
      }

      // Parse reply reference
      let replyTo: ChatMessage["replyTo"];
      const inReplyTo = content["m.relates_to"]?.["m.in_reply_to"];
      if (inReplyTo?.event_id) {
        const replyEvtId = inReplyTo.event_id;
        const replyMsg = msgs.find((m) => m.id === replyEvtId);
        replyTo = {
          eventId: replyEvtId,
          senderId: replyMsg?.senderId,
          user: replyMsg?.user,
          text: replyMsg?.text,
        };
      }

      const rawBody = replyTo ? stripReplyFallback(content.body) : content.body;
      const rawFormatted = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
      const formattedBody = rawFormatted && replyTo ? stripMxReply(rawFormatted) : rawFormatted;
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: rawBody, formattedBody, msgtype, avatarUrl, replyTo });
      continue;
    }

    // Messages media (image, fichier, vidéo, audio)
    if (msgtype === "m.image" || msgtype === "m.file" || msgtype === "m.video" || msgtype === "m.audio") {
      // Pour E2EE : l'URL est dans content.file.url, sinon dans content.url
      const mxcUrl: string = content.url || content.file?.url || "";
      const httpUrl = mxcUrl ? matrixService.mxcToHttp(mxcUrl) : null;
      if (!httpUrl) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info: Record<string, any> = content.info || {};
      const mimeType = info.mimetype || (({ "m.image": "image/jpeg", "m.video": "video/mp4", "m.audio": "audio/mpeg" } as Record<string, string>)[msgtype] || "application/octet-stream");
      const attachment: FileAttachment = {
        id: evtId,
        name: content.body || "fichier",
        size: info.size || 0,
        mimeType,
        url: httpUrl,
        width: info.w,
        height: info.h,
        // Si chiffré E2EE (content.file présent), stocker les clés pour décryption au rendu
        encryptedFile: content.file ? { ...content.file } : undefined,
      };
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: "", attachments: [attachment], avatarUrl });
    }
  }
  // Parse reactions (m.annotation) and attach to messages
  for (const evt of events) {
    if (evt.getType?.() !== "m.reaction") continue;
    const rel = evt.getContent?.()?.["m.relates_to"];
    if (rel?.rel_type !== "m.annotation" || !rel?.event_id || !rel?.key) continue;
    const target = msgs.find((m) => m.id === rel.event_id);
    if (!target) continue;
    if (!target.reactions) target.reactions = [];
    const senderId = evt.getSender?.() || "";
    const reactionEvtId = evt.getId?.() || "";
    const existing = target.reactions.find((r) => r.emoji === rel.key);
    if (existing) {
      if (!existing.userIds.includes(senderId)) {
        existing.userIds.push(senderId);
        existing.count++;
      }
      existing.eventIds[senderId] = reactionEvtId;
    } else {
      target.reactions.push({ emoji: rel.key, count: 1, userIds: [senderId], eventIds: { [senderId]: reactionEvtId } });
    }
  }

  return msgs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessagesFromRoom(room: any): ChatMessage[] {
  const client = matrixService.getMatrixClient();
  const timeline = room.getLiveTimeline().getEvents();
  return extractMessagesFromEvents(timeline, room, client);
}

export const useMatrixStore = create<MatrixState>((set, get) => ({
  channels: [],
  messages: {},
  roomHasMore: {},
  roomLoadingHistory: {},
  roomPaginationFrom: {},
  connectionStatus: "disconnected",
  currentUserId: null,
  needsVerification: false,
  isRestoringKeys: false,
  hasUndecryptableMessages: false,
  pinnedVersion: 0,
  bootstrapStep: "idle",
  generatedRecoveryKey: null,
  verificationStep: "idle",
  verificationEmojis: [],
  verificationError: null,

  bootstrapE2EE: async (password?: string) => {
    set({ bootstrapStep: "bootstrapping" });
    try {
      const recoveryKey = await matrixService.bootstrapAll(password);
      set({ bootstrapStep: "showRecoveryKey", generatedRecoveryKey: recoveryKey, needsVerification: false });
    } catch (err) {
      console.error("[Sion] Bootstrap failed, falling back to verification banner:", err);
      set({ bootstrapStep: "idle", needsVerification: true });
    }
  },

  dismissRecoveryKey: () => {
    set({ bootstrapStep: "done", generatedRecoveryKey: null });
  },

  initSync: (client: MatrixClient) => {
    set({ connectionStatus: "connecting", currentUserId: client.getUserId() || null });

    // Detect token invalidation (e.g. revoked from another client)
    client.on(HttpApiEvent.SessionLoggedOut, () => {
      console.warn("[Sion] Session logged out (token revoked) — forcing logout");
      // Import dynamically to avoid circular dependency
      import("./useAuthStore").then(({ useAuthStore }) => {
        useAuthStore.getState().logout();
      });
    });

    let hasPrepared = false;
    let verificationChecked = false;

    client.on(ClientEvent.Sync, async (state: string) => {
      if (state === "PREPARED" && !hasPrepared) {
        hasPrepared = true;
        const rooms = getJoinedRooms(client);
        const channels = rooms.map((room) => mapRoomToChannel(room, client));

        // Collect initial messages from timeline
        const messages: Record<string, ChatMessage[]> = {};
        for (const room of rooms) {
          const msgs = extractMessagesFromRoom(room);
          if (msgs.length > 0) {
            messages[room.roomId] = msgs;
          }
        }

        set({ channels, connectionStatus: "connected", messages });

        // Auto-accept pending invites (received while offline)
        const invitedRooms = client.getRooms().filter((r) =>
          r.getMyMembership() === "invite"
        );
        for (const room of invitedRooms) {
          client.joinRoom(room.roomId).catch((err) => {
            console.error("[Sion] Failed to auto-join pending invite:", err);
          });
        }

        // Auto-select default channel (or first channel as fallback)
        const currentActive = useAppStore.getState().activeChannel;
        if ((!currentActive || currentActive === "") && channels.length > 0) {
          const { defaultChannel, autoJoinVoice } = useSettingsStore.getState();
          const defaultCh = channels.find((c) => c.id === defaultChannel)
            || channels.find((c) => !c.hasVoice)
            || channels[0];
          const prevMobileView = useAppStore.getState().mobileView;
          useAppStore.getState().setActiveChannel(defaultCh.id, defaultCh.hasVoice);
          useAppStore.getState().setMobileView(prevMobileView);

          // Auto-join voice if the default channel is a voice channel and option is enabled
          if (autoJoinVoice && defaultCh.hasVoice) {
            useAppStore.getState().setConnectedVoice(defaultCh.id);
          }
        }

        // Check device verification status — only show banner if crypto is ready but NOT verified
        const crypto = client.getCrypto();
        if (!crypto) {
        } else {
          verificationChecked = true;

          // Check if this is a first-time setup (no SSSS / cross-signing)
          const needsBootstrap = await matrixService.checkNeedsBootstrap();
          // Import password cache helpers
          const { getCachedLoginPassword, clearCachedLoginPassword } = await import("./useAuthStore");

          if (needsBootstrap) {
            const password = getCachedLoginPassword() || undefined;
            clearCachedLoginPassword();
            await get().bootstrapE2EE(password);
          } else {
            clearCachedLoginPassword();
            const isVerified = await matrixService.checkDeviceVerified();
            if (!isVerified) {
              set({ needsVerification: true });
            } else {
              // Try auto-restoring key backup (uses secrets received via cross-device verification)
              try {
                const restored = await matrixService.tryAutoRestoreKeyBackup();
                if (restored > 0) {
                  get().reloadAllMessages();
                }
              } catch (err) {
                console.warn("[Sion] Auto key backup restore failed:", err instanceof Error ? err.message : String(err));
              }
            }
          }
        }

      } else if (state === "SYNCING") {
        const rooms = getJoinedRooms(client);
        const channels = rooms.map((room) => mapRoomToChannel(room, client));
        set({ channels, connectionStatus: "connected" });

        // Retry verification check if crypto wasn't ready during PREPARED
        if (!verificationChecked && client.getCrypto()) {
          verificationChecked = true;
          const isVerified = await matrixService.checkDeviceVerified();
          if (!isVerified) {
            set({ needsVerification: true });
          } else {
            set({ needsVerification: false });
          }
        }
      } else if (state === "ERROR") {
        set({ connectionStatus: "error" });
      }
    });

    // Listen for key backup decryption key arriving via secret gossiping
    // This fires after cross-device verification when the other device sends the backup key
    client.on(CryptoEvent.KeyBackupDecryptionKeyCached, async (_version: string) => {
      set({ isRestoringKeys: true });
      try {
        const restored = await matrixService.tryAutoRestoreKeyBackup();
        if (restored > 0) {
          get().reloadAllMessages();
        }
      } catch (err) {
        console.warn("[Sion] Secret gossiping key restore failed:", err instanceof Error ? err.message : String(err));
      } finally {
        set({ isRestoringKeys: false });
      }
    });

    // Listen for incoming verification requests (e.g. initiated from Element)
    client.on(CryptoEvent.VerificationRequestReceived, async (request: VerificationRequest) => {
      const otherUserId = request.otherUserId;
      const myUserId = client.getUserId();
      // Only handle self-verification requests (same user, different device)
      if (otherUserId !== myUserId) {
        return;
      }
      // Ignore if we already have a verification in progress
      if (get().verificationStep !== "idle" && get().verificationStep !== "cancelled" && get().verificationStep !== "error" && get().verificationStep !== "done") {
        return;
      }
      // Ignore if we're currently bootstrapping (recovery key modal is showing)
      const bStep = get().bootstrapStep;
      if (bStep === "bootstrapping" || bStep === "showRecoveryKey") {
        return;
      }

      activeVerificationRequest = request;
      activeSasCallbacks = null;
      // Don't force needsVerification — only set verificationStep to drive the UI
      // If the device is already verified (e.g. after bootstrap), needsVerification stays false
      set({ verificationStep: "waiting", verificationError: null, verificationEmojis: [] });

      // Accept the request so the other device sees us as ready
      try {
        await request.accept();
      } catch (err) {
        console.error("[Sion] Failed to accept incoming verification:", err);
        set({ verificationStep: "error", verificationError: String(err) });
        return;
      }

      const cleanup = () => {
        request.off(VerificationRequestEvent.Change, onRequestChange);
        activeVerificationRequest = null;
        activeSasCallbacks = null;
      };

      const onRequestChange = async () => {
        const phase = request.phase;

        if (phase === VerificationPhase.Started) {
          // Other device started SAS — get the verifier
          try {
            const verifier = request.verifier;
            if (!verifier) {
              console.warn("[Sion] No verifier available after Started phase");
              return;
            }

            verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
              activeSasCallbacks = sas;
              const emojis: EmojiData[] = (sas.sas.emoji || []).map(([emoji, name]) => ({ emoji, name }));
              set({ verificationStep: "comparing", verificationEmojis: emojis });
            });

            verifier.on(VerifierEvent.Cancel, () => {
              set({ verificationStep: "cancelled" });
              cleanup();
            });

            verifier.verify().then(async () => {
              set({ verificationStep: "done", needsVerification: false });

              try {
                await matrixService.tryAutoRestoreKeyBackup();
              } catch (err) {
                console.warn("[Sion] Post-incoming-verification: auto key restore failed:", err);
              }

              get().reloadAllMessages();
              cleanup();
            }).catch((err) => {
              console.error("[Sion] Incoming verification verify() failed:", err);
              set({ verificationStep: "error", verificationError: String(err) });
              cleanup();
            });
          } catch (err) {
            console.error("[Sion] Failed to handle incoming SAS:", err);
            set({ verificationStep: "error", verificationError: String(err) });
            cleanup();
          }
        } else if (phase === VerificationPhase.Cancelled) {
          set({ verificationStep: "cancelled" });
          cleanup();
        } else if (phase === VerificationPhase.Done) {
          set({ verificationStep: "done", needsVerification: false });
          cleanup();
        }
      };

      request.on(VerificationRequestEvent.Change, onRequestChange);
    });

    // Request notification permission
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Listen for new messages and reactions (real-time)
    client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return;
      if (!room) return;

      // Handle reactions in real-time
      if (event.getType?.() === "m.reaction") {
        const rel = event.getContent?.()?.["m.relates_to"];
        if (rel?.rel_type === "m.annotation" && rel?.event_id && rel?.key) {
          const senderId = event.getSender?.() || "";
          let reactionEvtId = event.getId?.() || "";
          // Skip local/pending event IDs (start with ~ or contain :m)
          // They're not valid for server-side operations like redact
          if (reactionEvtId.startsWith("~")) reactionEvtId = "";
          set((s) => {
            const existing = s.messages[room.roomId] || [];
            const idx = existing.findIndex((m) => m.id === rel.event_id);
            if (idx === -1) return s;
            const updated = [...existing];
            const msg = { ...updated[idx] };
            const reactions = [...(msg.reactions || [])];
            const rIdx = reactions.findIndex((r) => r.emoji === rel.key);
            if (rIdx >= 0) {
              const r = { ...reactions[rIdx], userIds: [...reactions[rIdx].userIds], eventIds: { ...reactions[rIdx].eventIds } };
              if (!r.userIds.includes(senderId)) {
                r.userIds.push(senderId);
                r.count++;
              }
              if (reactionEvtId) r.eventIds[senderId] = reactionEvtId;
              reactions[rIdx] = r;
            } else {
              const eventIds: Record<string, string> = {};
              if (reactionEvtId) eventIds[senderId] = reactionEvtId;
              reactions.push({ emoji: rel.key as string, count: 1, userIds: [senderId], eventIds });
            }
            msg.reactions = reactions;
            updated[idx] = msg;
            return { messages: { ...s.messages, [room.roomId]: updated } };
          });

          // If we got a local ID, wait for the event to be sent and update with the real ID
          if (!reactionEvtId && senderId === client.getUserId()) {
            const origId = event.getId?.() || "";
            const onSent = () => {
              const realId = event.getId?.() || "";
              if (realId && realId !== origId && !realId.startsWith("~")) {
                set((s) => {
                  const msgs = s.messages[room.roomId] || [];
                  const mIdx = msgs.findIndex((m) => m.id === rel.event_id);
                  if (mIdx === -1) return s;
                  const updMsgs = [...msgs];
                  const m = { ...updMsgs[mIdx] };
                  const rxns = [...(m.reactions || [])];
                  const ri = rxns.findIndex((r) => r.emoji === rel.key);
                  if (ri >= 0) {
                    rxns[ri] = { ...rxns[ri], eventIds: { ...rxns[ri].eventIds, [senderId]: realId } };
                  }
                  m.reactions = rxns;
                  updMsgs[mIdx] = m;
                  return { messages: { ...s.messages, [room.roomId]: updMsgs } };
                });
              }
            };
            // The SDK fires "Event.localEchoUpdated" when the event gets its server ID
            let onSentCalled = false;
            const guardedOnSent = () => {
              if (onSentCalled) return;
              onSentCalled = true;
              onSent();
            };
            event.once("Event.localEchoUpdated" as any, guardedOnSent);
            // Fallback: check after a delay
            setTimeout(() => {
              event.off("Event.localEchoUpdated" as any, guardedOnSent);
              guardedOnSent();
            }, 3000);
          }
        }
        return;
      }

      // Handle redaction of reactions in real-time
      if (event.getType?.() === "m.room.redaction") {
        const redactedId = event.getAssociatedId?.() || (event.getContent?.() as Record<string, string>)?.redacts;
        if (redactedId) {
          set((s) => {
            const existing = s.messages[room.roomId] || [];
            let changed = false;
            const updated = existing.map((msg) => {
              if (!msg.reactions) return msg;
              const newReactions = msg.reactions.map((r) => {
                // Find if this redacted event is one of our tracked reaction events
                const userEntry = Object.entries(r.eventIds).find(([, evtId]) => evtId === redactedId);
                if (!userEntry) return r;
                changed = true;
                const newEventIds = { ...r.eventIds };
                delete newEventIds[userEntry[0]];
                return {
                  ...r,
                  count: r.count - 1,
                  userIds: r.userIds.filter((id) => id !== userEntry[0]),
                  eventIds: newEventIds,
                };
              }).filter((r) => r.count > 0);
              if (!changed) return msg;
              return { ...msg, reactions: newReactions.length > 0 ? newReactions : undefined };
            });
            return changed ? { messages: { ...s.messages, [room.roomId]: updated } } : s;
          });
        }
        return;
      }

      const evtType = event.getType?.();

      // Son de notification pour les messages reçus (chiffrés ou non)
      if (evtType === "m.room.message" || evtType === "m.room.encrypted") {
        const eventSender = event.getSender?.();
        if (eventSender && eventSender !== client.getUserId()) {
          // Pas de son pour l'admin room (bot conduit)
          if (!eventSender.includes("conduit")) {
            const activeChannel = useAppStore.getState().activeChannel;
            if (activeChannel === room.roomId || room.getJoinedMemberCount() === 2) {
              playMessageReceived();
            }
          }
        }
      }

      if (evtType !== "m.room.message") return;
      const content = event.getContent?.();
      if (!content?.msgtype) return;

      const msgtype: string = content.msgtype;
      const evtId = event.getId?.() || String(Date.now());
      const senderId = event.getSender?.() || "unknown";
      const sender = getDisplayName(senderId, room, client);
      const avatarUrl = getAvatarFromSender(senderId, room, client);
      const time = new Date(event.getTs?.() || Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

      // Handle edit events (m.replace) in real-time
      const relatesTo = content["m.relates_to"];
      if (relatesTo?.rel_type === "m.replace" && relatesTo?.event_id) {
        const newContent = content["m.new_content"];
        const editedText = newContent?.body || content.body;
        const targetId = relatesTo.event_id;
        set((s) => {
          const existing = s.messages[room.roomId] || [];
          const idx = existing.findIndex((m) => m.id === targetId);
          if (idx === -1) return s;
          const updated = [...existing];
          updated[idx] = { ...updated[idx], text: editedText, edited: true };
          return { messages: { ...s.messages, [room.roomId]: updated } };
        });
        return;
      }

      let msg: ChatMessage | null = null;

      if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
        if (!content.body) return;
        // Parse reply reference in real-time
        let replyTo: ChatMessage["replyTo"];
        const inReplyTo = content["m.relates_to"]?.["m.in_reply_to"];
        if (inReplyTo?.event_id) {
          const replyEvtId = inReplyTo.event_id;
          const existing = get().messages[room.roomId] || [];
          const replyMsg = existing.find((m) => m.id === replyEvtId);
          replyTo = {
            eventId: replyEvtId,
            senderId: replyMsg?.senderId,
            user: replyMsg?.user,
            text: replyMsg?.text,
          };
        }
        const rawBody = replyTo ? stripReplyFallback(content.body) : content.body;
        const rawFormatted = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
        const formattedBody = rawFormatted && replyTo ? stripMxReply(rawFormatted) : rawFormatted;
        msg = { id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: rawBody, formattedBody, msgtype, avatarUrl, replyTo };
      } else if (msgtype === "m.image" || msgtype === "m.file" || msgtype === "m.video" || msgtype === "m.audio") {
        const mxcUrl: string = content.url || content.file?.url || "";
        const httpUrl = mxcUrl ? matrixService.mxcToHttp(mxcUrl) : null;
        if (!httpUrl) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info: Record<string, any> = content.info || {};
        const mimeType = info.mimetype || (({ "m.image": "image/jpeg", "m.video": "video/mp4", "m.audio": "audio/mpeg" } as Record<string, string>)[msgtype] || "application/octet-stream");
        const attachment: FileAttachment = {
          id: evtId,
          name: content.body || "fichier",
          size: info.size || 0,
          mimeType,
          url: httpUrl,
          width: info.w,
          height: info.h,
          encryptedFile: content.file ? { ...content.file } : undefined,
        };
        msg = { id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: "", attachments: [attachment], avatarUrl };
      }

      if (!msg) return;
      const finalMsg = msg;

      // DM notification
      const currentUserId = client.getUserId();
      if (senderId !== currentUserId && !document.hasFocus()) {
        const isDM = room.getDMInviter?.() || (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const directEvent = client.getAccountData("m.direct" as any);
            if (!directEvent) return false;
            const directContent = directEvent.getContent() as Record<string, string[]>;
            return Object.values(directContent).some((rooms) => rooms.includes(room.roomId));
          } catch { return false; }
        })();
        if (isDM && useSettingsStore.getState().notifyDM && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const avatarHttpUrl = avatarUrl || undefined;
          new Notification(sender, { body: finalMsg.text || "📎", icon: avatarHttpUrl });
        }
      }

      set((s) => {
        const existing = s.messages[room.roomId] || [];
        if (existing.some((m) => m.id === finalMsg.id)) return s;
        return {
          messages: {
            ...s.messages,
            [room.roomId]: [...existing, finalMsg],
          },
        };
      });

      // Append new event ID to cache
      if (evtId) {
        appendCachedEventIds(room.roomId, [evtId], null);
      }
    });

    // Listen for MatrixRTC call member state changes (voice users joining/leaving)
    // and pinned events changes
    client.on(RoomStateEvent.Events, (event) => {
      const eventType = event.getType?.();

      if (eventType === "m.room.pinned_events") {
        // Bump version to trigger re-render of PinnedBar
        set((s) => ({ pinnedVersion: s.pinnedVersion + 1 }));
        return;
      }

      if (eventType !== "org.matrix.msc3401.call.member") return;
      const roomId = event.getRoomId?.();
      if (!roomId) return;
      const room = client.getRoom(roomId);
      if (!room) return;

      const updatedVoiceUsers = extractVoiceUsers(room, client);
      set((s) => ({
        channels: s.channels.map((ch) =>
          ch.id === roomId ? { ...ch, voiceUsers: updatedVoiceUsers } : ch
        ),
      }));
    });

    // Listen for new rooms
    client.on(ClientEvent.Room, (room) => {
      const channel = mapRoomToChannel(room, client);
      set((s) => {
        if (s.channels.some((c) => c.id === channel.id)) return s;
        return { channels: [...s.channels, channel] };
      });
    });

    // Auto-accept invites (DM and server rooms)
    client.on(RoomMemberEvent.Membership, async (event, member) => {
      if (
        member.userId === client.getUserId() &&
        member.membership === "invite"
      ) {
        const roomId = event.getRoomId();
        if (!roomId) return;
        try {
          await client.joinRoom(roomId);

          // Si c'est un DM (is_direct dans l'invite), mettre à jour m.direct
          const inviteContent = event.getContent?.();
          if (inviteContent?.is_direct) {
            const sender = event.getSender();
            if (sender) {
              try {
                const directEvent = client.getAccountData("m.direct" as any);
                const directContent = (directEvent?.getContent() || {}) as Record<string, string[]>;
                const existing = directContent[sender] || [];
                if (!existing.includes(roomId)) {
                  directContent[sender] = [...existing, roomId];
                  await client.setAccountData("m.direct" as any, directContent);
                }
              } catch { /* ignore */ }
            }
          }
        } catch (err) {
          console.error("[Sion] Failed to auto-join invite:", err);
        }
      }
    });

    // Listen for membership changes
    client.on(RoomMemberEvent.Membership, () => {
      const rooms = getJoinedRooms(client);
      const channels = rooms.map((room) => mapRoomToChannel(room, client));
      set({ channels });
    });

    // Listen for decrypted events — update individual messages in place.
    // We track which event IDs were decrypted and only update those,
    // to avoid re-extracting entire room timelines (which loses history).
    let decryptReloadTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingDecryptedEvents = new Set<string>();

    client.on(MatrixEventEvent.Decrypted, (event) => {
      const evtId = event.getId?.();
      if (evtId) pendingDecryptedEvents.add(evtId);

      if (decryptReloadTimer) clearTimeout(decryptReloadTimer);
      decryptReloadTimer = setTimeout(() => {
        decryptReloadTimer = null;
        if (pendingDecryptedEvents.size === 0) return;
        const decryptedIds = new Set(pendingDecryptedEvents);
        pendingDecryptedEvents.clear();

        set((s) => {
          let changed = false;
          const updated = { ...s.messages };
          for (const [roomId, msgs] of Object.entries(updated)) {
            const room = client.getRoom(roomId);
            if (!room) continue;
            const needsUpdate = msgs.some((m) => m.eventId && decryptedIds.has(m.eventId));
            if (!needsUpdate) continue;

            const freshMsgs = extractMessagesFromRoom(room);
            const freshById = new Map(freshMsgs.map((m) => [m.eventId, m]));
            updated[roomId] = msgs.map((msg) => {
              if (!msg.eventId || !decryptedIds.has(msg.eventId)) return msg;
              const fresh = freshById.get(msg.eventId);
              if (fresh && fresh.text) {
                changed = true;
                return fresh;
              }
              return msg;
            });
          }
          return changed ? { messages: updated } : s;
        });
      }, 1000);
    });

    // Clear old cache — v1 stored raw event IDs (thousands of signaling events).
    // v2 stores only message IDs. Clear once so v2 cache rebuilds cleanly.
    if (!localStorage.getItem("sion-cache-v4")) {
      clearCache();
      localStorage.setItem("sion-cache-v4", "1");
    }

    matrixService.startSync();
  },

  loadRoomHistory: async (roomId) => {
    const { roomLoadingHistory, roomHasMore, roomPaginationFrom } = get();
    const hasMoreVal = roomHasMore[roomId];
    if (roomLoadingHistory[roomId]) return;
    if (hasMoreVal !== true && hasMoreVal !== undefined) return;

    const client = matrixService.getMatrixClient();
    if (!client) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    const isFirstLoad = hasMoreVal === undefined;

    set((s) => ({ roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: true } }));

    try {
      // 1. Show sync messages immediately (first load only)
      const syncMsgs = extractMessagesFromRoom(room);
      if (isFirstLoad && syncMsgs.length > 0) {
        set((s) => ({
          messages: { ...s.messages, [roomId]: syncMsgs },
        }));
      }

      // 2. Load history via filtered /messages API — skips signaling events server-side.
      const baseUrl = client.getHomeserverUrl();
      const accessToken = client.getAccessToken();
      const filterStr = JSON.stringify({ not_types: ["org.matrix.msc3401.call.member"] });

      // Continue from where we left off (scroll-up pagination)
      let from = isFirstLoad ? "" : (roomPaginationFrom[roomId] || "");
      const allRawEvents: Record<string, unknown>[] = [];
      const MAX_PAGES = 5; // 5 pages per load = 500 events
      let serverHasMore = true;

      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ dir: "b", limit: "100", filter: filterStr });
        if (from) params.set("from", from);

        const res = await fetch(
          `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const data = await res.json();
        const chunk = data.chunk || [];
        allRawEvents.push(...chunk);

        if (!data.end || chunk.length === 0) {
          serverHasMore = false;
          break;
        }
        from = data.end;
      }

      // 3. Create MatrixEvent objects and decrypt.
      // Reverse: API returns newest-first (dir=b), we want oldest-first.
      allRawEvents.reverse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixEvents: any[] = [];
      for (const raw of allRawEvents) {
        const evt = new MatrixEvent(raw);
        if (evt.isEncrypted()) {
          try {
            await client.decryptEventIfNeeded(evt);
          } catch { /* will show as encrypted placeholder */ }
        }
        matrixEvents.push(evt);
      }

      // 4. Extract messages from decrypted events
      const historyMsgs = extractMessagesFromEvents(matrixEvents, room, client);

      // 5. Merge: existing messages + new history + sync
      // On first load: history + sync. On scroll-up: existing + new history.
      const existingMsgs = isFirstLoad ? [] : (get().messages[roomId] || []);
      const seenIds = new Set<string>();
      const merged: ChatMessage[] = [];

      // Add new history (older messages from this API call)
      for (const msg of historyMsgs) {
        if (msg.eventId) seenIds.add(msg.eventId);
        merged.push(msg);
      }
      // Add existing messages (from previous loads)
      for (const msg of existingMsgs) {
        if (msg.eventId && seenIds.has(msg.eventId)) continue;
        seenIds.add(msg.eventId || "");
        merged.push(msg);
      }
      // Add sync messages (first load only)
      if (isFirstLoad) {
        for (const msg of syncMsgs) {
          if (msg.eventId && seenIds.has(msg.eventId)) continue;
          merged.push(msg);
        }
      }

      // 6. Load pinned messages that aren't in loaded messages
      const pinnedIds = matrixService.getPinnedEventIds(roomId);
      const loadedIds = new Set(merged.map((m) => m.eventId).filter(Boolean));
      const missingPinnedIds = pinnedIds.filter((id) => !loadedIds.has(id));

      if (missingPinnedIds.length > 0) {
        for (const eventId of missingPinnedIds) {
          try {
            const res = await fetch(
              `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            if (!res.ok) continue;
            const raw = await res.json();
            const evt = new MatrixEvent(raw);
            if (evt.isEncrypted()) {
              try { await client.decryptEventIfNeeded(evt); } catch { /* skip */ }
            }
            const pinnedMsgs = extractMessagesFromEvents([evt], room, client);
            if (pinnedMsgs.length > 0) {
              merged.push(pinnedMsgs[0]);
            }
          } catch { /* skip unavailable pinned messages */ }
        }
      }

      set((s) => ({
        messages: merged.length > 0 ? { ...s.messages, [roomId]: merged } : s.messages,
        roomHasMore: { ...s.roomHasMore, [roomId]: serverHasMore },
        roomPaginationFrom: { ...s.roomPaginationFrom, [roomId]: from },
        roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: false },
      }));

      // 7. Cache message IDs for next launch (only if meaningful count)
      if (merged.length > 5) {
        const messageIds = merged.map((m) => m.eventId).filter(Boolean) as string[];
        setCachedRoom(roomId, messageIds, from || null);
      }

    } catch (err) {
      console.error("[Sion] Failed to load room history:", err);
      set((s) => ({ roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: false } }));
    }
  },

  reloadAllMessages: () => {
    const client = matrixService.getMatrixClient();
    if (!client) return;
    const rooms = getJoinedRooms(client);
    const messages: Record<string, ChatMessage[]> = {};
    for (const room of rooms) {
      const msgs = extractMessagesFromRoom(room);
      if (msgs.length > 0) {
        messages[room.roomId] = msgs;
      }
    }
    set((s) => ({ messages: { ...s.messages, ...messages } }));
  },

  restoreWithRecoveryKey: async (recoveryKey: string) => {
    set({ isRestoringKeys: true });
    try {
      const keysRestored = await matrixService.restoreKeyBackup(recoveryKey);
      if (keysRestored > 0) {
        // Reload all room histories to get decrypted messages
        get().reloadAllMessages();
      }
      set({ needsVerification: false, isRestoringKeys: false, hasUndecryptableMessages: false });
    } catch (err) {
      console.error("[Sion] Failed to restore key backup:", err);
      set({ isRestoringKeys: false });
      throw err;
    }
  },

  startCrossDeviceVerification: async () => {
    set({ verificationStep: "requesting", verificationError: null, verificationEmojis: [] });

    // Cleanup previous verification
    activeVerificationRequest = null;

    activeSasCallbacks = null;

    try {
      const request = await matrixService.requestOwnUserVerification();
      activeVerificationRequest = request;
      set({ verificationStep: "waiting" });

      // Listen for phase changes
      const onRequestChange = async () => {
        const phase = request.phase;

        if (phase === VerificationPhase.Ready) {
          // Other device accepted — start SAS verification
          try {
            const verifier = await request.startVerification("m.sas.v1");


            verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
              activeSasCallbacks = sas;
              const emojis: EmojiData[] = (sas.sas.emoji || []).map(([emoji, name]) => ({ emoji, name }));
              set({ verificationStep: "comparing", verificationEmojis: emojis });
            });

            verifier.on(VerifierEvent.Cancel, () => {
              set({ verificationStep: "cancelled" });
              cleanup();
            });

            // verify() resolves when verification completes
            verifier.verify().then(async () => {
              set({ verificationStep: "done", needsVerification: false });

              // Auto-restore key backup now that we have the secrets
              try {
                await matrixService.tryAutoRestoreKeyBackup();
              } catch (err) {
                console.warn("[Sion] Post-verification: auto key restore failed:", err);
              }

              // Reload messages with newly available keys
              get().reloadAllMessages();
              cleanup();
            }).catch((err) => {
              console.error("[Sion] Verification verify() failed:", err);
              set({ verificationStep: "error", verificationError: String(err) });
              cleanup();
            });
          } catch (err) {
            console.error("[Sion] Failed to start SAS verification:", err);
            set({ verificationStep: "error", verificationError: String(err) });
            cleanup();
          }
        } else if (phase === VerificationPhase.Cancelled) {
          set({ verificationStep: "cancelled" });
          cleanup();
        } else if (phase === VerificationPhase.Done) {
          set({ verificationStep: "done", needsVerification: false });
          cleanup();
        }
      };

      request.on(VerificationRequestEvent.Change, onRequestChange);

      const cleanup = () => {
        request.off(VerificationRequestEvent.Change, onRequestChange);
        activeVerificationRequest = null;
    
        activeSasCallbacks = null;
      };

    } catch (err) {
      console.error("[Sion] Failed to start cross-device verification:", err);
      set({ verificationStep: "error", verificationError: String(err) });
    }
  },

  confirmVerificationEmojis: async () => {
    if (!activeSasCallbacks) return;
    set({ verificationStep: "confirmed" });
    try {
      await activeSasCallbacks.confirm();
    } catch (err) {
      console.error("[Sion] Failed to confirm emojis:", err);
      set({ verificationStep: "error", verificationError: String(err) });
    }
  },

  rejectVerificationEmojis: () => {
    if (activeSasCallbacks) {
      activeSasCallbacks.mismatch();
    }
    set({ verificationStep: "cancelled" });
    activeVerificationRequest = null;

    activeSasCallbacks = null;
  },

  cancelVerification: () => {
    if (activeVerificationRequest) {
      activeVerificationRequest.cancel().catch(() => {});
    }
    set({ verificationStep: "idle", verificationEmojis: [], verificationError: null });
    activeVerificationRequest = null;

    activeSasCallbacks = null;
  },

  sendMessage: async (channelId, text) => {
    try {
      await matrixService.sendTextMessage(channelId, text);
    } catch (err) {
      console.error("[Sion] Failed to send message:", err);
    }
  },

  sendReply: async (channelId, inReplyToEventId, text) => {
    try {
      await matrixService.sendReply(channelId, inReplyToEventId, text);
    } catch (err) {
      console.error("[Sion] Failed to send reply:", err);
    }
  },

  sendFile: async (channelId, file) => {
    try {
      await matrixService.sendFileMessage(channelId, file);
    } catch (err) {
      console.error("[Sion] Failed to send file:", err);
    }
  },

  editMessage: async (channelId, eventId, newText) => {
    try {
      await matrixService.editMessage(channelId, eventId, newText);
    } catch (err) {
      console.error("[Sion] Failed to edit message:", err);
    }
  },

  deleteMessage: async (channelId, eventId) => {
    try {
      await matrixService.redactMessage(channelId, eventId);
      // Remove from local state immediately
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: (s.messages[channelId] || []).filter((m) => m.id !== eventId),
        },
      }));
    } catch (err) {
      console.error("[Sion] Failed to delete message:", err);
    }
  },

  setChannels: (channels) => set({ channels }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  dismissVerification: () => set({ needsVerification: false }),
  reset: () => set({
    channels: [], messages: {}, roomHasMore: {}, roomLoadingHistory: {},
    connectionStatus: "disconnected", currentUserId: null,
    needsVerification: false, isRestoringKeys: false, hasUndecryptableMessages: false, pinnedVersion: 0,
    bootstrapStep: "idle", generatedRecoveryKey: null,
    verificationStep: "idle", verificationEmojis: [], verificationError: null,
  }),
}));
