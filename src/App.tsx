import { Suspense, useEffect, useState, useCallback } from "react";
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
import { useIsMobile } from "./hooks/useIsMobile";
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
  const [sessionChecked, setSessionChecked] = useState(false);
  const [mutedSpeakWarning, setMutedSpeakWarning] = useState(false);
  const isMobile = useIsMobile();

  useKeyboardShortcuts();
  useMutedSpeakDetection(useCallback(() => {
    setMutedSpeakWarning(true);
    setTimeout(() => setMutedSpeakWarning(false), 3000);
  }, []));

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

  // Account suspended — show pending approval screen
  if (isSuspended) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100dvh', width: '100%', background: 'var(--color-surface)',
        fontFamily: 'inherit', padding: 16,
      }}>
        <div style={{
          width: '100%', maxWidth: 420, background: 'var(--color-surface-container-low)',
          borderRadius: 28, padding: '48px 24px 32px', boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 8 }}>
            {t("auth.pendingApprovalTitle")}
          </div>
          <div style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', lineHeight: 1.6, marginBottom: 24 }}>
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
              width: '100%', padding: '14px 0', border: 'none', cursor: 'pointer',
              borderRadius: 28, fontSize: 15, fontWeight: 600, fontFamily: 'inherit',
              background: 'var(--color-primary)', color: 'var(--color-on-primary)',
              marginBottom: 12, transition: 'opacity 200ms',
            }}
          >
            {t("auth.checkApproval")}
          </button>
          <button
            onClick={() => useAuthStore.getState().logout()}
            style={{
              width: '100%', padding: '12px 0', border: 'none', cursor: 'pointer',
              borderRadius: 28, fontSize: 14, fontWeight: 500, fontFamily: 'inherit',
              background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)',
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
      </div>
    </Suspense>
  );
}
