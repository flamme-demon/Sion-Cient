import { create } from "zustand";
import * as livekitService from "../services/livekitService";

export interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
  name: string;
  size: number;
  mimeType: string;
}

type MobileView = "sidebar" | "chat";

interface AppState {
  activeChannel: string;
  connectedVoiceChannel: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  showAdmin: boolean;
  showSettings: boolean;
  showAccountPanel: boolean;
  pendingFiles: PendingFile[];
  isDraggingOver: boolean;
  editingMessage: { eventId: string; text: string } | null;
  replyingTo: { eventId: string; senderId: string; user: string; text: string } | null;
  mobileView: MobileView;
  isSpeaking: boolean;

  setActiveChannel: (id: string, hasVoice: boolean) => void;
  setConnectedVoice: (id: string | null) => void;
  disconnectVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleScreenShare: () => void;
  toggleAdmin: () => void;
  toggleSettings: () => void;
  toggleAccountPanel: () => void;
  addPendingFile: (file: File) => void;
  removePendingFile: (id: string) => void;
  clearPendingFiles: () => void;
  setDraggingOver: (v: boolean) => void;
  setEditingMessage: (msg: { eventId: string; text: string }) => void;
  clearEditingMessage: () => void;
  setReplyingTo: (reply: { eventId: string; senderId: string; user: string; text: string }) => void;
  clearReplyingTo: () => void;
  scrollToMessageId: string | null;
  setScrollToMessageId: (id: string | null) => void;
  setMobileView: (view: MobileView) => void;
  setIsSpeaking: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeChannel: "",
  connectedVoiceChannel: null,
  isMuted: false,
  isDeafened: false,
  isScreenSharing: false,
  showAdmin: false,
  showSettings: false,
  showAccountPanel: false,
  pendingFiles: [],
  isDraggingOver: false,
  editingMessage: null,
  replyingTo: null,
  mobileView: "sidebar" as MobileView,
  isSpeaking: false,

  setActiveChannel: (id, hasVoice) =>
    set((s) => ({
      activeChannel: id,
      mobileView: "chat" as MobileView,
      // Only clear voice if switching to a text channel; voice connection is managed by LiveKit
      connectedVoiceChannel: hasVoice ? s.connectedVoiceChannel : s.connectedVoiceChannel,
    })),
  setConnectedVoice: (id: string | null) => set({ connectedVoiceChannel: id }),
  disconnectVoice: () => set({ connectedVoiceChannel: null, isMuted: false, isDeafened: false }),
  toggleMute: async () => {
    const newMuted = !get().isMuted;
    set({ isMuted: newMuted });
    // Connect to LiveKit microphone
    try {
      await livekitService.toggleMicrophone(!newMuted);
    } catch (err) {
      console.error("[Sion] Failed to toggle microphone:", err);
    }
  },
  toggleDeafen: () => {
    const newDeafened = !get().isDeafened;
    set({ isDeafened: newDeafened });
    livekitService.setDeafened(newDeafened);
    // Deafen also mutes the mic
    if (newDeafened && !get().isMuted) {
      get().toggleMute();
    }
  },
  toggleScreenShare: async () => {
    const newSharing = !get().isScreenSharing;
    set({ isScreenSharing: newSharing });
    try {
      await livekitService.toggleScreenShare(newSharing);
    } catch (err) {
      console.error("[Sion] Failed to toggle screen share:", err);
      set({ isScreenSharing: !newSharing });
    }
  },
  toggleAdmin: () => set((s) => ({ showAdmin: !s.showAdmin, showSettings: s.showAdmin ? s.showSettings : false })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings, showAdmin: s.showSettings ? s.showAdmin : false })),
  toggleAccountPanel: () => set((s) => ({ showAccountPanel: !s.showAccountPanel })),
  addPendingFile: (file) => {
    // Limit file size to 100MB to prevent WebView crashes on mobile
    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      console.warn("[Sion] File too large:", file.name, file.size);
      return;
    }
    const id = crypto.randomUUID();
    // Only create blob preview for small images (<5MB) to avoid mobile memory issues
    const previewUrl = file.type.startsWith("image/") && file.size < 5 * 1024 * 1024
      ? URL.createObjectURL(file) : undefined;
    set((s) => ({
      pendingFiles: [...s.pendingFiles, { id, file, previewUrl, name: file.name, size: file.size, mimeType: file.type }],
    }));
  },
  removePendingFile: (id) => {
    const pf = get().pendingFiles.find((f) => f.id === id);
    if (pf?.previewUrl) URL.revokeObjectURL(pf.previewUrl);
    set((s) => ({ pendingFiles: s.pendingFiles.filter((f) => f.id !== id) }));
  },
  clearPendingFiles: () => {
    get().pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    set({ pendingFiles: [] });
  },
  setDraggingOver: (v) => set({ isDraggingOver: v }),
  setEditingMessage: (msg) => set({ editingMessage: msg }),
  clearEditingMessage: () => set({ editingMessage: null }),
  setReplyingTo: (reply) => set({ replyingTo: reply }),
  clearReplyingTo: () => set({ replyingTo: null }),
  scrollToMessageId: null,
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),
  setMobileView: (view) => set({ mobileView: view }),
  setIsSpeaking: (v) => set({ isSpeaking: v }),
}));