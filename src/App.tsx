import { Suspense, lazy, useEffect, useState, useCallback, useRef } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { MainArea } from "./components/layout/MainArea";

// Écrans lourds hors du chunk de démarrage (perf mémoire, 2026-09-12) : le
// chat n'en a pas besoin pour peindre ; chacun rejoint son propre chunk au
// premier affichage (Les Suspense existants couvrent déjà ces rendus).
const AdminPanel = lazy(() =>
  import("./components/layout/AdminPanel").then((m) => ({ default: m.AdminPanel })),
);
const SettingsPanel = lazy(() =>
  import("./components/layout/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const RecoveryKeyModal = lazy(() =>
  import("./components/RecoveryKeyModal").then((m) => ({ default: m.RecoveryKeyModal })),
);
const UserContextMenu = lazy(() =>
  import("./components/sidebar/UserContextMenu").then((m) => ({ default: m.UserContextMenu })),
);

/**
 * Préchauffage des écrans paresseux : sans ça, le premier clic sur
 * « Réglages » (ou Admin / les options de partage) payait le chargement ET la
 * transformation du chunk — très visible en dev, où Vite transforme les
 * modules à la volée. Voir `services/lazyScreens` (déclenché aussi au survol
 * du bouton).
 */

/** Indicateur d'ouverture d'un écran paresseux : discret, centré, sans faire
 *  clignoter le reste (le fallback local ne remplace que l'overlay). */
function LazyScreenFallback() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'color-mix(in srgb, var(--color-surface) 55%, transparent)',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '3px solid var(--color-outline-variant)',
        borderTopColor: 'var(--color-primary)',
        animation: 'sion-lazy-spin 0.9s linear infinite',
      }} />
      <style>{'@keyframes sion-lazy-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}
import { MobileVoiceBar } from "./components/mobile/MobileVoiceBar";
import { ConnectionStatusBanner } from "./components/ConnectionStatusBanner";
import { UpdateBanner } from "./components/layout/UpdateBanner";
import { DownloadToast } from "./components/layout/DownloadToast";
import { useAppStore } from "./stores/useAppStore";
import { useAuthStore } from "./stores/useAuthStore";
import { useMatrixStore } from "./stores/useMatrixStore";
import { useAdminStore } from "./stores/useAdminStore";
import { usePendingUsersStore } from "./stores/usePendingUsersStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMutedSpeakDetection } from "./hooks/useMutedSpeakDetection";
import { useVoiceChannel } from "./hooks/useVoiceChannel";
import { shouldAutoJoinVoice } from "./services/voiceNativeService";
import { preloadHeavyScreens } from "./services/lazyScreens";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useLayoutStore } from "./stores/useLayoutStore";
import { useIsMobile } from "./hooks/useIsMobile";
import { MatrixRain, MATRIX_GREEN } from "./components/sidebar/MatrixRain";
import { updateVoiceService } from "./services/androidVoiceService";
import { useTranslation } from "react-i18next";
import * as matrixService from "./services/matrixService";

export default function App() {
  const { t } = useTranslation();
  const showAdmin = useAppStore((s) => s.showAdmin);
  const showSettings = useAppStore((s) => s.showSettings);
  // Côté du menu principal (gauche ou droite) — voir « Dispositions ».
  const sidebarSide = useLayoutStore((s) => s.sidebarSide);
  const layoutEditing = useLayoutStore((s) => s.layoutEditing);
  const userContextMenu = useAppStore((s) => s.userContextMenu);
  const closeUserContextMenu = useAppStore((s) => s.closeUserContextMenu);
  const mobileView = useAppStore((s) => s.mobileView);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const credentials = useAuthStore((s) => s.credentials);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isSuspended = useAuthStore((s) => s.isSuspended);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const initSync = useMatrixStore((s) => s.initSync);
  // Préchauffe les écrans paresseux peu après la connexion (le survol du
  // bouton Réglages les prend encore plus tôt — cf. services/lazyScreens).
  // Seulement une fois connecté — rien à précharger sur l'écran de connexion.
  useEffect(() => {
    if (!credentials) return;
    preloadHeavyScreens(300);
  }, [credentials]);

  // Ménage des fonds transcodés, une fois au démarrage. Chaque essai de fond
  // laissait sa sortie derrière lui, sans que rien ne la reprenne — 39 Mo
  // pour quatre fichiers dont un seul servait (18/09). La configuration est
  // restaurée à ce stade : on connaît donc l'ensemble des fonds référencés.
  useEffect(() => {
    void import("./services/panelBackground").then((m) => m.purgerFondsInutilises());
  }, []);
  const connectionStatus = useMatrixStore((s) => s.connectionStatus);
  const fetchAdminData = useAdminStore((s) => s.fetchAdminData);
  const adminInitialized = useAdminStore((s) => s.initialized);
  const isAdmin = useAdminStore((s) => s.isAdmin);
  const startAdminCheck = useAdminStore((s) => s.startAdminCheck);
  const stopAdminCheck = useAdminStore((s) => s.stopAdminCheck);
  const startPendingListener = usePendingUsersStore((s) => s.startListening);
  const stopPendingListener = usePendingUsersStore((s) => s.stopListening);
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
    // Handle notification tap — open room (with retry until channels loaded)
    (window as unknown as Record<string, unknown>).__SION_OPEN_ROOM__ = (roomId: string) => {
      let retries = 0;
      const tryOpen = () => {
        const channel = useMatrixStore.getState().channels.find(c => c.id === roomId);
        if (channel) {
          useAppStore.getState().setActiveChannel(channel.id, channel.hasVoice);
          useAppStore.getState().setMobileView("chat");
          useMatrixStore.getState().loadRoomHistory(roomId);
        } else if (retries < 20) {
          retries++;
          setTimeout(tryOpen, 1000);
        }
      };
      tryOpen();
    };

    return () => {
      delete (window as unknown as Record<string, unknown>).__SION_VOICE_ACTION__;
      delete (window as unknown as Record<string, unknown>).__SION_OPEN_ROOM__;
    };
  }, []);

  // Note: notification actions are handled via broadcast → __SION_VOICE_ACTION__
  // No need for pendingActions consumption — the broadcast reaches JS directly

  // Sync mute/deafen state to Android foreground service notification
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const channels = useMatrixStore((s) => s.channels);
  const lastNotifState = useRef({ muted: false, deafened: false });
  useEffect(() => {
    if (!connectedVoice) return;
    // Only update notification if mute/deafen actually changed
    if (lastNotifState.current.muted === isMuted && lastNotifState.current.deafened === isDeafened) return;
    lastNotifState.current = { muted: isMuted, deafened: isDeafened };
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
        // Short delay for reconnect, longer for initial mobile auto-join
        const isReconnect = connectionStatus === "connected";
        setTimeout(() => {
          // Ne jamais percuter un join manuel en cours ni voler une session
          // active (course auto-join / clic qui coinçait la session native).
          const { connectedVoiceChannel, connectingVoiceChannel } = useAppStore.getState();
          if (!shouldAutoJoinVoice(roomId, connectedVoiceChannel, connectingVoiceChannel)) return;
          joinVoiceRef.current(roomId).catch((err: unknown) =>
            console.error("[Sion] Auto-join voice failed:", err)
          );
        }, isReconnect ? 500 : 3000);
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

  // Restore the soundboard panel open/closed state from the previous
  // session. Fires once on mount; subsequent toggles are already synced to
  // the persisted setting by the dock store (`sion-layout`).
  useEffect(() => {
    const layout = useLayoutStore.getState();
    const soundboardOpen =
      layout.dockZones.right.panels.includes("soundboard") ||
      layout.dockZones.bottom.panels.includes("soundboard") ||
      !!layout.floatingPanels["soundboard"];
    if (useSettingsStore.getState().soundboardOpenAtLaunch && !soundboardOpen) {
      layout.openDockPanel("soundboard");
    }
  }, []);

  // Register push notifications when connected + sync room names for Android
  useEffect(() => {
    if (connectionStatus !== "connected" || !credentials) return;

    // Sync room info and notification mode to Android
    import("./services/androidVoiceService").then(({ setNotificationMode }) => {
      const allChannels = useMatrixStore.getState().channels;
      const bridge = (window as unknown as Record<string, unknown>).__SION__ as
        { saveRoomInfo?: (id: string, name: string, isDM: boolean) => void } | undefined;
      if (bridge?.saveRoomInfo) {
        allChannels.forEach((ch) => bridge.saveRoomInfo!(ch.id, ch.name, ch.isDM ?? false));
      }
      setNotificationMode(useSettingsStore.getState().notificationMode);
    }).catch(() => {});

    import("./services/pushService").then(({ registerPusher, syncPushRules }) => {
      registerPusher();
      syncPushRules(useSettingsStore.getState().notificationMode);
      // Note: SSE push subscription is NOT used on desktop — the Matrix sync
      // handler in useMatrixStore.ts already manages notifications with proper
      // filtering (mentions, DMs, etc.) and access to decrypted content.
      // SSE push is only used by the Android NtfyListenerService when the app is closed.
    }).catch(() => {});
  }, [connectionStatus, credentials]);

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
            color: MATRIX_GREEN,
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
              color: MATRIX_GREEN, marginBottom: 12, transition: 'all 200ms',
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
        {(!isMobile || mobileView === "sidebar") && sidebarSide === "left" && <Sidebar />}
        {(!isMobile || mobileView === "chat") && <MainArea />}
        {(!isMobile || mobileView === "sidebar") && sidebarSide === "right" && <Sidebar />}

        {/* Panels: overlay on mobile, side panel on desktop */}
        {/* Chaque overlay paresseux a SON Suspense (fallback null) : sans ça,
            le chargement du chunk ferait clignoter tout l'écran. */}
        {showAdmin && <Suspense fallback={<LazyScreenFallback />}><AdminPanel /></Suspense>}
        {showSettings && <Suspense fallback={<LazyScreenFallback />}><SettingsPanel /></Suspense>}
        <Suspense fallback={null}><RecoveryKeyModal /></Suspense>
        <ConnectionStatusBanner />
        {layoutEditing && (
          <div style={{
            position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 500,
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 16px', borderRadius: 999,
            background: 'var(--color-surface-container-high)',
            border: '1px solid var(--color-primary)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)' }}>
              {t("layout.editLayoutHint", { defaultValue: "Glissez les blocs (et le menu) dans la grille — haut / droite / bas" })}
            </span>
            <button
              onClick={() => useLayoutStore.getState().resetLayout()}
              style={{ padding: '5px 12px', borderRadius: 999, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
            >{t("layout.editReset", { defaultValue: "Réinitialiser" })}</button>
            <button
              onClick={() => useLayoutStore.getState().setLayoutEditing(false)}
              style={{ padding: '5px 14px', borderRadius: 999, border: 'none', background: 'var(--color-primary)', color: 'var(--color-on-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
            >{t("layout.editDone", { defaultValue: "Terminé" })}</button>
          </div>
        )}
        <UpdateBanner />
        <DownloadToast />
        {userContextMenu && (
          <Suspense fallback={null}>
            <UserContextMenu
              userId={userContextMenu.userId}
              userName={userContextMenu.userName}
              x={userContextMenu.x}
              y={userContextMenu.y}
              onClose={closeUserContextMenu}
            />
          </Suspense>
        )}

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
