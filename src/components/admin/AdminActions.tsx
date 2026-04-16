import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as matrixService from "../../services/matrixService";
import { getRoomsList, banRoom } from "../../services/adminService";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { getMatrixClient } from "../../services/matrixService";
import { sendAdminCommand, findAdminRoom } from "../../services/adminCommandService";

export function AdminActions() {
  const { t } = useTranslation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelIsVoice, setNewChannelIsVoice] = useState(false);
  const [newChannelIsPublic, setNewChannelIsPublic] = useState(true);
  const [creating, setCreating] = useState(false);
  const channels = useMatrixStore((s) => s.channels);
  const [showRoomManager, setShowRoomManager] = useState(false);
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [deletingRoom, setDeletingRoom] = useState<string | null>(null);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState<string | null>(null);

  // Permissions modal state
  const [showPermissions, setShowPermissions] = useState(false);
  const [permUsers, setPermUsers] = useState<{ userId: string; isAdmin: boolean }[]>([]);
  const [permLoading, setPermLoading] = useState(false);
  const [permAction, setPermAction] = useState<string | null>(null);

  const loadRooms = async () => {
    setRoomsLoading(true);
    try {
      const res = await getRoomsList();
      const list = (res as { rooms?: string[] }).rooms;
      if (Array.isArray(list)) {
        setRoomIds(list);
      }
    } catch (err) {
      console.error("[Sion] Failed to load rooms:", err);
    } finally {
      setRoomsLoading(false);
    }
  };

  useEffect(() => {
    if (showRoomManager) loadRooms();
  }, [showRoomManager]);

  // Load users + detect admin status for permissions modal
  const loadPermUsers = useCallback(async () => {
    setPermLoading(true);
    try {
      const client = getMatrixClient();
      if (!client) return;
      const serverName = client.getDomain() || "";
      const knownIds = new Set<string>();

      // Collect local users from all rooms
      for (const room of client.getRooms()) {
        for (const m of room.getJoinedMembers()) {
          if (m.userId.endsWith(`:${serverName}`)) {
            knownIds.add(m.userId);
          }
        }
      }

      // Detect admins via power levels in the admin room
      const adminIds = new Set<string>();
      const adminRoomId = findAdminRoom();
      if (adminRoomId) {
        const adminRoom = client.getRoom(adminRoomId);
        if (adminRoom) {
          const plEvent = adminRoom.currentState.getStateEvents("m.room.power_levels", "");
          const plContent = plEvent?.getContent?.() || {};
          const users = (plContent.users || {}) as Record<string, number>;
          for (const [userId, level] of Object.entries(users)) {
            if (level >= 100 && userId.endsWith(`:${serverName}`)) {
              adminIds.add(userId);
              knownIds.add(userId);
            }
          }
        }
      }

      // Build entries, skip bot accounts (Continuwuity / Conduwuit / Conduit
      // bots — never expose them as a manageable user since demoting the
      // homeserver bot would break admin powers)
      const isBot = (userId: string) => {
        const local = userId.split(":")[0].toLowerCase();
        return (
          local === "@conduit" ||
          local === "@conduwuit" ||
          local === "@continuwuity" ||
          local === "@server" ||
          local === "@admin"
        );
      };
      const entries: { userId: string; isAdmin: boolean }[] = [];
      for (const userId of knownIds) {
        if (isBot(userId)) continue;
        entries.push({ userId, isAdmin: adminIds.has(userId) });
      }

      // Sort: admins first, then alphabetical
      entries.sort((a, b) => {
        if (a.isAdmin && !b.isAdmin) return -1;
        if (!a.isAdmin && b.isAdmin) return 1;
        return a.userId.localeCompare(b.userId);
      });

      setPermUsers(entries);
    } catch (err) {
      console.error("[Sion] Failed to load permissions:", err);
    } finally {
      setPermLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showPermissions) loadPermUsers();
  }, [showPermissions, loadPermUsers]);

  const handleToggleAdmin = async (userId: string, makeAdmin: boolean) => {
    setPermAction(userId);
    try {
      const adminRoomId = findAdminRoom();

      // Build the list of rooms to apply the change to. We restrict to rooms
      // where WE (the current admin) are joined AND have power level 100,
      // because the Matrix API requires that to read/write state events.
      // The Continuwuity admin API can list rooms we aren't in, but those
      // requests return 404/403, so filter them out upfront.
      const promoteClient = getMatrixClient();
      const myUserId = promoteClient?.getUserId() || "";
      let targetRoomIds: string[] = [];
      if (promoteClient) {
        for (const room of promoteClient.getRooms()) {
          if (room.roomId === adminRoomId) continue;
          if (matrixService.isDMRoom(room.roomId)) continue;
          // Skip rooms we're not joined to
          if (room.getMyMembership() !== "join") continue;
          // Skip rooms where we don't have admin power
          const myPl = matrixService.getMemberPowerLevel(room.roomId, myUserId);
          if (myPl < 100) continue;
          targetRoomIds.push(room.roomId);
        }
      }

      if (makeAdmin) {
        // Promouvoir : flag homeserver + join admin room + set PL 100 partout
        await sendAdminCommand(`!admin users make-user-admin ${userId}`);
        if (adminRoomId) {
          try {
            await sendAdminCommand(`!admin users force-join-room ${userId} ${adminRoomId}`);
          } catch { /* peut-être déjà dans la room */ }
        }
        // Continuwuity has no `force-promote` bot command, so we set PL via
        // the Matrix API. targetRoomIds is already pre-filtered to rooms
        // where we have admin powers, so M_FORBIDDEN errors should be rare.
        if (promoteClient) {
          for (const roomId of targetRoomIds) {
            // Force-join the target user if they aren't already a member,
            // otherwise setPowerLevel can't grant anything.
            const room = promoteClient.getRoom(roomId);
            const isMember = room?.getMember(userId)?.membership === "join";
            if (!isMember) {
              try {
                await sendAdminCommand(`!admin users force-join-room ${userId} ${roomId}`);
              } catch { /* ignore — already member or cannot join */ }
            }
            try {
              await promoteClient.setPowerLevel(roomId, userId, 100);
            } catch (err) {
              console.warn(`[Sion] Could not set PL 100 for ${userId} in ${roomId}:`, err);
            }
          }
        }
      } else {
        // Rétrograder : force-demote dans toutes les rooms non-DM + leave admin room
        for (const roomId of targetRoomIds) {
          try {
            await sendAdminCommand(`!admin users force-demote ${userId} ${roomId}`);
          } catch { /* ignore */ }
        }

        // Force-leave admin room
        if (adminRoomId) {
          try {
            await sendAdminCommand(`!admin users force-leave-room ${userId} ${adminRoomId}`);
          } catch { /* ignore */ }
        }
      }

      setPermUsers((prev) =>
        prev.map((u) => u.userId === userId ? { ...u, isAdmin: makeAdmin } : u)
      );
    } catch (err) {
      console.error("[Sion] Failed to toggle admin:", err);
    } finally {
      setPermAction(null);
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    setDeletingRoom(roomId);
    try {
      // Kick tous les membres du salon
      const client = getMatrixClient();
      const room = client?.getRoom(roomId);
      if (room) {
        const members = room.getJoinedMembers();
        for (const member of members) {
          if (member.userId.includes("conduit")) continue;
          try {
            await sendAdminCommand(`!admin users force-leave-room ${member.userId} ${roomId}`);
          } catch { /* ignore */ }
        }
      }

      // Bannir la room (empêche de la rejoindre)
      await banRoom(roomId, true);

      // Retirer de la liste
      setRoomIds((prev) => prev.filter((id) => id !== roomId));
      setConfirmDeleteRoom(null);
    } catch (err) {
      console.error("[Sion] Failed to delete room:", err);
    } finally {
      setDeletingRoom(null);
    }
  };

  const handleCreateChannel = async () => {
    if (!newChannelName.trim() || creating) return;
    setCreating(true);
    try {
      await matrixService.createChannel(newChannelName.trim(), newChannelIsVoice, newChannelIsPublic);
      setShowCreateModal(false);
      setNewChannelName("");
      setNewChannelIsVoice(false);
      setNewChannelIsPublic(true);
    } catch (err) {
      console.error("[Sion] Failed to create channel:", err);
    } finally {
      setCreating(false);
    }
  };

  const [soundboardBusy, setSoundboardBusy] = useState(false);
  const [soundboardToast, setSoundboardToast] = useState<string | null>(null);

  const handleSoundboard = async () => {
    if (soundboardBusy) return;
    setSoundboardBusy(true);
    setSoundboardToast(null);
    try {
      const res = await matrixService.createOrSyncSoundboardRoom();
      if (res.alreadyExisted) {
        setSoundboardToast(t("admin.actions.soundboardSynced", { count: res.invitedCount }));
      } else {
        setSoundboardToast(t("admin.actions.soundboardCreated"));
      }
    } catch (err) {
      console.error("[Sion] Failed to create/sync soundboard:", err);
      setSoundboardToast(t("admin.actions.soundboardFailed"));
    } finally {
      setSoundboardBusy(false);
      setTimeout(() => setSoundboardToast(null), 4000);
    }
  };

  const actions = [
    { label: t("admin.actions.createRoom"), icon: "+", onClick: () => setShowCreateModal(true), enabled: true },
    { label: t("admin.actions.manageRooms"), icon: "🏠", onClick: () => setShowRoomManager(true), enabled: true },
    { label: t("admin.actions.permissions"), icon: "\u{1F6E1}", onClick: () => setShowPermissions(true), enabled: true },
    { label: t("admin.actions.soundboard"), icon: "🔊", onClick: handleSoundboard, enabled: !soundboardBusy },
  ];

  return (
    <div style={{
      background: 'var(--color-surface-container)',
      borderRadius: 16,
      padding: '10px 12px',
    }}>
      {soundboardToast && (
        <div style={{
          padding: '8px 12px',
          marginBottom: 8,
          borderRadius: 12,
          background: 'var(--color-primary-container)',
          color: 'var(--color-on-primary-container)',
          fontSize: 12,
          textAlign: 'center',
        }}>{soundboardToast}</div>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        {actions.map((action, i) => (
          <button
            key={i}
            disabled={!action.enabled}
            onClick={action.enabled ? action.onClick : undefined}
            title={action.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: 12,
              border: 'none',
              background: 'var(--color-surface-container-high)',
              cursor: action.enabled ? 'pointer' : 'default',
              color: 'var(--color-on-surface-variant)',
              opacity: action.enabled ? 1 : 0.4,
              fontSize: 16,
              fontFamily: 'inherit',
              transition: 'background 200ms',
            }}
            onMouseEnter={(e) => { if (action.enabled) e.currentTarget.style.background = 'var(--color-primary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
          >
            {action.icon}
          </button>
        ))}
      </div>

      {showRoomManager && (
        <div
          onClick={() => setShowRoomManager(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface-container)',
              borderRadius: 24,
              padding: '28px 28px 20px 28px',
              maxWidth: 500,
              width: '90%',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {t("admin.actions.manageRooms")}
            </div>
            {roomsLoading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-outline)', fontSize: 13 }}>
                {t("settings.loadingSessions")}
              </div>
            ) : (
              <div style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* Séparer canaux et MPs */}
                {(() => {
                  const client = getMatrixClient();
                  const dmRoomIds = new Set<string>();
                  try {
                    const directEvent = client?.getAccountData("m.direct" as any);
                    const directContent = (directEvent?.getContent() || {}) as Record<string, string[]>;
                    for (const ids of Object.values(directContent)) {
                      for (const id of ids) dmRoomIds.add(id);
                    }
                  } catch { /* ignore */ }

                  const channelRooms = roomIds.filter((id) => !dmRoomIds.has(id));
                  const dmRooms = roomIds.filter((id) => dmRoomIds.has(id));

                  const adminRoomId = findAdminRoom();

                  return (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-on-surface-variant)', padding: '8px 4px 4px' }}>
                        {t("admin.actions.sectionChannels")} ({channelRooms.filter((id) => id !== adminRoomId).length})
                      </div>
                      {channelRooms.filter((id) => id !== adminRoomId).map((roomId) => {
                  const ch = channels.find((c) => c.id === roomId);
                  const isConfirming = confirmDeleteRoom === roomId;
                  return (
                    <div
                      key={roomId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderRadius: 12,
                        background: isConfirming ? 'var(--color-error-container)' : 'var(--color-surface-container-high)',
                        transition: 'background 200ms',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ch?.name || roomId}
                        </div>
                        {isConfirming && (
                          <div style={{ fontSize: 11, color: 'var(--color-error)', fontWeight: 500, marginTop: 2 }}>
                            {t("admin.actions.confirmDelete")}
                          </div>
                        )}
                      </div>
                      {isConfirming ? (
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                          <button
                            onClick={() => handleDeleteRoom(roomId)}
                            disabled={deletingRoom === roomId}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 16,
                              border: 'none',
                              cursor: deletingRoom === roomId ? 'not-allowed' : 'pointer',
                              fontSize: 12,
                              fontWeight: 600,
                              fontFamily: 'inherit',
                              background: 'var(--color-error)',
                              color: 'var(--color-on-error)',
                              opacity: deletingRoom === roomId ? 0.5 : 1,
                            }}
                          >
                            {deletingRoom === roomId ? "..." : t("admin.actions.confirmYes")}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteRoom(null)}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 16,
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 12,
                              fontWeight: 500,
                              fontFamily: 'inherit',
                              background: 'var(--color-surface-container-high)',
                              color: 'var(--color-on-surface)',
                            }}
                          >
                            {t("auth.cancel")}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteRoom(roomId)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 16,
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 500,
                            fontFamily: 'inherit',
                            flexShrink: 0,
                            marginLeft: 8,
                            background: 'var(--color-error-container)',
                            color: 'var(--color-error)',
                          }}
                        >
                          {t("admin.actions.deleteRoom")}
                        </button>
                      )}
                    </div>
                  );
                })}

                      {dmRooms.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-on-surface-variant)', padding: '12px 4px 4px' }}>
                            {t("admin.actions.sectionDMs")} ({dmRooms.length})
                          </div>
                          {dmRooms.map((roomId) => {
                            const ch = channels.find((c) => c.id === roomId);
                            const room = client?.getRoom(roomId);
                            const myId = client?.getUserId();
                            const otherMember = room?.getJoinedMembers().find((m) => m.userId !== myId);
                            const dmName = otherMember?.name || otherMember?.userId || ch?.name || roomId;
                            return (
                              <div
                                key={roomId}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  padding: '6px 12px',
                                  borderRadius: 12,
                                  background: 'var(--color-surface-container-high)',
                                }}
                              >
                                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {dmName}
                                </div>
                              </div>
                            );
                          })}
                        </>
                      )}

                      {roomIds.length === 0 && (
                        <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-outline)', fontSize: 13 }}>
                          {t("admin.actions.noRooms")}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setShowRoomManager(false)}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-surface-container-high)',
                  color: 'var(--color-on-surface)',
                }}
              >
                {t("auth.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div
          onClick={() => setShowCreateModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface-container)',
              borderRadius: 24,
              padding: '28px 28px 20px 28px',
              maxWidth: 360,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {t("channels.createTitle")}
            </div>
            <input
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder={t("channels.channelName")}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateChannel(); }}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: 16,
                border: '2px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button
                onClick={() => setNewChannelIsVoice(false)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: !newChannelIsVoice ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: !newChannelIsVoice ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.typeText")}
              </button>
              <button
                onClick={() => setNewChannelIsVoice(true)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: newChannelIsVoice ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: newChannelIsVoice ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.typeVoice")}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button
                onClick={() => setNewChannelIsPublic(true)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: newChannelIsPublic ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: newChannelIsPublic ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.accessPublic")}
              </button>
              <button
                onClick={() => setNewChannelIsPublic(false)}
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: !newChannelIsPublic ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: !newChannelIsPublic ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                  transition: 'all 200ms',
                }}
              >
                {t("channels.accessInvite")}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowCreateModal(false); setNewChannelName(""); }}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-surface-container-high)',
                  color: 'var(--color-on-surface)',
                  transition: 'background 200ms',
                }}
              >
                {t("auth.cancel")}
              </button>
              <button
                onClick={handleCreateChannel}
                disabled={!newChannelName.trim() || creating}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: newChannelName.trim() && !creating ? 'pointer' : 'not-allowed',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-primary)',
                  color: 'var(--color-on-primary)',
                  transition: 'background 200ms',
                  opacity: newChannelName.trim() && !creating ? 1 : 0.5,
                }}
              >
                {creating ? t("channels.creating") : t("channels.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPermissions && (
        <div
          onClick={() => setShowPermissions(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface-container)',
              borderRadius: 24,
              padding: '28px 28px 20px 28px',
              maxWidth: 500,
              width: '90%',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {t("admin.actions.permissions")}
            </div>
            {permLoading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-outline)', fontSize: 13 }}>
                ...
              </div>
            ) : (
              <div style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {permUsers.map((user) => {
                  const name = user.userId.match(/^@([^:]+):/)?.[1] || user.userId;
                  return (
                    <div
                      key={user.userId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
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
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}>
                          {name}
                          {user.isAdmin && (
                            <span style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: 'var(--color-primary)',
                              color: 'var(--color-on-primary)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}>
                              admin
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {user.userId}
                        </div>
                      </div>
                      <button
                        onClick={() => handleToggleAdmin(user.userId, !user.isAdmin)}
                        disabled={permAction === user.userId}
                        style={{
                          padding: '6px 14px',
                          borderRadius: 16,
                          border: 'none',
                          cursor: permAction === user.userId ? 'not-allowed' : 'pointer',
                          fontSize: 12,
                          fontWeight: 500,
                          fontFamily: 'inherit',
                          flexShrink: 0,
                          marginLeft: 8,
                          background: user.isAdmin
                            ? 'var(--color-error-container)'
                            : 'var(--color-primary-container)',
                          color: user.isAdmin
                            ? 'var(--color-error)'
                            : 'var(--color-on-primary-container)',
                          opacity: permAction === user.userId ? 0.5 : 1,
                        }}
                      >
                        {user.isAdmin
                          ? t("admin.actions.removeAdmin")
                          : t("admin.actions.makeAdmin")}
                      </button>
                    </div>
                  );
                })}
                {permUsers.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-outline)', fontSize: 13 }}>
                    {t("admin.activeUsers.none")}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setShowPermissions(false)}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-surface-container-high)',
                  color: 'var(--color-on-surface)',
                }}
              >
                {t("auth.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
