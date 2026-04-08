import { useTranslation } from "react-i18next";
import { MicIcon, HeadphoneIcon, DisconnectIcon, SettingsIcon } from "../icons";
import { UserAvatar } from "./UserAvatar";
import { AccountPopover } from "./AccountPopover";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useVoiceChannel } from "../../hooks/useVoiceChannel";

export function UserControls() {
  const { t } = useTranslation();
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const toggleMute = useAppStore((s) => s.toggleMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const showSettings = useAppStore((s) => s.showSettings);
  const toggleAccountPanel = useAppStore((s) => s.toggleAccountPanel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const channels = useMatrixStore((s) => s.channels);
  const credentials = useAuthStore((s) => s.credentials);
  const { leaveVoiceChannel } = useVoiceChannel();

  const displayName = credentials?.displayName || credentials?.userId || "User";
  const userId = credentials?.userId || "";
  const shortUserId = userId.replace(/^@/, "").replace(/:.*$/, "") || userId;
  const avatarUrl = credentials?.avatarUrl;

  const activeVoice = channels.find((c) => c.id === connectedVoice);

  const iconBtnStyle = (active: boolean, variant?: 'error' | 'accent') => ({
    border: 'none',
    cursor: 'pointer',
    padding: 8,
    borderRadius: 12,
    display: 'flex' as const,
    // Background fades smoothly, color/icon flips instantly so the muted state
    // is reflected the moment the shortcut fires (no perceived input lag).
    transition: 'background 150ms',
    background: active
      ? variant === 'accent' ? 'var(--color-secondary-container)' : 'var(--color-error-container)'
      : 'transparent',
    color: active
      ? variant === 'accent' ? 'var(--color-on-secondary-container)' : 'var(--color-error)'
      : 'var(--color-on-surface-variant)',
  });

  return (
    <div style={{
      padding: '12px 12px 16px 12px',
      background: 'var(--color-surface-container)',
      position: 'relative',
    }}>
      <AccountPopover />
      {connectedVoice && activeVoice && (
        <div style={{
          fontSize: 11,
          color: 'var(--color-green)',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-green)', display: 'inline-block', animation: 'pulse 2s infinite' }} />
            {t("voice.connected")} — {activeVoice.name}
          </span>
          <button
            onClick={() => connectedVoice && leaveVoiceChannel(connectedVoice)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 8, display: 'flex' }}
            title={t("voice.disconnect")}
          >
            <DisconnectIcon />
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div onClick={toggleAccountPanel} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <UserAvatar name={displayName} speaking={false} size="md" avatarUrl={avatarUrl} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{displayName}</div>
            <div style={{ fontSize: 10, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{shortUserId}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={toggleMute} style={iconBtnStyle(isMuted)} title={isMuted ? t("controls.unmute") : t("controls.mute")}>
            <MicIcon muted={isMuted} />
          </button>
          <button onClick={toggleDeafen} style={iconBtnStyle(isDeafened)} title={isDeafened ? t("controls.undeafen") : t("controls.deafen")}>
            <HeadphoneIcon muted={isDeafened} />
          </button>
          <button onClick={toggleSettings} data-panel-toggle style={iconBtnStyle(showSettings, 'accent')} title={t("settings.title")}>
            <SettingsIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
