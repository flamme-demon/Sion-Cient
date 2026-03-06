import { useTranslation } from "react-i18next";
import { SettingsIcon } from "../icons";
import { AdminStats } from "../admin/AdminStats";
import { AdminActions } from "../admin/AdminActions";
import { FederationInfo } from "../admin/FederationInfo";

export function AdminPanel() {
  const { t } = useTranslation();

  return (
    <div style={{
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
        <AdminStats />
        <AdminActions />
        <FederationInfo />
      </div>
    </div>
  );
}
