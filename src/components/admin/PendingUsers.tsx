import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { checkUserSuspended, suspendUser, getRoomsList } from "../../services/adminService";
import { getMatrixClient, inviteUser } from "../../services/matrixService";
import { sendAdminCommand, findAdminRoom } from "../../services/adminCommandService";
import { usePendingUsersStore } from "../../stores/usePendingUsersStore";

interface UserEntry {
  userId: string;
  suspended: boolean;
}

function usePendingUsers() {
  const [pendingUsers, setPendingUsers] = useState<UserEntry[]>([]);
  const [activeUsers, setActiveUsers] = useState<UserEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const knownUserIds = usePendingUsersStore((s) => s._knownUserIds);

  const refresh = useCallback(async () => {
    if (knownUserIds.size === 0) return;

    setLoading(true);

    const pending: UserEntry[] = [];
    const active: UserEntry[] = [];

    for (const userId of knownUserIds) {
      try {
        const result = await checkUserSuspended(userId);
        if (result.suspended) {
          pending.push({ userId, suspended: true });
        } else {
          active.push({ userId, suspended: false });
        }
      } catch {
        active.push({ userId, suspended: false });
      }
    }

    pending.sort((a, b) => a.userId.localeCompare(b.userId));
    active.sort((a, b) => a.userId.localeCompare(b.userId));

    setPendingUsers(pending);
    setActiveUsers(active);
    setLoading(false);
  }, [knownUserIds]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { pendingUsers, activeUsers, loading, refresh };
}

export function PendingUsers() {
  const { t } = useTranslation();
  const { pendingUsers, activeUsers: _activeUsers, loading, refresh } = usePendingUsers();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const refreshPendingCount = usePendingUsersStore((s) => s.refresh);

  const handleApprove = async (userId: string) => {
    setActionLoading(userId);
    try {
      // 1. Unsuspend
      await suspendUser(userId, false);

      // 2. Récupérer toutes les rooms du serveur via l'API admin
      const adminRoomId = findAdminRoom();
      let roomIds: string[] = [];
      try {
        const res = await getRoomsList();
        const data = res as { rooms?: string[] };
        if (Array.isArray(data.rooms)) {
          roomIds = data.rooms;
        } else if (Array.isArray(res)) {
          roomIds = res as string[];
        }
      } catch {
        // Fallback : rooms visibles par le client
        const client = getMatrixClient();
        if (client) roomIds = client.getRooms().map((r) => r.roomId);
      }

      // 3. Joindre toutes les rooms sauf l'admin room et les DM
      const client = getMatrixClient();
      // Collecter les room IDs qui sont des DM
      const dmRoomIds = new Set<string>();
      try {
        const directEvent = client?.getAccountData("m.direct" as any);
        const directContent = (directEvent?.getContent() || {}) as Record<string, string[]>;
        for (const ids of Object.values(directContent)) {
          for (const id of ids) dmRoomIds.add(id);
        }
      } catch { /* ignore */ }

      for (const roomId of roomIds) {
        if (roomId === adminRoomId) continue;
        if (dmRoomIds.has(roomId)) continue;

        // Exclure aussi les rooms sans nom ni type (probablement des DM non taggés)
        const room = client?.getRoom(roomId);
        if (room && !room.name && room.getJoinedMemberCount() <= 2) continue;
        try {
          // Vérifier la join_rule de la room
          const room = client?.getRoom(roomId);
          const joinRuleEvent = room?.currentState.getStateEvents("m.room.join_rules", "");
          const joinRule = joinRuleEvent?.getContent?.()?.join_rule;

          if (joinRule === "invite") {
            // Room sur invitation : inviter d'abord puis force-join
            await inviteUser(roomId, userId);
          }
          await sendAdminCommand(`!admin users force-join-room ${userId} ${roomId}`);
        } catch {
          // Ignorer les erreurs individuelles
        }
      }

      await refresh();
      refreshPendingCount();
    } catch (err) {
      console.error("[Sion] Failed to approve user:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (userId: string) => {
    setActionLoading(userId);
    try {
      await sendAdminCommand(`!admin users deactivate ${userId}`);
      await refresh();
      refreshPendingCount();
    } catch (err) {
      console.error("[Sion] Failed to reject user:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const extractName = (userId: string) => {
    const match = userId.match(/^@([^:]+):/);
    return match ? match[1] : userId;
  };

  return (
    <>
      {/* Pending approvals */}
      <div style={{
        background: 'var(--color-surface-container)',
        borderRadius: 16,
        padding: '14px 8px',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 8px',
          marginBottom: 8,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.06em',
            color: 'var(--color-on-surface-variant)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            {t("admin.pending.title")}
            {pendingUsers.length > 0 && (
              <span style={{
                background: 'var(--color-error)',
                color: 'var(--color-on-error)',
                borderRadius: 10,
                padding: '1px 7px',
                fontSize: 10,
                fontWeight: 700,
              }}>
                {pendingUsers.length}
              </span>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              background: 'none',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              color: 'var(--color-on-surface-variant)',
              fontSize: 14,
              padding: '2px 6px',
              borderRadius: 8,
              opacity: loading ? 0.4 : 0.7,
            }}
            title={t("admin.pending.refresh")}
          >
            ↻
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--color-outline)', fontSize: 12 }}>
            ...
          </div>
        ) : pendingUsers.length === 0 ? (
          <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--color-outline)', fontSize: 12 }}>
            {t("admin.pending.none")}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {pendingUsers.map((user) => (
              <div
                key={user.userId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: 12,
                  background: 'var(--color-surface-container-high)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--color-on-surface)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {extractName(user.userId)}
                  </div>
                  <div style={{
                    fontSize: 10,
                    color: 'var(--color-outline)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {user.userId}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                  <button
                    onClick={() => handleApprove(user.userId)}
                    disabled={actionLoading === user.userId}
                    title={t("admin.pending.approve")}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 14,
                      border: 'none',
                      cursor: actionLoading === user.userId ? 'not-allowed' : 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      background: 'var(--color-primary)',
                      color: 'var(--color-on-primary)',
                      opacity: actionLoading === user.userId ? 0.5 : 1,
                    }}
                  >
                    ✔
                  </button>
                  <button
                    onClick={() => handleReject(user.userId)}
                    disabled={actionLoading === user.userId}
                    title={t("admin.pending.reject")}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 14,
                      border: 'none',
                      cursor: actionLoading === user.userId ? 'not-allowed' : 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      background: 'var(--color-error-container)',
                      color: 'var(--color-error)',
                      opacity: actionLoading === user.userId ? 0.5 : 1,
                    }}
                  >
                    ✗
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </>
  );
}
