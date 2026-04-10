import { create } from "zustand";
import i18n from "../i18n";
import type { AuthCredentials } from "../types/auth";
import * as matrixService from "../services/matrixService";
import type { RegistrationFlowInfo } from "../services/matrixService";
import { useAdminStore } from "./useAdminStore";

const STORAGE_KEY = "sion_auth_credentials";

// Module-level password cache for UIA callback during cross-signing bootstrap
// NEVER persisted — only kept in memory during the login flow
let cachedLoginPassword: string | null = null;
export function getCachedLoginPassword(): string | null { return cachedLoginPassword; }
export function clearCachedLoginPassword(): void { cachedLoginPassword = null; }

interface AuthState {
  credentials: AuthCredentials | null;
  isLoading: boolean;
  error: string | null;
  isRegistering: boolean;
  recoveryKey: string | null; // Temporary, NOT persisted
  registrationFlows: RegistrationFlowInfo | null;
  isLoadingFlows: boolean;
  isSuspended: boolean;

  login: (homeserver: string, username: string, password: string) => Promise<void>;
  register: (homeserver: string, username: string, password: string, displayName?: string, token?: string, captchaResponse?: string) => Promise<void>;
  checkSuspendedStatus: () => Promise<void>;
  fetchRegistrationFlows: (homeserver: string) => Promise<void>;
  restoreSession: () => Promise<void>;
  logout: () => void;
  setLiveKitConfig: (url: string, apiKey: string, apiSecret: string) => void;
  updateCredentials: (partial: Partial<AuthCredentials>) => void;
  setRecoveryKey: (key: string) => void;
  clearError: () => void;
}

function saveCredentials(credentials: AuthCredentials) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}

function loadCredentials(): AuthCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthCredentials;
  } catch {
    return null;
  }
}

function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  credentials: null,
  isLoading: false,
  error: null,
  isRegistering: false,
  recoveryKey: null,
  registrationFlows: null,
  isLoadingFlows: false,
  isSuspended: false,

  login: async (homeserver, username, password) => {
    set({ isLoading: true, error: null });
    try {
      // Cache password for UIA callback during cross-signing bootstrap
      cachedLoginPassword = password;
      const client = await matrixService.initMatrixClient({
        homeserverUrl: homeserver,
        userId: username,
        password,
      });

      const userId = client.getUserId() || username;
      const deviceId = client.getDeviceId() || "";

      // Fetch real display name from profile
      let displayName = userId;
      const profileName = await matrixService.fetchDisplayName(userId);
      if (profileName) displayName = profileName;

      // Fetch avatar URL
      const avatarUrl = await matrixService.getAvatarUrl(userId);

      const credentials: AuthCredentials = {
        homeserverUrl: homeserver,
        userId,
        accessToken: client.getAccessToken() || "",
        deviceId,
        displayName,
        avatarUrl: avatarUrl || undefined,
        ...getLiveKitFromExisting(get().credentials),
      };

      saveCredentials(credentials);
      set({ credentials, isLoading: false });
    } catch (err) {
      set({ error: mapMatrixError(err), isLoading: false });
      throw err;
    }
  },

  register: async (homeserver, username, password, displayName, token, captchaResponse) => {
    set({ isLoading: true, error: null, isRegistering: true });
    try {
      await matrixService.registerUser(homeserver, username, password, displayName, token, captchaResponse);
      set({ isRegistering: false });
      // Auto-login after registration
      await get().login(homeserver, username, password);
      // Check if account was suspended on register
      const suspended = await matrixService.checkSuspended();
      if (suspended) {
        set({ isSuspended: true });
      }
    } catch (err) {
      set({ error: mapMatrixError(err), isLoading: false, isRegistering: false });
      throw err;
    }
  },

  checkSuspendedStatus: async () => {
    const suspended = await matrixService.checkSuspended();
    set({ isSuspended: suspended });
  },

  fetchRegistrationFlows: async (homeserver) => {
    set({ isLoadingFlows: true, registrationFlows: null });
    try {
      const flows = await matrixService.getRegistrationFlows(homeserver);
      set({ registrationFlows: flows, isLoadingFlows: false });
    } catch {
      set({ registrationFlows: null, isLoadingFlows: false });
    }
  },

  restoreSession: async () => {
    const saved = loadCredentials();
    if (!saved || !saved.accessToken) return;

    set({ isLoading: true, error: null });
    try {
      const client = await matrixService.initMatrixClient({
        homeserverUrl: saved.homeserverUrl,
        userId: saved.userId,
        accessToken: saved.accessToken,
        deviceId: saved.deviceId,
      });
      // Update deviceId in credentials if it was missing
      const deviceId = client.getDeviceId();
      if (deviceId && deviceId !== saved.deviceId) {
        saved.deviceId = deviceId;
        saveCredentials(saved);
      }
      // Don't fetch displayName from server here — we keep the local value.
      // It will be pushed to the server AFTER the initial sync completes
      // (see useMatrixStore sync handler) to avoid being overwritten by
      // stale m.room.member events during sync.
      if (!saved.displayName || saved.displayName === saved.userId) {
        const profileName = await matrixService.fetchDisplayName(saved.userId);
        if (profileName) saved.displayName = profileName;
      }
      // Always refresh avatarUrl from server
      const avatarUrl = await matrixService.getAvatarUrl(saved.userId);
      if (avatarUrl) {
        saved.avatarUrl = avatarUrl;
      }
      if (saved.displayName || saved.avatarUrl) {
        saveCredentials(saved);
      }
      set({ credentials: saved, isLoading: false });
      // Check if account is suspended
      const suspended = await matrixService.checkSuspended();
      if (suspended) set({ isSuspended: true });
    } catch (err) {
      clearCredentials();
      set({ error: mapMatrixError(err), isLoading: false, credentials: null });
    }
  },

  logout: () => {
    // Save last homeserver and username for pre-filling the login form
    const creds = get().credentials;
    if (creds) {
      localStorage.setItem("sion_last_homeserver", creds.homeserverUrl);
      localStorage.setItem("sion_last_username", creds.userId);
    }
    // Unregister push before logout
    import("../services/pushService").then(({ unregisterPusher }) => unregisterPusher()).catch(() => {});
    matrixService.logout();
    clearCredentials();
    useAdminStore.getState().reset();
    set({ credentials: null, error: null, recoveryKey: null });
  },

  setLiveKitConfig: (url, apiKey, apiSecret) => {
    const credentials = get().credentials;
    if (!credentials) return;
    const updated = { ...credentials, livekitUrl: url, livekitApiKey: apiKey, livekitApiSecret: apiSecret };
    saveCredentials(updated);
    set({ credentials: updated });
  },

  updateCredentials: (partial) => {
    const credentials = get().credentials;
    if (!credentials) return;
    const updated = { ...credentials, ...partial };
    saveCredentials(updated);
    set({ credentials: updated });
  },

  setRecoveryKey: (key) => set({ recoveryKey: key }),

  clearError: () => set({ error: null }),
}));

/** Map Matrix error codes to i18n keys */
function mapMatrixError(err: unknown): string {
  const e = err as { errcode?: string; data?: { errcode?: string }; message?: string };
  const code = e.errcode || e.data?.errcode;
  const t = i18n.t.bind(i18n);

  switch (code) {
    case "M_USER_IN_USE":
      return t("auth.errorUsernameExists");
    case "M_INVALID_USERNAME":
      return t("auth.errorInvalidUsername");
    case "M_WEAK_PASSWORD":
      return t("auth.errorWeakPassword");
    case "M_EXCLUSIVE":
      return t("auth.errorExclusive");
    case "M_FORBIDDEN":
      return t("auth.errorForbidden");
    case "M_INVALID_TOKEN":
    case "M_UNAUTHORIZED":
      return t("auth.errorInvalidToken");
    case "M_LIMIT_EXCEEDED":
      return t("auth.errorRateLimited");
    case "M_UNKNOWN":
      // Check if it's a connection error
      if (e.message && /fetch|network|ECONNREFUSED/i.test(e.message)) {
        return t("auth.errorServerUnreachable");
      }
      return t("auth.errorGeneric");
    default:
      if (err instanceof Error && /fetch|network|ECONNREFUSED/i.test(err.message)) {
        return t("auth.errorServerUnreachable");
      }
      return err instanceof Error ? err.message : t("auth.errorGeneric");
  }
}

function getLiveKitFromExisting(credentials: AuthCredentials | null) {
  if (!credentials) return {};
  return {
    livekitUrl: credentials.livekitUrl,
    livekitApiKey: credentials.livekitApiKey,
    livekitApiSecret: credentials.livekitApiSecret,
  };
}
