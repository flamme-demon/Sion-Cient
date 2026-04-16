import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { getMatrixClient, getMemberPowerLevel } from "../../services/matrixService";
import { UserAvatar } from "../sidebar/UserAvatar";

type Role = "admin" | "moderator" | "user";

interface Entry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  pl: number;
}

function plToRole(pl: number): Role {
  if (pl >= 100) return "admin";
  if (pl >= 50) return "moderator";
  return "user";
}

export function MemberPanel() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const showMemberPanel = useAppStore((s) => s.showMemberPanel);
  const toggleMemberPanel = useAppStore((s) => s.toggleMemberPanel);
  const openUserContextMenu = useAppStore((s) => s.openUserContextMenu);
  const channels = useMatrixStore((s) => s.channels);
  const channel = channels.find((c) => c.id === activeChannel);
  const [tick, setTick] = useState(0);

  // Refresh list on Matrix state events (member joins/leaves, power level changes)
  useEffect(() => {
    if (!showMemberPanel || !activeChannel) return;
    const client = getMatrixClient();
    if (!client) return;
    const room = client.getRoom(activeChannel);
    if (!room) return;
    const bump = () => setTick((n) => n + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = room as any;
    r.on("RoomMember.membership", bump);
    r.on("RoomMember.powerLevel", bump);
    r.on("RoomState.events", bump);
    return () => {
      r.off("RoomMember.membership", bump);
      r.off("RoomMember.powerLevel", bump);
      r.off("RoomState.events", bump);
    };
  }, [showMemberPanel, activeChannel]);

  const entries = useMemo<Entry[]>(() => {
    void tick;
    if (!activeChannel) return [];
    const client = getMatrixClient();
    if (!client) return [];
    const room = client.getRoom(activeChannel);
    if (!room) return [];
    const members = room.getJoinedMembers();
    const list: Entry[] = members.map((m) => {
      const pl = getMemberPowerLevel(activeChannel, m.userId);
      const avatarUrl = m.getAvatarUrl(client.baseUrl, 64, 64, "crop", true, false) || null;
      return {
        userId: m.userId,
        displayName: m.name || m.userId,
        avatarUrl,
        role: plToRole(pl),
        pl,
      };
    });
    list.sort((a, b) => {
      if (a.pl !== b.pl) return b.pl - a.pl;
      return a.displayName.localeCompare(b.displayName);
    });
    return list;
  }, [activeChannel, tick]);

  if (!showMemberPanel || !activeChannel || channel?.isDM) return null;

  const sections: { role: Role; entries: Entry[] }[] = [
    { role: "admin", entries: entries.filter((e) => e.role === "admin") },
    { role: "moderator", entries: entries.filter((e) => e.role === "moderator") },
    { role: "user", entries: entries.filter((e) => e.role === "user") },
  ];

  const roleLabel = (r: Role) => r === "admin" ? t("contextMenu.roleAdmin") : r === "moderator" ? t("contextMenu.roleModerator") : t("contextMenu.roleUser");

  return (
    <aside style={{
      width: 240,
      flexShrink: 0,
      background: 'var(--color-surface-container-low)',
      borderLeft: '1px solid var(--color-outline-variant)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-outline-variant)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t("members.title")} ({entries.length})
        </span>
        <button
          onClick={toggleMemberPanel}
          title={t("members.close")}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--color-on-surface-variant)',
            cursor: 'pointer',
            fontSize: 18,
            padding: 2,
            lineHeight: 1,
          }}
        >×</button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 6px 12px' }}>
        {sections.map((sec) => sec.entries.length > 0 && (
          <div key={sec.role}>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--color-outline)',
              padding: '10px 10px 4px',
            }}>
              {roleLabel(sec.role)} — {sec.entries.length}
            </div>
            {sec.entries.map((e) => (
              <div
                key={e.userId}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  openUserContextMenu({ userId: e.userId, userName: e.displayName, x: ev.clientX, y: ev.clientY });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 8,
                  cursor: 'default',
                }}
                onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--color-surface-container)'; }}
                onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
              >
                <UserAvatar name={e.displayName} size="sm" speaking={false} avatarUrl={e.avatarUrl || undefined} />
                <span style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 13,
                  color: e.role === "admin" ? 'var(--color-primary)' : e.role === "moderator" ? 'var(--color-tertiary)' : 'var(--color-on-surface)',
                  fontWeight: e.role !== "user" ? 600 : 400,
                }}>
                  {e.displayName}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
