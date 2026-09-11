import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { useEffect, useState, useRef, useCallback } from "react";
import { SettingsIcon, ArrowLeftIcon, PaperclipIcon, FileIcon, DownloadIcon } from "../icons";
import { useSettingsStore, type VoiceCue, type VoiceSoundCfg } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useClickOutside } from "../../hooks/useClickOutside";
import { keyEventToString, formatCombo, globalComboIssue } from "../../utils/keyCombo";
import { NativeAudioSettings } from "./NativeAudioSettings";
import { VoiceCueEditor } from "../chat/VoiceCueEditor";
import { ExternalAudioImport } from "../chat/ExternalAudioImport";
import { isModelDownloaded, ensureModelDownloaded, summaryAssetsStatus, ensureSummaryAssets, deleteAsrModel, deleteSummaryAssets } from "../../services/transcriptionService";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { detectTtsEngine, listTtsModels, installTtsModel, deleteTtsModel, pickTtsEnginePath, TTS_MODEL_LABELS, type TtsModelInfo } from "../../services/ttsService";
import { useThemeStore } from "../../stores/useThemeStore";
import { BUILTIN_THEMES } from "../../themes/builtin";
import { getActiveTheme, parseThemeFile, themeToJson, resolveThemeTokens } from "../../services/themeService";


type SettingsTab = "general" | "audio" | "channel" | "shortcuts" | "advanced";

export function SettingsPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const panelRef = useRef<HTMLDivElement>(null);
  // Click-outside-to-close — disabled on mobile (full-screen overlay)
  useClickOutside(panelRef, toggleSettings, !isMobile);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [recordingMute, setRecordingMute] = useState(false);
  const [recordingDeafen, setRecordingDeafen] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  // --- Apparence (thèmes) ---
  const themeId = useThemeStore((s) => s.themeId);
  const customThemes = useThemeStore((s) => s.customThemes);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const upsertCustomTheme = useThemeStore((s) => s.upsertCustomTheme);
  const removeCustomTheme = useThemeStore((s) => s.removeCustomTheme);
  const themeFileRef = useRef<HTMLInputElement>(null);
  const [themeMsg, setThemeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const allThemes = [...BUILTIN_THEMES, ...customThemes];

  const handleThemeImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (themeFileRef.current) themeFileRef.current.value = "";
    if (!file) return;
    try {
      const parsed = parseThemeFile(await file.text());
      if ("error" in parsed) {
        setThemeMsg({ ok: false, text: `${t("settings.themeErrInvalid")} (${parsed.error})` });
        return;
      }
      upsertCustomTheme(parsed.theme);
      setThemeMsg({ ok: true, text: t("settings.themeImported", { name: parsed.theme.name }) });
    } catch {
      setThemeMsg({ ok: false, text: t("settings.themeErrInvalid") });
    }
  };

  const handleThemeExport = () => {
    // WebKitGTK n'expose pas toujours navigator.clipboard : textarea +
    // execCommand, l'implémentation la plus compatible, déclenchée par le clic.
    try {
      const ta = document.createElement("textarea");
      ta.value = themeToJson(getActiveTheme());
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      setThemeMsg({ ok, text: ok ? t("settings.themeCopied") : t("settings.themeCopyFailed") });
    } catch {
      setThemeMsg({ ok: false, text: t("settings.themeCopyFailed") });
    }
  };

  const mutedSpeakAlert = useSettingsStore((s) => s.mutedSpeakAlert);
  const joinMuted = useSettingsStore((s) => s.joinMuted);
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
  const linkPreviews = useSettingsStore((s) => s.linkPreviews);
  const setMutedSpeakAlert = useSettingsStore((s) => s.setMutedSpeakAlert);
  const setJoinMuted = useSettingsStore((s) => s.setJoinMuted);
  const setMuteShortcut = useSettingsStore((s) => s.setMuteShortcut);
  const setDeafenShortcut = useSettingsStore((s) => s.setDeafenShortcut);
  const setLinkPreviews = useSettingsStore((s) => s.setLinkPreviews);
  const ffmpegPath = useSettingsStore((s) => s.ffmpegPath);
  const setFfmpegPath = useSettingsStore((s) => s.setFfmpegPath);
  // undefined = checking, null = not found, string = resolved ffmpeg path.
  const [ffmpegDetected, setFfmpegDetected] = useState<string | null | undefined>(undefined);
  // null = idle, number = install progress %, string = error message.
  const [ffmpegInstall, setFfmpegInstall] = useState<number | string | null>(null);
  const redetectFfmpeg = useCallback(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("detect_ffmpeg"))
      .then((p) => setFfmpegDetected(p ?? null))
      .catch(() => setFfmpegDetected(null));
  }, []);
  useEffect(() => { redetectFfmpeg(); }, [ffmpegPath, redetectFfmpeg]);
  const ytdlpPath = useSettingsStore((s) => s.ytdlpPath);
  const setYtdlpPath = useSettingsStore((s) => s.setYtdlpPath);
  const [ytdlpDetected, setYtdlpDetected] = useState<string | null | undefined>(undefined);
  const [ytdlpInstall, setYtdlpInstall] = useState<number | string | null>(null);
  // { current, latest } yt-dlp versions (YYYY.MM.DD); null while loading.
  const [ytdlpVer, setYtdlpVer] = useState<{ current: string | null; latest: string | null } | null>(null);
  const redetectYtdlp = useCallback(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("detect_ytdlp"))
      .then((p) => setYtdlpDetected(p ?? null))
      .catch(() => setYtdlpDetected(null));
    setYtdlpVer(null);
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("ytdlp_versions"))
      .then((raw) => setYtdlpVer(JSON.parse(raw)))
      .catch(() => setYtdlpVer(null));
  }, []);
  useEffect(() => { redetectYtdlp(); }, [ytdlpPath, redetectYtdlp]);
  // Voix générées (audio.cpp) : chemin du moteur + état des modèles.
  const ttsEnginePath = useSettingsStore((s) => s.ttsEnginePath);
  const setTtsEnginePath = useSettingsStore((s) => s.setTtsEnginePath);
  const [ttsEngineDetected, setTtsEngineDetected] = useState<string | null | undefined>(undefined);
  const [ttsModels, setTtsModels] = useState<TtsModelInfo[]>([]);
  const [ttsBusy, setTtsBusy] = useState<string | null>(null);
  const [ttsPct, setTtsPct] = useState<number | null>(null);
  const refreshTts = useCallback(() => {
    detectTtsEngine().then((p) => setTtsEngineDetected(p)).catch(() => setTtsEngineDetected(null));
    listTtsModels().then(setTtsModels).catch(() => setTtsModels([]));
  }, []);
  useEffect(() => { refreshTts(); }, [ttsEnginePath, refreshTts]);
  // llama.cpp (IA de résumé) : { current, latest, vulkan } — null pendant le
  // chargement ou hors Tauri.
  const [llamaVer, setLlamaVer] = useState<{ current: string | null; latest: string | null; vulkan: boolean } | null>(null);
  const [llamaInstall, setLlamaInstall] = useState<number | string | null>(null);
  const redetectLlama = useCallback(() => {
    setLlamaVer(null);
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("llama_versions"))
      .then((raw) => setLlamaVer(JSON.parse(raw)))
      .catch(() => setLlamaVer(null));
  }, []);
  useEffect(() => { redetectLlama(); }, [redetectLlama]);
  const defaultChannel = useSettingsStore((s) => s.defaultChannel);
  const autoJoinVoice = useSettingsStore((s) => s.autoJoinVoice);
  const setDefaultChannel = useSettingsStore((s) => s.setDefaultChannel);
  const setAutoJoinVoice = useSettingsStore((s) => s.setAutoJoinVoice);
  const enableGifs = useSettingsStore((s) => s.enableGifs);
  const setEnableGifs = useSettingsStore((s) => s.setEnableGifs);
  const screenShareAudio = useSettingsStore((s) => s.screenShareAudio);
  const setScreenShareAudio = useSettingsStore((s) => s.setScreenShareAudio);
  const voiceChannelSounds = useSettingsStore((s) => s.voiceChannelSounds);
  const setVoiceChannelSounds = useSettingsStore((s) => s.setVoiceChannelSounds);
  const voiceSounds = useSettingsStore((s) => s.voiceSounds);
  const setVoiceSound = useSettingsStore((s) => s.setVoiceSound);
  const muteSoundsWhenDeafened = useSettingsStore((s) => s.muteSoundsWhenDeafened);
  const setMuteSoundsWhenDeafened = useSettingsStore((s) => s.setMuteSoundsWhenDeafened);
  const [cueEditor, setCueEditor] = useState<{ cue: VoiceCue; file: File; path: string; label: string } | null>(null);
  const [cueUrlImport, setCueUrlImport] = useState<{ cue: VoiceCue; label: string } | null>(null);
  const [cueMenu, setCueMenu] = useState<VoiceCue | null>(null);
  const pickCueFile = useCallback(async (cue: VoiceCue, label: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const p = await invoke<string | null>("pick_audio_file");
      if (!p) return;
      const b64 = await invoke<string>("read_file_b64", { path: p });
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], p.split(/[/\\]/).pop() || "sound");
      setCueEditor({ cue, file, path: p, label });
    } catch { /* cancelled / not in Tauri */ }
    // `setCueEditor` est référencé explicitement : le React Compiler l'infère
    // comme dépendance et refuse sinon de préserver la mémoïsation manuelle.
  }, [setCueEditor]);
  // One configurable-sound row (preview / pick file / pick URL / reset).
  // Shared by the gated voice cues (join/leave/timeout) and the always-on
  // event sounds (poke/kick/memberKicked).
  const renderCueRow = ({ cue, label, cfg }: { cue: VoiceCue; label: string; cfg: VoiceSoundCfg | null }) => (
    <div key={cue} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 0', borderTop: '1px solid var(--color-surface-container-highest)', marginTop: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cfg
            ? `${cfg.path.split(/[/\\]/).pop()} · ${(cfg.end - cfg.start).toFixed(1)}s · ${Math.round(cfg.gain * 100)}%`
            : t("settings.cueDefault")}
        </div>
      </div>
      <button
        type="button"
        title={t("settings.cuePreview")}
        onClick={async () => {
          const { previewCue } = await import("../../services/voiceChannelSounds");
          previewCue(cue);
        }}
        style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', flexShrink: 0 }}
      >
        ▶
      </button>
      <div style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
        <button
          type="button"
          title={t("settings.cueSource")}
          onClick={() => setCueMenu((c) => (c === cue ? null : cue))}
          style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)' }}
        >
          <PaperclipIcon />
        </button>
        {cueMenu === cue && (
          <>
            <div onClick={() => setCueMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
            <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 51, background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)', borderRadius: 12, padding: 6, minWidth: 170, boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}>
              <button type="button"
                onClick={() => { setCueMenu(null); pickCueFile(cue, label); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--color-on-surface)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <FileIcon /> {t("soundboard.modeFile")}
              </button>
              <button type="button"
                onClick={() => { setCueMenu(null); setCueUrlImport({ cue, label }); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--color-on-surface)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <DownloadIcon /> {t("soundboard.modeUrl")}
              </button>
            </div>
          </>
        )}
      </div>
      {cfg && (
        <button
          type="button"
          title={t("settings.cueReset")}
          onClick={() => setVoiceSound(cue, null)}
          style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface-variant)', flexShrink: 0 }}
        >
          ✕
        </button>
      )}
    </div>
  );
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setNotificationMode = useSettingsStore((s) => s.setNotificationMode);
  const channels = useMatrixStore((s) => s.channels);

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
      // Reject globally-grabbed bare keys: a modifier-less printable key is
      // captured system-wide by the portal/RegisterHotKey grab and becomes
      // unusable for typing everywhere else (see keyCombo.globalComboIssue).
      const issue = globalComboIssue(combo);
      if (issue === "bare") {
        setShortcutError(t("settings.shortcutBareKey"));
        setRecordingMute(false); setRecordingDeafen(false);
        return;
      }
      if (issue === "f12" || issue === "webview-fkey") {
        setShortcutError(t("settings.shortcutReservedKey", { key: formatCombo(combo) }));
        setRecordingMute(false); setRecordingDeafen(false);
        return;
      }
      setShortcutError(null);
      if (recordingMute) { setMuteShortcut(combo); setRecordingMute(false); }
      if (recordingDeafen) { setDeafenShortcut(combo); setRecordingDeafen(false); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [recordingMute, recordingDeafen, setMuteShortcut, setDeafenShortcut, t]);

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
  const smallBtnStyle: React.CSSProperties = {
    flex: 1, padding: '8px 10px', borderRadius: 12, border: '1px solid var(--color-outline-variant)',
    background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
  };

  // Tab definitions
  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: "general", label: t("settings.tabGeneral"), icon: "⚙" },
    { id: "audio", label: t("settings.tabAudio"), icon: "🎧" },
    { id: "channel", label: t("settings.tabChannel"), icon: "#" },
    ...(!isMobile ? [{ id: "shortcuts" as SettingsTab, label: t("settings.tabShortcuts"), icon: "⌨" }] : []),
    { id: "advanced", label: t("settings.tabAdvanced"), icon: "🔧" },
  ];

  return (
    <div ref={panelRef} style={{
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
          {/* Apparence — thèmes en fichiers JSON (import/export, cf. §3 de la roadmap) */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 10 }}>{t("settings.appearance")}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {allThemes.map((th) => {
                const active = th.id === themeId;
                const tokens = resolveThemeTokens(th);
                return (
                  <div key={th.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      onClick={() => setThemeId(th.id)}
                      style={{
                        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                        border: active ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
                        background: active ? 'var(--color-secondary-container)' : 'transparent',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ display: 'flex', flexShrink: 0 }}>
                        {(["color-surface", "color-surface-container-high", "color-primary"] as const).map((k, i) => (
                          <span
                            key={k}
                            style={{
                              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                              marginLeft: i === 0 ? 0 : -5,
                              border: '1px solid var(--color-outline)',
                              background: tokens[k],
                            }}
                          />
                        ))}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: active ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {th.name}
                        </span>
                        {th.author && (
                          <span style={{ display: 'block', fontSize: 10, color: active ? 'var(--color-on-secondary-container)' : 'var(--color-outline)' }}>{th.author}</span>
                        )}
                      </span>
                      {active && <span style={{ fontSize: 13, color: 'var(--color-primary)', flexShrink: 0 }}>✓</span>}
                    </button>
                    {th.id.startsWith("custom-") && (
                      <button
                        onClick={() => removeCustomTheme(th.id)}
                        title={t("settings.themeRemove")}
                        style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', padding: 4, fontSize: 14, lineHeight: 1 }}
                      >×</button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => themeFileRef.current?.click()} style={smallBtnStyle}>{t("settings.themeImport")}</button>
              <button onClick={handleThemeExport} style={smallBtnStyle}>{t("settings.themeExport")}</button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 8, lineHeight: 1.45 }}>{t("settings.themeHint")}</div>
            {themeMsg && (
              <div style={{ fontSize: 11, marginTop: 6, color: themeMsg.ok ? 'var(--color-green)' : 'var(--color-error)' }}>{themeMsg.text}</div>
            )}
            <input ref={themeFileRef} type="file" accept="application/json,.json" onChange={handleThemeImport} style={{ display: 'none' }} />
          </div>
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 6 }}>{t("settings.language")}</div>
              <select value={language || i18n.language?.slice(0, 2)} onChange={(e) => setLanguage(e.target.value)} style={selectStyle}>
                <option value="">{t("settings.languageSystem")}</option>
                <option value="fr">{t("settings.languageFr")}</option>
                <option value="en">{t("settings.languageEn")}</option>
              </select>
            </div>

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
          <NativeAudioSettings />
          {/* Microphone */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ ...rowStyle, marginBottom: 14 }}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.mutedSpeakAlert")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.mutedSpeakAlertDesc")}</div>
              </div>
              <button onClick={() => setMutedSpeakAlert(!mutedSpeakAlert)} style={toggleStyle(mutedSpeakAlert)}>
                <div style={toggleDotStyle(mutedSpeakAlert)} />
              </button>
            </div>

            <div style={{ ...rowStyle, marginBottom: 14 }}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.joinMuted")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.joinMutedDesc")}</div>
              </div>
              <button onClick={() => setJoinMuted(!joinMuted)} style={toggleStyle(joinMuted)}>
                <div style={toggleDotStyle(joinMuted)} />
              </button>
            </div>

            <div style={rowStyle}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.screenShareAudio")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.screenShareAudioDesc")}</div>
              </div>
              <button onClick={() => setScreenShareAudio(!screenShareAudio)} style={toggleStyle(screenShareAudio)}>
                <div style={toggleDotStyle(screenShareAudio)} />
              </button>
            </div>
          </div>
        </>)}

        {/* === CHAT (notifications + chat options) === */}
        {activeTab === "channel" && (<>
          {/* ---- TEXTE ---- */}
          <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--color-on-surface-variant)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 4px 2px' }}>
            {t("settings.channelTextSection")}
          </div>
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

          {/* ---- VOCAL ---- */}
          <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--color-on-surface-variant)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 4px 2px' }}>
            {t("settings.channelVoiceSection")}
          </div>

          {/* Meeting transcription (local whisper) — model + language. The
              model is fetched on first use; the button just pre-downloads. */}
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.transcribeTitle")}</div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2, marginBottom: 12 }}>{t("settings.transcribeDesc")}</div>
            <TranscribeModelPicker selectStyle={selectStyle} />
          </div>
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={voiceChannelSounds ? { ...rowStyle, marginBottom: 8 } : rowStyle}>
              <div style={{ marginRight: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.voiceChannelSounds")}</div>
                <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.voiceChannelSoundsDesc")}</div>
              </div>
              <button onClick={() => setVoiceChannelSounds(!voiceChannelSounds)} style={toggleStyle(voiceChannelSounds)}>
                <div style={toggleDotStyle(voiceChannelSounds)} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0 0', borderTop: '1px solid var(--color-surface-container-highest)', marginTop: 8 }}>
              <div style={{ flex: 1, marginRight: 12 }}>
                <div style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>{t("settings.muteSoundsWhenDeafened")}</div>
                <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{t("settings.muteSoundsWhenDeafenedDesc")}</div>
              </div>
              <button onClick={() => setMuteSoundsWhenDeafened(!muteSoundsWhenDeafened)} style={toggleStyle(muteSoundsWhenDeafened)}>
                <div style={toggleDotStyle(muteSoundsWhenDeafened)} />
              </button>
            </div>

            {voiceChannelSounds && ([
              { cue: "join" as const, label: t("settings.cueJoin"), cfg: voiceSounds.join },
              { cue: "leave" as const, label: t("settings.cueLeave"), cfg: voiceSounds.leave },
              { cue: "timeout" as const, label: t("settings.cueTimeout"), cfg: voiceSounds.timeout },
            ]).map(renderCueRow)}
          </div>

          {/* ---- SONS D'ÉVÉNEMENTS (toujours actifs, personnalisables) ---- */}
          <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--color-on-surface-variant)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 4px 2px' }}>
            {t("settings.eventSoundsSection")}
          </div>
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("settings.eventSoundsDesc")}</div>
            {([
              { cue: "poke" as const, label: t("settings.cuePoke"), cfg: voiceSounds.poke },
              { cue: "kick" as const, label: t("settings.cueKick"), cfg: voiceSounds.kick },
              { cue: "memberKicked" as const, label: t("settings.cueMemberKicked"), cfg: voiceSounds.memberKicked },
            ]).map(renderCueRow)}
          </div>

          {/* ---- SONS D'ACTION (mute / sourdine — toujours actifs) ---- */}
          <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--color-on-surface-variant)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 4px 2px' }}>
            {t("settings.actionSoundsSection")}
          </div>
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("settings.actionSoundsDesc")}</div>
            {([
              { cue: "mute" as const, label: t("settings.cueMute"), cfg: voiceSounds.mute },
              { cue: "unmute" as const, label: t("settings.cueUnmute"), cfg: voiceSounds.unmute },
              { cue: "deafen" as const, label: t("settings.cueDeafen"), cfg: voiceSounds.deafen },
              { cue: "undeafen" as const, label: t("settings.cueUndeafen"), cfg: voiceSounds.undeafen },
            ]).map(renderCueRow)}
          </div>
        </>)}

        {/* === SHORTCUTS === */}
        {activeTab === "shortcuts" && !isMobile && (
          <div style={{ background: 'var(--color-surface-container)', borderRadius: 16, padding: 16 }}>
            <div style={{ ...rowStyle, marginBottom: 12 }}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.muteShortcut")}</div>
              <button onClick={() => { setShortcutError(null); setRecordingMute(true); setRecordingDeafen(false); }} style={shortcutBtnStyle(recordingMute)}>
                {recordingMute ? t("settings.pressKey") : formatCombo(muteShortcut) || t("settings.none")}
              </button>
            </div>
            <div style={rowStyle}>
              <div style={{ fontSize: 14, color: 'var(--color-on-surface)' }}>{t("settings.deafenShortcut")}</div>
              <button onClick={() => { setShortcutError(null); setRecordingDeafen(true); setRecordingMute(false); }} style={shortcutBtnStyle(recordingDeafen)}>
                {recordingDeafen ? t("settings.pressKey") : formatCombo(deafenShortcut) || t("settings.none")}
              </button>
            </div>
            {shortcutError && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-error)', background: 'var(--color-error-container)', padding: '8px 12px', borderRadius: 8 }}>
                {shortcutError}
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
              {t("settings.shortcutHint")}
            </div>
          </div>
        )}

        {/* === ADVANCED === */}
        {activeTab === "advanced" && (
          <div style={{ padding: '8px 0' }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--color-on-surface)', marginBottom: 4 }}>Chemin ffmpeg (optionnel)</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={ffmpegPath}
                  onChange={(e) => setFfmpegPath(e.target.value)}
                  placeholder={"ex : C:\\ffmpeg\\bin\\ffmpeg.exe"}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-outline)', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      const p = await invoke<string | null>("pick_ffmpeg_path");
                      if (p) setFfmpegPath(p);
                    } catch { /* not in Tauri, or cancelled */ }
                  }}
                  style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  Parcourir…
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4, lineHeight: 1.4 }}>
                Permet de lire les vidéos dont le codec n'est pas géré nativement (transcodage en WebM). Laisse vide pour la détection auto / le ffmpeg du PATH.
              </div>
              {ffmpegDetected !== undefined && (<>
                <div style={{ fontSize: 11, marginTop: 4, color: ffmpegDetected ? 'var(--color-green)' : 'var(--color-error)', wordBreak: 'break-all' }}>
                  {ffmpegDetected ? `✓ ffmpeg détecté : ${ffmpegDetected}` : "✗ ffmpeg introuvable — renseigne le chemin ci-dessus ou installe-le ci-dessous"}
                </div>
              {!ffmpegDetected && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={typeof ffmpegInstall === "number"}
                    onClick={async () => {
                      setFfmpegInstall(0);
                      try {
                        const { installFfmpeg } = await import("../../services/ffmpegInstall");
                        await installFfmpeg((pct) => setFfmpegInstall(pct));
                        setFfmpegInstall(null);
                        redetectFfmpeg();
                      } catch (err) {
                        setFfmpegInstall(`Échec : ${String(err)}`);
                      }
                    }}
                    style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: typeof ffmpegInstall === "number" ? 'default' : 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-primary)', color: 'var(--color-on-primary)', opacity: typeof ffmpegInstall === "number" ? 0.6 : 1 }}
                  >
                    {typeof ffmpegInstall === "number" ? `Installation… ${ffmpegInstall}%` : "Installer ffmpeg automatiquement (~80 Mo)"}
                  </button>
                  {typeof ffmpegInstall === "string" && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-error)' }}>{ffmpegInstall}</div>
                  )}
                </div>
              )}
              </>)}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--color-on-surface)', marginBottom: 4 }}>{t("tts.settings.title")}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={ttsEnginePath}
                  onChange={(e) => setTtsEnginePath(e.target.value)}
                  placeholder="ex : /home/moi/audio.cpp/build/bin/audiocpp_cli"
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-outline)', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={async () => { const p = await pickTtsEnginePath(); if (p) setTtsEnginePath(p); }}
                  style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', whiteSpace: 'nowrap', flexShrink: 0 }}
                >{t("tts.settings.browse")}</button>
              </div>
              {ttsEngineDetected !== undefined && (
                <div style={{ fontSize: 11, marginTop: 4, color: ttsEngineDetected ? 'var(--color-green)' : 'var(--color-error)', wordBreak: 'break-all' }}>
                  {ttsEngineDetected ? `✓ ${t("tts.settings.found")} : ${ttsEngineDetected}` : `✗ ${t("tts.settings.notFound")}`}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4, lineHeight: 1.4 }}>{t("tts.settings.hint")}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {ttsModels.map((m) => (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-on-surface)' }}>
                    <span style={{ flex: 1 }}>
                      {TTS_MODEL_LABELS[m.id] || m.id}
                      <span style={{ color: 'var(--color-outline)' }}> — {(m.sizeMb / 1000).toFixed(1)} Go</span>
                    </span>
                    {m.installed ? (
                      <button
                        type="button"
                        onClick={async () => { await deleteTtsModel(m.id); refreshTts(); }}
                        style={{ padding: '4px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)' }}
                      >{t("tts.settings.delete")}</button>
                    ) : (
                      <button
                        type="button"
                        disabled={ttsBusy !== null}
                        onClick={async () => {
                          setTtsBusy(m.id); setTtsPct(0);
                          try { await installTtsModel(m.id, setTtsPct); refreshTts(); }
                          finally { setTtsBusy(null); setTtsPct(null); }
                        }}
                        style={{ padding: '4px 10px', borderRadius: 8, border: 'none', cursor: ttsBusy ? 'default' : 'pointer', fontSize: 12, fontFamily: 'inherit', background: 'var(--color-primary)', color: 'var(--color-on-primary)', opacity: ttsBusy ? 0.6 : 1 }}
                      >{ttsBusy === m.id ? `${ttsPct ?? 0} %` : t("tts.settings.install", { size: (m.sizeMb / 1000).toFixed(1) })}</button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--color-on-surface)', marginBottom: 4 }}>Chemin yt-dlp (optionnel)</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={ytdlpPath}
                  onChange={(e) => setYtdlpPath(e.target.value)}
                  placeholder={"ex : C:\\Tools\\yt-dlp.exe"}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-outline)', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      const p = await invoke<string | null>("pick_ytdlp_path");
                      if (p) setYtdlpPath(p);
                    } catch { /* not in Tauri, or cancelled */ }
                  }}
                  style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  Parcourir…
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4, lineHeight: 1.4 }}>
                Permet d'importer des sons (soundboard et sons de canal) depuis un lien YouTube ou autre. Laisse vide pour la détection auto / le yt-dlp du PATH.
              </div>
              {ytdlpDetected !== undefined && (() => {
                const cur = ytdlpVer?.current || null;
                const latest = ytdlpVer?.latest || null;
                const upToDate = !!cur && !!latest && cur === latest;
                const updateAvail = !!cur && !!latest && cur !== latest;
                return (<>
                <div style={{ fontSize: 11, marginTop: 4, color: ytdlpDetected ? 'var(--color-green)' : 'var(--color-error)', wordBreak: 'break-all' }}>
                  {ytdlpDetected ? `✓ yt-dlp détecté : ${ytdlpDetected}` : "✗ yt-dlp introuvable — renseigne le chemin ci-dessus ou installe-le ci-dessous"}
                </div>
                {ytdlpDetected && (
                  <div style={{ fontSize: 11, marginTop: 2, color: updateAvail ? 'var(--color-orange)' : 'var(--color-outline)' }}>
                    {cur ? `Version ${cur}` : "Version inconnue"}
                    {latest && (upToDate ? " — à jour" : updateAvail ? ` — ${latest} disponible` : "")}
                    {!latest && cur && " — dernière version indisponible (hors-ligne ?)"}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={typeof ytdlpInstall === "number" || upToDate}
                    onClick={async () => {
                      setYtdlpInstall(0);
                      try {
                        const { installYtdlp } = await import("../../services/ytdlpInstall");
                        await installYtdlp((pct) => setYtdlpInstall(pct));
                        setYtdlpInstall(null);
                        redetectYtdlp();
                      } catch (err) {
                        setYtdlpInstall(`Échec : ${String(err)}`);
                      }
                    }}
                    style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: (typeof ytdlpInstall === "number" || upToDate) ? 'default' : 'pointer', fontSize: 13, fontFamily: 'inherit', background: updateAvail ? 'var(--color-primary)' : 'var(--color-surface-container-high)', color: updateAvail ? 'var(--color-on-primary)' : 'var(--color-on-surface)', opacity: (typeof ytdlpInstall === "number" || upToDate) ? 0.6 : 1 }}
                  >
                    {typeof ytdlpInstall === "number"
                      ? `Installation… ${ytdlpInstall}%`
                      : !ytdlpDetected
                        ? "Installer yt-dlp automatiquement (~30 Mo)"
                        : upToDate
                          ? "yt-dlp à jour"
                          : updateAvail
                            ? `Mettre à jour (${latest})`
                            : "Mettre à jour yt-dlp"}
                  </button>
                  {typeof ytdlpInstall === "string" && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-error)' }}>{ytdlpInstall}</div>
                  )}
                </div>
                </>);
              })()}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--color-on-surface)', marginBottom: 4 }}>IA de résumé (llama.cpp)</div>
              {(() => {
                const cur = llamaVer?.current || null;
                const latest = llamaVer?.latest || null;
                const upToDate = !!cur && !!latest && cur === latest;
                const updateAvail = !!cur && !!latest && cur !== latest;
                const installing = typeof llamaInstall === "number";
                return (<>
                <div style={{ fontSize: 11, color: cur ? 'var(--color-green)' : 'var(--color-outline)' }}>
                  {cur
                    ? `✓ llama.cpp installé (build ${llamaVer?.vulkan ? "GPU Vulkan" : "CPU"})`
                    : "llama.cpp non installé — il sera téléchargé au premier résumé de réunion"}
                </div>
                {cur && (
                  <div style={{ fontSize: 11, marginTop: 2, color: updateAvail ? 'var(--color-orange)' : 'var(--color-outline)' }}>
                    {`Version ${cur}`}
                    {latest ? (upToDate ? " — à jour" : ` — ${latest} disponible`) : " — dernière version indisponible (hors-ligne ?)"}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={installing || upToDate}
                    onClick={async () => {
                      setLlamaInstall(0);
                      try {
                        const { listen } = await import("@tauri-apps/api/event");
                        const { invoke } = await import("@tauri-apps/api/core");
                        const un = await listen<number>("llama-install-progress", (e) => setLlamaInstall(Number(e.payload)));
                        try {
                          await invoke("download_llama");
                        } finally { un(); }
                        setLlamaInstall(null);
                        redetectLlama();
                      } catch (err) {
                        setLlamaInstall(`Échec : ${String(err)}`);
                      }
                    }}
                    style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: (installing || upToDate) ? 'default' : 'pointer', fontSize: 13, fontFamily: 'inherit', background: updateAvail ? 'var(--color-primary)' : 'var(--color-surface-container-high)', color: updateAvail ? 'var(--color-on-primary)' : 'var(--color-on-surface)', opacity: (installing || upToDate) ? 0.6 : 1 }}
                  >
                    {installing
                      ? `Installation… ${llamaInstall}%`
                      : !cur
                        ? "Installer llama.cpp maintenant (~50 Mo)"
                        : upToDate
                          ? "llama.cpp à jour"
                          : updateAvail
                            ? `Mettre à jour (${latest})`
                            : "Réinstaller llama.cpp"}
                  </button>
                  {typeof llamaInstall === "string" && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-error)' }}>{llamaInstall}</div>
                  )}
                </div>
                </>);
              })()}
            </div>

            <button
              onClick={() => {
                if (window.confirm(t("settings.purgeCacheConfirm"))) {
                  const creds = localStorage.getItem("sion_auth_credentials");
                  const deviceId = localStorage.getItem("sion_device_id");
                  const userId = localStorage.getItem("sion_user_id");
                  localStorage.clear();
                  if (creds) localStorage.setItem("sion_auth_credentials", creds);
                  if (deviceId) localStorage.setItem("sion_device_id", deviceId);
                  if (userId) localStorage.setItem("sion_user_id", userId);
                  indexedDB.databases().then((dbs) => {
                    for (const db of dbs) {
                      if (!db.name) continue;
                      // NEVER wipe the E2EE crypto store here: this purge keeps the
                      // same device_id, so deleting the crypto store would make Rust
                      // crypto regenerate fresh identity keys under that same id —
                      // un-verifying the device, dropping every received room key, and
                      // breaking decryption for us AND everyone who cached our old
                      // keys. Only the regenerable sync/app caches get cleared.
                      // (Resetting crypto is done separately, on device mismatch /
                      // logout, via clearCryptoStores().)
                      if (db.name.includes("crypto") || db.name.includes("rust-sdk")) continue;
                      indexedDB.deleteDatabase(db.name);
                    }
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
            <div style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: 'var(--color-outline)' }}>
              Sion Client v{__APP_VERSION__}
            </div>
          </div>
        )}
      </div>

      {cueEditor && (
        <VoiceCueEditor
          file={cueEditor.file}
          path={cueEditor.path}
          title={cueEditor.label}
          onSave={(c) => setVoiceSound(cueEditor.cue, c)}
          onClose={() => setCueEditor(null)}
        />
      )}

      {cueUrlImport && (
        <div
          onClick={() => setCueUrlImport(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-container-high)', borderRadius: 16, padding: 20, width: 460, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>{cueUrlImport.label}</div>
            <ExternalAudioImport
              onImported={async (file, title) => {
                try {
                  // Cues replay from a local path → persist the imported clip.
                  const { invoke } = await import("@tauri-apps/api/core");
                  const buf = await file.arrayBuffer();
                  let bin = "";
                  const u8 = new Uint8Array(buf);
                  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
                  const dataB64 = btoa(bin);
                  const ext = file.name.split(".").pop() || "webm";
                  const path = await invoke<string>("save_imported_audio", { dataB64, ext });
                  const persisted = new File([u8], file.name, { type: file.type });
                  setCueUrlImport(null);
                  setCueEditor({ cue: cueUrlImport.cue, file: persisted, path, label: title || cueUrlImport.label });
                } catch (err) {
                  console.warn("[Sion] cue url import failed:", err);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Model picker with per-model download state IN the list (🟢 downloaded /
 *  ⚪ not yet — native <option> can't render real widgets, but emoji dots
 *  can), plus a manual download button for the selected model and the
 *  summary assets (llama-cli + LLM). Desktop only — the engines live in
 *  Rust; on web the parent still renders the plain select via the fallback
 *  below so the setting stays editable. */
function TranscribeModelPicker({ selectStyle }: { selectStyle: React.CSSProperties }) {
  const { t } = useTranslation();
  const transcribeModel = useSettingsStore((s) => s.transcribeModel);
  const setTranscribeModel = useSettingsStore((s) => s.setTranscribeModel);
  const transcribeLang = useSettingsStore((s) => s.transcribeLang);
  const setTranscribeLang = useSettingsStore((s) => s.setTranscribeLang);
  const asrPct = useTranscriptStore((s) => s.downloadPct);
  const summaryState = useTranscriptStore((s) => s.summaryState);
  const summaryPct = useTranscriptStore((s) => s.summaryPct);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [summaryReady, setSummaryReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"asr" | "summary" | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTauri = typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";

  const MODELS: { key: "whisper-base" | "whisper-small" | "whisper-medium" | "parakeet-v3"; label: string }[] = [
    { key: "whisper-base", label: t("settings.transcribeModelBase") },
    { key: "whisper-small", label: t("settings.transcribeModelSmall") },
    { key: "whisper-medium", label: t("settings.transcribeModelMedium") },
    { key: "parakeet-v3", label: t("settings.transcribeModelParakeet") },
  ];
  // Legacy persisted values ("small"…) from the whisper-rs era map onto
  // their whisper-* equivalents so the select never shows an empty value.
  const selected = transcribeModel.startsWith("whisper") || transcribeModel === "parakeet-v3"
    ? transcribeModel : `whisper-${transcribeModel}`;

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    Promise.all(MODELS.map(async (m) => [m.key, await isModelDownloaded(m.key)] as const)).then((pairs) => {
      if (!cancelled) setStatus(Object.fromEntries(pairs));
    });
    summaryAssetsStatus().then((s) => { if (!cancelled) setSummaryReady(s.llama && s.model); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isTauri]);

  const dlBtnStyle: React.CSSProperties = {
    border: '1px solid var(--color-outline-variant)', borderRadius: 8,
    background: 'transparent', color: 'var(--color-primary)',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
    padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  };

  const asrDownloading = busy === "asr" || (asrPct != null && asrPct < 100);
  const summaryDownloading = busy === "summary" || summaryState === "downloading";

  const HINTS: Record<string, string> = {
    "whisper-base": t("settings.transcribeModelBaseHint"),
    "whisper-small": t("settings.transcribeModelSmallHint"),
    "whisper-medium": t("settings.transcribeModelMediumHint"),
    "parakeet-v3": t("settings.transcribeModelParakeetHint"),
  };

  /** One asset line: status on the left, the single relevant action on the
   *  right — download when absent, delete when present. */
  const assetRow = (
    ready: boolean | null | undefined,
    downloading: boolean,
    pct: number | null,
    onDownload: () => void,
    onDelete: () => void,
  ) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, minHeight: 26 }}>
      <span style={{ fontSize: 11, color: ready ? 'var(--color-green)' : 'var(--color-on-surface-variant)' }}>
        {ready == null ? "…" : ready ? `✓ ${t("settings.assetDownloaded")}` : t("settings.assetMissing")}
      </span>
      {ready === false && (
        <button
          style={{ ...dlBtnStyle, cursor: downloading ? 'wait' : 'pointer' }}
          disabled={downloading}
          onClick={onDownload}
        >
          {downloading ? `${pct ?? 0}%` : t("settings.assetDownload")}
        </button>
      )}
      {ready === true && (
        <button
          style={{ ...dlBtnStyle, color: 'var(--color-error)' }}
          title={t("settings.assetDeleteHint")}
          onClick={onDelete}
        >
          {t("settings.assetDelete")}
        </button>
      )}
    </div>
  );

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 4 }}>{t("settings.transcribeModel")}</div>
      <select
        value={selected}
        onChange={(e) => setTranscribeModel(e.target.value as "whisper-base" | "whisper-small" | "whisper-medium" | "parakeet-v3")}
        style={selectStyle}
      >
        {MODELS.map((m) => (
          <option key={m.key} value={m.key}>{m.label}</option>
        ))}
      </select>
      {HINTS[selected] && (
        <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4 }}>{HINTS[selected]}</div>
      )}
      {isTauri && assetRow(
        status[selected],
        asrDownloading,
        asrPct,
        () => {
          setBusy("asr");
          ensureModelDownloaded(selected)
            .catch((e) => console.error("[Sion] ASR download failed:", e))
            .finally(() => setBusy(null));
        },
        () => {
          setBusy("asr");
          deleteAsrModel(selected)
            .catch((e) => console.error("[Sion] ASR delete failed:", e))
            .finally(() => setBusy(null));
        },
      )}
      {/* Spoken language — Whisper only: Parakeet auto-detects among its 25
          languages and takes no language option, so hide the select there. */}
      {selected.startsWith("whisper") && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 4 }}>{t("settings.transcribeLang")}</div>
          <select value={transcribeLang} onChange={(e) => setTranscribeLang(e.target.value as "auto" | "fr" | "en")} style={selectStyle}>
            <option value="auto">{t("settings.transcribeLangAuto")}</option>
            <option value="fr">{t("settings.languageFr")}</option>
            <option value="en">{t("settings.languageEn")}</option>
          </select>
        </div>
      )}
      {isTauri && (
        <div style={{ borderTop: '1px solid var(--color-outline-variant)', marginTop: 10, paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("settings.assetSummary")}</div>
          <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>{t("settings.assetSummaryHint")}</div>
          {assetRow(
            summaryReady,
            summaryDownloading,
            summaryPct,
            () => {
              setBusy("summary");
              ensureSummaryAssets()
                .catch((e) => console.error("[Sion] summary assets download failed:", e))
                .finally(() => {
                  useTranscriptStore.getState().setSummaryState("idle");
                  setBusy(null);
                });
            },
            () => {
              setBusy("summary");
              deleteSummaryAssets()
                .catch((e) => console.error("[Sion] summary delete failed:", e))
                .finally(() => setBusy(null));
            },
          )}
        </div>
      )}
    </div>
  );
}
