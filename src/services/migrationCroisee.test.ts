/**
 * Migration de l'ancien moteur vers le cœur Rust (étape 4), sur un vrai
 * compte — côté JS. Ignoré sans `SION_TEST_ECHANGE` ; lancé par
 * `build-scripts/migration-croisee.sh` avec
 * `src-tauri/sion-matrix/tests/migration_croisee.rs`.
 *
 * Un appareil sur matrix-js-sdk, vérifié comme celui d'un utilisateur (clé de
 * récupération) et nanti des clés de la sauvegarde, fait l'export que fera
 * `migrationMoteur.ts` : paquet de secrets et clés des salons.
 */
import { describe, it, expect } from "vitest";
import * as sdk from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { exporterSecretsEtCles } from "./migrationMoteur";

declare const process: { env: Record<string, string | undefined> };
type Fs = { writeFileSync(c: string, d: string): void; readFileSync(c: string, e: string): string; renameSync(a: string, b: string): void };
const fs = async () => (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;

const SERVEUR = process.env.SION_TEST_SERVEUR;
const ID = process.env.SION_TEST_IDENTIFIANT;
const MDP = process.env.SION_TEST_MOT_DE_PASSE;
const CLE = process.env.SION_TEST_CLE_RECUPERATION;
const ECHANGE = process.env.SION_TEST_ECHANGE;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ecrire(nom: string, valeur: unknown): Promise<void> {
  const f = await fs();
  f.writeFileSync(`${ECHANGE}/${nom}.tmp`, JSON.stringify(valeur));
  f.renameSync(`${ECHANGE}/${nom}.tmp`, `${ECHANGE}/${nom}`);
}

async function attendreFichier<T>(nom: string): Promise<T> {
  const f = await fs();
  const fin = Date.now() + 180_000;
  while (Date.now() < fin) {
    try {
      return JSON.parse(f.readFileSync(`${ECHANGE}/${nom}`, "utf8")) as T;
    } catch {
      await pause(300);
    }
  }
  throw new Error(`${nom} jamais écrit`);
}

describe.skipIf(!SERVEUR || !ID || !MDP || !CLE || !ECHANGE)("migration moteur JS → cœur Rust (compte réel)", () => {
  it("l'ancien appareil exporte secrets et clés de salons", async () => {
    const baseUrl = SERVEUR!.startsWith("http") ? SERVEUR! : `https://${SERVEUR}`;
    const connexion = await sdk.createClient({ baseUrl }).loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: ID! },
      password: MDP!,
      initial_device_display_name: "Sion — migration (ancien moteur)",
    });
    const cleSecrets = decodeRecoveryKey(CLE!);
    const client: MatrixClient = sdk.createClient({
      baseUrl,
      accessToken: connexion.access_token,
      userId: connexion.user_id,
      deviceId: connexion.device_id,
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          const id = Object.keys(keys)[0];
          return id ? [id, cleSecrets] : null;
        },
      },
    });
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      const pret = new Promise<void>((resoudre) => {
        client.on(sdk.ClientEvent.Sync, (etat) => {
          if (etat === sdk.SyncState.Prepared) resoudre();
        });
      });
      await client.startClient({ initialSyncLimit: 1 });
      await pret;
      const crypto = client.getCrypto()!;
      // Comme un utilisateur vérifié : signature croisée, sauvegarde restaurée.
      expect(await crypto.userHasCrossSigningKeys(client.getUserId()!, true)).toBe(true);
      await crypto.bootstrapCrossSigning({});
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      const restaure = await crypto.restoreKeyBackup({});

      // L'export que fera l'appli au premier lancement de la beta 2 (avant
      // `stopClient`, qui ferme la machine de chiffrement).
      const exporte = await exporterSecretsEtCles(client);
      expect(exporte.secrets).not.toBeNull();
      const nbCles = JSON.parse(exporte.cles ?? "[]").length;
      console.log(`export : secrets ${exporte.secrets ? "oui" : "non"}, ${nbCles} clé(s) de salons (sauvegarde : ${restaure.imported})`);
      expect(nbCles).toBeGreaterThan(0);
      await ecrire("export.json", exporte);
      const fin = await attendreFichier<{ ok?: boolean; erreur?: string }>("rust-fini.json");
      expect(fin.erreur ?? null).toBeNull();
    } finally {
      await client.logout(true).catch(() => {});
      client.stopClient();
    }
  }, 300_000);
});
