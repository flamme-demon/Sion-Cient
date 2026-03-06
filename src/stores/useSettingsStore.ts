import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChannelSortMode = "created" | "name" | "activity";
export type SidebarView = "channels" | "dm";
export type AudioQualityPreset = "voice" | "voiceHD" | "musicStereo";

interface SettingsState {
  mutedSpeakAlert: boolean;
  joinMuted: boolean;
  micThreshold: number;
  muteShortcut: string;
  deafenShortcut: string;
  notifyDM: boolean;
  channelSort: ChannelSortMode;
  sidebarView: SidebarView;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioQuality: AudioQualityPreset;
  linkPreviews: boolean;

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
    }),
    { name: "sion-settings" },
  ),
);
