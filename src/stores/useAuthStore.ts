import { create } from "zustand";
import i18n from "../i18n";
import type { AuthCredentials } from "../types/auth";
import * as matrixService from "../services/matrixService";
import type { RegistrationFlowInfo } from "../services/matrixService";
import { useAdminStore } from "./useAdminStore";
import { mirrorSessionToAppData } from "../services/sessionPersist";
import { moteurRust } from "../services/moteur";

const STORAGE_KEY = "sion_auth_credentials";
/** Moteur Rust : clé distincte, sans jeton (il reste dans le cœur), jamais
 *  recopiée hors de la webview (`sessionPersist` ne connaît que la clé JS).
 *  En développement, les deux moteurs partagent le même `localStorage`. */
const STORAGE_KEY_RUST = "sion_auth_credentials_rust";
const cleStockage = () => (moteurRust() ? STORAGE_KEY_RUST : STORAGE_KEY);

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
  /** Moteur Rust : le trousseau du système n'a pas rendu la session (verrouillé,
   *  pas encore prêt). Elle est intacte : on propose de réessayer plutôt que
   *  de se reconnecter, ce qui créerait un nouvel appareil. */
  keyringUnavailable: boolean;

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
  localStorage.setItem(cleStockage(), JSON.stringify(credentials));
  // Mirror outside the webview profile so a localStorage purge
  // doesn't force a re-login. Fire-and-forget; no-op on web.
  if (!moteurRust()) void mirrorSessionToAppData();
}

function loadCredentials(): AuthCredentials | null {
  try {
    const raw = localStorage.getItem(cleStockage());
    if (!raw) return null;
    return JSON.parse(raw) as AuthCredentials;
  } catch {
    return null;
  }
}

function clearCredentials() {
  localStorage.removeItem(cleStockage());
  // Reflect the cleared state in the app-data mirror too (logout must not
  // leave a stale session that re-hydrates on next boot).
  if (!moteurRust()) void mirrorSessionToAppData();
}

/** Moteur Rust : identifiants de l'interface une fois le cœur connecté (après
 *  connexion, inscription ou reprise). Le jeton reste dans le cœur. */
async function identifiantsRust(homeserver: string | undefined, precedents: Partial<AuthCredentials> | null): Promise<AuthCredentials | null> {
  const { etatConnexion } = await import("../services/matrixCore");
  const etat = await etatConnexion();
  // Hors ligne à la reprise : la session est gardée, on repart des derniers
  // identifiants connus.
  const userId = etat.etat === "connecte" ? etat.utilisateur : precedents?.userId;
  if (!userId) return null;
  // Des identifiants d'un AUTRE compte ne servent à rien ici — et leur nom
  // d'affichage finirait poussé sur celui-ci (vu le 27/09 : le compte de test
  // renommé du nom de la session JS, en développement où les deux moteurs
  // partagent le même stockage).
  if (precedents?.userId && precedents.userId !== userId) precedents = null;
  const deviceId = etat.etat === "connecte" ? etat.appareil : (precedents?.deviceId ?? "");
  const displayName = precedents?.displayName && precedents.displayName !== userId
    ? precedents.displayName
    : ((await matrixService.fetchDisplayName(userId)) ?? userId);
  const avatarUrl = (await matrixService.getAvatarUrl(userId)) ?? precedents?.avatarUrl;
  return {
    ...precedents,
    homeserverUrl: homeserver || precedents?.homeserverUrl || `https://${userId.split(":")[1] ?? ""}`,
    userId,
    accessToken: "",
    deviceId,
    displayName,
    avatarUrl: avatarUrl || undefined,
  };
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
  keyringUnavailable: false,

  login: async (homeserver, username, password) => {
    set({ isLoading: true, error: null });
    if (moteurRust()) {
      try {
        cachedLoginPassword = password;
        const core = await import("../services/matrixCore");
        const migration = await import("../services/migrationMoteur");
        let precedents: Partial<AuthCredentials> | null = getLiveKitFromExisting(get().credentials);
        const ancienne = migration.ancienneSession();
        const saisi = username.trim();
        const memeCompte = ancienne !== null
          && (saisi.startsWith("@") ? ancienne.userId === saisi : ancienne.userId.startsWith(`@${saisi}:`));
        if (ancienne && memeCompte) {
          // Étape 4 : le nouvel appareil reprend l'ancien (secrets, clés des
          // salons), puis l'ancien est déconnecté et effacé.
          const exporte = await migration.exporterAncienneSession(ancienne);
          const rapport = await core.connecterMigration(homeserver, username, password, exporte.secrets, exporte.cles);
          const { info } = await import("@tauri-apps/plugin-log");
          void info(`[Sion][migration] ancien appareil ${ancienne.deviceId} repris : secrets ${rapport.secretsImportes ? "oui" : "non"}, clés ${rapport.clesImportees}/${rapport.clesTotal}`).catch(() => {});
          await migration.terminerAncienneSession(ancienne);
          precedents = { ...precedents, displayName: ancienne.displayName, avatarUrl: ancienne.avatarUrl, livekitUrl: ancienne.livekitUrl, livekitApiKey: ancienne.livekitApiKey, livekitApiSecret: ancienne.livekitApiSecret, userId: ancienne.userId };
        } else {
          await core.connecter(homeserver, username, password);
        }
        const credentials = await identifiantsRust(homeserver, precedents);
        if (!credentials) throw new Error("connexion sans utilisateur");
        saveCredentials(credentials);
        set({ credentials, isLoading: false });
      } catch (err) {
        set({ error: mapMatrixError(err), isLoading: false });
        throw err;
      }
      return;
    }
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
    if (moteurRust()) {
      // Le cœur s'inscrit puis se connecte comme nouvel appareil.
      try {
        cachedLoginPassword = password;
        const { inscrire } = await import("../services/matrixCore");
        await inscrire(homeserver, username, password, token, captchaResponse);
        const credentials = await identifiantsRust(homeserver, displayName ? { displayName } : null);
        if (!credentials) throw new Error("inscription sans utilisateur");
        saveCredentials(credentials);
        set({ credentials, isLoading: false, isRegistering: false });
        if (await matrixService.checkSuspended()) set({ isSuspended: true });
      } catch (err) {
        set({ error: mapMatrixError(err), isLoading: false, isRegistering: false });
        throw err;
      }
      return;
    }
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
    if (moteurRust()) {
      // La session fait foi dans le cœur (fichier + coffre du système).
      set({ isLoading: true, error: null, keyringUnavailable: false });
      try {
        const { reprendre } = await import("../services/matrixCore");
        if (!(await reprendre())) {
          clearCredentials();
          set({ isLoading: false, credentials: null });
          return;
        }
        const migration = await import("../services/migrationMoteur");
        const ancienne = migration.ancienneSession();
        // À défaut d'identifiants du moteur Rust, ceux de l'ancien moteur
        // (nom local avec emojis, réglages LiveKit) — écartés par
        // `identifiantsRust` s'ils sont d'un autre compte.
        const precedents = loadCredentials() ?? ancienne;
        const { info } = await import("@tauri-apps/plugin-log");
        void info(`[Sion][auth] reprise (moteur Rust) : identifiants locaux de ${precedents?.userId ?? "personne"}`).catch(() => {});
        const credentials = await identifiantsRust(undefined, precedents);
        if (!credentials) {
          set({ isLoading: false, credentials: null });
          return;
        }
        saveCredentials(credentials);
        set({ credentials, isLoading: false });
        // Une session de l'ancien moteur du MÊME compte qui traîne encore (le
        // cœur avait déjà sa session) : son appareil ne servira plus, il est
        // déconnecté et ses données effacées, comme après une migration.
        if (ancienne && ancienne.userId === credentials.userId && ancienne.deviceId !== credentials.deviceId) {
          void info(`[Sion][migration] ancien appareil ${ancienne.deviceId} retiré (session Rust déjà présente)`).catch(() => {});
          void migration.terminerAncienneSession(ancienne);
        }
        if (await matrixService.checkSuspended().catch(() => false)) set({ isSuspended: true });
      } catch (err) {
        set({ error: mapMatrixError(err), isLoading: false, credentials: null, keyringUnavailable: estTrousseauIndisponible(err) });
      }
      return;
    }
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
    // Plus aucun média déchiffré sur le disque après la déconnexion.
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("vider_medias_temporaires"))
      .catch(() => {});
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

/** Erreur `CoffreIndisponible` du cœur (voir `sion-matrix/src/lib.rs`). */
function estTrousseauIndisponible(err: unknown): boolean {
  return /trousseau du système indisponible/.test(String(err));
}

/** Map Matrix error codes to i18n keys */
function mapMatrixError(err: unknown): string {
  const e = err as { errcode?: string; data?: { errcode?: string }; message?: string };
  // Moteur Rust : l'erreur arrive en texte (« …[403 / M_FORBIDDEN] … »).
  const texte = typeof err === "string" ? err : undefined;
  const code = e.errcode || e.data?.errcode || texte?.match(/\bM_[A-Z_]+\b/)?.[0];
  const t = i18n.t.bind(i18n);

  if (estTrousseauIndisponible(err)) return t("auth.errorKeyringUnavailable");

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
      if (texte && /error sending request|connection refused|dns error|timed out/i.test(texte)) {
        return t("auth.errorServerUnreachable");
      }
      return err instanceof Error ? err.message : (texte ?? t("auth.errorGeneric"));
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
