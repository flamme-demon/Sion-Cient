/**
 * Connexion sur le moteur Rust d'un compte qui a une session de l'ancien
 * moteur (étape 4) : ordre des opérations et garde-fous. Le cœur et l'export
 * eux-mêmes sont éprouvés sur un vrai compte par
 * build-scripts/migration-croisee.sh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const appels: string[] = [];
const ancienne = {
  homeserverUrl: "https://sionchat.fr",
  userId: "@alice:sionchat.fr",
  accessToken: "ancien-jeton",
  deviceId: "ANCIEN",
  displayName: "Alice 🌸",
};
let sessionJs: typeof ancienne | null = ancienne;
let connexionEchoue = false;

vi.mock("../services/moteur", () => ({ moteurRust: () => true }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("./useAdminStore", () => ({ useAdminStore: { getState: () => ({ reset: vi.fn() }) } }));
vi.mock("../services/sessionPersist", () => ({ mirrorSessionToAppData: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(() => Promise.resolve()) }));
vi.mock("../services/matrixService", () => ({
  fetchDisplayName: vi.fn(async () => "Alice (serveur)"),
  getAvatarUrl: vi.fn(async () => null),
  checkSuspended: vi.fn(async () => false),
}));
vi.mock("../services/migrationMoteur", () => ({
  ancienneSession: () => sessionJs,
  exporterAncienneSession: vi.fn(async () => {
    appels.push("export");
    return { secrets: { cross_signing: {} }, cles: "[]" };
  }),
  terminerAncienneSession: vi.fn(async () => {
    appels.push("terminer");
  }),
}));
vi.mock("../services/matrixCore", () => ({
  connecter: vi.fn(async () => {
    appels.push("connecter");
    if (connexionEchoue) throw new Error("M_FORBIDDEN");
  }),
  connecterMigration: vi.fn(async () => {
    appels.push("connecterMigration");
    if (connexionEchoue) throw new Error("M_FORBIDDEN");
    return { secretsImportes: true, clesImportees: 3, clesTotal: 3 };
  }),
  etatConnexion: vi.fn(async () => ({ etat: "connecte", utilisateur: "@alice:sionchat.fr", appareil: "NOUVEAU" })),
  reprendre: vi.fn(async () => true),
}));

// localStorage simulé (l'environnement de test n'en fournit pas ici).
const stockage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stockage[k] ?? null,
    setItem: (k: string, v: string) => { stockage[k] = v; },
    removeItem: (k: string) => { delete stockage[k]; },
    clear: () => { for (const k of Object.keys(stockage)) delete stockage[k]; },
  },
});

const { useAuthStore } = await import("./useAuthStore");

beforeEach(() => {
  appels.length = 0;
  sessionJs = ancienne;
  connexionEchoue = false;
  localStorage.clear();
  useAuthStore.setState({ credentials: null, error: null, isLoading: false });
});

describe("migration à la connexion (moteur Rust)", () => {
  it("même compte : export, connexion qui importe, puis fin de l'ancien appareil", async () => {
    await useAuthStore.getState().login("https://sionchat.fr", "alice", "mdp");
    expect(appels).toEqual(["export", "connecterMigration", "terminer"]);
    const c = useAuthStore.getState().credentials!;
    expect(c.userId).toBe("@alice:sionchat.fr");
    expect(c.deviceId).toBe("NOUVEAU");
    // Le nom local de l'ancien moteur (emojis compris) est gardé.
    expect(c.displayName).toBe("Alice 🌸");
    expect(c.accessToken).toBe("");
  });

  it("identifiant complet reconnu aussi", async () => {
    await useAuthStore.getState().login("https://sionchat.fr", "@alice:sionchat.fr", "mdp");
    expect(appels).toEqual(["export", "connecterMigration", "terminer"]);
  });

  it("autre compte : connexion normale, l'ancienne session reste intacte", async () => {
    await useAuthStore.getState().login("https://sionchat.fr", "bob", "mdp").catch(() => {});
    expect(appels).toEqual(["connecter"]);
  });

  it("mot de passe refusé : l'ancien appareil n'est PAS supprimé", async () => {
    connexionEchoue = true;
    await expect(useAuthStore.getState().login("https://sionchat.fr", "alice", "faux")).rejects.toThrow();
    expect(appels).toEqual(["export", "connecterMigration"]);
    expect(useAuthStore.getState().credentials).toBeNull();
  });

  it("pas d'ancienne session : connexion normale", async () => {
    sessionJs = null;
    await useAuthStore.getState().login("https://sionchat.fr", "alice", "mdp");
    expect(appels).toEqual(["connecter"]);
  });

  it("reprise d'une session Rust : l'ancienne du même compte est retirée", async () => {
    await useAuthStore.getState().restoreSession();
    await new Promise((r) => setTimeout(r, 0));
    expect(appels).toEqual(["terminer"]);
    // Nom local repris de l'ancien moteur.
    expect(useAuthStore.getState().credentials?.displayName).toBe("Alice 🌸");
  });

  it("reprise : l'ancienne session d'un AUTRE compte n'est pas touchée", async () => {
    sessionJs = { ...ancienne, userId: "@bob:sionchat.fr" };
    await useAuthStore.getState().restoreSession();
    await new Promise((r) => setTimeout(r, 0));
    expect(appels).toEqual([]);
  });
});
