import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/useAuthStore";

export function FederationInfo() {
  const { t } = useTranslation();
  const credentials = useAuthStore((s) => s.credentials);

  const homeserver = credentials?.homeserverUrl
    ? new URL(credentials.homeserverUrl).hostname
    : "N/A";

  return (
    <div style={{
      background: 'var(--color-surface-container)',
      borderRadius: 16,
      padding: '14px 16px',
      marginBottom: 12,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.06em',
        color: 'var(--color-on-surface-variant)',
        marginBottom: 10,
      }}>
        {t("admin.federation.title")}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
          <span>{t("admin.federation.servers")}</span>
          <span style={{ color: 'var(--color-on-surface)', fontWeight: 600 }}>N/A</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
          <span>{t("admin.federation.events")}</span>
          <span style={{ color: 'var(--color-on-surface)', fontWeight: 600 }}>N/A</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
          <span>{t("admin.federation.homeserver")}</span>
          <span style={{ color: 'var(--color-primary)', fontWeight: 500, fontSize: 11 }}>{homeserver}</span>
        </div>
      </div>
    </div>
  );
}
