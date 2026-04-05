import { useTranslation } from "react-i18next";
import { useEffect, useState, useRef, useCallback } from "react";
import { SettingsIcon, ArrowLeftIcon } from "../icons";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import { keyEventToString } from "../../hooks/useKeyboardShortcuts";
import * as livekitService from "../../services/livekitService";
import { invoke } from "@tauri-apps/api/core";

type SettingsTab = "general" | "audio" | "chat" | "shortcuts" | "advanced";

export function SettingsPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [recordingMute, setRecordingMute] = useState(false);
  const [recordingDeafen, setRecordingDeafen] = useState(false);

  const mutedSpeakAlert = useSettingsStore((s) => s.mutedSpeakAlert);
  const micThreshold = useSettingsStore((s) => s.micThreshold);
  const joinMuted = useSettingsStore((s) => s.joinMuted);
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
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
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const setNotificationMode = useSettingsStore((s) => s.setNotificationMode);
  const channels = useMatrixStore((s) => s.channels);

  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [_micTesting, setMicTesting] = useState(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnimRef = useRef<number>(0);
  const micCtxRef = useRef<AudioContext | null>(null);

  const stopMicTest = useCallback(() => {
    if (micAnimRef.current) cancelAnimationFrame(micAnimRef.current);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micCtxRef.current?.close();
    micStreamRef.current = null;
    micCtxRef.current = null;
    micAnimRef.current = 0;
    setMicLevel(0);
    setMicTesting(false);
  }, []);

  const startMicTest = useCallback(async () => {
    stopMicTest();
    try {
      const constraints: MediaStreamConstraints = { audio: audioInputDevice ? { deviceId: { exact: audioInputDevice } } : true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;
      const ctx = new AudioContext();
      micCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        setMicLevel(avg);
        micAnimRef.current = requestAnimationFrame(tick);
      };
      setMicTesting(true);
      tick();
    } catch {
      setMicTesting(false);
    }
  }, [audioInputDevice, stopMicTest]);

  // Auto-start mic test when on audio tab
  useEffect(() => {
    if (activeTab === "audio") startMicTest();
    return () => stopMicTest();
  }, [activeTab, audioInputDevice, startMicTest, stopMicTest]);

  const [speakerTesting, setSpeakerTesting] = useState(false);
  const speakerCtxRef = useRef<AudioContext | null>(null);
  const speakerOscRef = useRef<OscillatorNode | null>(null);

  const stopSpeakerTest = useCallback(() => {
    speakerOscRef.current?.stop();
    speakerCtxRef.current?.close();
    speakerOscRef.current = null;
    speakerCtxRef.current = null;
    setSpeakerTesting(false);
  }, []);

  const startSpeakerTest = useCallback(async () => {
    stopSpeakerTest();
    try {
      const ctx = new AudioContext();
      // Route to selected output device if supported
      if (audioOutputDevice && 'setSinkId' in ctx) {
        await (ctx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(audioOutputDevice);
      }
      speakerCtxRef.current = ctx;

      // Play a short melody: 3 ascending tones
      const notes = [440, 554, 659];
      const noteLen = 0.25;
      for (let i = 0; i < notes.length; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = notes[i];
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * noteLen);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + (i + 1) * noteLen);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * noteLen);
        osc.stop(ctx.currentTime + (i + 1) * noteLen);
      }
      setSpeakerTesting(true);
      setTimeout(() => {
        stopSpeakerTest();
      }, notes.length * noteLen * 1000 + 100);
    } catch {
      setSpeakerTesting(false);
    }
  }, [audioOutputDevice, stopSpeakerTest]);

  // Cleanup speaker on unmount or tab change
  useEffect(() => {
    if (activeTab !== "audio") stopSpeakerTest();
    return () => stopSpeakerTest();
  }, [activeTab, stopSpeakerTest]);

  useEffect(() => {
    async function loadDevices() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch { /* Permission denied */ }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasRealIds = devices.some((d) => d.deviceId !== "" && d.deviceId !== "default");

      if (hasRealIds) {
        const filterDefault = (list: MediaDeviceInfo[]) => list.length > 1 ? list.filter((d) => d.deviceId !== "default") : list;
        setAudioInputs(filterDefault(devices.filter((d) => d.kind === "audioinput")));
        setAudioOutputs(filterDefault(devices.filter((d) => d.kind === "audiooutput")));
        return;
      }

      try {
        const nativeDevices = await invoke<{ id: string; name: string; kind: string }[]>("list_audio_devices");
        const toMediaDevice = (d: { id: string; name: string; kind: string }): MediaDeviceInfo => ({
          deviceId: d.id, groupId: "", kind: (d.kind === "input" ? "audioinput" : "audiooutput") as MediaDeviceKind,
          label: d.name, toJSON() { return this; },
        });
        setAudioInputs(nativeDevices.filter((d) => d.kind === "input").map(toMediaDevice));
        setAudioOutputs(nativeDevices.filter((d) => d.kind === "output").map(toMediaDevice));
      } catch { setAudioInputs([]); setAudioOutputs([]); }
    }
    loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
  }, []);

  useEffect(() => {
    if (!recordingMute && !recordingDeafen) return;
    function handleKey(e: KeyboardEvent) {
      e.preventDefault(); e.stopPropagation();
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

  // Shared styles
  const toggleStyle = (active: boolean): React.CSSProperties => ({
    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
    position: 'relative', transition: 'background 200ms', flexShrink: 0,
    background: active ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
  });
  const toggleDotStyle = (active: boolean): React.CSSProperties => ({
    position: 'absolute', top: 3, left: active ? 23 : 3, width: 18, height: 18,
    borderRadius: '50%', transition: 'left 200ms',
    background: active ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
  });
  const shortcutBtnStyle = (recording: boolean): React.CSSProperties => ({
    padding: '8px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', minWidth: 80,
    textAlign: 'center', fontFamily: 'inherit',
    border: recording ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
    background: recording ? 'var(--color-primary-container)' : 'var(--color-surface-container)',
    color: recording ? 'var(--color-on-primary-container)' : 'var(--color-on-surface)',
  });
  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 12, border: '2px solid var(--color-outline-variant)',
    background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
    fontSize: 12, fontFamily: 'inherit', outline: 'none',
  };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };

  // Tab definitions
  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: "general", label: t("settings.tabGeneral"), icon: "⚙" },
    { id: "audio", label: t("settings.tabAudio"), icon: "🎧" },
    { id: "chat", label: t("settings.tabChat"), icon: "💬" },
    ...(!isMobile ? [{ id: "shortcuts" as SettingsTab, label: t("settings.tabShortcuts"), icon: "⌨" }] : []),
    { id: "advanced", label: t("settings.tabAdvanced"), icon: "🔧" },
  ];

  return (
    <div style={{
      ...(isMobile ? { position: 'fixed' as const, inset: 0, zIndex: 100, paddingTop: 'env(safe-area-inset-top, 0px)' } : { width: 280, minWidth: 280 }),
      background: 'var(--color-surface-container-low)', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '16px 16px 12px' : '20px 20px 12px' }}>
        {isMobile && (
          <button onClick={toggleSettings} style={{ padding: 8, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--color-on-surface)', display: 'flex', alignItems: 'center' }}>
            <ArrowLeftIcon />
          </button>
        )}
        <SettingsIcon />
        <span style={{ fontWeight: 600, fontSize: isMobile ? 16 : 15, color: 'var(--color-on-surface)' }}>{t("settings.title")}</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '0 12px 8px', overflowX: 'auto' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '8px 4px', border: 'none', borderRadius: 12, cursor: 'pointer',
              fontSize: 11, fontWeight: 600, fontFamily: 'inherit', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 2, transition: 'all 150ms',
              background: activeTab === tab.id ? 'var(--color-secondary-container)' : 'transparent',
              color: activeTab === tab.id ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
            }}
          >
            <span style={{ fontSize: 16 }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* === GENERAL === */}
        {activeTab === "general" && (<>
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.defaultChannel")}</div>
              <select value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} style={selectStyle}>
                <option value="">{t("settings.noDefault")}</option>
                {channels.filter((c) => !c.isDM).map((c) => (
                  <option key={c.id} value={c.id}>{c.hasVoice ? `🔊 ${c.name}` : `💬 ${c.name}`}</option>
                ))}
              </select>
            </div>

            {channels.find((c) => c.id === defaultChannel)?.hasVoice && (
              <div style={rowStyle}>
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
        </>)}

        {/* === AUDIO === */}
        {activeTab === "audio" && (<>
          {/* Microphone */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            {audioInputs.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.audioInput")}</div>
                <select value={audioInputDevice} onChange={(e) => { setAudioInputDevice(e.target.value); livekitService.switchAudioInput(e.target.value); }} style={selectStyle}>
                  <option value="">{t("settings.defaultDevice")}</option>
                  {audioInputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                </select>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.micThreshold")}</div>
                <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(micThreshold * 1000)}</span>
              </div>
              {/* Volume meter + threshold slider combo */}
              <div style={{ position: 'relative', height: 28, marginBottom: 4 }}>
                {/* Background track */}
                <div style={{
                  position: 'absolute', top: 10, left: 0, right: 0, height: 8, borderRadius: 4,
                  background: 'var(--color-surface-container-highest)', overflow: 'hidden',
                }}>
                  {/* Live mic level bar */}
                  <div style={{
                    height: '100%', borderRadius: 4, transition: 'width 50ms',
                    width: `${Math.min(micLevel * 300, 100)}%`,
                    background: micLevel * 100 > micThreshold * 1000
                      ? 'var(--color-primary)'
                      : 'var(--color-on-surface-variant)',
                    opacity: micLevel * 100 > micThreshold * 1000 ? 0.8 : 0.3,
                  }} />
                </div>
                {/* Threshold slider — transparent track, only thumb visible */}
                <input type="range" min={1} max={100} value={Math.round(micThreshold * 1000)}
                  onChange={(e) => setMicThreshold(Number(e.target.value) / 1000)}
                  className="mic-threshold-slider"
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                    cursor: 'pointer', zIndex: 1,
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>
                <span>{t("settings.sensitive")}</span><span>{t("settings.aggressive")}</span>
              </div>
            </div>

            <div style={{ ...rowStyle, marginBottom: 14 }}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.mutedSpeakAlert")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.mutedSpeakAlertDesc")}</div>
              </div>
              <button onClick={() => setMutedSpeakAlert(!mutedSpeakAlert)} style={toggleStyle(mutedSpeakAlert)}>
                <div style={toggleDotStyle(mutedSpeakAlert)} />
              </button>
            </div>

            <div style={rowStyle}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.joinMuted")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.joinMutedDesc")}</div>
              </div>
              <button onClick={() => setJoinMuted(!joinMuted)} style={toggleStyle(joinMuted)}>
                <div style={toggleDotStyle(joinMuted)} />
              </button>
            </div>
          </div>

          {/* Speaker */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            {audioOutputs.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.audioOutput")}</div>
                <select value={audioOutputDevice} onChange={(e) => { setAudioOutputDevice(e.target.value); livekitService.switchAudioOutput(e.target.value); }} style={selectStyle}>
                  <option value="">{t("settings.defaultDevice")}</option>
                  {audioOutputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                </select>
              </div>
            )}

            <div>
              <button
                onClick={startSpeakerTest}
                disabled={speakerTesting}
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: 12, border: 'none', cursor: speakerTesting ? 'default' : 'pointer',
                  fontSize: 12, fontWeight: 500, fontFamily: 'inherit', transition: 'all 150ms',
                  background: speakerTesting ? 'var(--color-surface-container-high)' : 'var(--color-primary-container)',
                  color: speakerTesting ? 'var(--color-on-surface-variant)' : 'var(--color-on-primary-container)',
                  opacity: speakerTesting ? 0.7 : 1,
                }}
              >
                {speakerTesting ? t("settings.speakerTesting") : t("settings.speakerTestStart")}
              </button>
            </div>
          </div>

          {/* Audio processing */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t("settings.audioProcessing")}
            </div>
            {[
              { label: t("settings.noiseSuppression"), desc: t("settings.noiseSuppressionDesc"), value: noiseSuppression, toggle: () => { setNoiseSuppression(!noiseSuppression); livekitService.updateAudioProcessing({ noiseSuppression: !noiseSuppression }); } },
              { label: t("settings.echoCancellation"), desc: t("settings.echoCancellationDesc"), value: echoCancellation, toggle: () => { setEchoCancellation(!echoCancellation); livekitService.updateAudioProcessing({ echoCancellation: !echoCancellation }); } },
              { label: t("settings.autoGainControl"), desc: t("settings.autoGainControlDesc"), value: autoGainControl, toggle: () => { setAutoGainControl(!autoGainControl); livekitService.updateAudioProcessing({ autoGainControl: !autoGainControl }); } },
            ].map((item, i) => (
              <div key={i} style={{ ...rowStyle, marginBottom: i < 2 ? 14 : 0 }}>
                <div style={{ marginRight: 12 }}>
                  <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{item.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{item.desc}</div>
                </div>
                <button onClick={item.toggle} style={toggleStyle(item.value)}><div style={toggleDotStyle(item.value)} /></button>
              </div>
            ))}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.audioQuality")}</div>
              <select value={audioQuality} onChange={(e) => { const v = e.target.value as import("../../stores/useSettingsStore").AudioQualityPreset; setAudioQuality(v); livekitService.updateAudioQuality(v); }} style={selectStyle}>
                <option value="voice">{t("settings.audioQualityVoice")}</option>
                <option value="voiceHD">{t("settings.audioQualityVoiceHD")}</option>
                <option value="musicStereo">{t("settings.audioQualityMusicStereo")}</option>
              </select>
            </div>
          </div>
        </>)}

        {/* === CHAT (notifications + chat options) === */}
        {activeTab === "chat" && (<>
          {/* Notification slider */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-on-surface)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t("settings.notifications")}
            </div>
            {(() => {
              const modes = ["minimal", "mentions", "all"] as const;
              const idx = modes.indexOf(notificationMode);
              const labels: Record<string, string> = { minimal: t("settings.notifyMinimal"), mentions: t("settings.notifyMentions"), all: t("settings.notifyAll") };
              const titles: Record<string, string> = { minimal: "Minimal", mentions: "Mentions", all: t("settings.notificationAll") };
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.notificationMode")}</div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-primary)' }}>{titles[notificationMode]}</span>
                  </div>
                  <div style={{ position: 'relative', height: 32, display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '0 6px' }}
                    onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const pct = (e.clientX - rect.left) / rect.width; setNotificationMode(modes[pct < 0.33 ? 0 : pct < 0.66 ? 1 : 2]); }}>
                    <div style={{ position: 'absolute', left: 6, right: 6, height: 4, borderRadius: 2, background: 'var(--color-surface-container-highest)' }} />
                    <div style={{ position: 'absolute', left: 6, width: `${idx * 50}%`, height: 4, borderRadius: 2, background: 'var(--color-primary)', transition: 'width 200ms' }} />
                    {modes.map((_, i) => (
                      <div key={i} style={{
                        position: 'absolute', left: `${i * 50}%`, borderRadius: '50%', transform: 'translateX(-50%)', transition: 'all 200ms', zIndex: 1,
                        width: i === idx ? 20 : 10, height: i === idx ? 20 : 10,
                        background: i <= idx ? 'var(--color-primary)' : 'var(--color-surface-container-highest)',
                        boxShadow: i === idx ? '0 0 0 3px var(--color-surface-container)' : 'none',
                      }} />
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 8, lineHeight: 1.4 }}>{labels[notificationMode]}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 6 }}>{t("settings.notifyPokeAlways")}</div>
                </div>
              );
            })()}
          </div>

          {/* Chat options */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ ...rowStyle, marginBottom: 14 }}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.linkPreviews")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.linkPreviewsDesc")}</div>
              </div>
              <button onClick={() => setLinkPreviews(!linkPreviews)} style={toggleStyle(linkPreviews)}><div style={toggleDotStyle(linkPreviews)} /></button>
            </div>
            <div style={rowStyle}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.enableGifs")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.enableGifsDesc")}</div>
              </div>
              <button onClick={() => setEnableGifs(!enableGifs)} style={toggleStyle(enableGifs)}><div style={toggleDotStyle(enableGifs)} /></button>
            </div>
          </div>
        </>)}

        {/* === SHORTCUTS === */}
        {activeTab === "shortcuts" && !isMobile && (
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ ...rowStyle, marginBottom: 12 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.muteShortcut")}</div>
              <button onClick={() => { setRecordingMute(true); setRecordingDeafen(false); }} style={shortcutBtnStyle(recordingMute)}>
                {recordingMute ? t("settings.pressKey") : muteShortcut || t("settings.none")}
              </button>
            </div>
            <div style={rowStyle}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.deafenShortcut")}</div>
              <button onClick={() => { setRecordingDeafen(true); setRecordingMute(false); }} style={shortcutBtnStyle(recordingDeafen)}>
                {recordingDeafen ? t("settings.pressKey") : deafenShortcut || t("settings.none")}
              </button>
            </div>
          </div>
        )}

        {/* === ADVANCED === */}
        {activeTab === "advanced" && (
          <div style={{ padding: '8px 0' }}>
            <button
              onClick={() => {
                if (window.confirm(t("settings.purgeCacheConfirm"))) {
                  const creds = localStorage.getItem("sion_auth_credentials");
                  const deviceId = localStorage.getItem("sion_device_id");
                  localStorage.clear();
                  if (creds) localStorage.setItem("sion_auth_credentials", creds);
                  if (deviceId) localStorage.setItem("sion_device_id", deviceId);
                  indexedDB.databases().then((dbs) => {
                    for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
                  }).finally(() => { window.location.reload(); });
                }
              }}
              style={{
                width: '100%', padding: '10px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                background: 'var(--color-error-container)', color: 'var(--color-error)', transition: 'all 200ms',
              }}
            >
              {t("settings.purgeCache")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
