/**
 * Étape 4 : passage de l'ancien moteur Matrix (matrix-js-sdk, dans la
 * webview) au cœur Rust, au premier lancement de la version qui l'active
 * (docs/plan-matrix-rust-sdk.md).
 *
 * L'ancien appareil vit dans la base IndexedDB du moteur JS, que le cœur ne
 * sait pas lire : ce module l'ouvre une dernière fois pour en exporter le
 * paquet de secrets (signature croisée, clé de sauvegarde) et les clés des
 * salons. Le cœur ouvre un NOUVEL appareil — même `device_id` avec un
 * magasin neuf casserait tout, voir 709af50 — et les importe avant sa
 * première synchro : vérifié d'emblée, historique lisible. L'ancien appareil
 * est ensuite déconnecté et ses données locales effacées.
 *
 * Le mot de passe reste nécessaire : Continuwuity exige une
 * authentification pour délivrer un jeton de connexion (27/09).
 */
import type { MatrixClient } from "matrix-js-sdk";
import type { AuthCredentials } from "../types/auth";

const CLE_ANCIENNE = "sion_auth_credentials";

export interface ExportAncienAppareil {
  /** `exportSecretsBundle()`, `null` si l'ancien appareil n'avait pas les
   *  secrets (jamais vérifié). */
  secrets: Record<string, unknown> | null;
  /** `exportRoomKeysAsJson()`. */
  cles: string | null;
}

/** Session de l'ancien moteur, s'il y en a une. */
export function ancienneSession(): AuthCredentials | null {
  try {
    const c = JSON.parse(localStorage.getItem(CLE_ANCIENNE) ?? "null") as AuthCredentials | null;
    return c?.accessToken && c.userId && c.homeserverUrl && c.deviceId ? c : null;
  } catch {
    return null;
  }
}

/** Paquet de secrets et clés des salons d'un client dont la crypto est prête. */
export async function exporterSecretsEtCles(client: MatrixClient): Promise<ExportAncienAppareil> {
  const crypto = client.getCrypto();
  if (!crypto) return { secrets: null, cles: null };
  const secrets = await (crypto.exportSecretsBundle?.() ?? Promise.resolve(null)).catch((e: unknown) => {
    console.warn("[Sion][migration] pas de secrets à reprendre :", e);
    return null;
  });
  const cles = await crypto.exportRoomKeysAsJson().catch((e: unknown) => {
    console.warn("[Sion][migration] clés de salons non exportées :", e);
    return null;
  });
  return { secrets: secrets as Record<string, unknown> | null, cles };
}

/** Ouvre une dernière fois l'ancien appareil — sans synchro — pour l'export. */
export async function exporterAncienneSession(c: AuthCredentials): Promise<ExportAncienAppareil> {
  const sdk = await import("matrix-js-sdk");
  const client = sdk.createClient({
    baseUrl: c.homeserverUrl,
    accessToken: c.accessToken,
    userId: c.userId,
    deviceId: c.deviceId,
  });
  try {
    // Réglages par défaut : la base qu'utilisait l'ancien moteur.
    await client.initRustCrypto();
    return await exporterSecretsEtCles(client);
  } catch (e) {
    console.warn("[Sion][migration] ancien appareil illisible :", e);
    return { secrets: null, cles: null };
  } finally {
    client.stopClient();
  }
}

/** Déconnecte l'ancien appareil (côté serveur) et efface ses données locales. */
export async function terminerAncienneSession(c: AuthCredentials): Promise<void> {
  await fetch(`${c.homeserverUrl.replace(/\/$/, "")}/_matrix/client/v3/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.accessToken}`, "Content-Type": "application/json" },
    body: "{}",
  }).catch((e) => console.warn("[Sion][migration] ancien appareil non déconnecté :", e));
  localStorage.removeItem(CLE_ANCIENNE);
  localStorage.removeItem("sion_device_id");
  localStorage.removeItem("sion_user_id");
  void import("./sessionPersist").then((m) => m.mirrorSessionToAppData());
  const { clearCryptoStores } = await import("./matrixService");
  await clearCryptoStores();
}
