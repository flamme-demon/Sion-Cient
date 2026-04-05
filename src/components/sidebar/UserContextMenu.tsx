import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionQuality } from "livekit-client";
import { getCurrentRoom, muteRemoteParticipant } from "../../services/livekitService";
import { useAdminStore } from "../../stores/useAdminStore";
import { useAppStore } from "../../stores/useAppStore";
import { checkUserSuspended, suspendUser } from "../../services/adminService";
import * as matrixService from "../../services/matrixService";

interface UserContextMenuProps {
  userId: string;
  userName: string;
  x: number;
  y: number;
  onClose: () => void;
}

function getColor(ms: number) {
  if (ms < 50) return "var(--color-green)";
  if (ms < 150) return "var(--color-yellow)";
  return "var(--color-error)";
}

function qualityColor(q: ConnectionQuality) {
  if (q === ConnectionQuality.Excellent) return "var(--color-green)";
  if (q === ConnectionQuality.Good) return "var(--color-yellow)";
  return "var(--color-error)";
}

function qualityLabel(q: ConnectionQuality) {
  if (q === ConnectionQuality.Excellent) return "Excellent";
  if (q === ConnectionQuality.Good) return "Good";
  if (q === ConnectionQuality.Poor) return "Poor";
  if (q === ConnectionQuality.Lost) return "Lost";
  return "Unknown";
}

function LatencySparkline({ participantIdentity }: { participantIdentity: string }) {
  const { t } = useTranslation();
  const room = getCurrentRoom();
  const isLocal = room?.localParticipant.identity === participantIdentity;

  const [samples, setSamples] = useState<number[]>([]);
  const samplesRef = useRef<number[]>([]);
  const [quality, setQuality] = useState<ConnectionQuality | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const currentRoom = getCurrentRoom();
      if (!currentRoom) return;

      if (isLocal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (currentRoom as any)?.engine;
        const rtt = engine?.client?.rtt ?? engine?.rtt ?? null;
        if (rtt != null) {
          samplesRef.current = [...samplesRef.current.slice(-29), rtt];
          setSamples([...samplesRef.current]);
        }
      } else {
        const participant = currentRoom.remoteParticipants.get(participantIdentity);
        if (participant) {
          setQuality(participant.connectionQuality);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [participantIdentity, isLocal]);

  if (!isLocal) {
    if (quality === null) {
      return (
        <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--color-outline)" }}>
          {t("contextMenu.noLatencyData")}
        </div>
      );
    }
    return (
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: qualityColor(quality),
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: qualityColor(quality) }}>
          {qualityLabel(quality)}
        </span>
      </div>
    );
  }

  const current = samples.length > 0 ? samples[samples.length - 1] : null;

  if (current === null) {
    return (
      <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--color-outline)" }}>
        {t("contextMenu.noLatencyData")}
      </div>
    );
  }

  const max = Math.max(...samples, 1);
  const width = 140;
  const height = 32;
  const points = samples
    .map((v, i) => {
      const x = (i / 29) * width;
      const y = height - (v / max) * (height - 4);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 10 }}>
      <svg width={width} height={height} style={{ flexShrink: 0 }}>
        <polyline
          points={points}
          fill="none"
          stroke={getColor(current)}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 600, color: getColor(current), fontVariantNumeric: "tabular-nums" }}>
        {Math.round(current)} ms
      </span>
    </div>
  );
}

type RoleType = "admin" | "moderator" | "user";

function getRoleFromPowerLevel(level: number): RoleType {
  if (level >= 100) return "admin";
  if (level >= 50) return "moderator";
  return "user";
}

export function UserContextMenu({ userId: rawUserId, userName, x, y, onClose }: UserContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showLatency, setShowLatency] = useState(false);
  const isAdmin = useAdminStore((s) => s.isAdmin);
  const activeChannel = useAppStore((s) => s.activeChannel);
  const [suspended, setSuspended] = useState<boolean | null>(null);
  const [suspendLoading, setSuspendLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Persist mute state across context menu re-opens
  const [isMuted, setIsMuted] = useState(() => {
    const room = getCurrentRoom();
    if (!room) return false;
    const participant = room.remoteParticipants.get(rawUserId);
    if (!participant) return false;
    for (const pub of participant.audioTrackPublications.values()) {
      if (pub.track && !pub.track.mediaStreamTrack.enabled) return true;
    }
    return false;
  });

  // Extract Matrix userId from LiveKit identity (@user:server:deviceId → @user:server)
  const matrixUserId = rawUserId.match(/^(@[^:]+:[^:]+)/)?.[1] || rawUserId;

  // Current user's power level in this room
  const myPowerLevel = activeChannel ? matrixService.getUserPowerLevel(activeChannel) : 0;
  // Target user's power level
  const targetPowerLevel = activeChannel ? matrixService.getMemberPowerLevel(activeChannel, matrixUserId) : 0;
  const targetRole = getRoleFromPowerLevel(targetPowerLevel);

  // Can we moderate this user? (our PL must be > target PL, and >= 50)
  const canModerate = myPowerLevel >= 50 && myPowerLevel > targetPowerLevel;
  // Can we change roles? (need admin level)
  const canChangeRole = myPowerLevel >= 100 && myPowerLevel > targetPowerLevel;
  // Is this ourselves?
  const isMyself = matrixUserId === matrixService.getMatrixClient()?.getUserId();

  useEffect(() => {
    if (!isAdmin) return;
    checkUserSuspended(matrixUserId)
      .then((res) => setSuspended(res.suspended))
      .catch(() => {});
  }, [isAdmin, matrixUserId]);

  const handleToggleSuspend = async () => {
    if (suspendLoading || suspended === null) return;
    setSuspendLoading(true);
    try {
      await suspendUser(matrixUserId, !suspended);
      setSuspended(!suspended);
    } catch (err) {
      console.error("[Sion] Failed to toggle suspend:", err);
    } finally {
      setSuspendLoading(false);
    }
  };

  const _handleKickVoice = async () => {
    if (!activeChannel || actionLoading) return;
    setActionLoading(true);
    try {
      // Retirer le call.member de l'utilisateur (le déconnecte du vocal)
      const client = matrixService.getMatrixClient();
      if (client) {
        // Trouver le state_key du call.member de cet utilisateur
        const room = client.getRoom(activeChannel);
        if (room) {
          const callMembers = room.currentState.getStateEvents("org.matrix.msc3401.call.member");
          const events = Array.isArray(callMembers) ? callMembers : callMembers ? [callMembers] : [];
          for (const evt of events) {
            const sk = evt.getStateKey?.() || "";
            if (sk.includes(matrixUserId)) {
              // Envoyer un contenu vide pour retirer la membership
              await client.sendStateEvent(activeChannel, "org.matrix.msc3401.call.member" as any, {}, sk);
            }
          }
        }
      }
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to kick from voice:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const _handleKickRoom = async () => {
    if (!activeChannel || actionLoading) return;
    setActionLoading(true);
    try {
      await matrixService.kickUser(activeChannel, matrixUserId);
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to kick from room:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleBan = async () => {
    if (!activeChannel || actionLoading) return;
    setActionLoading(true);
    try {
      await matrixService.banUser(activeChannel, matrixUserId);
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to ban:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleMuteToggle = () => {
    const newMuted = !isMuted;
    muteRemoteParticipant(rawUserId, newMuted);
    setIsMuted(newMuted);
  };

  const handleSetRole = async (role: RoleType) => {
    if (!activeChannel || actionLoading) return;
    setActionLoading(true);
    const level = role === "admin" ? 100 : role === "moderator" ? 50 : 0;
    try {
      await matrixService.setUserPowerLevel(activeChannel, matrixUserId, level);
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to set role:", err);
    } finally {
      setActionLoading(false);
    }
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - 300);

  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "10px 14px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: "var(--color-on-surface)",
    fontSize: 13,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
  };

  const roleLabel = targetRole === "admin" ? t("contextMenu.roleAdmin") : targetRole === "moderator" ? t("contextMenu.roleModerator") : t("contextMenu.roleUser");

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: adjustedX,
        top: adjustedY,
        zIndex: 9999,
        background: "var(--color-surface-container-high)",
        borderRadius: 12,
        padding: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: 200,
      }}
    >
      {/* User name + role badge */}
      <div style={{ padding: "8px 14px 4px", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--color-outline)", fontWeight: 600 }}>
          {userName}
        </span>
        <span style={{
          fontSize: 9,
          fontWeight: 700,
          padding: "1px 6px",
          borderRadius: 8,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          background: targetRole === "admin" ? "var(--color-primary)" : targetRole === "moderator" ? "var(--color-tertiary-container, var(--color-secondary-container))" : "var(--color-surface-container)",
          color: targetRole === "admin" ? "var(--color-on-primary)" : targetRole === "moderator" ? "var(--color-on-secondary-container)" : "var(--color-outline)",
        }}>
          {roleLabel}
        </span>
      </div>

      {/* Latency */}
      <button onClick={() => setShowLatency(!showLatency)} style={itemStyle}>
        {t("contextMenu.latency")}
      </button>
      {showLatency && <LatencySparkline participantIdentity={rawUserId} />}

      {/* Mute (local, works for everyone in vocal) */}
      {!isMyself && getCurrentRoom() && (
        <button onClick={handleMuteToggle} style={itemStyle}>
          {isMuted ? t("contextMenu.unmute") : t("contextMenu.mute")}
        </button>
      )}

      {/* Moderation actions — need PL >= 50 and > target */}
      {!isMyself && canModerate && (
        <>
          <div style={{ height: 1, background: "var(--color-outline-variant)", margin: "4px 8px" }} />
          <button onClick={handleBan} disabled={actionLoading} style={{ ...itemStyle, color: "var(--color-error)", opacity: actionLoading ? 0.5 : 1 }}>
            {t("contextMenu.ban")}
          </button>
        </>
      )}

      {/* Role change — need PL >= 100 and > target */}
      {!isMyself && canChangeRole && (
        <>
          <div style={{ height: 1, background: "var(--color-outline-variant)", margin: "4px 8px" }} />
          <div style={{ padding: "4px 14px 2px", fontSize: 10, color: "var(--color-outline)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("contextMenu.changeRole")}
          </div>
          {(["user", "moderator"] as RoleType[]).map((role) => (
            <button
              key={role}
              onClick={() => handleSetRole(role)}
              disabled={actionLoading || targetRole === role}
              style={{
                ...itemStyle,
                fontWeight: targetRole === role ? 600 : 400,
                color: targetRole === role ? "var(--color-primary)" : "var(--color-on-surface)",
                opacity: targetRole === role ? 1 : actionLoading ? 0.5 : 0.8,
                cursor: targetRole === role ? "default" : "pointer",
              }}
            >
              {role === "moderator" ? t("contextMenu.roleModerator") : t("contextMenu.roleUser")}
              {targetRole === role && " ✓"}
            </button>
          ))}
        </>
      )}

      {/* Server admin: suspend/unsuspend */}
      {!isMyself && isAdmin && suspended !== null && (
        <>
          <div style={{ height: 1, background: "var(--color-outline-variant)", margin: "4px 8px" }} />
          <button
            onClick={handleToggleSuspend}
            disabled={suspendLoading}
            style={{
              ...itemStyle,
              color: suspended ? "var(--color-green)" : "var(--color-error)",
              opacity: suspendLoading ? 0.5 : 1,
            }}
          >
            {suspendLoading
              ? "..."
              : suspended
                ? t("contextMenu.unsuspend")
                : t("contextMenu.suspend")}
          </button>
        </>
      )}
    </div>
  );
}
