import { useMemo, useState } from "react";
import { SpeakerIcon, MicIcon, HeadphoneIcon, CrownIcon, ShieldIcon, MessageBubbleIcon, SignalBarsIcon } from "../icons";
import { ChannelIcon } from "./ChannelIcon";
import { UserAvatar } from "./UserAvatar";
import { useAppStore, APP_SESSION_START_TS } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useLiveKitStore } from "../../stores/useLiveKitStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useVoiceChannel } from "../../hooks/useVoiceChannel";
import { useIsMobile } from "../../hooks/useIsMobile";
import { findAdminRoom } from "../../services/adminCommandService";
import { getMatrixClient } from "../../services/matrixService";
import * as matrixService from "../../services/matrixService";
import type { Channel, UserRole } from "../../types/matrix";

function roleIcon(role: UserRole) {
  if (role === "admin") return <CrownIcon />;
  if (role === "mod") return <ShieldIcon />;
  return null;
}

function roleColor(role: UserRole): string {
  if (role === "admin") return "var(--color-orange)";
  if (role === "mod") return "var(--color-yellow)";
  return "var(--color-on-surface-variant)";
}

// Extract display name and avatar from LiveKit participant identity
function getParticipantInfo(identity: string, roomId: string | null, localUserId: string | null, localDisplayName: string | null, localAvatarUrl: string | undefined) {
  // Check if this is the local user
  const isLocal = localUserId && (identity === localUserId || identity.startsWith(localUserId + ":"));

  if (isLocal && localDisplayName) {
    return { name: localDisplayName, avatarUrl: localAvatarUrl, isLocal: true };
  }

  // Extract Matrix user ID from identity (format: @user:server.com or @user:server.com:deviceId)
  const userIdMatch = identity.match(/^(@[^:]+:[^:]+)/);
  const userId = userIdMatch ? userIdMatch[1] : identity;

  const client = getMatrixClient();
  if (client) {
    // Try room member first — populated from room state events, reliable after sync
    if (roomId) {
      const room = client.getRoom(roomId);
      const member = room?.getMember?.(userId);
      if (member?.name) {
        const avatarMxc = member.getMxcAvatarUrl?.() || member.events?.member?.getContent?.()?.avatar_url;
        const avatarUrl = avatarMxc ? (client.mxcUrlToHttp(avatarMxc) ?? undefined) : undefined;
        return { name: member.name, avatarUrl, isLocal: false };
      }
    }

    // Fallback: global User object (may not have displayName right after reload)
    const user = client.getUser(userId);
    if (user) {
      const name = user.displayName || userIdMatch?.[1]?.replace("@", "").split(":")[0] || identity;
      const avatarUrl = user.avatarUrl ? (client.mxcUrlToHttp(user.avatarUrl) ?? undefined) : undefined;
      return { name, avatarUrl, isLocal: false };
    }
  }

  // Fallback: extract localpart from identity
  const localpart = identity.replace("@", "").split(":")[0].split(":")[0];
  return { name: localpart, avatarUrl: undefined, isLocal: false };
}

export function ChannelItem({ channel }: { channel: Channel }) {
  const activeChannel = useAppStore((s) => s.activeChannel);
  const connectedVoiceChannel = useAppStore((s) => s.connectedVoiceChannel);
  const setActiveChannel = useAppStore((s) => s.setActiveChannel);
  const loadRoomHistory = useMatrixStore((s) => s.loadRoomHistory);
  const currentUserId = useMatrixStore((s) => s.currentUserId);
  const liveKitParticipants = useLiveKitStore((s) => s.participants);
  const liveKitConnected = useLiveKitStore((s) => s.connected);
  const credentials = useAuthStore((s) => s.credentials);
  const matrixConnected = useMatrixStore((s) => s.connectionStatus);
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const setSidebarView = useSettingsStore((s) => s.setSidebarView);
  const { joinVoiceChannel, hasLiveKitConfig } = useVoiceChannel();

  const isMobile = useIsMobile();
  const openUserContextMenu = useAppStore((s) => s.openUserContextMenu);
  const [hoveredUserId, setHoveredUserId] = useState<string | null>(null);

  const messages = useMatrixStore((s) => s.messages[channel.id]);
  const lastReadId = useAppStore((s) => s.lastReadMessageId[channel.id]);

  const unreadCount = useMemo(() => {
    if (!messages || messages.length === 0 || channel.id === findAdminRoom()) return 0;
    // Messages sent by the current user are always considered read — they shouldn't
    // bump the unread badge (e.g. sending a poke in a DM, or own messages echoed back).
    const isUnreadMsg = (m: { senderId?: string; ts?: number }) => !currentUserId || m.senderId !== currentUserId;
    // Session-start fallback: ignore pre-session history whose read state
    // we don't reliably know.
    const sessionFilter = (m: { ts?: number; senderId?: string }) =>
      (m.ts ?? 0) > APP_SESSION_START_TS && isUnreadMsg(m);

    if (!lastReadId) {
      // Channel never opened: count only messages that arrived this session.
      return messages.filter(sessionFilter).length;
    }
    const idx = messages.findIndex((m) => (m.eventId || String(m.id)) === lastReadId);
    if (idx === -1) {
      // lastReadId fell outside the loaded window (e.g. long-running channel).
      // We can't trust the full list — fall back to session-start filter.
      return messages.filter(sessionFilter).length;
    }
    return messages.slice(idx + 1).filter(isUnreadMsg).length;
  }, [messages, lastReadId, channel.id, currentUserId]);

  const isActive = activeChannel === channel.id;
  const isConnectedChannel = connectedVoiceChannel === channel.id;

  const handleClick = async () => {
    setActiveChannel(channel.id, channel.hasVoice);
    loadRoomHistory(channel.id);
    // On mobile: single tap on voice channel joins it directly
    if (isMobile && channel.hasVoice && connectedVoiceChannel !== channel.id && hasLiveKitConfig) {
      try {
        await joinVoiceChannel(channel.id);
      } catch (err) {
        console.error("[Sion] Failed to join voice channel:", err);
      }
    }
  };

  const handleDoubleClick = async () => {
    if (!channel.hasVoice) return;
    if (connectedVoiceChannel !== channel.id && hasLiveKitConfig) {
      try {
        await joinVoiceChannel(channel.id);
      } catch (err) {
        console.error("[Sion] Failed to join voice channel:", err);
      }
    }
  };

  const handleDMClick = async (userId: string, userName: string) => {
    try {
      const roomId = await matrixService.createOrGetDMRoom(userId);
      const channels = useMatrixStore.getState().channels;
      const exists = channels.some((c) => c.id === roomId);
      setActiveChannel(roomId, false);
      setSidebarView("dm");
      if (!exists) {
        useMatrixStore.getState().setChannels([
          ...channels,
          { id: roomId, name: userName, hasVoice: false, voiceUsers: [], createdAt: Date.now(), lastActivity: Date.now(), isDM: true, dmUserId: userId },
        ]);
      }
    } catch (err) {
      console.error("[Sion] Failed to create/get DM room:", err);
    }
  };

  // Enrich LiveKit participants with Matrix display names and avatars
  // Filter by Matrix call.member events to avoid showing users from other channels
  // (the SFU may share the same LiveKit room across multiple Matrix rooms)
  const voiceUsers = useMemo(() => {
    if (!isConnectedChannel || !liveKitConnected) {
      return channel.voiceUsers;
    }

    const localUserId = credentials?.userId || null;
    const localDisplayName = credentials?.displayName || null;
    const localAvatarUrl = credentials?.avatarUrl;

    // Build a set of user IDs that are actually in THIS room's MatrixRTC session
    const matrixMemberIds = new Set(channel.voiceUsers.map((u) => u.id));
    // Always include the local user (they may not yet appear in call.member events)
    if (localUserId) matrixMemberIds.add(localUserId);

    return liveKitParticipants
      .filter((p) => {
        // Extract the Matrix user ID from LiveKit identity (format: @user:server or @user:server:deviceId)
        const userIdMatch = p.identity.match(/^(@[^:]+:[^:]+)/);
        const userId = userIdMatch ? userIdMatch[1] : p.identity;
        return matrixMemberIds.has(userId);
      })
      .map((p) => {
        const info = getParticipantInfo(p.identity, channel.id, localUserId, localDisplayName, localAvatarUrl);
        const isSelf = info.isLocal;
        const muted = isSelf ? isMuted : p.isMuted;
        // Local: use the store (canonical truth). Remote: read the deafened
        // flag broadcast via LiveKit participant metadata.
        const deafened = isSelf ? isDeafened : p.isDeafened;
        return {
          id: p.identity,
          name: info.name,
          avatarUrl: info.avatarUrl || undefined,
          role: "user" as UserRole,
          speaking: muted ? false : p.isSpeaking,
          muted,
          deafened,
          connectionQuality: p.connectionQuality,
          playingSoundEmoji: p.playingSoundEmoji,
        };
      });
  }, [isConnectedChannel, liveKitConnected, liveKitParticipants, channel.voiceUsers, credentials, isMuted, isDeafened, matrixConnected]);

  // Context menu state (right-click on a DM offers "leave conversation")
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const closeCtxMenu = () => setCtxMenu(null);
  const handleLeaveDM = async () => {
    closeCtxMenu();
    if (!channel.isDM) return;
    if (!window.confirm(`Quitter la conversation avec ${channel.name} ?`)) return;
    try {
      const client = getMatrixClient();
      if (!client) return;
      await client.leave(channel.id);
      // Scrub this room from m.direct so it doesn't come back as an auto-resolved DM.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const directEvent = (client as any).getAccountData("m.direct");
        const prev = (directEvent?.getContent?.() || {}) as Record<string, string[]>;
        const next: Record<string, string[]> = {};
        for (const [peer, rooms] of Object.entries(prev)) {
          const filtered = rooms.filter((rid) => rid !== channel.id);
          if (filtered.length > 0) next[peer] = filtered;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).setAccountData("m.direct", next);
      } catch { /* m.direct cleanup is best-effort */ }
    } catch (err) {
      console.error("[Sion] Failed to leave DM:", err);
    }
  };

  return (
    <div>
      {/* M3 Navigation Drawer item */}
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => {
          if (!channel.isDM) return;
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderRadius: 28,
          border: 'none',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: isActive ? 600 : 500,
          fontFamily: 'inherit',
          textAlign: 'left' as const,
          transition: 'all 200ms cubic-bezier(0.2, 0, 0, 1)',
          background: isActive ? 'var(--color-secondary-container)' : 'transparent',
          color: isActive ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
          letterSpacing: '0.01em',
        }}
      >
        <ChannelIcon icon={channel.icon} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {channel.isDM ? `💬 ${channel.name}` : channel.name}
        </span>
        {unreadCount > 0 && !isActive && (
          <span style={{
            minWidth: 18, height: 18, padding: '0 5px',
            borderRadius: 9,
            background: 'var(--color-error)',
            color: 'var(--color-on-error, #fff)',
            fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            lineHeight: 1,
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {channel.hasVoice && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: isConnectedChannel ? 'var(--color-green)' : 'var(--color-outline)' }}>
            <SpeakerIcon />
            {voiceUsers.length > 0 && (
              <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{voiceUsers.length}</span>
            )}
          </span>
        )}
      </button>

      {/* Voice users */}
      {channel.hasVoice && voiceUsers.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 2,
          marginBottom: 4,
          marginLeft: 36,
          paddingLeft: 12,
          borderLeft: '2px solid var(--color-outline-variant)',
        }}>
          {voiceUsers.map((u) => {
            const isSelf = currentUserId && (u.id === currentUserId || u.id.startsWith(currentUserId + ":"));
            return (
              <div
                key={u.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openUserContextMenu({ userId: u.id, userName: u.name, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={() => setHoveredUserId(u.id)}
                onMouseLeave={() => setHoveredUserId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  fontSize: 11,
                  borderRadius: 8,
                  cursor: 'default',
                }}
              >
                <UserAvatar name={u.name} speaking={isConnectedChannel && u.speaking} size="sm" avatarUrl={u.avatarUrl || undefined} playingSoundEmoji={isConnectedChannel ? u.playingSoundEmoji : undefined} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: roleColor(u.role), fontWeight: u.role !== "user" ? 600 : 400, opacity: u.deafened ? 0.55 : 0.8 }}>
                  {u.name}
                </span>
                {u.deafened && (
                  <span
                    title="AFK (sourdine)"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      padding: '1px 5px',
                      borderRadius: 6,
                      background: 'var(--color-surface-container-high)',
                      color: 'var(--color-on-surface-variant)',
                      flexShrink: 0,
                    }}
                  >
                    AFK
                  </span>
                )}
                <span style={{ display: 'flex', gap: 4, alignItems: 'center', opacity: 0.5 }}>
                  {roleIcon(u.role)}
                  {/* Hide redundant mic/headphone icons when AFK badge already conveys the state */}
                  {u.muted && !u.deafened && <MicIcon muted />}
                  {u.deafened && <HeadphoneIcon muted />}
                  {u.connectionQuality && u.connectionQuality !== "excellent" && u.connectionQuality !== "unknown" && (
                    <SignalBarsIcon quality={u.connectionQuality} size={12} />
                  )}
                  {!isSelf && hoveredUserId === u.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Extract Matrix user ID from identity
                        const userIdMatch = u.id.match(/^(@[^:]+:[^:]+)/);
                        const userId = userIdMatch ? userIdMatch[1] : u.id;
                        handleDMClick(userId, u.name);
                      }}
                      title="DM"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 2,
                        color: 'var(--color-on-surface-variant)',
                        display: 'flex',
                        alignItems: 'center',
                        opacity: 1,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-on-surface-variant)')}
                    >
                      <MessageBubbleIcon />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {ctxMenu && (
        <>
          {/* Invisible fullscreen catcher closes the menu on any outside click */}
          <div
            onClick={closeCtxMenu}
            onContextMenu={(e) => { e.preventDefault(); closeCtxMenu(); }}
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
          />
          <div
            style={{
              position: 'fixed',
              left: ctxMenu.x,
              top: ctxMenu.y,
              zIndex: 1000,
              background: 'var(--color-surface-container-high)',
              borderRadius: 12,
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
              padding: '6px 0',
              minWidth: 220,
              fontSize: 13,
            }}
          >
            <button
              onClick={handleLeaveDM}
              style={{
                width: '100%', padding: '8px 16px', border: 'none',
                background: 'transparent', textAlign: 'left' as const,
                cursor: 'pointer', color: 'var(--color-error)', fontFamily: 'inherit',
                fontSize: 13,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-error-container)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Quitter cette conversation
            </button>
          </div>
        </>
      )}
    </div>
  );
}
