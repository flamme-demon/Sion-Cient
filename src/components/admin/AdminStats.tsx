import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAdminStore } from "../../stores/useAdminStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { getMatrixClient } from "../../services/matrixService";

interface StatItem {
  label: string;
  value: string;
  color?: string;
}

interface StatSection {
  titleKey: string;
  items: StatItem[];
}

function val(v: string | number | null, isLoading: boolean): string {
  if (isLoading) return "...";
  if (v === null) return "N/A";
  return String(v);
}

export function AdminStats() {
  const { t } = useTranslation();
  const { data, isLoading } = useAdminStore();
  const channels = useMatrixStore((s) => s.channels);

  const voiceCount = channels.filter((c) => c.hasVoice).length;
  const textCount = channels.filter((c) => !c.hasVoice).length;

  const onlineCount = useMemo(() => {
    const client = getMatrixClient();
    if (!client) return null;
    const users = client.getUsers();
    return users.filter((u) => u.presence === "online").length;
  }, [channels]); // recalculate when channels update (proxy for sync events)

  const sections: StatSection[] = [
    {
      titleKey: "admin.users.title",
      items: [
        { label: t("admin.users.connected"), value: onlineCount !== null ? String(onlineCount) : "N/A", color: onlineCount ? "var(--color-green)" : undefined },
        { label: t("admin.users.registered"), value: val(data.totalUsers, isLoading) },
        { label: t("admin.users.banned"), value: "N/A" },
      ],
    },
    {
      titleKey: "admin.rooms.title",
      items: [
        { label: t("admin.rooms.voice"), value: String(voiceCount) },
        { label: t("admin.rooms.text"), value: String(textCount) },
        { label: t("admin.rooms.total"), value: val(data.totalRooms, isLoading) },
      ],
    },
    {
      titleKey: "admin.server.title",
      items: [
        { label: t("admin.server.version"), value: val(data.serverName && data.serverVersion ? `${data.serverName} ${data.serverVersion}` : (data.serverVersion ?? null), isLoading) },
        { label: t("admin.server.uptime"), value: "N/A" },
        { label: t("admin.server.ram"), value: "N/A" },
        { label: t("admin.server.livekitRooms"), value: "N/A" },
      ],
    },
  ];

  return (
    <>
      {sections.map((section) => (
        <div key={section.titleKey} style={{
          background: 'var(--color-surface-container)',
          borderRadius: 16,
          padding: '14px 16px',
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.06em',
            color: 'var(--color-on-surface-variant)',
            marginBottom: 10,
          }}>
            {t(section.titleKey)}
          </div>
          {section.items.map((item, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '5px 0',
              fontSize: 12,
            }}>
              <span style={{ color: 'var(--color-on-surface-variant)' }}>{item.label}</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: item.color || 'var(--color-on-surface)' }}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
