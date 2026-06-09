import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChannelSortMode = "created" | "name" | "activity";
export type SidebarView = "channels" | "dm";
export type AudioQualityPreset = "voice" | "voiceHD" | "musicStereo";
export type NotificationMode = "all" | "mentions" | "minimal";

/** A custom voice-channel cue sound: a picked file, trimmed to [start,end]
 *  seconds, played at `gain` (Web Audio). null = use the bundled default. */
export interface VoiceSoundCfg {
  path: string;
  start: number;
  end: number;
  gain: number;
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
  /** RNNoise-based noise suppression (Jean-Marc Valin's model, via
   *  `nnnoiseless`). Runs on the Rust side in place of Chromium's native
   *  noise filter — keeping both enabled would double-filter voice.
   *  Lightweight (~5% of a core). */
  aiNoiseSuppression: boolean;
  /** Dry/wet mix for RNNoise (0.0 = full passthrough, 1.0 = full denoise).
   *  RNNoise is causal (0 lookahead) so any mix value is artifact-free — the
   *  slider is a genuine intensity knob. */
  aiNoiseSuppressionMix: number;
  audioQuality: AudioQualityPreset;
  linkPreviews: boolean;
  audioInputDevice: string;
  audioOutputDevice: string;
  /** Optional path to an ffmpeg executable, used to transcode videos whose
   *  codec CEF can't play natively (e.g. H.264 on the minimal CEF build,
   *  notably Windows). Empty = use `ffmpeg` from PATH. */
  ffmpegPath: string;
  defaultChannel: string;
  autoJoinVoice: boolean;
  enableGifs: boolean;
  language: string;
  soundboardEnabled: boolean;
  soundboardVolume: number;
  /** Play short join/leave/timeout cues when a member enters or leaves the
   *  voice channel the local user is currently in (TeamSpeak-style). */
  voiceChannelSounds: boolean;
  /** Optional custom sound (trimmed + gain) overriding the bundled default for
   *  each cue. null = use the bundled default. */
  voiceSoundJoin: VoiceSoundCfg | null;
  voiceSoundLeave: VoiceSoundCfg | null;
  voiceSoundTimeout: VoiceSoundCfg | null;
  /** Remember whether the soundboard panel was open when the app was last
   *  closed, so we can reopen it automatically on relaunch. Written
   *  whenever `useAppStore.toggleSoundboardPanel` fires; read at startup
   *  in App.tsx. */
  soundboardOpenAtLaunch: boolean;
  /** Soundboard category paths the local user has hidden from their view.
   *  A hidden category keeps its entry in the left tree (with a striked-
   *  through look) but removes all its sounds from the grid. Purely local
   *  / cosmetic — doesn't affect other users or the server. Store paths
   *  like "Films/Kamelott", so hiding a parent also hides its children. */
  hiddenCategories: string[];
  screenShareAudio: boolean;
  /** Transparent click-through overlay on the sharer's real screen that
   *  shows viewers' cursors. Off by default — it creates an extra Tauri
   *  window and gets captured back in the stream. Can be toggled mid-share. */
  screenShareCursorOverlay: boolean;
  screenShareResolution: "720p" | "1080p" | "1440p";
  screenShareFramerate: 5 | 15 | 30 | 60;

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
  setAudioOutputDevice: (v: string) => void;
  setDefaultChannel: (v: string) => void;
  setAutoJoinVoice: (v: boolean) => void;
  setEnableGifs: (v: boolean) => void;
  setSoundboardEnabled: (v: boolean) => void;
  setSoundboardVolume: (v: number) => void;
  setVoiceChannelSounds: (v: boolean) => void;
  setVoiceSound: (cue: "join" | "leave" | "timeout", cfg: VoiceSoundCfg | null) => void;
  setSoundboardOpenAtLaunch: (v: boolean) => void;
  toggleCategoryHidden: (categoryPath: string) => void;
  clearHiddenCategories: () => void;
  setScreenShareAudio: (v: boolean) => void;
  setScreenShareCursorOverlay: (v: boolean) => void;
  setScreenShareResolution: (v: "720p" | "1080p" | "1440p") => void;
  setScreenShareFramerate: (v: 5 | 15 | 30 | 60) => void;
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
      audioInputDevice: "",
      ffmpegPath: "",
      audioOutputDevice: "",
      defaultChannel: "",
      autoJoinVoice: false,
      enableGifs: false,
      language: "",
      soundboardEnabled: true,
      soundboardVolume: 0.2,
      voiceChannelSounds: true,
      voiceSoundJoin: null,
      voiceSoundLeave: null,
      voiceSoundTimeout: null,
      soundboardOpenAtLaunch: false,
      hiddenCategories: [],
      screenShareAudio: true,
      screenShareCursorOverlay: false,
      screenShareResolution: "1080p" as const,
      screenShareFramerate: 15 as const,
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
        // Re-capture the mic so the denoise shim (re)wraps the track.
        import("../services/livekitService").then(({ refreshMicrophoneForDenoise }) => refreshMicrophoneForDenoise()).catch(() => {});
        if (!v) {
          import("../services/denoiseService").then(({ disableDenoise }) => disableDenoise()).catch(() => {});
        }
      },
      setAiNoiseSuppressionMix: (v) => {
        const clamped = Math.max(0, Math.min(1, v));
        set({ aiNoiseSuppressionMix: clamped });
        // Live wet/dry update on the active RNNoise worklet — no mic republish.
        import("../services/denoiseService").then(({ setDenoiseMix }) => setDenoiseMix(clamped)).catch(() => {});
      },
      setAudioQuality: (v) => set({ audioQuality: v }),
      setLinkPreviews: (v) => set({ linkPreviews: v }),
      setAudioInputDevice: (v) => set({ audioInputDevice: v }),
      setFfmpegPath: (v) => set({ ffmpegPath: v.trim() }),
      setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
      setDefaultChannel: (v) => set({ defaultChannel: v }),
      setAutoJoinVoice: (v) => set({ autoJoinVoice: v }),
      setEnableGifs: (v) => set({ enableGifs: v }),
      setVoiceChannelSounds: (v) => set({ voiceChannelSounds: v }),
      setVoiceSound: (cue, cfg) => set(
        cue === "join" ? { voiceSoundJoin: cfg }
          : cue === "leave" ? { voiceSoundLeave: cfg }
          : { voiceSoundTimeout: cfg },
      ),
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
      setScreenShareAudio: (v) => set({ screenShareAudio: v }),
      setScreenShareCursorOverlay: (v) => {
        set({ screenShareCursorOverlay: v });
        // Toggle live if a share is already in progress so the user doesn't
        // have to stop/restart the share to see the change.
        import("../services/livekitService").then(({ getCurrentRoom }) => {
          const room = getCurrentRoom();
          if (!room?.localParticipant.isScreenShareEnabled) return;
          import("../services/cursorOverlayService").then((svc) => {
            if (v) svc.openCursorOverlay().catch(() => {});
            else svc.closeCursorOverlay().catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      },
      setScreenShareResolution: (v) => set({ screenShareResolution: v }),
      setScreenShareFramerate: (v) => set({ screenShareFramerate: v }),
      setLanguage: (v) => {
        set({ language: v });
        import("i18next").then((i18n) => i18n.default.changeLanguage(v));
      },
      setNotificationMode: (v) => {
        set({ notificationMode: v });
        import("../services/androidVoiceService").then(({ setNotificationMode: syncMode }) => syncMode(v)).catch(() => {});
        import("../services/pushService").then(({ syncPushRules }) => syncPushRules(v)).catch(() => {});
      },
    }),
    { name: "sion-settings" },
  ),
);
