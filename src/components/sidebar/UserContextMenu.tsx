import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionQuality } from "../../types/livekit";
import { useLiveKitStore } from "../../stores/useLiveKitStore";
import { useAdminStore } from "../../stores/useAdminStore";
import { useAppStore } from "../../stores/useAppStore";
import { checkUserSuspended, suspendUser } from "../../services/adminService";
import * as matrixService from "../../services/matrixService";
import { moteurRust } from "../../services/moteur";
import { useAuthStore } from "../../stores/useAuthStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useEntreMembresStore, rafraichirIgnores } from "../../stores/useEntreMembresStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { ouvertALInstant } from "../../utils/menuContextuel";

interface UserContextMenuProps {
  userId: string;
  userName: string;
  x: number;
  y: number;
  onClose: () => void;
}

function qualityColor(q: ConnectionQuality) {
  if (q === "excellent") return "var(--color-green)";
  if (q === "good") return "var(--color-yellow)";
  return "var(--color-error)";
}

function qualityLabel(q: ConnectionQuality) {
  if (q === "excellent") return "Excellent";
  if (q === "good") return "Good";
  if (q === "poor") return "Poor";
  if (q === "lost") return "Lost";
  return "Unknown";
}

/** Qualité de connexion LiveKit du participant, alimentée par le moteur Rust
 *  (`ParticipantInfo.connectionQuality`). Le RTT local n'est plus exposé par
 *  la webview : seul le niveau de qualité reste affiché. */
function LatencySparkline({ participantIdentity }: { participantIdentity: string }) {
  const { t } = useTranslation();
  const quality = useLiveKitStore(
    (s) => s.participants.find((p) => p.identity === participantIdentity)?.connectionQuality,
  );

  if (!quality) {
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
  const [showKickModal, setShowKickModal] = useState(false);
  const [kickReason, setKickReason] = useState("");

  // Extract Matrix userId from LiveKit identity (@user:server:deviceId → @user:server)
  const matrixUserId = rawUserId.match(/^(@[^:]+:[^:]+)/)?.[1] || rawUserId;

  // Whether the target is CURRENTLY in the voice room. Réactif (liste des
  // participants du moteur Rust) : les options Kick disparaissent dès qu'il
  // part, sans offrir de kicker un utilisateur absent.
  const participants = useLiveKitStore((s) => s.participants);
  const targetInVoice = participants.some(
    (p) => p.identity === matrixUserId || p.identity.startsWith(matrixUserId + ":"),
  );

  // If the kick modal is open and the target leaves (someone else kicked them
  // first), dismiss it — there's no one left to kick.
  useEffect(() => {
    if (showKickModal && !targetInVoice) onClose();
  }, [showKickModal, targetInVoice, onClose]);

  // Current user's power level in this room
  const myPowerLevel = activeChannel ? matrixService.getUserPowerLevel(activeChannel) : 0;
  // Target user's power level
  const targetPowerLevel = activeChannel ? matrixService.getMemberPowerLevel(activeChannel, matrixUserId) : 0;
  const targetRole = getRoleFromPowerLevel(targetPowerLevel);

  // Can we moderate this user? (our PL must be > target PL, and >= 50)
  const canModerate = myPowerLevel >= 50 && myPowerLevel > targetPowerLevel;
  // Can we voice-kick this user? Voice kick is a client-side signal
  // (com.sion.voice_kick), NOT a real Matrix membership kick, so we don't need
  // the protocol's PL hierarchy. We cap the target PL at 100 so any admin
  // (PL 100) can kick anyone — including room creators, whose PL is Infinity
  // under room v12 (Hydra) and would otherwise be unkickable since no finite
  // admin level satisfies `myPowerLevel >= targetPowerLevel`.
  const canVoiceKick = myPowerLevel >= 50 && myPowerLevel >= Math.min(targetPowerLevel, 100);
  // Can we change roles? (need admin level)
  const canChangeRole = myPowerLevel >= 100 && myPowerLevel > targetPowerLevel;
  // Is this ourselves? (Moteur Rust : il n'y a pas de client JS, on lit
  // l'identifiant de la session — sans quoi on se voyait comme un autre.)
  const myUserId = useAuthStore((s) => s.credentials?.userId) ?? matrixService.getMatrixClient()?.getUserId();
  const isMyself = matrixUserId === myUserId;

  // Entre membres (moteur Rust) : ignoré ?, bannière, salons en commun.
  const ignore = useEntreMembresStore((s) => s.ignores.includes(matrixUserId));
  const [banniere, setBanniere] = useState<string | null>(null);
  const [enCommun, setEnCommun] = useState<string[] | null>(null);
  const [showEnCommun, setShowEnCommun] = useState(false);
  const channels = useMatrixStore((s) => s.channels);
  useEffect(() => {
    if (!moteurRust() || isMyself) return;
    let actif = true;
    void import("../../services/matrixCore").then(async (core) => {
      const [b, salons] = await Promise.all([
        core.banniere(matrixUserId).catch(() => null),
        core.salonsEnCommun(matrixUserId).catch(() => [] as string[]),
      ]);
      if (!actif) return;
      setBanniere(b);
      setEnCommun(salons);
    });
    return () => { actif = false; };
  }, [matrixUserId, isMyself]);
  // Salons partagés, hors MP et soundboard, dans l'ordre de la barre latérale.
  const salonsEnCommun = enCommun
    ? channels.filter((c) => enCommun.includes(c.id) && !c.isDM && !c.isSoundboard)
    : [];

  const handleToggleIgnore = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      const core = await import("../../services/matrixCore");
      if (ignore) await core.nePlusIgnorer(matrixUserId);
      else await core.ignorer(matrixUserId);
      await rafraichirIgnores();
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to toggle ignore:", err);
    } finally {
      setActionLoading(false);
    }
  };

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

  const connectedVoiceChannel = useAppStore((s) => s.connectedVoiceChannel);

  // Écoute de cette personne, réglée pour soi (tous ses appareils).
  const reglageEcoute = useSettingsStore((s) => s.volumesParticipants[matrixUserId]);
  const setVolumeParticipant = useSettingsStore((s) => s.setVolumeParticipant);
  const volumeEcoute = reglageEcoute?.volume ?? 1;
  const coupeePourMoi = reglageEcoute?.coupe ?? false;

  // Open the Sion-styled kick modal (replaces the native window.prompt).
  const handleKickVoice = () => {
    const voiceRoom = connectedVoiceChannel || activeChannel;
    if (!voiceRoom || actionLoading) return;
    setShowKickModal(true);
  };

  const confirmKickVoice = async () => {
    const voiceRoom = connectedVoiceChannel || activeChannel;
    if (!voiceRoom) return;
    setActionLoading(true);
    try {
      if (moteurRust()) {
        // Moteur Rust : pas de client JS, l'événement passe par le cœur
        // (sans cette branche, l'exclusion ne partait jamais).
        const moi = useAuthStore.getState().credentials;
        const core = await import("../../services/matrixCore");
        await core.envoyerEvenement(voiceRoom, "com.sion.voice_kick", {
          kicked_user: matrixUserId,
          kicked_by: moi?.userId ?? "",
          kicked_by_name: moi?.displayName || moi?.userId || "",
          reason: kickReason.trim(),
        });
        onClose();
        return;
      }
      const client = matrixService.getMatrixClient();
      if (client) {
        const myUserId = client.getUserId() || "";
        const myName = client.getUser(myUserId)?.displayName || myUserId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await client.sendEvent(voiceRoom, "com.sion.voice_kick" as any, {
          kicked_user: matrixUserId,
          kicked_by: myUserId,
          kicked_by_name: myName,
          reason: kickReason.trim(),
        });
      }
      onClose();
    } catch (err) {
      console.error("[Sion] Failed to kick from voice:", err);
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
      // Ouvert par un appui long : le doigt relevé peut produire un
      // `mousedown` hors du menu, qui le refermait aussitôt.
      if (ouvertALInstant()) return;
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

  // Position is corrected after the menu is rendered so we can measure its
  // real size. The menu's content is dynamic (latency expand, suspend button
  // appears after async fetch, role list…) so we use a ResizeObserver to
  // re-clamp on every size change rather than just on mount.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;

    const reclamp = () => {
      const rect = el.getBoundingClientRect();
      const margin = 8;
      let left = x;
      let top = y;
      if (left + rect.width + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
      }
      if (top + rect.height + margin > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
      }
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    };

    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);

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

  if (showKickModal) {
    return (
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 380, maxWidth: "92%",
            background: "var(--color-surface-container)",
            borderRadius: 20, padding: 24,
            display: "flex", flexDirection: "column", gap: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-on-surface)" }}>
            {t("contextMenu.kickTitle", { defaultValue: "Exclure du vocal", name: userName })}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-on-surface-variant)" }}>
            {t("contextMenu.kickConfirm", { defaultValue: "Exclure {{name}} du salon vocal ?", name: userName })}
          </div>
          <input
            autoFocus
            value={kickReason}
            onChange={(e) => setKickReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !actionLoading) confirmKickVoice(); }}
            placeholder={t("contextMenu.kickReason")}
            style={{
              padding: "10px 12px", borderRadius: 12,
              border: "1px solid var(--color-outline-variant)",
              background: "var(--color-surface-container-high)",
              color: "var(--color-on-surface)", fontSize: 13, fontFamily: "inherit",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={onClose} style={{
              padding: "8px 16px", borderRadius: 16, border: "none", cursor: "pointer",
              background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
              fontSize: 13, fontFamily: "inherit",
            }}>{t("auth.cancel")}</button>
            <button onClick={confirmKickVoice} disabled={actionLoading} style={{
              padding: "8px 16px", borderRadius: 16, border: "none",
              cursor: actionLoading ? "default" : "pointer", opacity: actionLoading ? 0.5 : 1,
              background: "var(--color-error)", color: "var(--color-on-error)",
              fontSize: 13, fontFamily: "inherit", fontWeight: 600,
            }}>{t("contextMenu.kickVoice")}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        background: "var(--color-surface-container-high)",
        borderRadius: 12,
        padding: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: 200,
        maxWidth: 280,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
      }}
    >
      {/* Bannière de profil (MSC4427) */}
      {banniere && (
        <img
          src={banniere}
          alt=""
          onError={() => setBanniere(null)}
          style={{ display: "block", width: "100%", aspectRatio: "3 / 1", objectFit: "cover", borderRadius: 8, marginBottom: 2 }}
        />
      )}
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

      {/* Écoute de cette personne, pour soi seul : volume et coupure. Proposée
          quand elle est en vocal, ou qu'un réglage existe déjà. */}
      {!isMyself && (targetInVoice || reglageEcoute) && (
        <>
          <div style={{ padding: "6px 14px 8px" }} title={t("contextMenu.volumeReset")}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4, color: "var(--color-on-surface-variant)" }}>
              <span>{t("contextMenu.volume")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: coupeePourMoi ? "var(--color-error)" : undefined }}>
                {coupeePourMoi ? t("contextMenu.mutedForMe") : `${Math.round(volumeEcoute * 100)} %`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(volumeEcoute * 100)}
              disabled={coupeePourMoi}
              aria-label={t("contextMenu.volume")}
              onChange={(e) => setVolumeParticipant(matrixUserId, { volume: Number(e.target.value) / 100, coupe: false })}
              onDoubleClick={() => setVolumeParticipant(matrixUserId, { volume: 1, coupe: false })}
              style={{ width: "100%", accentColor: "var(--color-primary)", opacity: coupeePourMoi ? 0.4 : 1 }}
            />
          </div>
          <button
            onClick={() => setVolumeParticipant(matrixUserId, { volume: volumeEcoute, coupe: !coupeePourMoi })}
            style={itemStyle}
          >
            {coupeePourMoi ? t("contextMenu.unmuteForMe") : t("contextMenu.muteForMe")}
          </button>
        </>
      )}

      {/* Poke — always sent in the DM with the target user, never in the active channel */}
      {!isMyself && (
        <button onClick={async () => {
          try {
            const dmRoomId = await matrixService.createOrGetDMRoom(matrixUserId);
            await matrixService.sendPoke(dmRoomId);
          } catch (err) {
            console.error("[Sion] Failed to send poke:", err);
          }
          onClose();
        }} style={itemStyle}>
          👉 Poke
        </button>
      )}

      {/* Salons en commun */}
      {!isMyself && moteurRust() && salonsEnCommun.length > 0 && (
        <>
          <button onClick={() => setShowEnCommun(!showEnCommun)} style={itemStyle}>
            {t("contextMenu.mutualRooms", { count: salonsEnCommun.length })}
          </button>
          {showEnCommun && salonsEnCommun.map((c) => (
            <button
              key={c.id}
              onClick={() => { useAppStore.getState().setActiveChannel(c.id, c.hasVoice); onClose(); }}
              style={{ ...itemStyle, padding: "6px 14px 6px 26px", fontSize: 12, color: "var(--color-on-surface-variant)" }}
            >
              {c.hasVoice ? "🔊" : "#"} {c.name}
            </button>
          ))}
        </>
      )}

      {/* Ignorer : ses messages et frappes ne s'affichent plus */}
      {!isMyself && moteurRust() && (
        <button onClick={handleToggleIgnore} disabled={actionLoading} style={{ ...itemStyle, opacity: actionLoading ? 0.5 : 1 }}>
          {ignore ? t("contextMenu.unignore") : t("contextMenu.ignore")}
        </button>
      )}

      {/* Voice kick — PL >= 50 and >= target, capped (admins can kick each other, incl. room creators) */}
      {!isMyself && canVoiceKick && targetInVoice && (
        <>
          <div style={{ height: 1, background: "var(--color-outline-variant)", margin: "4px 8px" }} />
          <button onClick={handleKickVoice} disabled={actionLoading} style={{ ...itemStyle, color: "var(--color-orange)", opacity: actionLoading ? 0.5 : 1 }}>
            {t("contextMenu.kickVoice")}
          </button>
        </>
      )}

      {/* Ban — PL >= 50 and strictly > target */}
      {!isMyself && canModerate && (
        <>
          {!(canVoiceKick && targetInVoice) && (
            <div style={{ height: 1, background: "var(--color-outline-variant)", margin: "4px 8px" }} />
          )}
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
