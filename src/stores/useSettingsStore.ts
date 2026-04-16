import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChannelSortMode = "created" | "name" | "activity";
export type SidebarView = "channels" | "dm";
export type AudioQualityPreset = "voice" | "voiceHD" | "musicStereo";
export type NotificationMode = "all" | "mentions" | "minimal";

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
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioQuality: AudioQualityPreset;
  linkPreviews: boolean;
  audioInputDevice: string;
  audioOutputDevice: string;
  defaultChannel: string;
  autoJoinVoice: boolean;
  enableGifs: boolean;
  language: string;
  soundboardEnabled: boolean;
  soundboardVolume: number;
  screenShareAudio: boolean;
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
  setNoiseSuppression: (v: boolean) => void;
  setEchoCancellation: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;
  setAudioQuality: (v: AudioQualityPreset) => void;
  setLinkPreviews: (v: boolean) => void;
  setAudioInputDevice: (v: string) => void;
  setAudioOutputDevice: (v: string) => void;
  setDefaultChannel: (v: string) => void;
  setAutoJoinVoice: (v: boolean) => void;
  setEnableGifs: (v: boolean) => void;
  setSoundboardEnabled: (v: boolean) => void;
  setSoundboardVolume: (v: number) => void;
  setScreenShareAudio: (v: boolean) => void;
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
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      audioQuality: "voiceHD",
      linkPreviews: true,
      audioInputDevice: "",
      audioOutputDevice: "",
      defaultChannel: "",
      autoJoinVoice: false,
      enableGifs: false,
      language: "",
      soundboardEnabled: true,
      soundboardVolume: 0.2,
      screenShareAudio: true,
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
      setNoiseSuppression: (v) => set({ noiseSuppression: v }),
      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),
      setAudioQuality: (v) => set({ audioQuality: v }),
      setLinkPreviews: (v) => set({ linkPreviews: v }),
      setAudioInputDevice: (v) => set({ audioInputDevice: v }),
      setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
      setDefaultChannel: (v) => set({ defaultChannel: v }),
      setAutoJoinVoice: (v) => set({ autoJoinVoice: v }),
      setEnableGifs: (v) => set({ enableGifs: v }),
      setSoundboardEnabled: (v) => set({ soundboardEnabled: v }),
      setSoundboardVolume: (v) => {
        set({ soundboardVolume: v });
        import("../services/soundboardService").then(({ setPlaybackVolume }) => setPlaybackVolume(v));
      },
      setScreenShareAudio: (v) => set({ screenShareAudio: v }),
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
