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
import { playMessageReceived, playPoke } from "../services/soundService";
import { findAdminRoom } from "../services/adminCommandService";

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
  connectionStatus: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
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

// Extract the quoted text from a Matrix reply-fallback body. Matrix clients
// prefix the reply body with lines of the form `> <@user:server> original text`
// so that non-reply-aware clients still see the quote. We use this as a
// fallback when the replied-to message isn't in our cached timeline (e.g. it
// fell out of the loaded window, or the reply event arrived before the
// original was processed).
function extractReplyQuoteBody(body: string): string | undefined {
  const lines = body.split("\n");
  const quoteLines: string[] = [];
  for (const l of lines) {
    if (!l.startsWith("> ")) break;
    quoteLines.push(l.slice(2));
  }
  if (quoteLines.length === 0) return undefined;
  // First quoted line is typically `<@user:server> actual text`
  const first = quoteLines[0].replace(/^<[^>]+>\s*/, "");
  const rest = quoteLines.slice(1).join("\n");
  const joined = (rest ? first + "\n" + rest : first).trim();
  return joined || undefined;
}

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

    // Sion embeds the user's mute/deafen state inside the call.member
    // content (fields `sion_muted` / `sion_deafened`) so this
    // information is visible in the sidebar for voice channels the local
    // user hasn't joined — the LiveKit data-channel path only reaches
    // peers in the same room. Missing fields default to false (remote
    // is not a Sion client, or hasn't toggled since connecting).
    const sionMuted = content?.sion_muted === true;
    const sionDeafened = content?.sion_deafened === true;
    users.push({
      id: userId,
      name: getDisplayName(userId, room, client),
      role: "user",
      avatarUrl: getAvatarFromSender(userId, room, client),
      speaking: false,
      muted: sionMuted,
      deafened: sionDeafened,
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

    // Fallback: 2-member DM (we and the peer both still joined).
    if (!isDM && room.getJoinedMemberCount() <= 2 && !roomType && !customType) {
      const myUserId = client.getUserId();
      const members = room.getJoinedMembers();
      const otherMember = members.find((m: any) => m.userId !== myUserId);
      if (otherMember && members.length === 2) {
        isDM = true;
        dmUserId = otherMember.userId;
      }
    }

    // Orphan DM: peer has left, we're the only joined member. Detected from
    // the historic member list (≤2 total ever) so these rooms still surface
    // under the MP tab and become eligible for the cleanup actions.
    if (!isDM && !roomType && !customType) {
      const myUserId = client.getUserId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allMembers = (room as any).getMembers?.() || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveMembers = allMembers.filter((m: any) => m.membership === "join" || m.membership === "invite");
      if (
        liveMembers.length === 1
        && liveMembers[0].userId === myUserId
        && allMembers.length <= 2
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const peer = allMembers.find((m: any) => m.userId !== myUserId);
        if (peer) {
          isDM = true;
          dmUserId = peer.userId;
        }
      }
    }
  }

  // Soundboard rooms are hidden from the sidebar — users access them via the
  // dedicated panel in the chat input. Detected by canonical alias starting
  // with #soundboard:
  const canonicalAlias: string = room.getCanonicalAlias?.() || "";
  const isSoundboard = canonicalAlias.startsWith("#soundboard:");

  return {
    id: room.roomId,
    name: room.name || canonicalAlias || room.roomId,
    topic: topic || undefined,
    icon,
    hasVoice,
    voiceUsers: extractVoiceUsers(room, client),
    createdAt,
    lastActivity,
    isDM,
    dmUserId,
    isSoundboard,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessagesFromEvents(events: any[], room: any, client: any): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const evt of events) {
    const type = evt.getType?.();
    const content = evt.getContent?.();

    // Detect messages robustly. matrix-js-sdk can leave getType() stale at
    // "m.room.encrypted" even after a backward-paginated event has been
    // decrypted — its cleartext content (with msgtype) is the authoritative
    // signal for whether it's a displayable message. Without this, rooms
    // with lots of paginated history show only the most-recently-synced
    // message on first open.
    const isMessage = type === "m.room.message" || !!content?.msgtype;

    // Show failed-to-decrypt messages as placeholders (getType already
    // correctly reads "m.room.message" for these, so no ambiguity).
    if (type === "m.room.message" && evt.isDecryptionFailure?.()) {
      const evtId = evt.getId?.() || String(Date.now());
      const senderId = evt.getSender?.() || "unknown";
      const sender = getDisplayName(senderId, room, client);
      const avatarUrl = getAvatarFromSender(senderId, room, client);
      const ts = evt.getTs?.() || Date.now();
      const time = new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, ts, text: "🔒 Message chiffré (clé de déchiffrement manquante)", msgtype: "m.encrypted", avatarUrl });
      continue;
    }

    if (!isMessage) continue;
    if (!content?.msgtype) continue;

    const msgtype: string = content.msgtype;
    const evtId = evt.getId?.() || String(Date.now());
    const senderId = evt.getSender?.() || "unknown";
    const sender = getDisplayName(senderId, room, client);
    const avatarUrl = getAvatarFromSender(senderId, room, client);
    const ts = evt.getTs?.() || Date.now();
    const time = new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

    // Messages texte
    if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote" || msgtype === "m.poke") {
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
        // Fallback: if the original isn't in our cache, pull the quoted text
        // out of the reply body itself so we still show something useful.
        const fallbackText = !replyMsg?.text ? extractReplyQuoteBody(content.body || "") : undefined;
        replyTo = {
          eventId: replyEvtId,
          senderId: replyMsg?.senderId,
          user: replyMsg?.user,
          text: replyMsg?.text || fallbackText,
          msgtype: replyMsg?.msgtype,
          attachmentName: replyMsg?.attachments?.[0]?.name,
        };
      }

      const rawBody = replyTo ? stripReplyFallback(content.body) : content.body;
      const rawFormatted = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
      const formattedBody = rawFormatted && replyTo ? stripMxReply(rawFormatted) : rawFormatted;
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, ts, text: rawBody, formattedBody, msgtype, avatarUrl, replyTo });
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
      msgs.push({ id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, ts, text: "", attachments: [attachment], avatarUrl });
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

        // Push local displayName to server AFTER sync completes — this ensures
        // stale m.room.member events from the sync don't overwrite the emoji name.
        import("./useAuthStore").then(({ useAuthStore: authStore }) => {
          const creds = authStore.getState().credentials;
          if (creds?.displayName && creds.displayName !== creds.userId) {
            import("../services/matrixService").then(({ setDisplayName }) => {
              setDisplayName(creds.displayName!).catch(() => {});
            });
          }
        });

        // Auto-accept pending invites (received while offline).
        // Also update m.direct for DM invites — otherwise the user ends up
        // with the joined room but no m.direct entry, so the next call to
        // createOrGetDMRoom() creates a duplicate DM.
        const invitedRooms = client.getRooms().filter((r) =>
          r.getMyMembership() === "invite"
        );
        for (const room of invitedRooms) {
          const myUserId = client.getUserId();
          const myMember = myUserId ? room.getMember(myUserId) : null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inviteEvent = (myMember as any)?.events?.member;
          const isDirect = inviteEvent?.getContent?.()?.is_direct === true;
          const inviter = inviteEvent?.getSender?.();
          client.joinRoom(room.roomId).then(async () => {
            if (isDirect && inviter) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const directEvent = client.getAccountData("m.direct" as any);
                const directContent = (directEvent?.getContent() || {}) as Record<string, string[]>;
                const existing = directContent[inviter] || [];
                if (!existing.includes(room.roomId)) {
                  directContent[inviter] = [...existing, room.roomId];
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  await client.setAccountData("m.direct" as any, directContent as any);
                }
              } catch (err) {
                console.warn("[Sion] Failed to update m.direct after offline invite auto-join:", err);
              }
            }
          }).catch((err) => {
            console.error("[Sion] Failed to auto-join pending invite:", err);
          });
        }

        // Auto-select default channel (or first channel as fallback)
        const currentActive = useAppStore.getState().activeChannel;
        const connectedVoice = useAppStore.getState().connectedVoiceChannel;
        if ((!currentActive || currentActive === "") && channels.length > 0) {
          const { defaultChannel, autoJoinVoice } = useSettingsStore.getState();
          const defaultCh = channels.find((c) => c.id === defaultChannel)
            || channels.find((c) => !c.hasVoice)
            || channels[0];
          const prevMobileView = useAppStore.getState().mobileView;
          useAppStore.getState().setActiveChannel(defaultCh.id, defaultCh.hasVoice);
          useAppStore.getState().setMobileView(prevMobileView);

          // Auto-join voice if the default channel is a voice channel and option is enabled
          if (autoJoinVoice && defaultCh.hasVoice && !connectedVoice) {
            useAppStore.getState().setConnectingVoice(defaultCh.id);
            useAppStore.getState().setPendingAutoJoinVoice(defaultCh.id);
          }
        }
        // Note: auto-join voice only happens on initial channel selection (above).
        // We do NOT retry on subsequent syncs to avoid reconnect loops (e.g. HMR in dev).

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

        // Angle 2 of the MSC4268 coverage (see the shareHistoryWithUser
        // block below): sweep every joined room × joined member and push
        // shareable history keys to everyone. This is the retry path for
        // reload scenarios — the newcomer already has membership so no
        // RoomMemberEvent.Membership fires, but their crypto store may be
        // missing sessions. The 2 s delay lets crypto finish bootstrap and
        // the initial device-list sync settle before we start encrypting
        // to-device events. Fire-and-forget; per-call failures are logged
        // by shareHistoryWithUser.
        setTimeout(() => {
          const myUserId = client.getUserId();
          if (!myUserId) return;
          const joined = getJoinedRooms(client);
          let planned = 0;
          for (const room of joined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const members = (room as any).getJoinedMembers?.() || [];
            for (const m of members) {
              if (m.userId === myUserId) continue;
              shareHistoryWithUser(room.roomId, m.userId, "startup-sync");
              planned++;
            }
          }
          if (planned > 0) console.info(`[Sion][e2ee] startup reshare planned for ${planned} (room, user) pairs`);
        }, 2000);

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
      } else if (state === "RECONNECTING") {
        set({ connectionStatus: "reconnecting" });
      } else if (state === "CATCHUP") {
        // After reconnection, the SDK catches up — treat as still recovering
        set({ connectionStatus: "reconnecting" });
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

    // Track processed event IDs to prevent duplicates from SDK re-emissions
    const processedEventIds = new Set<string>();

    // Listen for voice kick events (Sion-specific)
    client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return; // skip backfill/pagination
      if (!room || event.getType?.() !== "com.sion.voice_kick") return;
      // Ignore stale kick events (initial sync replay, reload, etc.) —
      // a legitimate kick is delivered within seconds. Without this check,
      // reloading the app re-triggers the kick banner from timeline replay.
      const eventTs = event.getTs?.() ?? 0;
      if (Date.now() - eventTs > 60_000) return;
      const content = event.getContent?.();
      const myUserId = client.getUserId();
      if (!content?.kicked_user || content.kicked_user !== myUserId) return;

      // Verify the sender has power level >= 50 (moderator+)
      const senderId = event.getSender?.() || "";
      const senderPL = room.getMember?.(senderId)?.powerLevel ?? 0;
      if (senderPL < 50) {
        console.warn("[Sion] Ignoring voice kick from non-moderator:", senderId, "PL:", senderPL);
        return;
      }

      const kickerName = content.kicked_by_name || senderId;
      console.warn("[Sion] Voice kicked by:", kickerName);

      // Full clean disconnect: LiveKit + MatrixRTC session
      const kickedRoom = useAppStore.getState().connectedVoiceChannel;
      if (kickedRoom) {
        import("../hooks/useVoiceChannel").then(({ cleanupVoiceOnKick }) => {
          cleanupVoiceOnKick();
        });
      }

      // Show persistent kick message with room reference for reconnect
      const reason = content.reason ? ` — ${content.reason}` : "";
      useAppStore.setState({ kickMessage: `Kick par ${kickerName}${reason}`, kickedFromRoom: kickedRoom || room.roomId });
    });

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
            const idx = existing.findIndex(
              (m) => m.id === rel.event_id || m.eventId === rel.event_id,
            );
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

      // Handle redaction in real-time (messages + reactions)
      if (event.getType?.() === "m.room.redaction") {
        const redactedId = event.getAssociatedId?.() || (event.getContent?.() as Record<string, string>)?.redacts;
        if (redactedId) {
          set((s) => {
            const existing = s.messages[room.roomId] || [];

            // Check if the redacted event is a message itself
            const msgIdx = existing.findIndex((m) => m.id === redactedId || m.eventId === redactedId);
            if (msgIdx !== -1) {
              return {
                messages: {
                  ...s.messages,
                  [room.roomId]: existing.filter((_, i) => i !== msgIdx),
                },
              };
            }

            // Otherwise check if it's a reaction
            let changed = false;
            const updated = existing.map((msg) => {
              if (!msg.reactions) return msg;
              const newReactions = msg.reactions.map((r) => {
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
          // Pas de son pour l'admin room (bot conduit OU autres admins humains
          // qui exécutent des commandes via le menu Admin)
          const isAdminRoom = room.roomId === findAdminRoom();
          if (!eventSender.includes("conduit") && !isAdminRoom) {
            const activeChannel = useAppStore.getState().activeChannel;
            const connectedVoice = useAppStore.getState().connectedVoiceChannel;
            if (activeChannel === room.roomId || connectedVoice === room.roomId || room.getJoinedMemberCount() === 2) {
              // For plain m.room.message we can read msgtype now. For encrypted
              // events, defer the sound to the Decrypted handler so we can
              // distinguish a poke (fanfare) from a regular message (blop).
              if (evtType === "m.room.message") {
                const eventMsgtype = event.getContent?.()?.msgtype;
                if (eventMsgtype === "m.poke") {
                  playPoke();
                } else {
                  playMessageReceived();
                }
              }
            }
          }
        }
      }

      // Skip encrypted events — they'll be handled when decrypted
      if (evtType === "m.room.encrypted") return;
      if (evtType !== "m.room.message") return;
      // Skip events with no ID or sender (malformed/pending decryption artifacts)
      const eventId = event.getId?.();
      if (!eventId || !event.getSender?.()) return;
      // Prevent duplicate processing (SDK can emit Timeline twice for same event)
      if (processedEventIds.has(eventId)) return;
      processedEventIds.add(eventId);
      const content = event.getContent?.();
      if (!content?.msgtype) return;

      const msgtype: string = content.msgtype;
      const evtId = event.getId?.() || String(Date.now());
      const senderId = event.getSender?.() || "unknown";
      const sender = getDisplayName(senderId, room, client);
      const avatarUrl = getAvatarFromSender(senderId, room, client);
      const ts = event.getTs?.() || Date.now();
      const time = new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

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

      if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote" || msgtype === "m.poke") {
        if (!content.body) return;
        // Parse reply reference in real-time
        let replyTo: ChatMessage["replyTo"];
        const inReplyTo = content["m.relates_to"]?.["m.in_reply_to"];
        if (inReplyTo?.event_id) {
          const replyEvtId = inReplyTo.event_id;
          const existing = get().messages[room.roomId] || [];
          const replyMsg = existing.find((m) => m.id === replyEvtId);
          // Fallback: extract the quoted text from the reply body itself if
          // the original message isn't in our cache (e.g. not yet loaded or
          // outside the currently-loaded window).
          const fallbackText = !replyMsg?.text ? extractReplyQuoteBody(content.body || "") : undefined;
          replyTo = {
            eventId: replyEvtId,
            senderId: replyMsg?.senderId,
            user: replyMsg?.user,
            text: replyMsg?.text || fallbackText,
            msgtype: replyMsg?.msgtype,
            attachmentName: replyMsg?.attachments?.[0]?.name,
          };
        }
        const rawBody = replyTo ? stripReplyFallback(content.body) : content.body;
        const rawFormatted = content.format === "org.matrix.custom.html" ? content.formatted_body : undefined;
        const formattedBody = rawFormatted && replyTo ? stripMxReply(rawFormatted) : rawFormatted;
        msg = { id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, ts, text: rawBody, formattedBody, msgtype, avatarUrl, replyTo };
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
        msg = { id: evtId, eventId: evtId, senderId, user: sender, role: "user", time, ts, text: "", attachments: [attachment], avatarUrl };
      }

      if (!msg) return;
      const finalMsg = msg;

      // Notifications (Tauri native)
      const currentUserId = client.getUserId();
      // Skip all notifications for the admin room — actions from other admins
      // (open admin menu, run commands) generate messages we don't want to ping on.
      // The message is still added to the store below, just no notification.
      const isAdminRoomNotif = room.roomId === findAdminRoom();
      if (senderId !== currentUserId && !isAdminRoomNotif) {
        const isPoke = msgtype === "m.poke";
        const isDM = !!room.getDMInviter?.() || (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const directEvent = client.getAccountData("m.direct" as any);
            if (!directEvent) return false;
            const directContent = directEvent.getContent() as Record<string, string[]>;
            return Object.values(directContent).some((rooms) => rooms.includes(room.roomId));
          } catch { return false; }
        })();

        const { notificationMode } = useSettingsStore.getState();
        const connectedVoice = useAppStore.getState().connectedVoiceChannel;
        const isActiveChannel = connectedVoice === room.roomId;
        const isMention = currentUserId && content.body?.includes(currentUserId.slice(0, currentUserId.indexOf(":")));
        const isReplyToMe = content["m.relates_to"]?.["m.in_reply_to"] && (() => {
          const replyEvtId = content["m.relates_to"]["m.in_reply_to"].event_id;
          const msgs = get().messages[room.roomId] || [];
          const repliedMsg = msgs.find((m) => m.eventId === replyEvtId);
          return repliedMsg?.senderId === currentUserId;
        })();

        // Poke: always notify
        // all: active channel + DM + mentions + replies
        // mentions: DM + @mentions + replies to me
        // minimal: DM only
        let shouldNotify = false;
        if (isPoke) {
          shouldNotify = true;
        } else if (notificationMode === "all") {
          shouldNotify = (isActiveChannel || isDM || isMention || isReplyToMe) && !document.hasFocus();
        } else if (notificationMode === "mentions") {
          shouldNotify = isDM || isMention || isReplyToMe;
        } else if (notificationMode === "minimal") {
          shouldNotify = isDM;
        }

        if (shouldNotify && !document.hasFocus()) {
          const title = isPoke ? `👉 ${sender}` : sender;
          const body = isPoke ? "Poke!" : (finalMsg.text || "📎");
          const notifRoomId = room.roomId;
          const notifEventId = evtId;

          import("@tauri-apps/plugin-notification").then(async ({ sendNotification, isPermissionGranted, requestPermission, registerActionTypes, onAction }) => {
            let granted = await isPermissionGranted();
            if (!granted) granted = (await requestPermission()) === "granted";
            if (!granted) return;

            // Register action type with reply input (once)
            if (!(window as unknown as Record<string, boolean>).__sionNotifActionsRegistered) {
              (window as unknown as Record<string, boolean>).__sionNotifActionsRegistered = true;
              await registerActionTypes([{
                id: "msg-reply",
                actions: [
                  { id: "reply", title: "Répondre", input: true, inputButtonTitle: "Envoyer", inputPlaceholder: "Votre réponse..." },
                  { id: "open", title: "Ouvrir", foreground: true },
                ],
              }]).catch(() => {});

              onAction((notification) => {
                const extra = notification.extra as Record<string, string> | undefined;
                if (!extra) return;
                const actionId = (notification as unknown as Record<string, string>).actionId;
                if (actionId === "open" || !actionId) {
                  // Navigate to the room/message
                  useAppStore.getState().setActiveChannel(extra.roomId, false);
                  if (extra.eventId) useAppStore.getState().setScrollToMessageId(extra.eventId);
                }
                if (actionId === "reply") {
                  const inputValue = (notification as unknown as Record<string, string>).inputValue;
                  if (inputValue && extra.roomId) {
                    import("../services/matrixService").then((ms) => {
                      ms.sendReply(extra.roomId, extra.eventId, inputValue).catch(console.error);
                    });
                  }
                }
              }).catch(() => {});
            }

            sendNotification({
              title,
              body,
              icon: "icons/128x128.png",
              actionTypeId: "msg-reply",
              extra: { roomId: notifRoomId, eventId: notifEventId },
            });
          }).catch(() => {
            // Fallback web notification with click handler
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              const n = new Notification(title, { body, icon: "/icons/128x128.png" });
              n.onclick = () => {
                window.focus();
                useAppStore.getState().setActiveChannel(notifRoomId, false);
                if (notifEventId) useAppStore.getState().setScrollToMessageId(notifEventId);
              };
            }
          });
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
                  await client.setAccountData("m.direct" as any, directContent as any);
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

    // Historic Megolm key sharing (MSC4268). Key-sharing needs to fire from
    // three angles to actually cover reload + late-device + offline-at-join
    // scenarios:
    //
    //  1. On membership change (RoomMemberEvent.Membership == "join")
    //     — the canonical path: all current members push their shareable
    //     history keys to the newcomer.
    //  2. On client startup (after PREPARED sync) — catches users who joined
    //     while we were offline, and re-runs for reload scenarios where the
    //     newcomer already has membership but their crypto store is missing
    //     sessions. This is the case flamme kept hitting with flammemob
    //     (reload doesn't fire a Membership event).
    //  3. On CryptoEvent.DevicesUpdated for a recent joiner — catches the
    //     race where `shareRoomHistoryWithUser` runs before the newcomer's
    //     device keys are published, targeting 0 devices. A second pass
    //     once the device list updates delivers to the real device.
    //
    // The helper logs counts so we can tell from devtools whether shares
    // actually reach the wire. Both `shareRoomHistoryWithUser` and the
    // backing to-device sends silently no-op on clients/crypto stores that
    // don't support MSC4268 and on non-E2EE rooms.
    const recentJoinTs = new Map<string, number>(); // `${roomId}:${userId}` → ts
    const RECENT_JOIN_WINDOW_MS = 2 * 60 * 1000; // 2 min

    const shareHistoryWithUser = async (roomId: string, userId: string, reason: string) => {
      const myUserId = client.getUserId();
      if (!myUserId || userId === myUserId) return;
      const room = client.getRoom(roomId);
      if (!room || room.getMyMembership() !== "join") return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crypto = (client as any).getCrypto?.();
      if (!crypto?.shareRoomHistoryWithUser) {
        console.debug(`[Sion][e2ee] shareRoomHistoryWithUser unsupported — reason=${reason}`);
        return;
      }
      try {
        await crypto.shareRoomHistoryWithUser(roomId, userId);
        console.info(`[Sion][e2ee] shared history to ${userId} in ${roomId} (${reason})`);
      } catch (err) {
        console.warn(`[Sion][e2ee] share failed for ${userId} in ${roomId} (${reason}):`, err);
      }
    };

    // Angle 1: membership join event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(RoomMemberEvent.Membership, async (_event: any, member: any) => {
      if (member.membership !== "join") return;
      const myUserId = client.getUserId();
      if (!myUserId || member.userId === myUserId) return;
      const roomId = member.roomId;
      if (!roomId) return;
      recentJoinTs.set(`${roomId}:${member.userId}`, Date.now());
      shareHistoryWithUser(roomId, member.userId, "join-event");
    });

    // Angle 3: devices updated for a recent joiner. The SDK emits
    // CryptoEvent.DevicesUpdated with an array of userIds whose device list
    // has changed. We filter to users flagged as "recently joined" and
    // re-share for every room they're in with us. This is the fix for the
    // "newcomer's device keys uploaded after our initial share" race.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(CryptoEvent.DevicesUpdated, async (userIds: string[]) => {
      if (!userIds || userIds.length === 0) return;
      const myUserId = client.getUserId();
      if (!myUserId) return;
      const now = Date.now();
      for (const userId of userIds) {
        if (userId === myUserId) continue;
        // Sweep the recent-join map for this user across all rooms.
        for (const [key, ts] of recentJoinTs) {
          if (now - ts > RECENT_JOIN_WINDOW_MS) {
            recentJoinTs.delete(key);
            continue;
          }
          if (!key.endsWith(`:${userId}`)) continue;
          const roomId = key.slice(0, -(`:${userId}`.length));
          shareHistoryWithUser(roomId, userId, "devices-updated-after-join");
        }
      }
    });

    // Auto-leave a DM when the only other member leaves it. Without this,
    // each side accumulates "ghost" 1-member rooms after the peer cleans up
    // (or simply leaves) — visually noisy, and the room stays alive
    // server-side forever. The peer can re-invite via createOrGetDMRoom's
    // reuseRoom flow if they want to resume the conversation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(RoomMemberEvent.Membership, async (event, member) => {
      if (member.membership !== "leave") return;
      const myUserId = client.getUserId();
      if (!myUserId || member.userId === myUserId) return; // their leave, not ours
      const roomId = event.getRoomId?.();
      if (!roomId) return;
      const room = client.getRoom(roomId);
      if (!room) return;
      if (room.getMyMembership() !== "join") return;
      // Only consider DM-shaped rooms.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allMembers = (room as any).getMembers?.() || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveMembers = allMembers.filter((m: any) => m.membership === "join" || m.membership === "invite");
      const looksDM =
        !!room.getDMInviter?.()
        || (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const directEvent = (client as any).getAccountData("m.direct");
            const directContent = (directEvent?.getContent?.() || {}) as Record<string, string[]>;
            return Object.values(directContent).some((arr) => arr.includes(roomId));
          } catch { return false; }
        })()
        // Shape-based fallback: ≤2 historic members, no name set, no type —
        // catches DMs that lost their m.direct entry but are still 1:1 in shape.
        || (allMembers.length <= 2 && !room.name);
      if (!looksDM) return;
      // We must be the only one left after the peer's leave
      if (liveMembers.length !== 1 || liveMembers[0].userId !== myUserId) return;
      try {
        await client.leave(roomId);
        // Scrub from m.direct so it doesn't reappear as a candidate for this peer
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const directEvent = (client as any).getAccountData("m.direct");
          const prev = (directEvent?.getContent?.() || {}) as Record<string, string[]>;
          const next: Record<string, string[]> = {};
          for (const [peer, rooms] of Object.entries(prev)) {
            const filtered = rooms.filter((rid) => rid !== roomId);
            if (filtered.length > 0) next[peer] = filtered;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (client as any).setAccountData("m.direct", next);
        } catch { /* m.direct cleanup is best-effort */ }
      } catch (err) {
        console.warn(`[Sion][DM] Failed to auto-leave orphaned DM ${roomId}:`, err);
      }
    });

    // Listen for decrypted events — update individual messages in place.
    // We track which event IDs were decrypted and only update those,
    // to avoid re-extracting entire room timelines (which loses history).
    let decryptReloadTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingDecryptedEvents = new Set<string>();

    client.on(MatrixEventEvent.Decrypted, (event) => {
      // Play notification sound once the message has actually been decrypted.
      // Freshness window keeps us from replaying sounds for historical events
      // that decrypt during initial sync or after key re-emit.
      if (event.getType?.() === "m.room.message") {
        const eventTs = event.getTs?.() ?? 0;
        if (Date.now() - eventTs < 10_000) {
          const sender = event.getSender?.();
          const myUserId = client.getUserId();
          const roomId = event.getRoomId?.();
          const room = roomId ? client.getRoom(roomId) : null;
          if (sender && sender !== myUserId && room && !sender.includes("conduit")) {
            const isAdminRoom = roomId === findAdminRoom();
            if (!isAdminRoom) {
              const activeChannel = useAppStore.getState().activeChannel;
              const connectedVoice = useAppStore.getState().connectedVoiceChannel;
              if (activeChannel === roomId || connectedVoice === roomId || room.getJoinedMemberCount() === 2) {
                const msgtype = event.getContent?.()?.msgtype;
                if (msgtype === "m.poke") {
                  playPoke();
                } else {
                  playMessageReceived();
                }
              }
            }
          }
        }
      }

      // Check for voice kick in decrypted events (custom events arrive
      // as m.room.encrypted first, so the Timeline listener misses them)
      if (event.getType?.() === "com.sion.voice_kick") {
        // Ignore stale kicks — same rationale as the Timeline handler:
        // reloads would otherwise re-trigger the banner from replayed events.
        const eventTs = event.getTs?.() ?? 0;
        if (Date.now() - eventTs > 60_000) return;
        const content = event.getContent?.();
        const myUserId = client.getUserId();
        if (content?.kicked_user === myUserId) {
          const roomId = event.getRoomId?.();
          const room = roomId ? client.getRoom(roomId) : null;
          const senderId = event.getSender?.() || "";
          const senderPL = room?.getMember?.(senderId)?.powerLevel ?? 0;
          if (senderPL >= 50) {
            const kickerName = content.kicked_by_name || senderId;
            console.warn("[Sion] Voice kicked by (decrypted):", kickerName);
            const kickedRoom = useAppStore.getState().connectedVoiceChannel;
            if (kickedRoom) {
              import("../hooks/useVoiceChannel").then(({ cleanupVoiceOnKick }) => {
                cleanupVoiceOnKick();
              });
            }
            const reason = content.reason ? ` — ${content.reason}` : "";
            useAppStore.setState({ kickMessage: `Kick par ${kickerName}${reason}`, kickedFromRoom: kickedRoom || roomId });
          }
        }
      }

      const evtId = event.getId?.();
      if (evtId) pendingDecryptedEvents.add(evtId);

      // Coalesce bursts of decryption events into a single state update.
      // Throttle (not debounce): schedule a flush at most once every 200ms.
      // The previous debounce reset the timer on every new decryption, so
      // during a burst at login (hundreds of events) the timer never fired
      // until decryption calmed down, leaving rooms apparently empty on
      // first click.
      if (decryptReloadTimer) return;
      decryptReloadTimer = setTimeout(() => {
        decryptReloadTimer = null;
        if (pendingDecryptedEvents.size === 0) return;
        const decryptedIds = new Set(pendingDecryptedEvents);
        pendingDecryptedEvents.clear();

        set((s) => {
          let changed = false;
          const updated = { ...s.messages };

          // Include rooms that may have no messages yet but just received decrypted events
          const roomIdsToCheck = new Set<string>(Object.keys(updated));
          for (const room of client.getRooms()) {
            roomIdsToCheck.add(room.roomId);
          }

          for (const roomId of roomIdsToCheck) {
            const room = client.getRoom(roomId);
            if (!room) continue;
            const msgs = updated[roomId] || [];

            const freshMsgs = extractMessagesFromRoom(room);
            const freshById = new Map(freshMsgs.map((m) => [m.eventId, m]));
            const freshIds = new Set(freshMsgs.map((m) => m.eventId));

            // 0. Drop stale local-echo entries: when the SDK confirms a sent
            // message, it mutates the eventId in place from "~localXXX" to
            // "$realXXX". Our store still holds the old local ID — without
            // removing it, the insert step below would create a duplicate.
            const cleanedMsgs = msgs.filter(
              (m) => !m.eventId?.startsWith("~") || freshIds.has(m.eventId),
            );
            if (cleanedMsgs.length !== msgs.length) changed = true;
            const existingIds = new Set(cleanedMsgs.map((m) => m.eventId));

            // A message has displayable content if it has text OR attachments
            const hasContent = (m: ChatMessage) =>
              !!m.text || (Array.isArray(m.attachments) && m.attachments.length > 0);

            // 1. Update existing messages whose decryption just completed
            let next = cleanedMsgs.map((msg) => {
              if (!msg.eventId || !decryptedIds.has(msg.eventId)) return msg;
              const fresh = freshById.get(msg.eventId);
              if (fresh && hasContent(fresh)) {
                changed = true;
                return fresh;
              }
              return msg;
            });

            // 2. Insert newly decrypted messages that were never added (real-time E2EE)
            const toInsert = freshMsgs.filter(
              (fm) =>
                fm.eventId &&
                decryptedIds.has(fm.eventId) &&
                !existingIds.has(fm.eventId) &&
                hasContent(fm),
            );
            if (toInsert.length > 0) {
              next = [...next, ...toInsert];
              changed = true;
            }

            // 3. Sync reactions from freshMsgs. When an m.reaction event is decrypted,
            // its eventId (the reaction's own id) won't match any message in next, so
            // steps 1-2 won't fire. But extractMessagesFromRoom already attached the
            // new reaction to its target inside freshMsgs. We propagate that here.
            const reactionsKey = (m: ChatMessage) =>
              (m.reactions || [])
                .map((r) => `${r.emoji}:${r.count}:${r.userIds.slice().sort().join(",")}`)
                .join("|");
            next = next.map((msg) => {
              if (!msg.eventId) return msg;
              const fresh = freshById.get(msg.eventId);
              if (!fresh) return msg;
              if (reactionsKey(msg) === reactionsKey(fresh)) return msg;
              changed = true;
              return { ...msg, reactions: fresh.reactions };
            });

            if (next !== msgs) updated[roomId] = next;
          }
          return changed ? { messages: updated } : s;
        });
      }, 200);
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
    const { roomLoadingHistory, roomHasMore } = get();
    const hasMoreVal = roomHasMore[roomId];
    if (roomLoadingHistory[roomId]) return;
    if (hasMoreVal !== true && hasMoreVal !== undefined) return;

    const client = matrixService.getMatrixClient();
    if (!client) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    // Send read receipt when opening a room
    matrixService.markRoomAsRead(roomId);

    set((s) => ({ roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: true } }));

    try {
      // Use the SDK's scrollback instead of a custom /messages fetch.
      // scrollback() uses the prev_batch token attached to the live timeline
      // by sync. The Matrix /messages endpoint returns ALL event types
      // (state, call.member, reactions, …) in a single chunk — for voice-heavy
      // rooms with lots of membership churn, a single 200-event page can
      // contain zero actual messages. Loop until we have enough displayable
      // messages or we've hit the start of the timeline.
      // Load 30 more messages on top of whatever we already have. Works
      // both for the initial load and subsequent scroll-up: each call
      // expands the timeline by ~30 displayable messages, regardless of
      // how many non-message events (state, call memberships) are in
      // between.
      const MESSAGES_PER_CALL = 30;
      // Voice-heavy rooms can pack 1000+ call.member / encryption_keys /
      // m.reaction events between consecutive text messages. With the old
      // cap of 10 × 200 = 2000 events, we'd bail before reaching the first
      // text message and the UI showed "1 message" on entry. 50 × 200 =
      // 10000 events is enough to traverse the busiest voice rooms we
      // have in the wild, bounded so a truly empty room can't spin forever.
      const MAX_ITERATIONS = 50;
      // Count displayable messages. matrix-js-sdk has a subtle quirk: events
      // fetched via backward pagination (`scrollback`) sometimes keep
      // `getType() === "m.room.encrypted"` even after successful decryption,
      // while their `getContent()` correctly returns the cleartext body
      // with `msgtype`. Filtering on getType alone undercounts — sometimes
      // by two orders of magnitude in voice-heavy rooms — and the loop
      // bails thinking the room is empty.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isMessageEvent = (e: any) => {
        if (e.getType?.() === "m.room.message") return true;
        const content = e.getContent?.();
        return !!content?.msgtype;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const countMessages = () => room.getLiveTimeline().getEvents().filter((e: any) => isMessageEvent(e)).length;
      const target = countMessages() + MESSAGES_PER_CALL;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (countMessages() >= target) break;
        const before = room.getLiveTimeline().getEvents().length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).scrollback(room, 200);
        const afterScroll = room.getLiveTimeline().getEvents().length;
        // No new events → we're at the start of history.
        if (afterScroll === before) break;
        // Decrypt newly-backfilled events INLINE before the next iteration's
        // count. `scrollback()` resolves when the HTTP fetch completes, but
        // matrix-js-sdk queues decryption to a separate worker — if we count
        // immediately, the freshly-fetched Megolm payloads still look like
        // `m.room.encrypted` with no cleartext, and `countMessages()` returns
        // 0 even when the batch contains dozens of messages. Awaiting
        // `decryptEventIfNeeded` per event is idempotent (fast no-op when
        // already decrypted) and catches up the queue before we decide
        // whether to keep paginating.
        const events = room.getLiveTimeline().getEvents();
        await Promise.all(events.map((evt: { isEncrypted: () => boolean; getClearContent: () => unknown }) =>
          evt.isEncrypted() && !evt.getClearContent()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? (client as any).decryptEventIfNeeded(evt).catch(() => { /* leave as failure placeholder */ })
            : Promise.resolve(),
        ));
      }

      // Decrypt any encrypted events that were backfilled
      const timeline = room.getLiveTimeline().getEvents();
      for (const evt of timeline) {
        if (evt.isEncrypted()) {
          try {
            await client.decryptEventIfNeeded(evt);
          } catch { /* will show as encrypted placeholder */ }
        }
      }

      const merged = extractMessagesFromEvents(timeline, room, client);

      // Load pinned messages that may not be in the backfilled window
      const baseUrl = client.getHomeserverUrl();
      const accessToken = client.getAccessToken();
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
            if (pinnedMsgs.length > 0) merged.push(pinnedMsgs[0]);
          } catch { /* skip unavailable pinned messages */ }
        }
      }

      // Whether older history is still available: the live timeline exposes
      // a backward pagination token only while more events exist on the server.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveTimeline = (room as any).getLiveTimeline?.();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canPaginateBackward = !!liveTimeline?.getPaginationToken?.("b");

      set((s) => ({
        messages: merged.length > 0 ? { ...s.messages, [roomId]: merged } : s.messages,
        roomHasMore: { ...s.roomHasMore, [roomId]: canPaginateBackward },
        roomLoadingHistory: { ...s.roomLoadingHistory, [roomId]: false },
      }));

      if (merged.length > 5) {
        const messageIds = merged.map((m) => m.eventId).filter(Boolean) as string[];
        setCachedRoom(roomId, messageIds, null);
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
      // Can't redact local/pending events (ID starts with ~ instead of $)
      if (!eventId.startsWith("$")) {
        console.warn("[Sion] Cannot delete message with local ID:", eventId);
        return;
      }
      await matrixService.redactMessage(channelId, eventId);
      // Remove from local state immediately
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: (s.messages[channelId] || []).filter((m) => m.id !== eventId && m.eventId !== eventId),
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

// Dev helper: expose matrix client + a couple of one-shot admin actions
// on `window` so issues can be worked around from DevTools.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__SION_DEBUG__ = {
    getClient: () => matrixService.getMatrixClient(),
    // Get the current LiveKit Room so tests can inspect remote participants,
    // subscribed tracks, and whether audio is actually coming through.
    getLKRoom: () => {
      // Lazy import to avoid a circular dependency at module load.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return import("../services/livekitService").then(m => m.getCurrentRoom());
    },
    // One-shot dump of LiveKit voice state: self + remotes, with their tracks.
    dumpVoice: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room: any = await (window as any).__SION_DEBUG__.getLKRoom();
      if (!room) { console.log("[Sion] no current LiveKit room"); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const summarize = (p: any) => ({
        identity: p.identity,
        name: p.name,
        isLocal: p === room.localParticipant,
        tracks: Array.from(p.trackPublications?.values?.() ?? []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (pub: any) => ({
            sid: pub.trackSid,
            source: pub.source,
            kind: pub.kind,
            muted: pub.isMuted,
            subscribed: pub.isSubscribed,
            hasTrack: !!pub.track,
          }),
        ),
      });
      const all = [room.localParticipant, ...room.remoteParticipants.values()].map(summarize);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = [];
      for (const p of all) {
        if (p.tracks.length === 0) {
          rows.push({ who: p.identity, sid: "(none)", source: "", kind: "", muted: "", subscribed: "", hasTrack: false });
        } else {
          for (const t of p.tracks) rows.push({ who: p.identity, ...t });
        }
      }
      console.table(rows);
      return all;
    },
    // Fix up an existing room so members who join later can see past messages.
    // Requires PL >= 50 in the room (admin-equivalent).
    setHistoryShared: async (roomId: string) => {
      const client = matrixService.getMatrixClient();
      if (!client) throw new Error("No matrix client");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sendStateEvent(
        roomId,
        "m.room.history_visibility",
        { history_visibility: "shared" },
        "",
      );
      console.log(`[Sion] history_visibility set to shared for ${roomId}`);
    },
  };
}
