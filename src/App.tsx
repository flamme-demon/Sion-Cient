import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { MainArea } from "./components/layout/MainArea";
import { AdminPanel } from "./components/layout/AdminPanel";
import { SettingsPanel } from "./components/layout/SettingsPanel";
import { MobileVoiceBar } from "./components/mobile/MobileVoiceBar";
import { LoginPage } from "./pages/LoginPage";
import { RecoveryKeyModal } from "./components/RecoveryKeyModal";
import { useAppStore } from "./stores/useAppStore";
import { useAuthStore } from "./stores/useAuthStore";
import { useMatrixStore } from "./stores/useMatrixStore";
import { useAdminStore } from "./stores/useAdminStore";
import { usePendingUsersStore } from "./stores/usePendingUsersStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMutedSpeakDetection } from "./hooks/useMutedSpeakDetection";
import { useVoiceChannel } from "./hooks/useVoiceChannel";
import { useIsMobile } from "./hooks/useIsMobile";
import { MatrixRain } from "./components/sidebar/MatrixRain";
import { updateVoiceService } from "./services/androidVoiceService";
import { useTranslation } from "react-i18next";
import * as matrixService from "./services/matrixService";

export default function App() {
  const { t } = useTranslation();
  const showAdmin = useAppStore((s) => s.showAdmin);
  const showSettings = useAppStore((s) => s.showSettings);
  const mobileView = useAppStore((s) => s.mobileView);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const credentials = useAuthStore((s) => s.credentials);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isSuspended = useAuthStore((s) => s.isSuspended);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const initSync = useMatrixStore((s) => s.initSync);
  const connectionStatus = useMatrixStore((s) => s.connectionStatus);
  const fetchAdminData = useAdminStore((s) => s.fetchAdminData);
  const adminInitialized = useAdminStore((s) => s.initialized);
  const isAdmin = useAdminStore((s) => s.isAdmin);
  const startAdminCheck = useAdminStore((s) => s.startAdminCheck);
  const stopAdminCheck = useAdminStore((s) => s.stopAdminCheck);
  const startPendingListener = usePendingUsersStore((s) => s.startListening);
  const stopPendingListener = usePendingUsersStore((s) => s.stopListening);
  const showAccountPanel = useAppStore((s) => s.showAccountPanel);
  const toggleAccountPanel = useAppStore((s) => s.toggleAccountPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleAdmin = useAppStore((s) => s.toggleAdmin);
  const setMobileView = useAppStore((s) => s.setMobileView);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [mutedSpeakWarning, setMutedSpeakWarning] = useState(false);
  const [backToast, setBackToast] = useState(false);
  const isMobile = useIsMobile();

  const { joinVoiceChannel, leaveVoiceChannel } = useVoiceChannel();
  const joinVoiceRef = useRef(joinVoiceChannel);
  joinVoiceRef.current = joinVoiceChannel;
  const leaveVoiceRef = useRef(leaveVoiceChannel);
  leaveVoiceRef.current = leaveVoiceChannel;

  // Listen for Android foreground service notification actions
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__SION_VOICE_ACTION__ = (action: string) => {
      if (action === "mute") useAppStore.getState().toggleMute();
      if (action === "deafen") useAppStore.getState().toggleDeafen();
      if (action === "disconnect") {
        const voiceId = useAppStore.getState().connectedVoiceChannel;
        if (voiceId) leaveVoiceRef.current(voiceId);
      }
    };
    return () => { delete (window as unknown as Record<string, unknown>).__SION_VOICE_ACTION__; };
  }, []);

  // Sync mute/deafen state to Android foreground service notification
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const channels = useMatrixStore((s) => s.channels);
  useEffect(() => {
    if (!connectedVoice) return;
    const channelName = channels.find(c => c.id === connectedVoice)?.name || "Voice";
    updateVoiceService(channelName, isMuted, isDeafened);
  }, [connectedVoice, isMuted, isDeafened, channels]);

  useKeyboardShortcuts();
  useMutedSpeakDetection(useCallback(() => {
    setMutedSpeakWarning(true);
    setTimeout(() => setMutedSpeakWarning(false), 3000);
  }, []));

  // Auto-join voice channel via zustand subscribe (outside React render cycle)
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.pendingAutoJoinVoice && state.pendingAutoJoinVoice !== prev.pendingAutoJoinVoice) {
        const roomId = state.pendingAutoJoinVoice;
        useAppStore.getState().setPendingAutoJoinVoice(null);
        setTimeout(() => {
          console.log("[Sion] Auto-joining voice channel:", roomId);
          joinVoiceRef.current(roomId).catch((err: unknown) =>
            console.error("[Sion] Auto-join voice failed:", err)
          );
        }, 3000);
      }
    });
    return unsub;
  }, []);

  // Mobile back button handler via Tauri plugin (Android)
  useEffect(() => {
    if (!isMobile) return;

    let wantsToQuit = false;
    let quitTimer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: { unregister: () => Promise<void> } | null = null;

    import("@tauri-apps/api/app").then(({ onBackButtonPress }) => {
      onBackButtonPress((_payload) => {
        const appState = useAppStore.getState();

        // Close panels first (most specific → least specific)
        if (appState.showAccountPanel) { toggleAccountPanel(); return; }
        if (appState.showSettings) { toggleSettings(); return; }
        if (appState.showAdmin) { toggleAdmin(); return; }

        // If viewing chat, go back to sidebar
        if (appState.mobileView === "chat") { setMobileView("sidebar"); return; }

        // Already on sidebar — double-tap to quit
        if (wantsToQuit) {
          if (quitTimer) clearTimeout(quitTimer);
          wantsToQuit = false;
          setBackToast(false);
          // Disconnect voice cleanly before exiting
          const voiceChannel = useAppStore.getState().connectedVoiceChannel;
          if (voiceChannel) {
            leaveVoiceRef.current(voiceChannel).finally(() => {
              import("@tauri-apps/api/core").then(({ invoke }) => invoke("exit_app"));
            });
          } else {
            import("@tauri-apps/api/core").then(({ invoke }) => invoke("exit_app"));
          }
          return;
        }

        wantsToQuit = true;
        setBackToast(true);
        quitTimer = setTimeout(() => {
          wantsToQuit = false;
          setBackToast(false);
        }, 2500);
      }).then((listener) => { unlisten = listener; });
    }).catch(() => { /* Not in Tauri context */ });

    return () => {
      unlisten?.unregister();
      if (quitTimer) clearTimeout(quitTimer);
    };
  }, [isMobile, toggleAccountPanel, toggleSettings, toggleAdmin, setMobileView]);

  // Restore session on mount
  useEffect(() => {
    restoreSession().finally(() => setSessionChecked(true));
  }, [restoreSession]);

  // Init Matrix sync when credentials are available
  useEffect(() => {
    if (credentials && connectionStatus === "disconnected") {
      const client = matrixService.getMatrixClient();
      if (client) {
        initSync(client);
      }
    }
  }, [credentials, connectionStatus, initSync]);

  // Fetch admin data early to know if user is admin
  useEffect(() => {
    if (credentials?.homeserverUrl && credentials?.accessToken && !adminInitialized) {
      fetchAdminData(credentials.homeserverUrl, credentials.accessToken);
    }
  }, [credentials, adminInitialized, fetchAdminData]);

  // Poll admin status changes (promotion/rétrogradation par un autre admin)
  useEffect(() => {
    if (adminInitialized && connectionStatus === "connected") {
      startAdminCheck();
      return () => stopAdminCheck();
    }
  }, [adminInitialized, connectionStatus, startAdminCheck, stopAdminCheck]);

  // Start pending users listener when admin is confirmed
  useEffect(() => {
    if (isAdmin && connectionStatus === "connected") {
      startPendingListener();
      return () => stopPendingListener();
    }
  }, [isAdmin, connectionStatus, startPendingListener, stopPendingListener]);

  // Show loading spinner while checking session
  if (!sessionChecked || (isLoading && !credentials)) {
    return (
      <div className="app-loading">
        <div className="app-spinner" />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Not authenticated — show login
  if (!credentials) {
    return (
      <Suspense fallback={null}>
        <LoginPage />
      </Suspense>
    );
  }

  // Account suspended — show pending approval screen with Matrix rain
  if (isSuspended) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100dvh', width: '100%', background: 'var(--color-surface)',
        fontFamily: 'inherit', padding: 16,
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <MatrixRain width={window.innerWidth} height={window.innerHeight} />
        </div>
        <div style={{
          position: 'relative', zIndex: 1,
          width: '100%', maxWidth: 420,
          borderRadius: 28, padding: '48px 24px 32px',
          textAlign: 'center',
          background: 'rgba(17, 19, 24, 0.85)',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 4px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{
            fontSize: 28, fontWeight: 700, marginBottom: 8,
            color: '#0f0',
            textShadow: '0 0 12px rgba(0,255,70,0.5)',
          }}>
            {t("auth.pendingApprovalTitle")}
          </div>
          <div style={{
            fontSize: 14, color: 'rgba(0, 255, 70, 0.7)', lineHeight: 1.6, marginBottom: 24,
          }}>
            {t("auth.pendingApprovalDesc")}
          </div>
          <button
            onClick={async () => {
              const suspended = await matrixService.checkSuspended();
              if (!suspended) {
                useAuthStore.getState().checkSuspendedStatus();
              }
            }}
            style={{
              width: '100%', padding: '14px 0', border: '1px solid rgba(0,255,70,0.3)',
              cursor: 'pointer', borderRadius: 28, fontSize: 15, fontWeight: 600,
              fontFamily: 'inherit', background: 'rgba(0,255,70,0.1)',
              color: '#0f0', marginBottom: 12, transition: 'all 200ms',
            }}
          >
            {t("auth.checkApproval")}
          </button>
          <button
            onClick={() => useAuthStore.getState().logout()}
            style={{
              width: '100%', padding: '12px 0', border: 'none', cursor: 'pointer',
              borderRadius: 28, fontSize: 14, fontWeight: 500, fontFamily: 'inherit',
              background: 'rgba(255,255,255,0.05)', color: 'var(--color-on-surface-variant)',
              transition: 'opacity 200ms',
            }}
          >
            {t("auth.logout")}
          </button>
        </div>
      </div>
    );
  }

  // Authenticated — show main app
  return (
    <Suspense fallback={
      <div className="app-loading">Loading...</div>
    }>
      <div className="app-root">
        {/* Mobile: show sidebar OR chat based on mobileView */}
        {/* Desktop: always show sidebar */}
        {(!isMobile || mobileView === "sidebar") && <Sidebar />}
        {(!isMobile || mobileView === "chat") && <MainArea />}

        {/* Panels: overlay on mobile, side panel on desktop */}
        {showAdmin && <AdminPanel />}
        {showSettings && <SettingsPanel />}
        <RecoveryKeyModal />

        {/* Mobile voice bar with PTT */}
        {isMobile && connectedVoice && <MobileVoiceBar />}

        {mutedSpeakWarning && (
          <div style={{
            position: 'fixed',
            bottom: isMobile && connectedVoice ? 140 : 80,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-error-container)',
            color: 'var(--color-on-error-container)',
            padding: '10px 20px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 500,
            zIndex: 1000,
            animation: 'fadeIn 200ms',
            pointerEvents: 'none',
          }}>
            {t("settings.mutedSpeakWarning")}
          </div>
        )}

        {backToast && (
          <div style={{
            position: 'fixed',
            bottom: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-surface-container-highest)',
            color: 'var(--color-on-surface)',
            padding: '10px 20px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 500,
            zIndex: 1000,
            animation: 'fadeIn 200ms',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}>
            {t("app.pressBackAgain")}
          </div>
        )}
      </div>
    </Suspense>
  );
}
