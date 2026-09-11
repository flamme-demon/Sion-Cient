import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import {
  getVoiceNativeAudioLevel,
  getVoiceNativeAudioDevices,
  isVoiceNativeAvailable,
  setVoiceNativeAudioProcessing,
  setVoiceNativeAudioQuality,
  startVoiceNativeMicrophoneTest,
  stopVoiceNativeAudioTest,
  switchVoiceNativeAudioDevice,
  testVoiceNativeSpeaker,
  type NativeAudioDevices,
  type NativeAudioProcessing,
} from "../../services/voiceNativeService";

const cardStyle: CSSProperties = {
  background: "var(--color-surface-container)", borderRadius: 16, padding: 16,
};
const selectStyle: CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 12,
  border: "2px solid var(--color-outline-variant)",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
  fontSize: 12, fontFamily: "inherit", outline: "none",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const toggleStyle = (active: boolean): CSSProperties => ({
  width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
  position: "relative", transition: "background 200ms", flexShrink: 0,
  background: active ? "var(--color-primary)" : "var(--color-surface-container-high)",
});
const toggleDotStyle = (active: boolean): CSSProperties => ({
  position: "absolute", top: 3, left: active ? 23 : 3, width: 18, height: 18,
  borderRadius: "50%", transition: "left 200ms",
  background: active ? "var(--color-on-primary)" : "var(--color-on-surface-variant)",
});

export function NativeAudioSettings() {
  const { t } = useTranslation();
  const input = useSettingsStore((s) => s.nativeAudioInputDevice);
  const output = useSettingsStore((s) => s.nativeAudioOutputDevice);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);
  const noiseSuppression = useSettingsStore((s) => s.aiNoiseSuppression);
  const mix = useSettingsStore((s) => s.aiNoiseSuppressionMix);
  const micThreshold = useSettingsStore((s) => s.micThreshold);
  const quality = useSettingsStore((s) => s.audioQuality);
  const isMuted = useAppStore((s) => s.isMuted);
  const [devices, setDevices] = useState<NativeAudioDevices>({ recording: [], playout: [] });
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [speakerTesting, setSpeakerTesting] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const supported = await isVoiceNativeAvailable();
        if (stopped) return;
        setAvailable(supported);
        if (supported) {
          const next = await getVoiceNativeAudioDevices();
          if (!stopped) setDevices((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
        }
      } catch (err) {
        if (!stopped) setError(String(err));
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(refresh, 3000);
        }
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!available) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let previousSequence = -1;
    async function sample() {
      try {
        const level = await getVoiceNativeAudioLevel();
        if (!stopped) {
          setMicLevel(level.sequence !== previousSequence ? level.rms : 0);
          previousSequence = level.sequence;
        }
      } catch (err) {
        if (!stopped) setError(String(err));
      } finally {
        if (!stopped) timer = setTimeout(sample, 50);
      }
    }
    void startVoiceNativeMicrophoneTest(input, "settings")
      .then(() => sample())
      .catch((err) => { if (!stopped) setError(String(err)); });
    return () => {
      stopped = true;
      clearTimeout(timer);
      setMicLevel(0);
      void stopVoiceNativeAudioTest("settings");
    };
  }, [available, input, isMuted]);

  async function select(kind: "input" | "output", id: string) {
    setBusy(true);
    setError(null);
    try {
      if (useAppStore.getState().connectedVoiceChannel) await switchVoiceNativeAudioDevice(kind, id);
      const settings = useSettingsStore.getState();
      if (kind === "input") settings.setNativeAudioInputDevice(id);
      else settings.setNativeAudioOutputDevice(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeProcessing(patch: Partial<NativeAudioProcessing>) {
    setBusy(true);
    setError(null);
    const current = useSettingsStore.getState();
    const processing = {
      echoCancellation: current.echoCancellation,
      autoGainControl: current.autoGainControl,
      noiseSuppression: current.aiNoiseSuppression,
      mix: current.aiNoiseSuppressionMix,
      ...patch,
    };
    try {
      if (useAppStore.getState().connectedVoiceChannel) await setVoiceNativeAudioProcessing(processing);
      // The regular JS setters recapture the browser microphone, which must
      // stay idle while Rust owns the call.
      useSettingsStore.setState({
        echoCancellation: processing.echoCancellation,
        autoGainControl: processing.autoGainControl,
        aiNoiseSuppression: processing.noiseSuppression,
        aiNoiseSuppressionMix: processing.mix,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeQuality(next: typeof quality) {
    setBusy(true);
    setError(null);
    try {
      if (useAppStore.getState().connectedVoiceChannel) await setVoiceNativeAudioQuality(next);
      useSettingsStore.getState().setAudioQuality(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startSpeakerTest() {
    setSpeakerTesting(true);
    setError(null);
    try {
      await testVoiceNativeSpeaker(output);
      setTimeout(() => setSpeakerTesting(false), 850);
    } catch (err) {
      setSpeakerTesting(false);
      setError(String(err));
    }
  }

  const unavailable = loading || !available;
  const selectors = [
    { kind: "input" as const, value: input, list: devices.recording, label: "settings.audioInput" },
    { kind: "output" as const, value: output, list: devices.playout, label: "settings.audioOutput" },
  ];
  const processingRows = [
    { key: "noiseSuppression" as const, value: noiseSuppression, label: t("settings.noiseSuppression"), desc: t("settings.noiseSuppressionDesc") },
    { key: "echoCancellation" as const, value: echoCancellation, label: t("settings.echoCancellation"), desc: t("settings.echoCancellationDesc") },
    { key: "autoGainControl" as const, value: autoGainControl, label: t("settings.autoGainControl"), desc: t("settings.autoGainControlDesc") },
  ];

  return <>
    <div style={cardStyle}>
      {!loading && !available && <div role="status" style={{ fontSize: 12, color: "var(--color-on-surface-variant)", marginBottom: 14 }}>
        {t("settings.nativeAudioUnavailable")}
      </div>}
      {selectors.map(({ kind, value, list, label }, position) => {
        const defaultDevice = list.find((device) => device.index === 0);
        const selectable = list.filter((device) => device.index !== 0 && device.id);
        return <div key={kind} style={{ marginBottom: position === selectors.length - 1 ? 0 : 14 }}>
          <div style={{ fontSize: 14, color: "var(--color-on-surface)", marginBottom: 6 }}>{t(label)}</div>
          <select value={value} disabled={unavailable || busy}
            onChange={(event) => void select(kind, event.target.value)} style={selectStyle}>
            <option value="">
              {t("settings.defaultDevice")}{defaultDevice?.name ? ` — ${defaultDevice.name.replace(/^default:\s*/i, "")}` : ""}
            </option>
            {value && !list.some((device) => device.id === value) && <option value={value} disabled>
              {t("settings.nativeAudioDeviceMissing")}
            </option>}
            {selectable.map((device) => <option key={`${device.id}-${device.index}`} value={device.id}>{device.name}</option>)}
          </select>
        </div>;
      })}
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--color-outline-variant)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 14, color: "var(--color-on-surface)" }}>{t("settings.micThreshold")}</div>
          <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(micThreshold * 1000)}
          </span>
        </div>
        <div style={{ position: "relative", height: 28, marginBottom: 4 }}>
          <div style={{ position: "absolute", top: 10, left: 0, right: 0, height: 8, borderRadius: 4,
            background: "var(--color-surface-container-highest)", overflow: "hidden" }}>
            <div data-testid="native-mic-level" style={{ height: "100%", borderRadius: 4, transition: "width 50ms",
              width: `${Math.min(micLevel * 1000, 100)}%`,
              background: micLevel > micThreshold ? "var(--color-primary)" : "var(--color-on-surface-variant)",
              opacity: micLevel > micThreshold ? 0.8 : 0.3 }} />
          </div>
          <input type="range" min={1} max={100} value={Math.round(micThreshold * 1000)}
            onChange={(event) => useSettingsStore.getState().setMicThreshold(Number(event.target.value) / 1000)}
            className="mic-threshold-slider"
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", cursor: "pointer", zIndex: 1 }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-on-surface-variant)", marginTop: 2 }}>
          <span>{t("settings.sensitive")}</span><span>{t("settings.aggressive")}</span>
        </div>
      </div>
      <button type="button" onClick={() => void startSpeakerTest()} disabled={unavailable || busy || speakerTesting}
        style={{ width: "100%", padding: "8px 12px", marginTop: 14, borderRadius: 12, border: "none",
          cursor: speakerTesting ? "default" : "pointer", fontSize: 12, fontWeight: 500, fontFamily: "inherit",
          transition: "all 150ms", background: speakerTesting ? "var(--color-surface-container-high)" : "var(--color-primary-container)",
          color: speakerTesting ? "var(--color-on-surface-variant)" : "var(--color-on-primary-container)",
          opacity: speakerTesting ? 0.7 : 1 }}>
        {speakerTesting ? t("settings.speakerTesting") : t("settings.speakerTestStart")}
      </button>
    </div>

    <div style={cardStyle}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "var(--color-on-surface)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {t("settings.audioProcessing")}
      </div>
      {processingRows.map((item, index) => <div key={item.key}>
        <div style={{ ...rowStyle, marginBottom: item.key === "noiseSuppression" && noiseSuppression ? 10 : index < processingRows.length - 1 ? 14 : 0 }}>
          <div style={{ marginRight: 12 }}>
            <div style={{ fontSize: 14, color: "var(--color-on-surface)" }}>
              {item.label}{item.key === "noiseSuppression" ? " (RNNoise)" : ""}
            </div>
            <div style={{ fontSize: 12, color: "var(--color-on-surface-variant)", marginTop: 2 }}>{item.desc}</div>
          </div>
          <button type="button" aria-pressed={item.value} aria-label={item.label}
            disabled={unavailable || busy}
            onClick={() => void changeProcessing({ [item.key]: !item.value })} style={toggleStyle(item.value)}>
            <div style={toggleDotStyle(item.value)} />
          </button>
        </div>
        {item.key === "noiseSuppression" && noiseSuppression && <div style={{ marginBottom: 14, paddingLeft: 12, borderLeft: "2px solid var(--color-outline-variant)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ fontSize: 13, color: "var(--color-on-surface)" }}>{t("settings.aiNoiseSuppressionMix")}</div>
            <div style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{Math.round(mix * 100)}%</div>
          </div>
          <input type="range" min={0} max={100} step={5} value={Math.round(mix * 100)}
            className="sion-range"
            disabled={unavailable || busy}
            onChange={(event) => void changeProcessing({ mix: Number(event.target.value) / 100 })}
            style={{ width: "100%", "--sion-range-progress": `${Math.round(mix * 100)}%` } as CSSProperties} />
          <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)", marginTop: 4 }}>
            {t("settings.aiNoiseSuppressionMixDesc")}
          </div>
        </div>}
      </div>)}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 14, color: "var(--color-on-surface)", marginBottom: 6 }}>{t("settings.audioQuality")}</div>
        <select value={quality} disabled={unavailable || busy}
          onChange={(event) => void changeQuality(event.target.value as typeof quality)} style={selectStyle}>
          <option value="voice">{t("settings.audioQualityVoice")}</option>
          <option value="voiceHD">{t("settings.audioQualityVoiceHD")}</option>
          <option value="musicStereo">{t("settings.audioQualityMusicStereo")}</option>
        </select>
      </div>
    </div>

    {error && <div role="alert" style={{ fontSize: 12, color: "var(--color-error)", background: "var(--color-error-container)", padding: "8px 12px", borderRadius: 8 }}>
      {t("settings.nativeAudioError", { error })}
    </div>}
  </>;
}
