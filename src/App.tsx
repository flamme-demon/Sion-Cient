import { Suspense, useEffect, useState, useCallback } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { MainArea } from "./components/layout/MainArea";
import { AdminPanel } from "./components/layout/AdminPanel";
import { SettingsPanel } from "./components/layout/SettingsPanel";
import { LoginPage } from "./pages/LoginPage";
import { RecoveryKeyModal } from "./components/RecoveryKeyModal";
import { useAppStore } from "./stores/useAppStore";
import { useAuthStore } from "./stores/useAuthStore";
import { useMatrixStore } from "./stores/useMatrixStore";
import { useAdminStore } from "./stores/useAdminStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMutedSpeakDetection } from "./hooks/useMutedSpeakDetection";
import { useTranslation } from "react-i18next";
import * as matrixService from "./services/matrixService";

export default function App() {
  const { t } = useTranslation();
  const showAdmin = useAppStore((s) => s.showAdmin);
  const showSettings = useAppStore((s) => s.showSettings);
  const credentials = useAuthStore((s) => s.credentials);
  const isLoading = useAuthStore((s) => s.isLoading);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const initSync = useMatrixStore((s) => s.initSync);
  const connectionStatus = useMatrixStore((s) => s.connectionStatus);
  const fetchAdminData = useAdminStore((s) => s.fetchAdminData);
  const adminInitialized = useAdminStore((s) => s.initialized);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [mutedSpeakWarning, setMutedSpeakWarning] = useState(false);

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

  // Show loading spinner while checking session
  if (!sessionChecked || (isLoading && !credentials)) {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface)', color: 'var(--color-on-surface-variant)' }}>
        <div style={{
          width: 32, height: 32,
          border: '3px solid var(--color-surface-container-high)',
          borderTopColor: 'var(--color-primary)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }} />
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

  // Authenticated — show main app
  return (
    <Suspense fallback={
      <div style={{ display: 'flex', height: '100vh', width: '100vw', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface)', color: 'var(--color-on-surface-variant)' }}>
        Loading...
      </div>
    }>
      <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--color-surface)' }}>
        <Sidebar />
        <MainArea />
        {showAdmin && <AdminPanel />}
        {showSettings && <SettingsPanel />}
        <RecoveryKeyModal />
        {mutedSpeakWarning && (
          <div style={{
            position: 'fixed',
            bottom: 80,
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
