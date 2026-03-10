import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { SettingsIcon, ArrowLeftIcon } from "../icons";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import { keyEventToString } from "../../hooks/useKeyboardShortcuts";
import * as livekitService from "../../services/livekitService";

export function SettingsPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const [recordingMute, setRecordingMute] = useState(false);
  const [recordingDeafen, setRecordingDeafen] = useState(false);


  const mutedSpeakAlert = useSettingsStore((s) => s.mutedSpeakAlert);
  const micThreshold = useSettingsStore((s) => s.micThreshold);
  const joinMuted = useSettingsStore((s) => s.joinMuted);
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
  const notifyDM = useSettingsStore((s) => s.notifyDM);
  const linkPreviews = useSettingsStore((s) => s.linkPreviews);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);
  const audioQuality = useSettingsStore((s) => s.audioQuality);
  const setMutedSpeakAlert = useSettingsStore((s) => s.setMutedSpeakAlert);
  const setMicThreshold = useSettingsStore((s) => s.setMicThreshold);
  const setJoinMuted = useSettingsStore((s) => s.setJoinMuted);
  const setMuteShortcut = useSettingsStore((s) => s.setMuteShortcut);
  const setDeafenShortcut = useSettingsStore((s) => s.setDeafenShortcut);
  const setNotifyDM = useSettingsStore((s) => s.setNotifyDM);
  const setLinkPreviews = useSettingsStore((s) => s.setLinkPreviews);
  const setNoiseSuppression = useSettingsStore((s) => s.setNoiseSuppression);
  const setEchoCancellation = useSettingsStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useSettingsStore((s) => s.setAutoGainControl);
  const setAudioQuality = useSettingsStore((s) => s.setAudioQuality);

  // Shortcut recording
  useEffect(() => {
    if (!recordingMute && !recordingDeafen) return;

    function handleKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        if (recordingMute) { setMuteShortcut(""); setRecordingMute(false); }
        if (recordingDeafen) { setDeafenShortcut(""); setRecordingDeafen(false); }
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const combo = keyEventToString(e);
      if (recordingMute) { setMuteShortcut(combo); setRecordingMute(false); }
      if (recordingDeafen) { setDeafenShortcut(combo); setRecordingDeafen(false); }
    }

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [recordingMute, recordingDeafen, setMuteShortcut, setDeafenShortcut]);

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    width: 44,
    height: 24,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    transition: 'background 200ms',
    background: active ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
    flexShrink: 0,
  });

  const toggleDotStyle = (active: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: 3,
    left: active ? 23 : 3,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: active ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
    transition: 'left 200ms',
  });

  const shortcutBtnStyle = (recording: boolean): React.CSSProperties => ({
    padding: '8px 14px',
    borderRadius: 8,
    border: recording ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
    background: recording ? 'var(--color-primary-container)' : 'var(--color-surface-container)',
    color: recording ? 'var(--color-on-primary-container)' : 'var(--color-on-surface)',
    fontSize: 12,
    cursor: 'pointer',
    minWidth: 80,
    textAlign: 'center',
    fontFamily: 'inherit',
  });

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', padding: isMobile ? '0 16px 24px' : '0 16px 16px', gap: 16 }}>
      {/* Voice Settings */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.voiceSettings")}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.mutedSpeakAlert")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.mutedSpeakAlertDesc")}</div>
          </div>
          <button onClick={() => setMutedSpeakAlert(!mutedSpeakAlert)} style={toggleStyle(mutedSpeakAlert)}>
            <div style={toggleDotStyle(mutedSpeakAlert)} />
          </button>
        </div>

        {/* Mic threshold slider */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.micThreshold")}</div>
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(micThreshold * 1000)}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={Math.round(micThreshold * 1000)}
            onChange={(e) => setMicThreshold(Number(e.target.value) / 1000)}
            style={{
              width: '100%',
              accentColor: 'var(--color-primary)',
              cursor: 'pointer',
              height: 20,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>
            <span>{t("settings.sensitive")}</span>
            <span>{t("settings.aggressive")}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.joinMuted")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.joinMutedDesc")}</div>
          </div>
          <button onClick={() => setJoinMuted(!joinMuted)} style={toggleStyle(joinMuted)}>
            <div style={toggleDotStyle(joinMuted)} />
          </button>
        </div>
      </div>

      {/* Audio Processing */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.audioProcessing")}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.noiseSuppression")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.noiseSuppressionDesc")}</div>
          </div>
          <button onClick={() => { setNoiseSuppression(!noiseSuppression); livekitService.updateAudioProcessing({ noiseSuppression: !noiseSuppression }); }} style={toggleStyle(noiseSuppression)}>
            <div style={toggleDotStyle(noiseSuppression)} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.echoCancellation")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.echoCancellationDesc")}</div>
          </div>
          <button onClick={() => { setEchoCancellation(!echoCancellation); livekitService.updateAudioProcessing({ echoCancellation: !echoCancellation }); }} style={toggleStyle(echoCancellation)}>
            <div style={toggleDotStyle(echoCancellation)} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.autoGainControl")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.autoGainControlDesc")}</div>
          </div>
          <button onClick={() => { setAutoGainControl(!autoGainControl); livekitService.updateAudioProcessing({ autoGainControl: !autoGainControl }); }} style={toggleStyle(autoGainControl)}>
            <div style={toggleDotStyle(autoGainControl)} />
          </button>
        </div>

        {/* Audio quality dropdown */}
        <div>
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.audioQuality")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.audioQualityDesc")}</div>
          </div>
          <select
            value={audioQuality}
            onChange={(e) => {
              const v = e.target.value as import("../../stores/useSettingsStore").AudioQualityPreset;
              setAudioQuality(v);
              livekitService.updateAudioQuality(v);
            }}
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 12,
              border: '1px solid var(--color-outline-variant)',
              background: 'var(--color-surface-container-high)',
              color: 'var(--color-on-surface)',
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: 'pointer',
              outline: 'none',
              appearance: 'none',
              WebkitAppearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 12px center',
              paddingRight: 32,
            }}
          >
            <option value="voice">{t("settings.audioQualityVoice")}</option>
            <option value="voiceHD">{t("settings.audioQualityVoiceHD")}</option>
            <option value="musicStereo">{t("settings.audioQualityMusicStereo")}</option>
          </select>
        </div>
      </div>

      {/* Notifications */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.notifications")}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.notifyDM")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.notifyDMDesc")}</div>
          </div>
          <button onClick={() => setNotifyDM(!notifyDM)} style={toggleStyle(notifyDM)}>
            <div style={toggleDotStyle(notifyDM)} />
          </button>
        </div>
      </div>

      {/* Chat */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.chat")}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.linkPreviews")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.linkPreviewsDesc")}</div>
          </div>
          <button onClick={() => setLinkPreviews(!linkPreviews)} style={toggleStyle(linkPreviews)}>
            <div style={toggleDotStyle(linkPreviews)} />
          </button>
        </div>
      </div>

      {/* Keyboard Shortcuts — hidden on mobile (no physical keyboard) */}
      {!isMobile && (
        <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t("settings.shortcuts")}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.muteShortcut")}</div>
            <button
              onClick={() => { setRecordingMute(true); setRecordingDeafen(false); }}
              style={shortcutBtnStyle(recordingMute)}
            >
              {recordingMute ? t("settings.pressKey") : muteShortcut || t("settings.none")}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.deafenShortcut")}</div>
            <button
              onClick={() => { setRecordingDeafen(true); setRecordingMute(false); }}
              style={shortcutBtnStyle(recordingDeafen)}
            >
              {recordingDeafen ? t("settings.pressKey") : deafenShortcut || t("settings.none")}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{
      ...(isMobile ? {
        position: 'fixed' as const,
        inset: 0,
        zIndex: 100,
      } : {
        width: 280,
        minWidth: 280,
      }),
      background: 'var(--color-surface-container-low)',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: isMobile ? '16px 16px 12px 16px' : '20px 20px 16px 20px',
      }}>
        {isMobile && (
          <button
            onClick={toggleSettings}
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
        )}
        <SettingsIcon />
        <span style={{ fontWeight: 600, fontSize: isMobile ? 16 : 15, color: 'var(--color-on-surface)' }}>{t("settings.title")}</span>
      </div>

      {content}
    </div>
  );
}
