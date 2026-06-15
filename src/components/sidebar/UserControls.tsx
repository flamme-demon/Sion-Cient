import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MicIcon, HeadphoneIcon, DisconnectIcon, SettingsIcon, SpeakerIcon, SignalBarsIcon, RefreshIcon } from "../icons";
import { UserAvatar } from "./UserAvatar";
import { AccountPopover } from "./AccountPopover";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useVoiceChannel, republishVoicePresence } from "../../hooks/useVoiceChannel";
import { getCurrentRoom } from "../../services/livekitService";

type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

const normQuality = (q: unknown): Quality => {
  const s = String(q ?? "");
  return (["excellent", "good", "poor", "lost"].includes(s) ? s : "unknown") as Quality;
};

/** Poll the local LiveKit connection for RTT (ms) + quality, only while in voice. */
function useVoiceStats(active: boolean) {
  const [rtt, setRtt] = useState<number | null>(null);
  const [quality, setQuality] = useState<Quality>("unknown");
  useEffect(() => {
    if (!active) { setRtt(null); setQuality("unknown"); return; }
    const tick = () => {
      const room = getCurrentRoom();
      if (!room) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engine = (room as any).engine;
      const r = engine?.client?.rtt ?? engine?.rtt ?? null;
      setRtt(typeof r === "number" ? r : null);
      setQuality(normQuality(room.localParticipant?.connectionQuality));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active]);
  return { rtt, quality };
}

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
  const e2eeUnhealthy = useAppStore((s) => s.e2eeUnhealthy);
  const setE2EEUnhealthy = useAppStore((s) => s.setE2EEUnhealthy);
  const { leaveVoiceChannel } = useVoiceChannel();
  // Brief "done" feedback after the user hits the republish-presence recovery.
  const [republished, setRepublished] = useState(false);

  const handleRepublish = async () => {
    await republishVoicePresence();
    // Optimistically clear the unhealthy flag — if E2EE is still broken a new
    // MissingKey error re-raises it within seconds.
    setE2EEUnhealthy(false);
    setRepublished(true);
    setTimeout(() => setRepublished(false), 2000);
  };

  const displayName = credentials?.displayName || credentials?.userId || "User";
  const userId = credentials?.userId || "";
  const shortUserId = userId.replace(/^@/, "").replace(/:.*$/, "") || userId;
  const avatarUrl = credentials?.avatarUrl;

  const activeVoice = channels.find((c) => c.id === connectedVoice);
  const inVoice = !!(connectedVoice && activeVoice);
  const { rtt, quality } = useVoiceStats(inVoice);

  // Icon-only audio buttons (used on the user row when NOT in a voice channel).
  const iconBtnStyle = (active: boolean, variant?: 'error' | 'accent') => ({
    border: 'none',
    cursor: 'pointer',
    padding: 8,
    borderRadius: 12,
    display: 'flex' as const,
    transition: 'background 150ms',
    background: active
      ? variant === 'accent' ? 'var(--color-secondary-container)' : 'var(--color-error-container)'
      : 'transparent',
    color: active
      ? variant === 'accent' ? 'var(--color-on-secondary-container)' : 'var(--color-error)'
      : 'var(--color-on-surface-variant)',
  });

  // Labeled pill (used for Micro / Son inside the voice card).
  const pillBtn = (active: boolean, label: string, icon: React.ReactNode, onClick: () => void, title: string) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '8px 10px', borderRadius: 10, border: 'none', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        background: active ? 'var(--color-error-container)' : 'var(--color-surface-container-highest)',
        color: active ? 'var(--color-error)' : 'var(--color-on-surface)',
        transition: 'background 150ms',
      }}
    >{icon}{label}</button>
  );

  return (
    <div style={{
      padding: '12px 12px 16px 12px',
      background: 'var(--color-surface-container)',
      position: 'relative',
    }}>
      <AccountPopover />

      {inVoice && (
        <div style={{
          marginBottom: 10, padding: 10, borderRadius: 12,
          background: 'var(--color-surface-container-high)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* Status + ping + hang up */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-green)', flexShrink: 0, animation: 'pulse 2s infinite' }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-green)', whiteSpace: 'nowrap' }}>{t("voice.connected")}</span>
              <SignalBarsIcon quality={quality} size={13} />
              {rtt != null && (
                <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', whiteSpace: 'nowrap' }}>{Math.round(rtt)} ms</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {/* Recovery: re-publish our voice presence + E2EE keys without
                  leaving the call. Shown only while voice E2EE is struggling
                  locally (recent MissingKey errors) — or briefly after a click
                  to confirm the action — so it isn't permanent clutter. */}
              {(e2eeUnhealthy || republished) && (
                <button
                  onClick={handleRepublish}
                  title={t("voice.republishPresence")}
                  style={{
                    flexShrink: 0, border: 'none', cursor: 'pointer', padding: 7, borderRadius: 10, display: 'flex',
                    background: republished ? 'var(--color-primary-container)' : 'var(--color-error-container)',
                    color: republished ? 'var(--color-primary)' : 'var(--color-error)',
                    transition: 'all 150ms',
                  }}
                >
                  <RefreshIcon />
                </button>
              )}
              <button
                onClick={() => connectedVoice && leaveVoiceChannel(connectedVoice)}
                title={t("voice.disconnect")}
                style={{
                  flexShrink: 0, border: 'none', cursor: 'pointer', padding: 7, borderRadius: 10, display: 'flex',
                  background: 'var(--color-error-container)', color: 'var(--color-error)',
                }}
              >
                <DisconnectIcon />
              </button>
            </div>
          </div>

          {/* Channel name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-on-surface-variant)', minWidth: 0 }}>
            <SpeakerIcon />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeVoice.name}</span>
          </div>

          {/* Micro / Son */}
          <div style={{ display: 'flex', gap: 6 }}>
            {pillBtn(isMuted, t("controls.micro"), <MicIcon muted={isMuted} />, toggleMute, isMuted ? t("controls.unmute") : t("controls.mute"))}
            {pillBtn(isDeafened, t("controls.sound"), <HeadphoneIcon muted={isDeafened} />, toggleDeafen, isDeafened ? t("controls.undeafen") : t("controls.deafen"))}
          </div>
        </div>
      )}

      {/* User row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div onClick={toggleAccountPanel} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <UserAvatar name={displayName} speaking={false} size="md" avatarUrl={avatarUrl} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
            <div style={{ fontSize: 10, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortUserId}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {/* When not in voice, mute/deafen live here so you can pre-set them. */}
          {!inVoice && (
            <>
              <button onClick={() => toggleMute()} style={iconBtnStyle(isMuted)} title={isMuted ? t("controls.unmute") : t("controls.mute")}>
                <MicIcon muted={isMuted} />
              </button>
              <button onClick={toggleDeafen} style={iconBtnStyle(isDeafened)} title={isDeafened ? t("controls.undeafen") : t("controls.deafen")}>
                <HeadphoneIcon muted={isDeafened} />
              </button>
            </>
          )}
          <button onClick={toggleSettings} data-panel-toggle style={iconBtnStyle(showSettings, 'accent')} title={t("settings.title")}>
            <SettingsIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
