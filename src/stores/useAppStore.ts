import { create } from "zustand";
import * as voiceNativeService from "../services/voiceNativeService";
import * as matrixService from "../services/matrixService";
import { resolveShareVideoCodec } from "./useMediaCapsStore";
import { playMuteCue, playUnmuteCue, playDeafenCue, playUndeafenCue } from "../services/voiceChannelSounds";

// Timestamp at which the app session started. Used as a cutoff for unread
// badge computation on channels the user has never opened: historical
// messages loaded during the initial sync must not count as unread,
// otherwise channels display "99+" as soon as the client connects.
export const APP_SESSION_START_TS = Date.now();

/** Sérialise les bascules moteur mute/deafen : un enchaînement rapide F8/F9
 *  ne doit pas lancer des commandes concurrentes (le deafen sort le moteur de
 *  son holder, un mute simultané le croit absent — bug F9 — et le
 *  stop/start playout s'entrelace mal). Les appels s'exécutent dans l'ordre. */
let engineToggleChain: Promise<unknown> = Promise.resolve();
function chainEngineToggle(op: () => Promise<unknown>): Promise<unknown> {
  engineToggleChain = engineToggleChain.catch(() => {}).then(op);
  return engineToggleChain;
}

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
  /** Set to true when the user requested "Share audio" but the native OS
   *  picker didn't attach an audio track (they unchecked the box, or the
   *  platform can't capture system audio for that source — macOS whole-screen,
   *  Firefox, etc.). Rendered as an inline banner next to the Stop button. */
  screenShareAudioWarning: boolean;
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
  /** True while voice E2EE is struggling locally (recent MissingKey errors —
   *  i.e. we can't decrypt a peer). Best available proxy for "voice E2EE is
   *  unhealthy right now"; surfaces the manual republish-presence recovery. */
  e2eeUnhealthy: boolean;
  /** Écart estimé entre l'horloge locale et le serveur, en minutes. 0 = aligné.
   *  Au-delà de la tolérance, l'utilisateur disparaît des salons vocaux des
   *  autres et n'y voit plus personne — sans le moindre indice. */
  clockSkewMin: number;
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
  toggleMute: (silent?: boolean) => void;
  toggleDeafen: () => void | Promise<void>;
  toggleScreenShare: () => void;
  toggleAdmin: () => void;
  toggleSettings: () => void;
  toggleAccountPanel: () => void;
  addPendingFile: (file: File) => Promise<void> | void;
  fileError: string | null;
  /** Affiche un message d'erreur transitoire au-dessus de la zone de saisie. */
  setFileError: (message: string) => void;
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
  setE2EEUnhealthy: (v: boolean) => void;
  setClockSkewMin: (v: number) => void;
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
  screenShareAudioWarning: false,
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
  e2eeUnhealthy: false,
  clockSkewMin: 0,
  userContextMenu: null,
  downloadNotification: null,
  downloadedFiles: new Set<string>(JSON.parse(localStorage.getItem("sion-downloaded-files") || "[]")),

  setActiveChannel: (id, _hasVoice) =>
    set(() => ({
      activeChannel: id,
      mobileView: "chat" as MobileView,
    })),
  setConnectedVoice: (id: string | null) => set({ connectedVoiceChannel: id }),
  // `isScreenSharing` doit retomber ici aussi. Une coupure réseau est réparée
  // par LiveKit, qui republie les pistes : le partage reprend et l'indicateur
  // reste juste. Un kick est au contraire une déconnexion définitive suivie
  // d'une nouvelle session, où rien n'est republié — l'indicateur restait alors
  // allumé, le bouton passait pour actif, et le premier clic au retour tentait
  // d'ARRÊTER un partage inexistant au lieu d'en démarrer un.
  disconnectVoice: () => set({ connectedVoiceChannel: null, isMuted: false, isDeafened: false, e2eeUnhealthy: false, isScreenSharing: false }),
  setE2EEUnhealthy: (v: boolean) => set({ e2eeUnhealthy: v }),
  setClockSkewMin: (v: number) => set({ clockSkewMin: v }),
  toggleMute: async (silent = false) => {
    const newMuted = !get().isMuted;
    console.log(`[Sion][mute] toggleMute() store: ${get().isMuted} → ${newMuted} (silent=${silent})`);
    set({ isMuted: newMuted });
    // Mirror into the call.member state event so clients in other voice
    // channels see our mute indicator. Fire-and-forget — the publish is
    // debounced and a failure is purely cosmetic for those other clients.
    matrixService.publishLocalVoiceState({ muted: newMuted });
    try {
      await chainEngineToggle(() => voiceNativeService.setVoiceNativeMuted(newMuted));
    } catch (err) {
      console.error("[Sion] Failed to toggle microphone:", err);
    }
    // `silent` is set ONLY when deafen triggers the implicit mute below (passed
    // as a literal `true`) — the deafen cue already played, so we skip the mute
    // cue to avoid a double sound. We must compare `=== true` and NOT rely on
    // truthiness: this is also wired straight to button `onClick` handlers,
    // which inject the click event as the first arg — a truthy object that
    // would otherwise swallow the cue on every manual mute/unmute.
    // Le cue est joué APRÈS l'action moteur : le stop/start de capture peut
    // suspendre le sink audio partagé et couper un son démarré juste avant.
    if (silent !== true) {
      if (newMuted) playMuteCue();
      else playUnmuteCue();
    }
  },
  toggleDeafen: async () => {
    const newDeafened = !get().isDeafened;
    console.log(`[Sion][deafen] toggleDeafen() store: ${get().isDeafened} → ${newDeafened}`);
    set({ isDeafened: newDeafened });
    // ORDRE IMPOSÉ (bug F9 du 08/09) : le deafen Rust SORT le moteur de
    // son holder pendant l'opération — un mute tiré en même temps le
    // croit absent et abandonne en silence (micro live + sourdine).
    // On attend donc la fin du deafen avant de couper le micro
    // (le Rust attend aussi, cf. `wait_for_engine` : double sécurité).
    try {
      await chainEngineToggle(() => voiceNativeService.setVoiceNativeDeafened(newDeafened));
    } catch (err) {
      console.error("[Sion] Failed to set native deafen:", err);
    }
    matrixService.publishLocalVoiceState({ deafened: newDeafened });
    // Deafen also mutes the mic — silently, so only the deafen cue plays.
    if (newDeafened && !get().isMuted) {
      get().toggleMute(true);
    } else if (newDeafened) {
      // Garde-fou : le store peut croire le micro déjà coupé alors que le
      // moteur publie encore (désync historique : "muté" affiché + micro
      // live — les pairs entendent tout). La coupure moteur est idempotente
      // ("micro déjà coupé" si vraiment coupé), donc on force sans risque.
      console.log("[Sion][deafen] micro déjà marqué muté — coupure moteur forcée (idempotente)");
      chainEngineToggle(() => voiceNativeService.setVoiceNativeMuted(true)).catch((err) => {
        console.error("[Sion] Failed to force native mute on deafen:", err);
      });
    }
    // Cue APRÈS le stop/start du playout : sinon le sink partagé peut
    // suspendre et avaler le son (sourdine/unsourdine intermittente).
    if (newDeafened) playDeafenCue();
    else playUndeafenCue();
  },
  toggleScreenShare: async () => {
    const newSharing = !get().isScreenSharing;
    // Capture + publication Rust avec les réglages du menu. État posé après
    // succès moteur, jamais de partage fantôme affiché. `screenShareAudioWarning`
    // ("Sans son") reflète l'absence de piste audio publiée.
    const { useSettingsStore } = await import("./useSettingsStore");
    const settings = useSettingsStore.getState();
    const wantAudio = settings.screenShareAudio;
    // L'identifiant `screen:N:0` est un index de moniteur historique qui ne
    // correspond pas forcément au DesktopCapturer natif. Sur Wayland, laisser
    // le portail KDE fournir sa propre source ; réutiliser ce nombre peut
    // sélectionner un flux périmé et produire une piste noire.
    const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
    const sourceMatch = isWindows
      ? settings.screenShareSourceId?.match(/^screen:(\d+):/)
      : null;
    const sourceId = sourceMatch ? Number(sourceMatch[1]) : undefined;
    let audioPublished = false;
    try {
      const autoQuality = settings.screenShareQualityMode === "auto";
        const result = await voiceNativeService.setVoiceNativeScreensharing(newSharing, {
          sourceId,
          withAudio: wantAudio,
          // Automatique = dimensions de la source conservées dans un plafond
          // 1440p/30 ; congestion WebRTC et simulcast adaptent ensuite le débit.
          resolution: autoQuality ? "1440p" : settings.screenShareResolution,
          framerate: autoQuality ? 30 : settings.screenShareFramerate,
          videoCodec: resolveShareVideoCodec(settings.screenShareCodec),
        });
      audioPublished = result.audioPublished;
    } catch (err) {
      console.warn("[Sion][voix-native] partage d'écran natif impossible:", err);
      set({ fileError: `Partage d'écran impossible : ${String(err)}` });
      setTimeout(() => set({ fileError: null }), 5000);
      return;
    }
    set({
      isScreenSharing: newSharing,
      screenShareAudioWarning: newSharing && wantAudio && !audioPublished,
    });
    // Overlay curseurs : éteint/affiché avec le partage pour que les viewers
    // puissent pointer sur notre écran.
    import("../services/cursorOverlayService").then((overlay) => {
      if (newSharing) overlay.openCursorOverlay().catch(() => {});
      else overlay.closeCursorOverlay().catch(() => {});
    }).catch(() => {});
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
  setFileError: (message) => {
    set({ fileError: message });
    setTimeout(() => set({ fileError: null }), 5000);
  },
  dismissDownloadNotification: () => set({ downloadNotification: null }),
  markAsDownloaded: (url) => set((s) => {
    const next = new Set(s.downloadedFiles);
    next.add(url);
    localStorage.setItem("sion-downloaded-files", JSON.stringify([...next]));
    return { downloadedFiles: next };
  }),
}));
