import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ServerIcon, LogoutIcon, SettingsIcon } from "../icons";
import { UserAvatar } from "./UserAvatar";
import { useAppStore } from "../../stores/useAppStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useAdminStore } from "../../stores/useAdminStore";
import { usePendingUsersStore } from "../../stores/usePendingUsersStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useIsMobile } from "../../hooks/useIsMobile";

export function ServerHeader() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggleAdmin = useAppStore((s) => s.toggleAdmin);
  const showAdmin = useAppStore((s) => s.showAdmin);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleAccountPanel = useAppStore((s) => s.toggleAccountPanel);
  const isAdmin = useAdminStore((s) => s.isAdmin);
  const pendingCount = usePendingUsersStore((s) => s.pendingCount);
  const credentials = useAuthStore((s) => s.credentials);
  const homeserverUrl = credentials?.homeserverUrl || "";
  const logout = useAuthStore((s) => s.logout);
  const resetMatrix = useMatrixStore((s) => s.reset);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Close profile menu on outside click
  useEffect(() => {
    if (!showProfileMenu) return;
    const handler = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProfileMenu]);

  const displayName = credentials?.displayName || credentials?.userId || "User";
  const avatarUrl = credentials?.avatarUrl;
  const serverName = (() => {
    try {
      return new URL(homeserverUrl).hostname;
    } catch {
      return homeserverUrl || "Sion";
    }
  })();

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 16px 12px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40,
          height: 40,
          borderRadius: 14,
          background: 'var(--color-primary-container)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--color-on-primary-container)',
        }}>
          S
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)', letterSpacing: '0.01em' }}>
            {serverName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-green)', display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-green)', display: 'inline-block' }} />
            {t("server.online")}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        {!isMobile && isAdmin !== false && (
          <button
            onClick={toggleAdmin}
            data-panel-toggle
            style={{
              padding: 8,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              border: 'none',
              transition: 'background 200ms',
              background: showAdmin ? 'var(--color-secondary-container)' : 'transparent',
              color: showAdmin ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
              position: 'relative',
            }}
            title={t("admin.title")}
          >
            <ServerIcon />
            {pendingCount > 0 && (
              <span style={{
                position: 'absolute',
                top: 2,
                right: 2,
                minWidth: 16,
                height: 16,
                borderRadius: 8,
                background: 'var(--color-error)',
                color: 'var(--color-on-error)',
                fontSize: 10,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
                lineHeight: 1,
              }}>
                {pendingCount}
              </span>
            )}
          </button>
        )}
        {!isMobile && (
          <button
            onClick={() => setShowLogoutConfirm(true)}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-error-container)';
              e.currentTarget.style.color = 'var(--color-error)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--color-on-surface-variant)';
            }}
            style={{
              padding: 8,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              border: 'none',
              transition: 'all 200ms',
              background: 'transparent',
              color: 'var(--color-on-surface-variant)',
            }}
            title={t("auth.logout")}
          >
            <LogoutIcon />
          </button>
        )}

        {/* Mobile: profile avatar with dropdown menu */}
        {isMobile && (
          <div ref={profileMenuRef} style={{ position: 'relative' }}>
            <div
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              style={{ cursor: 'pointer' }}
            >
              <UserAvatar name={displayName} speaking={false} size="sm" avatarUrl={avatarUrl} />
            </div>
            {showProfileMenu && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 8,
                background: 'var(--color-surface-container)',
                borderRadius: 16,
                padding: 8,
                minWidth: 200,
                zIndex: 100,
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}>
                {/* User info */}
                <div
                  onClick={() => { setShowProfileMenu(false); toggleAccountPanel(); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
                    transition: 'background 150ms',
                  }}
                >
                  <UserAvatar name={displayName} speaking={false} size="sm" avatarUrl={avatarUrl} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                    <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>{t("settings.account")}</div>
                  </div>
                </div>

                <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 8px' }} />

                {/* Settings */}
                <button
                  onClick={() => { setShowProfileMenu(false); toggleSettings(); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
                    border: 'none', background: 'transparent', fontFamily: 'inherit',
                    color: 'var(--color-on-surface)', fontSize: 13,
                  }}
                >
                  <SettingsIcon />
                  {t("settings.title")}
                </button>

                {/* Admin */}
                {isAdmin !== false && (
                  <button
                    onClick={() => { setShowProfileMenu(false); toggleAdmin(); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
                      border: 'none', background: 'transparent', fontFamily: 'inherit',
                      color: 'var(--color-on-surface)', fontSize: 13,
                      position: 'relative',
                    }}
                  >
                    <ServerIcon />
                    {t("admin.title")}
                    {pendingCount > 0 && (
                      <span style={{
                        marginLeft: 'auto',
                        minWidth: 18, height: 18, borderRadius: 9,
                        background: 'var(--color-error)', color: 'var(--color-on-error)',
                        fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px',
                      }}>
                        {pendingCount}
                      </span>
                    )}
                  </button>
                )}

                <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 8px' }} />

                {/* Logout */}
                <button
                  onClick={() => { setShowProfileMenu(false); setShowLogoutConfirm(true); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
                    border: 'none', background: 'transparent', fontFamily: 'inherit',
                    color: 'var(--color-error)', fontSize: 13,
                  }}
                >
                  <LogoutIcon />
                  {t("auth.logout")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showLogoutConfirm && (
        <div
          onClick={() => setShowLogoutConfirm(false)}
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
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 12 }}>
              {t("auth.logoutConfirmTitle")}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5, marginBottom: 24 }}>
              {t("auth.logoutConfirmMessage")}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowLogoutConfirm(false)}
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
                onClick={() => { setShowLogoutConfirm(false); resetMatrix(); logout(); }}
                style={{
                  padding: '10px 20px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'var(--color-error)',
                  color: 'var(--color-on-error)',
                  transition: 'background 200ms',
                }}
              >
                {t("auth.logoutConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
