import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SettingsIcon, ArrowLeftIcon } from "../icons";
import { AdminStats } from "../admin/AdminStats";
import { PendingUsers } from "../admin/PendingUsers";
import { AdminActions } from "../admin/AdminActions";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useAppStore } from "../../stores/useAppStore";
import { useClickOutside } from "../../hooks/useClickOutside";

export function AdminPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggleAdmin = useAppStore((s) => s.toggleAdmin);
  const panelRef = useRef<HTMLDivElement>(null);
  // Click-outside-to-close — disabled on mobile (full-screen overlay, has its own back button)
  useClickOutside(panelRef, toggleAdmin, !isMobile);

  if (isMobile) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-surface-container-low)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        zIndex: 100,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '16px 16px 12px 16px',
        }}>
          <button
            onClick={toggleAdmin}
            style={{
              padding: 8,
              borderRadius: 12,
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
              color: 'var(--color-on-surface)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ArrowLeftIcon />
          </button>
          <SettingsIcon />
          <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-on-surface)' }}>{t("admin.title")}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 12px', gap: 8 }}>
          <AdminActions />
          <PendingUsers />
          <AdminStats />
        </div>
      </div>
    );
  }

  return (
    <div ref={panelRef} style={{
      width: 280,
      minWidth: 280,
      background: 'var(--color-surface-container-low)',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto' as const,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '20px 20px 16px 20px',
      }}>
        <SettingsIcon />
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)' }}>{t("admin.title")}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '0 12px', gap: 8 }}>
        <AdminActions />
        <PendingUsers />
        <AdminStats />
      </div>
    </div>
  );
}
