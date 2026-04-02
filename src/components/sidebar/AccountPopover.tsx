import { useTranslation } from "react-i18next";
import { useRef, useState, useEffect } from "react";
import { useAuthStore } from "../../stores/useAuthStore";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import * as matrixService from "../../services/matrixService";
import { UserAvatar } from "./UserAvatar";
import { ArrowLeftIcon } from "../icons";
import { useIsMobile } from "../../hooks/useIsMobile";

export function AccountPopover() {
  const { t } = useTranslation();
  const credentials = useAuthStore((s) => s.credentials);
  const updateCredentials = useAuthStore((s) => s.updateCredentials);
  const showAccountPanel = useAppStore((s) => s.showAccountPanel);
  const toggleAccountPanel = useAppStore((s) => s.toggleAccountPanel);

  const [displayName, setDisplayName] = useState(credentials?.displayName || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<{ device_id: string; display_name?: string; last_seen_ts?: number; last_seen_ip?: string }[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deletePasswordFor, setDeletePasswordFor] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [sessionMsg, setSessionMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const needsVerification = useMatrixStore((s) => s.needsVerification);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isMobile = useIsMobile();
  const nameChanged = displayName !== (credentials?.displayName || "");

  // Reset state when opening
  useEffect(() => {
    if (showAccountPanel) {
      setDisplayName(credentials?.displayName || "");
      setProfileMsg(null);
      setPasswordMsg(null);
      setShowPasswordForm(false);
      setCurrentPassword("");
      setNewPassword("");
      setShowSessions(false);
      setSessionMsg(null);
    }
  }, [showAccountPanel, credentials?.displayName]);

  const currentDeviceId = matrixService.getMatrixClient()?.getDeviceId();

  const loadSessions = async () => {
    setLoadingSessions(true);
    setSessionMsg(null);
    try {
      const result = await matrixService.getDevices();
      setSessions(result.devices || []);
    } catch {
      setSessionMsg({ type: "error", text: t("settings.errorDeleteSession") });
    } finally {
      setLoadingSessions(false);
    }
  };

  const handleDeleteSession = async (deviceId: string) => {
    if (!deletePassword || deletingSessionId) return;
    setDeletingSessionId(deviceId);
    setSessionMsg(null);
    try {
      await matrixService.deleteDevice(deviceId, deletePassword);
      setSessionMsg({ type: "success", text: t("settings.sessionDeleted") });
      setDeletePasswordFor(null);
      setDeletePassword("");
      await loadSessions();
    } catch {
      setSessionMsg({ type: "error", text: t("settings.errorDeleteSession") });
    } finally {
      setDeletingSessionId(null);
    }
  };

  // Close on click outside
  useEffect(() => {
    if (!showAccountPanel) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        toggleAccountPanel();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showAccountPanel, toggleAccountPanel]);

  if (!showAccountPanel) return null;

  const handleSaveDisplayName = async () => {
    if (!nameChanged || savingProfile) return;
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      await matrixService.setDisplayName(displayName);
      updateCredentials({ displayName });
      setProfileMsg({ type: "success", text: t("settings.profileSaved") });
    } catch {
      setProfileMsg({ type: "error", text: t("settings.errorProfile") });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    setProfileMsg(null);
    try {
      const httpUrl = await matrixService.setAvatar(file);
      updateCredentials({ avatarUrl: httpUrl });
      setProfileMsg({ type: "success", text: t("settings.profileSaved") });
    } catch {
      setProfileMsg({ type: "error", text: t("settings.errorProfile") });
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || savingPassword) return;
    setSavingPassword(true);
    setPasswordMsg(null);
    try {
      await matrixService.changePassword(currentPassword, newPassword);
      setPasswordMsg({ type: "success", text: t("settings.passwordChanged") });
      setCurrentPassword("");
      setNewPassword("");
      setShowPasswordForm(false);
    } catch {
      setPasswordMsg({ type: "error", text: t("settings.errorPassword") });
    } finally {
      setSavingPassword(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 12,
    border: '1px solid var(--color-outline-variant)',
    background: 'var(--color-surface-container-high)',
    color: 'var(--color-on-surface)',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      ref={popoverRef}
      style={isMobile ? {
        position: 'fixed',
        inset: 0,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        overflowY: 'auto',
        background: 'var(--color-surface-container-low)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      } : {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        maxHeight: 'calc(100dvh - 80px - env(safe-area-inset-top, 0px))',
        overflowY: 'auto',
        background: 'var(--color-surface-container)',
        borderRadius: 16,
        padding: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: isMobile ? '16px 16px 0' : 0,
      }}>
        {isMobile && (
          <button onClick={toggleAccountPanel} style={{ padding: 8, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--color-on-surface)', display: 'flex', alignItems: 'center' }}>
            <ArrowLeftIcon />
          </button>
        )}
        <div style={{ fontWeight: 600, fontSize: isMobile ? 16 : 12, color: 'var(--color-on-surface)', textTransform: isMobile ? 'none' as const : 'uppercase' as const, letterSpacing: isMobile ? undefined : '0.05em' }}>
          {t("settings.account")}
        </div>
      </div>
      {isMobile && <div style={{ padding: '0 16px' }}><div style={{ height: 1, background: 'var(--color-outline-variant)' }} /></div>}
      {/* Content wrapper for mobile padding */}
      <div style={{ padding: isMobile ? '0 16px 16px' : 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Avatar + Display Name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{ position: 'relative', cursor: 'pointer', flexShrink: 0, opacity: uploadingAvatar ? 0.5 : 1 }}
          onClick={() => !uploadingAvatar && fileInputRef.current?.click()}
          title={t("settings.changeAvatar")}
        >
          <UserAvatar
            name={credentials?.displayName || credentials?.userId || "?"}
            speaking={false}
            size="md"
            avatarUrl={credentials?.avatarUrl}
          />
          <div style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--color-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            color: 'var(--color-on-primary)',
          }}>
            ✎
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            style={{ display: 'none' }}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{t("settings.displayName")}</div>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {nameChanged && (
        <button
          onClick={handleSaveDisplayName}
          disabled={savingProfile}
          style={{
            width: '100%',
            padding: '8px 16px',
            borderRadius: 20,
            border: 'none',
            background: 'var(--color-primary)',
            color: 'var(--color-on-primary)',
            fontSize: 13,
            fontFamily: 'inherit',
            fontWeight: 600,
            cursor: savingProfile ? 'default' : 'pointer',
            opacity: savingProfile ? 0.7 : 1,
          }}
        >
          {savingProfile ? t("settings.saving") : t("settings.saveProfile")}
        </button>
      )}

      {profileMsg && (
        <div style={{
          fontSize: 11,
          color: profileMsg.type === "success" ? 'var(--color-green)' : 'var(--color-error)',
        }}>
          {profileMsg.text}
        </div>
      )}

      {/* Change Password */}
      <button
        onClick={() => { setShowPasswordForm(!showPasswordForm); setPasswordMsg(null); }}
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 12,
          border: '1px solid var(--color-outline-variant)',
          background: 'var(--color-surface-container-high)',
          color: 'var(--color-on-surface)',
          fontSize: 13,
          fontFamily: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {t("settings.changePassword")}
      </button>

      {showPasswordForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="password"
            placeholder={t("settings.currentPassword")}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder={t("settings.newPassword")}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            style={inputStyle}
          />
          <button
            onClick={handleChangePassword}
            disabled={savingPassword || !currentPassword || !newPassword}
            style={{
              padding: '8px 16px',
              borderRadius: 20,
              border: 'none',
              background: 'var(--color-primary)',
              color: 'var(--color-on-primary)',
              fontSize: 13,
              fontFamily: 'inherit',
              fontWeight: 600,
              cursor: (savingPassword || !currentPassword || !newPassword) ? 'default' : 'pointer',
              opacity: (savingPassword || !currentPassword || !newPassword) ? 0.5 : 1,
            }}
          >
            {savingPassword ? t("settings.saving") : t("settings.changePassword")}
          </button>
          {passwordMsg && (
            <div style={{
              fontSize: 11,
              color: passwordMsg.type === "success" ? 'var(--color-green)' : 'var(--color-error)',
            }}>
              {passwordMsg.text}
            </div>
          )}
        </div>
      )}

      {/* Regenerate Recovery Key — only visible when device is verified */}
      {!needsVerification && !confirmRegenerate && (
        <button
          onClick={() => { setConfirmRegenerate(true); setRegenerateError(null); }}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 12,
            border: '1px solid var(--color-outline-variant)',
            background: 'var(--color-surface-container-high)',
            color: 'var(--color-on-surface)',
            fontSize: 13,
            fontFamily: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {t("auth.regenerateKey")}
        </button>
      )}
      {!needsVerification && confirmRegenerate && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          borderRadius: 12,
          border: '1px solid var(--color-error)',
          background: 'var(--color-surface-container-high)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--color-error)', fontWeight: 600 }}>
            {t("auth.regenerateKeyWarningTitle")}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
            {t("auth.regenerateKeyWarning")}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { setConfirmRegenerate(false); }}
              style={{
                flex: 1,
                padding: '6px 12px',
                borderRadius: 20,
                border: '1px solid var(--color-outline-variant)',
                background: 'transparent',
                color: 'var(--color-on-surface)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t("auth.cancel")}
            </button>
            <button
              onClick={async () => {
                if (regenerating) return;
                setRegenerating(true);
                setRegenerateError(null);
                try {
                  const key = await matrixService.regenerateRecoveryKey();
                  useMatrixStore.setState({ bootstrapStep: "showRecoveryKey", generatedRecoveryKey: key });
                  setConfirmRegenerate(false);
                } catch (err) {
                  console.error("[Sion] Regenerate recovery key failed:", err);
                  setRegenerateError(t("auth.errorRegenerateKey"));
                } finally {
                  setRegenerating(false);
                }
              }}
              disabled={regenerating}
              style={{
                flex: 1,
                padding: '6px 12px',
                borderRadius: 20,
                border: 'none',
                background: 'var(--color-error)',
                color: 'var(--color-on-error, #fff)',
                fontSize: 12,
                fontFamily: 'inherit',
                fontWeight: 600,
                cursor: regenerating ? 'default' : 'pointer',
                opacity: regenerating ? 0.7 : 1,
              }}
            >
              {regenerating ? t("auth.regenerating") : t("auth.regenerateKeyConfirm")}
            </button>
          </div>
        </div>
      )}
      {regenerateError && (
        <div style={{ fontSize: 11, color: 'var(--color-error)' }}>{regenerateError}</div>
      )}

      {/* Sessions */}
      <button
        onClick={() => {
          const next = !showSessions;
          setShowSessions(next);
          setSessionMsg(null);
          setDeletePasswordFor(null);
          setDeletePassword("");
          if (next) loadSessions();
        }}
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 12,
          border: '1px solid var(--color-outline-variant)',
          background: 'var(--color-surface-container-high)',
          color: 'var(--color-on-surface)',
          fontSize: 13,
          fontFamily: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {t("settings.sessions")}
      </button>

      {showSessions && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loadingSessions ? (
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center', padding: 8 }}>
              {t("settings.loadingSessions")}
            </div>
          ) : sessions.length <= 1 && sessions.every(d => d.device_id === currentDeviceId) ? (
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center', padding: 8 }}>
              {t("settings.noOtherSessions")}
            </div>
          ) : (
            sessions.map((device) => {
              const isCurrent = device.device_id === currentDeviceId;
              const isDeleting = deletingSessionId === device.device_id;
              const showPasswordInput = deletePasswordFor === device.device_id;
              return (
                <div
                  key={device.device_id}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: 'var(--color-surface-container-high)',
                    border: isCurrent ? '1px solid var(--color-primary)' : '1px solid transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {device.display_name || device.device_id}
                      </span>
                      {isCurrent && (
                        <span style={{
                          fontSize: 9,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 8,
                          background: 'var(--color-primary)',
                          color: 'var(--color-on-primary)',
                          whiteSpace: 'nowrap',
                        }}>
                          {t("settings.currentSession")}
                        </span>
                      )}
                    </div>
                    {!isCurrent && !showPasswordInput && (
                      <button
                        onClick={() => { setDeletePasswordFor(device.device_id); setDeletePassword(""); setSessionMsg(null); }}
                        title={t("settings.deleteSession")}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-error)',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 14,
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                  {device.last_seen_ts && (
                    <div style={{ fontSize: 10, color: 'var(--color-on-surface-variant)' }}>
                      {t("settings.lastSeen")}: {new Date(device.last_seen_ts).toLocaleString()}
                    </div>
                  )}
                  {showPasswordInput && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                      <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                        {t("settings.deleteSessionConfirm")}
                      </div>
                      <input
                        type="password"
                        placeholder={t("settings.deleteSessionPassword")}
                        value={deletePassword}
                        onChange={(e) => setDeletePassword(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleDeleteSession(device.device_id); }}
                        style={{
                          width: '100%',
                          padding: '6px 10px',
                          borderRadius: 10,
                          border: '1px solid var(--color-outline-variant)',
                          background: 'var(--color-surface-container)',
                          color: 'var(--color-on-surface)',
                          fontSize: 12,
                          fontFamily: 'inherit',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => { setDeletePasswordFor(null); setDeletePassword(""); }}
                          style={{
                            flex: 1,
                            padding: '5px 10px',
                            borderRadius: 16,
                            border: '1px solid var(--color-outline-variant)',
                            background: 'transparent',
                            color: 'var(--color-on-surface)',
                            fontSize: 11,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                          }}
                        >
                          {t("auth.cancel")}
                        </button>
                        <button
                          onClick={() => handleDeleteSession(device.device_id)}
                          disabled={!deletePassword || isDeleting}
                          style={{
                            flex: 1,
                            padding: '5px 10px',
                            borderRadius: 16,
                            border: 'none',
                            background: 'var(--color-error)',
                            color: 'var(--color-on-error, #fff)',
                            fontSize: 11,
                            fontFamily: 'inherit',
                            fontWeight: 600,
                            cursor: (!deletePassword || isDeleting) ? 'default' : 'pointer',
                            opacity: (!deletePassword || isDeleting) ? 0.5 : 1,
                          }}
                        >
                          {isDeleting ? t("settings.deletingSession") : t("settings.deleteSession")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {sessionMsg && (
            <div style={{
              fontSize: 11,
              color: sessionMsg.type === "success" ? 'var(--color-green)' : 'var(--color-error)',
            }}>
              {sessionMsg.text}
            </div>
          )}
        </div>
      )}
      </div>{/* end content wrapper */}
    </div>
  );
}
