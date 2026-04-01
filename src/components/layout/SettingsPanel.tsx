import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { SettingsIcon, ArrowLeftIcon } from "../icons";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import { keyEventToString } from "../../hooks/useKeyboardShortcuts";
import * as livekitService from "../../services/livekitService";
import { invoke } from "@tauri-apps/api/core";

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
  const audioInputDevice = useSettingsStore((s) => s.audioInputDevice);
  const audioOutputDevice = useSettingsStore((s) => s.audioOutputDevice);
  const setAudioInputDevice = useSettingsStore((s) => s.setAudioInputDevice);
  const setAudioOutputDevice = useSettingsStore((s) => s.setAudioOutputDevice);
  const defaultChannel = useSettingsStore((s) => s.defaultChannel);
  const autoJoinVoice = useSettingsStore((s) => s.autoJoinVoice);
  const setDefaultChannel = useSettingsStore((s) => s.setDefaultChannel);
  const setAutoJoinVoice = useSettingsStore((s) => s.setAutoJoinVoice);
  const enableGifs = useSettingsStore((s) => s.enableGifs);
  const setEnableGifs = useSettingsStore((s) => s.setEnableGifs);
  const channels = useMatrixStore((s) => s.channels);

  // Audio devices enumeration
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    async function loadDevices() {
      // Try web API first
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission denied
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasRealIds = devices.some((d) => d.deviceId !== "" && d.deviceId !== "default");

      if (hasRealIds) {
        const filterDefault = (list: MediaDeviceInfo[]) => {
          if (list.length > 1) return list.filter((d) => d.deviceId !== "default");
          return list;
        };
        setAudioInputs(filterDefault(devices.filter((d) => d.kind === "audioinput")));
        setAudioOutputs(filterDefault(devices.filter((d) => d.kind === "audiooutput")));
        return;
      }

      // Fallback: use Tauri native enumeration (cpal)
      try {
        const nativeDevices = await invoke<{ id: string; name: string; kind: string }[]>("list_audio_devices");
        const toMediaDevice = (d: { id: string; name: string; kind: string }): MediaDeviceInfo => ({
          deviceId: d.id,
          groupId: "",
          kind: (d.kind === "input" ? "audioinput" : "audiooutput") as MediaDeviceKind,
          label: d.name,
          toJSON() { return this; },
        });
        setAudioInputs(nativeDevices.filter((d) => d.kind === "input").map(toMediaDevice));
        setAudioOutputs(nativeDevices.filter((d) => d.kind === "output").map(toMediaDevice));
      } catch (err) {
        console.warn("[Sion] Native device enumeration failed:", err);
        setAudioInputs([]);
        setAudioOutputs([]);
      }
    }

    loadDevices();

    // Update list when devices are plugged/unplugged
    navigator.mediaDevices.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
  }, []);

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
      {/* Default Channel */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.defaultChannels")}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.defaultChannel")}</div>
          <select
            value={defaultChannel}
            onChange={(e) => setDefaultChannel(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 12,
              border: '2px solid var(--color-outline-variant)',
              background: 'var(--color-surface-container-high)',
              color: 'var(--color-on-surface)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
            }}
          >
            <option value="">{t("settings.noDefault")}</option>
            {channels.filter((c) => !c.isDM).map((c) => (
              <option key={c.id} value={c.id}>{c.hasVoice ? `🔊 ${c.name}` : `💬 ${c.name}`}</option>
            ))}
          </select>
        </div>

        {channels.find((c) => c.id === defaultChannel)?.hasVoice && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ marginRight: 12 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.autoJoinVoice")}</div>
              <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.autoJoinVoiceDesc")}</div>
            </div>
            <button onClick={() => setAutoJoinVoice(!autoJoinVoice)} style={toggleStyle(autoJoinVoice)}>
              <div style={toggleDotStyle(autoJoinVoice)} />
            </button>
          </div>
        )}
      </div>

      {/* Voice Settings */}
      <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t("settings.voiceSettings")}
        </div>

        {/* Audio device selectors */}
        {audioInputs.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.audioInput")}</div>
            <select
              value={audioInputDevice}
              onChange={(e) => {
                setAudioInputDevice(e.target.value);
                livekitService.switchAudioInput(e.target.value);
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 12,
                border: '2px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            >
              <option value="">{t("settings.defaultDevice")}</option>
              {audioInputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
              ))}
            </select>
          </div>
        )}

        {audioOutputs.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.audioOutput")}</div>
            <select
              value={audioOutputDevice}
              onChange={(e) => {
                setAudioOutputDevice(e.target.value);
                livekitService.switchAudioOutput(e.target.value);
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 12,
                border: '2px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            >
              <option value="">{t("settings.defaultDevice")}</option>
              {audioOutputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
              ))}
            </select>
          </div>
        )}

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

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.linkPreviews")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.linkPreviewsDesc")}</div>
          </div>
          <button onClick={() => setLinkPreviews(!linkPreviews)} style={toggleStyle(linkPreviews)}>
            <div style={toggleDotStyle(linkPreviews)} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.enableGifs")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.enableGifsDesc")}</div>
          </div>
          <button onClick={() => setEnableGifs(!enableGifs)} style={toggleStyle(enableGifs)}>
            <div style={toggleDotStyle(enableGifs)} />
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

      {/* Purger le cache */}
      <div style={{ padding: '16px 0 8px 0' }}>
        <button
          onClick={() => {
            if (window.confirm(t("settings.purgeCacheConfirm"))) {
              const creds = localStorage.getItem("sion_auth_credentials");
              const deviceId = localStorage.getItem("sion_device_id");
              localStorage.clear();
              if (creds) localStorage.setItem("sion_auth_credentials", creds);
              if (deviceId) localStorage.setItem("sion_device_id", deviceId);
              indexedDB.databases().then((dbs) => {
                for (const db of dbs) {
                  if (db.name) indexedDB.deleteDatabase(db.name);
                }
              }).finally(() => {
                window.location.reload();
              });
            }
          }}
          style={{
            width: '100%',
            padding: '10px 16px',
            borderRadius: 20,
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'inherit',
            background: 'var(--color-error-container)',
            color: 'var(--color-error)',
            transition: 'all 200ms',
          }}
        >
          {t("settings.purgeCache")}
        </button>
      </div>
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
