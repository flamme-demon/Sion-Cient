import { useMemo, useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAppStore } from "../../stores/useAppStore";
import { useSettingsStore, type ChannelSortMode } from "../../stores/useSettingsStore";
import { SortIcon } from "../icons";
import { ChannelItem } from "./ChannelItem";
import { MatrixRain } from "./MatrixRain";
import { findAdminRoom } from "../../services/adminCommandService";

const SORT_OPTIONS: ChannelSortMode[] = ["created", "name", "activity"];

const SORT_KEYS: Record<ChannelSortMode, string> = {
  created: "channels.sortCreated",
  name: "channels.sortName",
  activity: "channels.sortActivity",
};

export function ChannelList() {
  const { t } = useTranslation();
  const channels = useMatrixStore((s) => s.channels);
  const connectingVoice = useAppStore((s) => s.connectingVoiceChannel);
  const channelSort = useSettingsStore((s) => s.channelSort);
  const setChannelSort = useSettingsStore((s) => s.setChannelSort);
  const sidebarView = useSettingsStore((s) => s.sidebarView);
  const setSidebarView = useSettingsStore((s) => s.setSidebarView);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const sortedChannels = useMemo(() => {
    const filtered = channels.filter((ch) =>
      sidebarView === "dm" ? ch.isDM : !ch.isDM
    );
    const copy = [...filtered];
    switch (channelSort) {
      case "created":
        return copy.sort((a, b) => a.createdAt - b.createdAt);
      case "name":
        return copy.sort((a, b) => a.name.localeCompare(b.name));
      case "activity":
        return copy.sort((a, b) => b.lastActivity - a.lastActivity);
      default:
        return copy;
    }
  }, [channels, channelSort, sidebarView]);

  const allMessages = useMatrixStore((s) => s.messages);
  const lastReadMessageId = useAppStore((s) => s.lastReadMessageId);
  const activeChannel = useAppStore((s) => s.activeChannel);

  const { unreadChannels, unreadDMs } = useMemo(() => {
    const adminRoom = findAdminRoom();
    let chCount = 0;
    let dmCount = 0;
    for (const ch of channels) {
      if (ch.id === adminRoom || ch.id === activeChannel) continue;
      const msgs = allMessages[ch.id];
      if (!msgs || msgs.length === 0) continue;
      const lastReadId = lastReadMessageId[ch.id];
      let unread: number;
      if (!lastReadId) {
        unread = msgs.length;
      } else {
        const idx = msgs.findIndex((m) => (m.eventId || String(m.id)) === lastReadId);
        unread = idx === -1 ? msgs.length : msgs.length - idx - 1;
      }
      if (unread > 0) {
        if (ch.isDM) dmCount += unread;
        else chCount += unread;
      }
    }
    return { unreadChannels: chCount, unreadDMs: dmCount };
  }, [channels, allMessages, lastReadMessageId, activeChannel]);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '6px 8px',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    letterSpacing: '0.02em',
    background: active ? 'var(--color-secondary-container)' : 'transparent',
    color: active ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
    transition: 'all 150ms ease',
  });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
      {/* Tabs + sort */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px 8px 12px' }}>
        <button onClick={() => setSidebarView("channels")} style={{ ...tabStyle(sidebarView === "channels"), position: 'relative' }}>
          {t("channels.tabChannels")}
          {sidebarView !== "channels" && unreadChannels > 0 && (
            <span style={{
              position: 'absolute', top: 2, right: 2,
              minWidth: 8, height: 8,
              borderRadius: 4,
              background: 'var(--color-error)',
            }} />
          )}
        </button>
        <button onClick={() => setSidebarView("dm")} style={{ ...tabStyle(sidebarView === "dm"), position: 'relative' }}>
          {t("channels.tabDM")}
          {sidebarView !== "dm" && unreadDMs > 0 && (
            <span style={{
              position: 'absolute', top: 2, right: 2,
              minWidth: 8, height: 8,
              borderRadius: 4,
              background: 'var(--color-error)',
            }} />
          )}
        </button>
        <div ref={menuRef} style={{ position: 'relative', marginLeft: 'auto', flexShrink: 0 }}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            title={t(SORT_KEYS[channelSort])}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: menuOpen ? 'var(--color-accent)' : 'var(--color-on-surface-variant)',
              display: 'flex',
              alignItems: 'center',
              borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent)')}
            onMouseLeave={(e) => { if (!menuOpen) e.currentTarget.style.color = 'var(--color-on-surface-variant)'; }}
          >
            <SortIcon />
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              background: 'var(--color-bg-dark)',
              border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
              borderRadius: 6,
              padding: '4px 0',
              minWidth: 160,
              zIndex: 50,
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            }}>
              {SORT_OPTIONS.map((mode) => (
                <button
                  key={mode}
                  onClick={() => { setChannelSort(mode); setMenuOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 12px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: channelSort === mode ? 'var(--color-accent)' : 'var(--color-on-surface)',
                    fontSize: 12,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <span style={{ width: 16, textAlign: 'center', fontSize: 13 }}>
                    {channelSort === mode ? "✓" : ""}
                  </span>
                  {t(SORT_KEYS[mode])}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {connectingVoice ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          position: 'relative', overflow: 'hidden', borderRadius: 12,
          minHeight: 200,
        }}>
          <MatrixRain width={236} height={200} />
          <div style={{
            position: 'absolute', bottom: 16,
            fontSize: 12, fontWeight: 600, color: '#0f0',
            textShadow: '0 0 8px rgba(0,255,70,0.6)',
            letterSpacing: '0.1em',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}>
            {t("voice.connecting")}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sortedChannels.map((ch) => (
            <ChannelItem key={ch.id} channel={ch} />
          ))}
        </div>
      )}
    </div>
  );
}
