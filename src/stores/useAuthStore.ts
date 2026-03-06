import { create } from "zustand";
import type { AuthCredentials } from "../types/auth";
import * as matrixService from "../services/matrixService";
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

  login: (homeserver: string, username: string, password: string) => Promise<void>;
  register: (homeserver: string, username: string, password: string, displayName?: string) => Promise<void>;
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
      const message = err instanceof Error ? err.message : "Une erreur est survenue";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  register: async (homeserver, username, password, displayName) => {
    set({ isLoading: true, error: null, isRegistering: true });
    try {
      await matrixService.registerUser(homeserver, username, password, displayName);
      set({ isRegistering: false });
      // Auto-login after registration
      await get().login(homeserver, username, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Une erreur est survenue";
      set({ error: message, isLoading: false, isRegistering: false });
      throw err;
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
      // Update displayName if missing
      if (!saved.displayName || saved.displayName === saved.userId) {
        const profileName = await matrixService.fetchDisplayName(saved.userId);
        if (profileName) {
          saved.displayName = profileName;
        }
      }
      // Update avatarUrl if missing
      if (!saved.avatarUrl) {
        const avatarUrl = await matrixService.getAvatarUrl(saved.userId);
        if (avatarUrl) {
          saved.avatarUrl = avatarUrl;
        }
      }
      if (saved.displayName || saved.avatarUrl) {
        saveCredentials(saved);
      }
      set({ credentials: saved, isLoading: false });
    } catch (err) {
      clearCredentials();
      const message = err instanceof Error ? err.message : "Session expirée";
      set({ error: message, isLoading: false, credentials: null });
    }
  },

  logout: () => {
    // Save last homeserver and username for pre-filling the login form
    const creds = get().credentials;
    if (creds) {
      localStorage.setItem("sion_last_homeserver", creds.homeserverUrl);
      localStorage.setItem("sion_last_username", creds.userId);
    }
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

function getLiveKitFromExisting(credentials: AuthCredentials | null) {
  if (!credentials) return {};
  return {
    livekitUrl: credentials.livekitUrl,
    livekitApiKey: credentials.livekitApiKey,
    livekitApiSecret: credentials.livekitApiSecret,
  };
}
