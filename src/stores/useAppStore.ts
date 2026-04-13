import { create } from "zustand";
import * as livekitService from "../services/livekitService";
import { playMute, playUnmute, playDeafen, playUndeafen } from "../services/soundService";

export interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
  name: string;
  size: number;
  mimeType: string;
}

type MobileView = "sidebar" | "chat";

export interface UserContextMenuState {
  userId: string;
  userName: string;
  x: number;
  y: number;
}

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
  pendingAutoJoinVoice: string | null;
  connectingVoiceChannel: string | null;
  /** Globally-positioned user context menu, opened from sidebar voice list, mention pills, etc. */
  userContextMenu: UserContextMenuState | null;
  /** Download completion toast */
  downloadNotification: { filename: string; path: string } | null;
  /** Tracks URLs that have been downloaded to Downloads folder */
  downloadedFiles: Set<string>;

  setActiveChannel: (id: string, hasVoice: boolean) => void;
  setConnectedVoice: (id: string | null) => void;
  setConnectingVoice: (id: string | null) => void;
  disconnectVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleScreenShare: () => void;
  toggleAdmin: () => void;
  toggleSettings: () => void;
  toggleAccountPanel: () => void;
  addPendingFile: (file: File) => Promise<void> | void;
  fileError: string | null;
  kickMessage: string | null;
  kickedFromRoom: string | null;
  dismissKick: () => void;
  lastReadMessageId: Record<string, string>;
  setLastReadMessageId: (roomId: string, messageId: string) => void;
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
  setPendingAutoJoinVoice: (roomId: string | null) => void;
  openUserContextMenu: (state: UserContextMenuState) => void;
  closeUserContextMenu: () => void;
  showDownloadNotification: (filename: string, path: string) => void;
  dismissDownloadNotification: () => void;
  markAsDownloaded: (url: string) => void;
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
  pendingAutoJoinVoice: null,
  connectingVoiceChannel: null,
  userContextMenu: null,
  downloadNotification: null,
  downloadedFiles: new Set<string>(JSON.parse(localStorage.getItem("sion-downloaded-files") || "[]")),

  setActiveChannel: (id, _hasVoice) =>
    set(() => ({
      activeChannel: id,
      mobileView: "chat" as MobileView,
    })),
  setConnectedVoice: (id: string | null) => set({ connectedVoiceChannel: id }),
  disconnectVoice: () => set({ connectedVoiceChannel: null, isMuted: false, isDeafened: false }),
  toggleMute: async () => {
    const newMuted = !get().isMuted;
    set({ isMuted: newMuted });
    newMuted ? playMute() : playUnmute();
    try {
      await livekitService.toggleMicrophone(!newMuted);
    } catch (err) {
      console.error("[Sion] Failed to toggle microphone:", err);
    }
  },
  toggleDeafen: () => {
    const newDeafened = !get().isDeafened;
    set({ isDeafened: newDeafened });
    newDeafened ? playDeafen() : playUndeafen();
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
  fileError: null,
  kickMessage: null,
  kickedFromRoom: null,
  dismissKick: () => set({ kickMessage: null, kickedFromRoom: null }),
  lastReadMessageId: JSON.parse(localStorage.getItem("sion-last-read") || "{}"),
  setLastReadMessageId: (roomId, messageId) => {
    const updated = { ...get().lastReadMessageId, [roomId]: messageId };
    set({ lastReadMessageId: updated });
    localStorage.setItem("sion-last-read", JSON.stringify(updated));
  },
  addPendingFile: async (file) => {
    // Check server upload limit
    let maxSize = 100 * 1024 * 1024;
    try {
      const { getMaxUploadSize } = await import("../services/matrixService");
      maxSize = await getMaxUploadSize();
    } catch { /* use default */ }

    if (file.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      const fileMB = Math.round(file.size / 1024 / 1024);
      const msg = `Fichier trop volumineux (${fileMB} MB). La limite du serveur est de ${maxMB} MB.`;
      set({ fileError: msg });
      setTimeout(() => set({ fileError: null }), 5000);
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
  setPendingAutoJoinVoice: (roomId) => set({ pendingAutoJoinVoice: roomId }),
  openUserContextMenu: (s) => set({ userContextMenu: s }),
  closeUserContextMenu: () => set({ userContextMenu: null }),
  setConnectingVoice: (id) => set({ connectingVoiceChannel: id }),
  showDownloadNotification: (filename, path) => {
    set({ downloadNotification: { filename, path } });
    setTimeout(() => set({ downloadNotification: null }), 6000);
  },
  dismissDownloadNotification: () => set({ downloadNotification: null }),
  markAsDownloaded: (url) => set((s) => {
    const next = new Set(s.downloadedFiles);
    next.add(url);
    localStorage.setItem("sion-downloaded-files", JSON.stringify([...next]));
    return { downloadedFiles: next };
  }),
}));