import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChannelSortMode = "created" | "name" | "activity";
export type SidebarView = "channels" | "dm";
export type AudioQualityPreset = "voice" | "voiceHD" | "musicStereo";
/** Codec de la piste de partage d'écran (`screenshare_publish_options`).
 *  `auto` = meilleur codec décodable par tous, matériel d'abord. */
export type ShareVideoCodec = "auto" | "av1" | "vp9" | "h264" | "vp8";
export type NotificationMode = "all" | "mentions" | "minimal";

// join/leave/timeout are gated by the `voiceChannelSounds` toggle; poke/kick/
// memberKicked are user-event notifications that always play; mute/unmute/
// deafen/undeafen are local action-feedback (always play, never silenced by
// deafen). All are customizable.
export type VoiceCue =
  | "join" | "leave" | "timeout"
  | "poke" | "kick" | "memberKicked"
  | "mute" | "unmute" | "deafen" | "undeafen";

/** A custom voice-channel cue sound: a picked file, trimmed to [start,end]
 *  seconds, played at `gain` (Web Audio). null = use the bundled default. */
export interface VoiceSoundCfg {
  path: string;
  start: number;
  end: number;
  gain: number;
}

const EMPTY_VOICE_SOUNDS: Record<VoiceCue, VoiceSoundCfg | null> = {
  join: null,
  leave: null,
  timeout: null,
  poke: null,
  kick: null,
  memberKicked: null,
  mute: null,
  unmute: null,
  deafen: null,
  undeafen: null,
};

/** Migration du snapshot Zustand historique (version implicite 0).
 *
 * `persist` fusionne l'état seulement au premier niveau : lorsqu'un nouveau
 * son est ajouté, un ancien objet `voiceSounds` écraserait donc entièrement
 * les valeurs par défaut. La migration conserve toutes les préférences
 * connues et complète les cues absents, sans toucher aux chemins personnalisés
 * encore valides sur disque. */
export function migrateSettingsState(persistedState: unknown): Partial<SettingsState> {
  if (!persistedState || typeof persistedState !== "object" || Array.isArray(persistedState)) {
    return {};
  }
  const state = persistedState as Partial<SettingsState>;
  const voiceSounds = state.voiceSounds && typeof state.voiceSounds === "object"
    ? state.voiceSounds
    : {};
  return {
    ...state,
    voiceSounds: { ...EMPTY_VOICE_SOUNDS, ...voiceSounds },
  };
}

interface SettingsState {
  mutedSpeakAlert: boolean;
  joinMuted: boolean;
  micThreshold: number;
  muteShortcut: string;
  deafenShortcut: string;
  notifyDM: boolean;
  notificationMode: NotificationMode;
  channelSort: ChannelSortMode;
  sidebarView: SidebarView;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** RNNoise Rust (port `nnnoiseless`) dans l'APM de capture WebRTC natif.
   *  Remplace le filtre de bruit de Chromium, qui n'est plus utilisé pour la
   *  voix. */
  aiNoiseSuppression: boolean;
  /** Dry/wet mix for RNNoise (0.0 = full passthrough, 1.0 = full denoise).
   *  RNNoise is causal (0 lookahead) so any mix value is artifact-free — the
   *  slider is a genuine intensity knob. */
  aiNoiseSuppressionMix: number;
  audioQuality: AudioQualityPreset;
  linkPreviews: boolean;
  nativeAudioInputDevice: string;
  nativeAudioOutputDevice: string;
  setNativeAudioInputDevice: (id: string) => void;
  setNativeAudioOutputDevice: (id: string) => void;
  audioInputDevice: string;
  audioOutputDevice: string;
  /** Optional path to an ffmpeg executable, used to transcode videos whose
   *  codec n'est pas décodé par la webview (dépend des codecs système,
   *  notamment sous Linux/WebKitGTK). Empty = use `ffmpeg` from PATH. */
  ffmpegPath: string;
  /** Absolute path to a yt-dlp binary for importing audio from external-media
   *  URLs (soundboard + voice cues). Empty = app-managed download / PATH. */
  ytdlpPath: string;
  /** Absolute path to an `audiocpp_cli` binary for generated voices. Upstream
   *  only ships Windows releases, so Linux/macOS users point at their own
   *  build. Empty = app-managed download (Windows only). */
  ttsEnginePath: string;
  /** Selected TTS model id (see the Rust catalogue in tts.rs). */
  ttsModel: string;
  defaultChannel: string;
  autoJoinVoice: boolean;
  enableGifs: boolean;
  language: string;
  soundboardEnabled: boolean;
  soundboardVolume: number;
  /** Play short join/leave/timeout cues when a member enters or leaves the
   *  voice channel the local user is currently in (TeamSpeak-style). */
  voiceChannelSounds: boolean;
  /** When true, all voice/event cues (join/leave/timeout/poke/kick/…) are
   *  silenced while the local user is deafened. Off by default: most users
   *  like still hearing who joins even while deafened. */
  muteSoundsWhenDeafened: boolean;
  /** Optional custom sound (trimmed + gain) per cue, overriding the bundled
   *  default. null = use the bundled default. */
  voiceSounds: Record<VoiceCue, VoiceSoundCfg | null>;
  /** Remember whether the soundboard panel was open when the app was last
   *  closed, so we can reopen it automatically on relaunch. Written by the
   *  dock store (`useLayoutStore`) whenever the soundboard panel opens or
   *  closes; read at startup in App.tsx. */
  soundboardOpenAtLaunch: boolean;
  /** Soundboard category paths the local user has hidden from their view.
   *  A hidden category keeps its entry in the left tree (with a striked-
   *  through look) but removes all its sounds from the grid. Purely local
   *  / cosmetic — doesn't affect other users or the server. Store paths
   *  like "Films/Kamelott", so hiding a parent also hides its children. */
  hiddenCategories: string[];
  /** Favorited soundboard sounds, by Matrix eventId. */
  soundboardFavorites: string[];
  /** Play count per soundboard sound (eventId → times played), for the "Top". */
  soundboardPlayCounts: Record<string, number>;
  /** Last active soundboard view (filter + category), restored on reopen. */
  soundboardView: { mode: "all" | "favorites" | "top"; category: string | null };
  screenShareAudio: boolean;
  /** Transparent click-through overlay on the sharer's real screen that
   *  shows viewers' cursors. Off by default — it creates an extra Tauri
   *  window and gets captured back in the stream. Can be toggled mid-share. */
  screenShareCursorOverlay: boolean;
  /** Auto garde la définition native jusqu'à 1440p/30 et laisse WebRTC
   *  adapter le débit. Custom applique les deux plafonds choisis dessous. */
  screenShareQualityMode: "auto" | "custom";
  screenShareResolution: "720p" | "1080p" | "1440p";
  screenShareFramerate: 5 | 15 | 30 | 60;
  /** Codec de la piste de partage publiée. `auto` (défaut) prend le meilleur
   *  codec décodable par tous les participants présents, **le matériel
   *  d'abord** ; sinon `av1`/`h264` = encodage matériel VAAPI (CPU quasi nul),
   *  `vp9`/`vp8` = logiciel (plus de CPU, compatibilité maximale pour vp8). */
  screenShareCodec: ShareVideoCodec;
  /** Windows only: which desktop source to capture (e.g. "screen:0:0").
   *  Le sélecteur natif Windows est utilisé directement,
   *  so we pick a single monitor ourselves via the legacy getUserMedia desktop
   *  constraint. null = primary screen (screen:0:0). Unused on Linux (xdg
   *  portal), macOS (native picker) and web (getDisplayMedia). */
  screenShareSourceId: string | null;
  /** ASR model for the local meeting transcription (GGUF via transcribe.cpp,
   *  downloaded on first use): whisper-base ≈64 MB (weak CPUs), whisper-small
   *  ≈194 MB, whisper-medium ≈583 MB (best whisper quality),
   *  parakeet-v3 ≈549 MB (default — 25 EU languages, much faster, excellent French). Legacy
   *  values "base"/"small"/"medium" may persist from the whisper-rs era —
   *  the Rust catalog still accepts them. */
  transcribeModel: "whisper-base" | "whisper-small" | "whisper-medium" | "parakeet-v3";
  /** Spoken language hint ("auto" = detect). Only whisper uses it — parakeet
   *  is inherently multilingual. Pinning the right language avoids whisper
   *  misdetections on short utterances. */
  transcribeLang: "auto" | "fr" | "en";

  setMutedSpeakAlert: (v: boolean) => void;
  setJoinMuted: (v: boolean) => void;
  setMicThreshold: (v: number) => void;
  setMuteShortcut: (key: string) => void;
  setDeafenShortcut: (key: string) => void;
  setNotifyDM: (v: boolean) => void;
  setChannelSort: (sort: ChannelSortMode) => void;
  setSidebarView: (view: SidebarView) => void;
  setEchoCancellation: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;
  setAiNoiseSuppression: (v: boolean) => void;
  setAiNoiseSuppressionMix: (v: number) => void;
  setAudioQuality: (v: AudioQualityPreset) => void;
  setLinkPreviews: (v: boolean) => void;
  setAudioInputDevice: (v: string) => void;
  setFfmpegPath: (v: string) => void;
  setYtdlpPath: (v: string) => void;
  setTtsEnginePath: (v: string) => void;
  setTtsModel: (v: string) => void;
  setAudioOutputDevice: (v: string) => void;
  setDefaultChannel: (v: string) => void;
  setAutoJoinVoice: (v: boolean) => void;
  setEnableGifs: (v: boolean) => void;
  setSoundboardEnabled: (v: boolean) => void;
  setSoundboardVolume: (v: number) => void;
  setVoiceChannelSounds: (v: boolean) => void;
  setMuteSoundsWhenDeafened: (v: boolean) => void;
  setVoiceSound: (cue: VoiceCue, cfg: VoiceSoundCfg | null) => void;
  setSoundboardOpenAtLaunch: (v: boolean) => void;
  toggleCategoryHidden: (categoryPath: string) => void;
  clearHiddenCategories: () => void;
  toggleSoundboardFavorite: (eventId: string) => void;
  incrementSoundboardPlay: (eventId: string) => void;
  setSoundboardView: (v: { mode: "all" | "favorites" | "top"; category: string | null }) => void;
  setScreenShareAudio: (v: boolean) => void;
  setScreenShareCursorOverlay: (v: boolean) => void;
  setScreenShareQualityMode: (v: "auto" | "custom") => void;
  setScreenShareResolution: (v: "720p" | "1080p" | "1440p") => void;
  setScreenShareFramerate: (v: 5 | 15 | 30 | 60) => void;
  setScreenShareCodec: (v: ShareVideoCodec) => void;
  setScreenShareSourceId: (v: string | null) => void;
  setTranscribeModel: (v: "whisper-base" | "whisper-small" | "whisper-medium" | "parakeet-v3") => void;
  setTranscribeLang: (v: "auto" | "fr" | "en") => void;
  setNotificationMode: (v: NotificationMode) => void;
  setLanguage: (v: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      mutedSpeakAlert: true,
      joinMuted: false,
      micThreshold: 0.015,
      muteShortcut: "",
      deafenShortcut: "",
      notifyDM: true,
      channelSort: "created",
      sidebarView: "channels",
      echoCancellation: true,
      autoGainControl: true,
      aiNoiseSuppression: true,
      aiNoiseSuppressionMix: 1.0,
      audioQuality: "voiceHD",
      linkPreviews: true,
      nativeAudioInputDevice: "",
      nativeAudioOutputDevice: "",
      setNativeAudioInputDevice: (id) => set({ nativeAudioInputDevice: id }),
      setNativeAudioOutputDevice: (id) => set({ nativeAudioOutputDevice: id }),
      audioInputDevice: "",
      ffmpegPath: "",
      ytdlpPath: "",
      ttsEnginePath: "",
      ttsModel: "chatterbox",
      audioOutputDevice: "",
      defaultChannel: "",
      autoJoinVoice: false,
      enableGifs: false,
      language: "",
      soundboardEnabled: true,
      soundboardVolume: 0.2,
      voiceChannelSounds: true,
      muteSoundsWhenDeafened: false,
      voiceSounds: { ...EMPTY_VOICE_SOUNDS },
      soundboardOpenAtLaunch: false,
      hiddenCategories: [],
      soundboardFavorites: [],
      soundboardPlayCounts: {},
      soundboardView: { mode: "all", category: null },
      screenShareAudio: true,
      screenShareCursorOverlay: false,
      screenShareQualityMode: "auto" as const,
      screenShareResolution: "1080p" as const,
      screenShareFramerate: 15 as const,
      screenShareCodec: "auto" as const,
      screenShareSourceId: null,
      transcribeModel: "parakeet-v3",
      transcribeLang: "auto",
      notificationMode: "mentions" as NotificationMode,

      setMutedSpeakAlert: (v) => set({ mutedSpeakAlert: v }),
      setJoinMuted: (v) => set({ joinMuted: v }),
      setMicThreshold: (v) => set({ micThreshold: v }),
      setMuteShortcut: (key) => set({ muteShortcut: key }),
      setDeafenShortcut: (key) => set({ deafenShortcut: key }),
      setNotifyDM: (v) => set({ notifyDM: v }),
      setChannelSort: (sort) => set({ channelSort: sort }),
      setSidebarView: (view) => set({ sidebarView: view }),
      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),
      setAiNoiseSuppression: (v) => {
        set({ aiNoiseSuppression: v });
      },
      setAiNoiseSuppressionMix: (v) => {
        // Live wet/dry update : la valeur est poussée au moteur natif par
        // NativeAudioSettings (`setVoiceNativeAudioProcessing`).
        set({ aiNoiseSuppressionMix: Math.max(0, Math.min(1, v)) });
      },
      setAudioQuality: (v) => set({ audioQuality: v }),
      setLinkPreviews: (v) => set({ linkPreviews: v }),
      setAudioInputDevice: (v) => set({ audioInputDevice: v }),
      setFfmpegPath: (v) => set({ ffmpegPath: v.trim() }),
      setYtdlpPath: (v) => set({ ytdlpPath: v.trim() }),
      setTtsEnginePath: (v) => set({ ttsEnginePath: v.trim() }),
      setTtsModel: (v) => set({ ttsModel: v }),
      setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
      setDefaultChannel: (v) => set({ defaultChannel: v }),
      setAutoJoinVoice: (v) => set({ autoJoinVoice: v }),
      setEnableGifs: (v) => set({ enableGifs: v }),
      setVoiceChannelSounds: (v) => set({ voiceChannelSounds: v }),
      setMuteSoundsWhenDeafened: (v) => set({ muteSoundsWhenDeafened: v }),
      setVoiceSound: (cue, cfg) => set((s) => ({ voiceSounds: { ...s.voiceSounds, [cue]: cfg } })),
      setSoundboardEnabled: (v) => set({ soundboardEnabled: v }),
      setSoundboardVolume: (v) => {
        set({ soundboardVolume: v });
        import("../services/soundboardService").then(({ setPlaybackVolume }) => setPlaybackVolume(v));
      },
      setSoundboardOpenAtLaunch: (v) => set({ soundboardOpenAtLaunch: v }),
      toggleCategoryHidden: (path) => set((s) => {
        const next = s.hiddenCategories.includes(path)
          ? s.hiddenCategories.filter((p) => p !== path)
          : [...s.hiddenCategories, path];
        return { hiddenCategories: next };
      }),
      clearHiddenCategories: () => set({ hiddenCategories: [] }),
      toggleSoundboardFavorite: (eventId) => set((s) => ({
        soundboardFavorites: s.soundboardFavorites.includes(eventId)
          ? s.soundboardFavorites.filter((id) => id !== eventId)
          : [...s.soundboardFavorites, eventId],
      })),
      incrementSoundboardPlay: (eventId) => set((s) => ({
        soundboardPlayCounts: { ...s.soundboardPlayCounts, [eventId]: (s.soundboardPlayCounts[eventId] || 0) + 1 },
      })),
      setSoundboardView: (v) => set({ soundboardView: v }),
      setScreenShareAudio: (v) => set({ screenShareAudio: v }),
      setScreenShareCursorOverlay: (v) => {
        set({ screenShareCursorOverlay: v });
        // Toggle live if a share is already in progress so the user doesn't
        // have to stop/restart the share to see the change.
        import("./useAppStore").then(({ useAppStore }) => {
          if (!useAppStore.getState().isScreenSharing) return;
          import("../services/cursorOverlayService").then((svc) => {
            if (v) svc.openCursorOverlay().catch(() => {});
            else svc.closeCursorOverlay().catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      },
      setScreenShareQualityMode: (v) => set({ screenShareQualityMode: v }),
      setScreenShareResolution: (v) => set({ screenShareResolution: v }),
      setScreenShareFramerate: (v) => set({ screenShareFramerate: v }),
      setScreenShareCodec: (v) => set({ screenShareCodec: v }),
      setScreenShareSourceId: (v) => set({ screenShareSourceId: v }),
      setTranscribeModel: (v) => set({ transcribeModel: v }),
      setTranscribeLang: (v) => set({ transcribeLang: v }),
      setLanguage: (v) => {
        set({ language: v });
        // v vide = « Système » : on redétecte via le navigateur (le défaut de
        // l'app reste le français si la locale n'est pas reconnue).
        const target = v || navigator.language?.slice(0, 2) || "fr";
        import("i18next").then((i18n) => i18n.default.changeLanguage(target));
      },
      setNotificationMode: (v) => {
        set({ notificationMode: v });
        import("../services/androidVoiceService").then(({ setNotificationMode: syncMode }) => syncMode(v)).catch(() => {});
        import("../services/pushService").then(({ syncPushRules }) => syncPushRules(v)).catch(() => {});
      },
    }),
    {
      name: "sion-settings",
      version: 1,
      migrate: (persistedState) => migrateSettingsState(persistedState),
    },
  ),
);
