import { useMemo, useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAdminStore } from "../../stores/useAdminStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { getMatrixClient } from "../../services/matrixService";
import { sendAdminCommand } from "../../services/adminCommandService";

interface StatItem {
  label: string;
  value: string;
  color?: string;
  onClick?: () => void;
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
  const [userModal, setUserModal] = useState<{ title: string; users: { name: string; userId: string }[] } | null>(null);

  const voiceCount = channels.filter((c) => c.hasVoice).length;
  const textCount = channels.filter((c) => !c.hasVoice).length;

  const onlineCount = useMemo(() => {
    const client = getMatrixClient();
    if (!client) return null;
    const users = client.getUsers();
    return users.filter((u) => u.presence === "online").length;
  }, [channels]);

  const showConnectedUsers = () => {
    const client = getMatrixClient();
    if (!client) return;
    const users = client.getUsers()
      .filter((u) => u.presence === "online" && !u.userId.includes("conduit"))
      .map((u) => ({ name: u.displayName || u.userId.match(/@([^:]+)/)?.[1] || u.userId, userId: u.userId }));
    setUserModal({ title: t("admin.users.connected"), users });
  };

  const showRegisteredUsers = () => {
    const client = getMatrixClient();
    if (!client) return;
    const serverName = client.getDomain() || "";
    const seen = new Set<string>();
    const users: { name: string; userId: string }[] = [];
    for (const room of client.getRooms()) {
      for (const m of room.getJoinedMembers()) {
        if (m.userId.endsWith(`:${serverName}`) && !m.userId.includes("conduit") && !seen.has(m.userId)) {
          seen.add(m.userId);
          users.push({ name: m.name || m.userId.match(/@([^:]+)/)?.[1] || m.userId, userId: m.userId });
        }
      }
    }
    users.sort((a, b) => a.name.localeCompare(b.name));
    setUserModal({ title: t("admin.users.registered"), users });
  };

  // Uptime + RAM serveur via admin commands
  const [uptime, setUptime] = useState("...");
  const [ram, setRam] = useState("...");
  const initRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const fetchServerInfo = async () => {
      try {
        const uptimeResp = await sendAdminCommand("!admin server uptime");
        setUptime(uptimeResp.replace(/<[^>]+>/g, "").trim());
      } catch {
        setUptime("N/A");
      }

      try {
        const memResp = await sendAdminCommand("!admin server memory-usage");
        const clean = memResp.replace(/<[^>]+>/g, " ");
        const match = clean.match(/Memory buffers:\s*([\d.]+\s*\w+)/i);
        setRam(match ? match[1] : "N/A");
      } catch {
        setRam("N/A");
      }
    };

    fetchServerInfo();
    intervalRef.current = setInterval(fetchServerInfo, 60000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const sections: StatSection[] = [
    {
      titleKey: "admin.users.title",
      items: [
        { label: t("admin.users.connected"), value: onlineCount !== null ? String(onlineCount) : "N/A", color: onlineCount ? "var(--color-green)" : undefined, onClick: showConnectedUsers },
        { label: t("admin.users.registered"), value: val(data.totalUsers, isLoading), onClick: showRegisteredUsers },
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
        { label: t("admin.server.uptime"), value: uptime },
        { label: t("admin.server.ram"), value: ram },
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
            <div
              key={i}
              onClick={item.onClick}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '5px 4px',
                fontSize: 12,
                borderRadius: 8,
                cursor: item.onClick ? 'pointer' : 'default',
                transition: 'background 150ms',
              }}
              onMouseEnter={(e) => { if (item.onClick) e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ color: 'var(--color-on-surface-variant)' }}>{item.label}</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: item.color || 'var(--color-on-surface)' }}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      ))}

      {userModal && (
        <div
          onClick={() => setUserModal(null)}
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
              maxWidth: 400,
              width: '90%',
              maxHeight: '60vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 16 }}>
              {userModal.title} ({userModal.users.length})
            </div>
            <div style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {userModal.users.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-outline)', fontSize: 13 }}>
                  {t("admin.activeUsers.none")}
                </div>
              ) : userModal.users.map((user) => (
                <div
                  key={user.userId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: 12,
                    background: 'var(--color-surface-container-high)',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-on-surface)' }}>
                      {user.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                      {user.userId}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setUserModal(null)}
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
    </>
  );
}
