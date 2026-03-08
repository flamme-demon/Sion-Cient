import { create } from "zustand";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent, RoomStateEvent, EventTimeline, HttpApiEvent } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import type { VerificationRequest, ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api/verification";
import { VerificationPhase, VerifierEvent, VerificationRequestEvent } from "matrix-js-sdk/lib/crypto-api/verification";
import type { ChatMessage, Channel, FileAttachment, VoiceChannelUser } from "../types/matrix";
import * as matrixService from "../services/matrixService";
import { useAppStore } from "./useAppStore";
import { useSettingsStore } from "./useSettingsStore";

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
function extractMessagesFromRoom(room: any): ChatMessage[] {
  const client = matrixService.getMatrixClient();
  const timeline = room.getLiveTimeline().getEvents();
  const msgs: ChatMessage[] = [];
  for (const evt of timeline) {
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

      const formattedBody = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: content.body, formattedBody, msgtype, avatarUrl, replyTo });
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
  for (const evt of timeline) {
    if (evt.getType?.() !== "m.reaction") continue;
    const rel = evt.getContent?.()?.["m.relates_to"];
    if (rel?.rel_type !== "m.annotation" || !rel?.event_id || !rel?.key) continue;
    const target = msgs.find((m) => m.id === rel.event_id);
    if (!target) continue;
    if (!target.reactions) target.reactions = [];
    const senderId = evt.getSender?.() || "";
    const existing = target.reactions.find((r) => r.emoji === rel.key);
    if (existing) {
      if (!existing.userIds.includes(senderId)) {
        existing.userIds.push(senderId);
        existing.count++;
      }
    } else {
      target.reactions.push({ emoji: rel.key, count: 1, userIds: [senderId] });
    }
  }

  return msgs;
}

export const useMatrixStore = create<MatrixState>((set, get) => ({
  channels: [],
  messages: {},
  roomHasMore: {},
  roomLoadingHistory: {},
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

        // Auto-select first channel
        const currentActive = useAppStore.getState().activeChannel;
        if ((!currentActive || currentActive === "") && channels.length > 0) {
          useAppStore.getState().setActiveChannel(channels[0].id, channels[0].hasVoice);
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
          set((s) => {
            const existing = s.messages[room.roomId] || [];
            const idx = existing.findIndex((m) => m.id === rel.event_id);
            if (idx === -1) return s;
            const updated = [...existing];
            const msg = { ...updated[idx] };
            const reactions = [...(msg.reactions || [])];
            const rIdx = reactions.findIndex((r) => r.emoji === rel.key);
            if (rIdx >= 0) {
              const r = { ...reactions[rIdx], userIds: [...reactions[rIdx].userIds] };
              if (!r.userIds.includes(senderId)) {
                r.userIds.push(senderId);
                r.count++;
              }
              reactions[rIdx] = r;
            } else {
              reactions.push({ emoji: rel.key as string, count: 1, userIds: [senderId] });
            }
            msg.reactions = reactions;
            updated[idx] = msg;
            return { messages: { ...s.messages, [room.roomId]: updated } };
          });
        }
        return;
      }

      if (event.getType?.() !== "m.room.message") return;
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
        const formattedBody = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
        msg = { id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, text: content.body, formattedBody, msgtype, avatarUrl, replyTo };
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

    // Listen for membership changes
    client.on(RoomMemberEvent.Membership, () => {
      const rooms = getJoinedRooms(client);
      const channels = rooms.map((room) => mapRoomToChannel(room, client));
      set({ channels });
    });

    // Listen for decrypted events (after key restore / cross-device verification)
    let decryptReloadTimer: ReturnType<typeof setTimeout> | null = null;
    client.on(MatrixEventEvent.Decrypted, (event) => {
      const roomId = event.getRoomId?.();
      if (!roomId) return;
      // Debounce: many events decrypt at once, reload once after a short delay
      if (decryptReloadTimer) clearTimeout(decryptReloadTimer);
      decryptReloadTimer = setTimeout(() => {
        decryptReloadTimer = null;
        const rooms = getJoinedRooms(client);
        const messages: Record<string, ChatMessage[]> = {};
        for (const room of rooms) {
          const msgs = extractMessagesFromRoom(room);
          if (msgs.length > 0) {
            messages[room.roomId] = msgs;
          }
        }
        set((s) => ({ messages: { ...s.messages, ...messages } }));
      }, 500);
    });

    matrixService.startSync();
  },

  loadRoomHistory: async (roomId) => {
    const { roomLoadingHistory, roomHasMore } = get();
    const hasMoreVal = roomHasMore[roomId];
    if (roomLoadingHistory[roomId]) return;
    if (hasMoreVal !== true && hasMoreVal !== undefined) return;

    const client = matrixService.getMatrixClient();
    if (!client) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    set((s) => ({ roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: true } }));

    try {
      // Check if SDK timeline already has messages (from sync or previous scrollback)
      let msgs = extractMessagesFromRoom(room);
      if (msgs.length > 0) {
        const hasMore = !!room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
        set((s) => ({
          messages: { ...s.messages, [roomId]: msgs },
          roomHasMore: { ...s.roomHasMore, [roomId]: hasMore },
          roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: false },
        }));
        return;
      }

      // Paginate backwards using scrollback (needed for encrypted rooms where raw API can't decrypt).
      // Server caps at ~100 events per request. Voice channels can have thousands of signaling
      // events before messages, so we may need many rounds (like Element which does ~80 requests).
      // Use Promise.race for timeout protection on each round.
      const MAX_ROUNDS = 200; // ~20K events max
      const BATCH = 100;
      const SCROLLBACK_TIMEOUT = 8000;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const paginationToken = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
        if (!paginationToken) break;

        try {
          await Promise.race([
            client.scrollback(room, BATCH),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), SCROLLBACK_TIMEOUT)),
          ]);
        } catch {
          break;
        }

        msgs = extractMessagesFromRoom(room);

        // Update store periodically (every 10 rounds) to show progress
        if (msgs.length > 0 || round % 10 === 9) {
          const hasMore = !!room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
          set((s) => ({
            messages: msgs.length > 0 ? { ...s.messages, [roomId]: msgs } : s.messages,
            roomHasMore: { ...s.roomHasMore, [roomId]: hasMore },
          }));
        }

        // Found messages — do a few more rounds for additional context, then stop
        if (msgs.length > 0) {
          for (let extra = 0; extra < 3; extra++) {
            const tk = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
            if (!tk) break;
            try {
              await Promise.race([
                client.scrollback(room, BATCH),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), SCROLLBACK_TIMEOUT)),
              ]);
            } catch { break; }
          }
          msgs = extractMessagesFromRoom(room);
          break;
        }
      }

      const finalHasMore = !!room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
      set((s) => ({
        messages: msgs.length > 0 ? { ...s.messages, [roomId]: msgs } : s.messages,
        roomHasMore: { ...s.roomHasMore, [roomId]: finalHasMore },
        roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: false },
      }));

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
