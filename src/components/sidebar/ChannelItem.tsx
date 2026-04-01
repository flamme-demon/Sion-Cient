import { SpeakerIcon, MicIcon, HeadphoneIcon, CrownIcon, ShieldIcon, MessageBubbleIcon } from "../icons";
import { ChannelIcon } from "./ChannelIcon";
import { UserAvatar } from "./UserAvatar";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useLiveKitStore } from "../../stores/useLiveKitStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useVoiceChannel } from "../../hooks/useVoiceChannel";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getMatrixClient } from "../../services/matrixService";
import * as matrixService from "../../services/matrixService";
import type { Channel, UserRole } from "../../types/matrix";
import { useMemo, useState } from "react";
import { UserContextMenu } from "./UserContextMenu";

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
function getParticipantInfo(identity: string, localUserId: string | null, localDisplayName: string | null, localAvatarUrl: string | undefined) {
  // Check if this is the local user
  const isLocal = localUserId && (identity === localUserId || identity.startsWith(localUserId + ":"));

  if (isLocal && localDisplayName) {
    return { name: localDisplayName, avatarUrl: localAvatarUrl, isLocal: true };
  }

  // Try to get user info from Matrix client
  const client = getMatrixClient();
  if (client) {
    // Extract Matrix user ID from identity (format: @user:server.com or @user:server.com:deviceId)
    const userIdMatch = identity.match(/^(@[^:]+:[^:]+)/);
    const userId = userIdMatch ? userIdMatch[1] : identity;

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
  const connectingVoiceChannel = useAppStore((s) => s.connectingVoiceChannel);
  const setActiveChannel = useAppStore((s) => s.setActiveChannel);
  const loadRoomHistory = useMatrixStore((s) => s.loadRoomHistory);
  const currentUserId = useMatrixStore((s) => s.currentUserId);
  const liveKitParticipants = useLiveKitStore((s) => s.participants);
  const liveKitConnected = useLiveKitStore((s) => s.connected);
  const credentials = useAuthStore((s) => s.credentials);
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const setSidebarView = useSettingsStore((s) => s.setSidebarView);
  const { joinVoiceChannel, hasLiveKitConfig } = useVoiceChannel();

  const isMobile = useIsMobile();
  const [userContextMenu, setUserContextMenu] = useState<{ userId: string; userName: string; x: number; y: number } | null>(null);
  const [hoveredUserId, setHoveredUserId] = useState<string | null>(null);

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
        const info = getParticipantInfo(p.identity, localUserId, localDisplayName, localAvatarUrl);
        const isSelf = info.isLocal;
        const muted = isSelf ? isMuted : p.isMuted;
        const deafened = isSelf ? isDeafened : false;
        return {
          id: p.identity,
          name: info.name,
          avatarUrl: info.avatarUrl || undefined,
          role: "user" as UserRole,
          speaking: muted ? false : p.isSpeaking,
          muted,
          deafened,
        };
      });
  }, [isConnectedChannel, liveKitConnected, liveKitParticipants, channel.voiceUsers, credentials, isMuted, isDeafened]);

  return (
    <div>
      {/* M3 Navigation Drawer item */}
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
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
                  setUserContextMenu({ userId: u.id, userName: u.name, x: e.clientX, y: e.clientY });
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
                <UserAvatar name={u.name} speaking={isConnectedChannel && u.speaking} size="sm" avatarUrl={u.avatarUrl || undefined} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: roleColor(u.role), fontWeight: u.role !== "user" ? 600 : 400, opacity: 0.8 }}>
                  {u.name}
                </span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center', opacity: 0.5 }}>
                  {roleIcon(u.role)}
                  {u.muted && <MicIcon muted />}
                  {u.deafened && <HeadphoneIcon muted />}
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

      {/* User context menu */}
      {userContextMenu && (
        <UserContextMenu
          userId={userContextMenu.userId}
          userName={userContextMenu.userName}
          x={userContextMenu.x}
          y={userContextMenu.y}
          onClose={() => setUserContextMenu(null)}
        />
      )}
    </div>
  );
}
