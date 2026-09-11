import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MicIcon, HeadphoneIcon, DisconnectIcon, SettingsIcon, SpeakerIcon, RefreshIcon } from "../icons";
import { UserAvatar } from "./UserAvatar";
import { AccountPopover } from "./AccountPopover";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { useVoiceChannel, republishVoicePresence } from "../../hooks/useVoiceChannel";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { useLayoutStore } from "../../stores/useLayoutStore";

/** "CC" captions glyph for the transcript toggle — drawn inline (the icons
 *  module has no captions icon) and tinted green while OUR engine runs. */
function TranscriptIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={active ? { color: 'var(--color-green)' } : undefined}>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M10.5 10.2a2.4 2.4 0 0 0-3.4 0 2.7 2.7 0 0 0 0 3.6 2.4 2.4 0 0 0 3.4 0" />
      <path d="M17 10.2a2.4 2.4 0 0 0-3.4 0 2.7 2.7 0 0 0 0 3.6 2.4 2.4 0 0 0 3.4 0" />
    </svg>
  );
}

export function UserControls({ compact = false }: { compact?: boolean }) {
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
  const clockSkewMin = useAppStore((s) => s.clockSkewMin);
  const setE2EEUnhealthy = useAppStore((s) => s.setE2EEUnhealthy);
  const { leaveVoiceChannel } = useVoiceChannel();
  // Le bloc voix vit-il dans le menu (oui par défaut) ou a-t-il été détaché
  // dans la dock ?
  const voiceInMenu = useLayoutStore((s) => s.voiceInMenu);
  const transcriptPanelOpen = useLayoutStore(
    (s) => s.dockZones.right.panels.includes("transcript") || s.dockZones.bottom.panels.includes("transcript"),
  );
  const transcriptState = useTranscriptStore((s) => s.state);
  const transcriptInvites = useTranscriptStore((s) => s.armedPeers.length);
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
      padding: compact ? '12px 8px 16px 8px' : '12px 12px 16px 12px',
      background: 'var(--color-surface-container)',
      position: 'relative',
      display: compact ? 'flex' : undefined,
      flexDirection: compact ? 'column' : undefined,
      alignItems: compact ? 'center' : undefined,
      gap: compact ? 8 : undefined,
    }}>
      <AccountPopover compact={compact} />

      {/* Horloge décalée : l'utilisateur ne voit plus personne en vocal et les
          autres ne le voient plus non plus, sans qu'aucun symptôme ne l'explique. */}
      {clockSkewMin !== 0 && (
        compact ? (
          // Rail : pastille d'alerte, le détail complet passe en infobulle.
          <div
            title={t("voice.clockSkew", { minutes: Math.abs(clockSkewMin) })}
            style={{
              width: 32, height: 32, borderRadius: 10, flexShrink: 0,
              background: 'var(--color-error-container)', color: 'var(--color-error)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 700, cursor: 'help',
            }}
          >
            !
          </div>
        ) : (
        <div style={{
          marginBottom: 10, padding: '8px 10px', borderRadius: 12,
          background: 'var(--color-error-container)', color: 'var(--color-on-error-container)',
          fontSize: 11, lineHeight: 1.4,
        }}>
          {t("voice.clockSkew", { minutes: Math.abs(clockSkewMin) })}
        </div>
        )
      )}

      {inVoice && voiceInMenu && (
        compact ? (
          // Rail : la carte vocale se réduit à une colonne d'icônes — état,
          // récupération E2EE, micro, son, transcription, raccrocher.
          <div style={{
            padding: '8px 0', borderRadius: 12, width: '100%', flexShrink: 0,
            background: 'var(--color-surface-container-high)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          }}>
            <span
              title={`${t("voice.connected")} — ${activeVoice.name}`}
              style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-green)', animation: 'pulse 2s infinite', cursor: 'help' }}
            />
            {(e2eeUnhealthy || republished) && (
              <button
                onClick={handleRepublish}
                title={t("voice.republishPresence")}
                style={{
                  border: 'none', cursor: 'pointer', padding: 8, borderRadius: 10, display: 'flex',
                  background: republished ? 'var(--color-primary-container)' : 'var(--color-error-container)',
                  color: republished ? 'var(--color-primary)' : 'var(--color-error)',
                  transition: 'all 150ms',
                }}
              >
                <RefreshIcon />
              </button>
            )}
            <button onClick={() => toggleMute()} style={iconBtnStyle(isMuted)} title={isMuted ? t("controls.unmute") : t("controls.mute")}>
              <MicIcon muted={isMuted} />
            </button>
            <button onClick={toggleDeafen} style={iconBtnStyle(isDeafened)} title={isDeafened ? t("controls.undeafen") : t("controls.deafen")}>
              <HeadphoneIcon muted={isDeafened} />
            </button>
            <button
              onClick={() => useLayoutStore.getState().toggleDockPanel("transcript")}
              title={t("transcript.togglePanel", { defaultValue: "Transcription de la réunion" })}
              style={iconBtnStyle(transcriptPanelOpen || transcriptState === 'on' || transcriptInvites > 0, 'accent')}
            >
              <TranscriptIcon active={transcriptState === 'on'} />
            </button>
            <button
              onClick={() => connectedVoice && leaveVoiceChannel(connectedVoice)}
              title={t("voice.disconnect")}
              style={{
                border: 'none', cursor: 'pointer', padding: 8, borderRadius: 12, display: 'flex',
                background: 'var(--color-error-container)', color: 'var(--color-error)',
              }}
            >
              <DisconnectIcon />
            </button>
          </div>
        ) : (
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
              {/* Détacher : le bloc part dans le bandeau bas de la dock. */}
              <button
                onClick={() => useLayoutStore.getState().sendVoiceToDock()}
                title={t("layout.voiceSendToDock", { defaultValue: "Placer dans la dock (bandeau bas)" })}
                style={{
                  flexShrink: 0, border: 'none', cursor: 'pointer', padding: 7, borderRadius: 10, display: 'flex',
                  background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface-variant)',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M4 21h16" />
                </svg>
              </button>
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

          {/* Meeting transcript panel toggle. Opening the panel does NOT start
              transcribing — that's an explicit per-user opt-in inside the
              panel (each participant transcribes their own mic, locally). */}
          <button
            onClick={() => useLayoutStore.getState().toggleDockPanel("transcript")}
            title={t("transcript.togglePanel", { defaultValue: "Transcription de la réunion" })}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 10px', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              background: transcriptPanelOpen || transcriptState === 'on' || transcriptInvites > 0
                ? 'var(--color-secondary-container)'
                : 'var(--color-surface-container-highest)',
              color: transcriptPanelOpen || transcriptState === 'on' || transcriptInvites > 0
                ? 'var(--color-on-secondary-container)'
                : 'var(--color-on-surface)',
              transition: 'background 150ms',
            }}
          >
            <TranscriptIcon active={transcriptState === 'on'} />
            {t("transcript.pill", { defaultValue: "Transcription" })}
            {/* Someone armed and waiting → visible invitation badge. */}
            {transcriptInvites > 0 && transcriptState !== 'on' && (
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: 'var(--color-pending)', animation: 'pulse 2s infinite',
              }} />
            )}
          </button>
        </div>
        )
      )}

      {/* User row */}
      {compact ? (
        // Rail : avatar (ouvre le panneau compte) puis les actions en colonne.
        // En vocal, micro/son/transcription vivent déjà dans la carte ci-dessus.
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 'auto', flexShrink: 0 }}>
          <div onClick={toggleAccountPanel} title={displayName} style={{ cursor: 'pointer', display: 'flex' }}>
            <UserAvatar name={displayName} speaking={false} size="md" avatarUrl={avatarUrl} />
          </div>
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
      ) : (
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
      )}
    </div>
  );
}
