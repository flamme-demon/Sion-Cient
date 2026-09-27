/**
 * Vérification par emojis ENTRE LES DEUX MOTEURS, sur un vrai compte — côté
 * JS. Ignoré sans `SION_TEST_ECHANGE` ; lancé par
 * `build-scripts/verification-croisee.sh` avec
 * `src-tauri/sion-matrix/tests/verification_croisee.rs`.
 *
 * C'est le cas de la migration : l'appareil JS habituel, déjà vérifié (ici par
 * la clé de récupération, comme `restoreKeyBackup`), accepte la demande du
 * NOUVEL appareil sur le moteur Rust, comme le fait `useMatrixStore` à la
 * réception d'une demande ; les deux comparent les mêmes emojis et confirment.
 */
import { describe, it, expect } from "vitest";
import * as sdk from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent } from "matrix-js-sdk/lib/crypto-api";
import type { ShowSasCallbacks, VerificationRequest } from "matrix-js-sdk/lib/crypto-api";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";

declare const process: { env: Record<string, string | undefined> };
type Fs = {
  writeFileSync(chemin: string, donnees: string): void;
  readFileSync(chemin: string, codage: string): string;
  renameSync(de: string, vers: string): void;
};
const fs = async () => (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;

const SERVEUR = process.env.SION_TEST_SERVEUR;
const ID = process.env.SION_TEST_IDENTIFIANT;
const MDP = process.env.SION_TEST_MOT_DE_PASSE;
const CLE = process.env.SION_TEST_CLE_RECUPERATION;
const ECHANGE = process.env.SION_TEST_ECHANGE;
const ATTENTE_MS = 120_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ecrire(nom: string, valeur: unknown): Promise<void> {
  const f = await fs();
  f.writeFileSync(`${ECHANGE}/${nom}.tmp`, JSON.stringify(valeur));
  f.renameSync(`${ECHANGE}/${nom}.tmp`, `${ECHANGE}/${nom}`);
}

async function attendreFichier<T>(nom: string): Promise<T> {
  const f = await fs();
  const fin = Date.now() + ATTENTE_MS;
  while (Date.now() < fin) {
    try {
      return JSON.parse(f.readFileSync(`${ECHANGE}/${nom}`, "utf8")) as T;
    } catch {
      await pause(300);
    }
  }
  throw new Error(`${nom} jamais écrit`);
}

describe.skipIf(!SERVEUR || !ID || !MDP || !CLE || !ECHANGE)("vérification par emojis moteur JS ↔ moteur Rust", () => {
  it("l'appareil JS vérifié accepte et vérifie le nouvel appareil Rust", async () => {
    const baseUrl = SERVEUR!.startsWith("http") ? SERVEUR! : `https://${SERVEUR}`;
    const connexion = await sdk.createClient({ baseUrl }).loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: ID! },
      password: MDP!,
      initial_device_display_name: "Sion — vérification croisée (JS)",
    });
    const cleSecrets = decodeRecoveryKey(CLE!);
    const client: MatrixClient = sdk.createClient({
      baseUrl,
      accessToken: connexion.access_token,
      userId: connexion.user_id,
      deviceId: connexion.device_id,
      // Comme `cryptoCallbacks` de matrixService : la clé de récupération
      // ouvre le stockage de secrets.
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
      // Dans l'appli, l'identité publique du compte est déjà téléchargée
      // quand l'utilisateur saisit sa clé ; ici, juste après la synchro, non.
      expect(await crypto.userHasCrossSigningKeys(client.getUserId()!, true)).toBe(true);
      // `restoreKeyBackup` : signature croisée depuis le stockage de secrets.
      await crypto.bootstrapCrossSigning({});
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      expect((await crypto.getUserVerificationStatus(client.getUserId()!)).isVerified()).toBe(true);

      // Demande entrante : même logique que useMatrixStore.
      const demande = new Promise<VerificationRequest>((resoudre) => {
        client.on(CryptoEvent.VerificationRequestReceived, (req: VerificationRequest) => {
          if (req.otherUserId === client.getUserId()) resoudre(req);
        });
      });
      await ecrire("js-pret.json", { appareil: client.getDeviceId() });

      const req = await demande;
      await req.accept();
      const sas = await new Promise<ShowSasCallbacks>((resoudre, rejeter) => {
        const suivre = () => {
          if (req.phase === VerificationPhase.Started && req.verifier) {
            req.off(VerificationRequestEvent.Change, suivre);
            const verifier = req.verifier;
            verifier.on(VerifierEvent.ShowSas, resoudre);
            verifier.verify().catch(rejeter);
          } else if (req.phase === VerificationPhase.Cancelled) {
            rejeter(new Error("demande annulée"));
          }
        };
        req.on(VerificationRequestEvent.Change, suivre);
        suivre();
      });
      const emojis = (sas.sas.emoji ?? []).map(([emoji, nom]) => ({ emoji, name: nom }));
      await ecrire("js-emojis.json", emojis);
      const rust = await attendreFichier<{ emoji: string; name: string }[]>("rust-emojis.json");
      expect(rust).toEqual(emojis);
      await sas.confirm();
      const verdict = await attendreFichier<{ ok?: boolean; erreur?: string }>("rust-verifie.json");
      expect(verdict.erreur ?? null).toBeNull();
    } catch (e) {
      await ecrire("js-emojis.json", { erreur: String(e) }).catch(() => {});
      throw e;
    } finally {
      await client.logout(true).catch(() => {});
      client.stopClient();
    }
  }, 300_000);
});
