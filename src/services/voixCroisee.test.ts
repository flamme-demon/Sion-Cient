/**
 * La voix ENTRE LES DEUX MOTEURS, sur un vrai compte — côté JS. Ignoré sans
 * `SION_TEST_ECHANGE` ; lancé par `build-scripts/voix-croisee.sh` avec
 * `src-tauri/sion-matrix/tests/voix_croisee.rs`, qui décrit le déroulé.
 *
 * C'est le vrai `MatrixRTCSession` de matrix-js-sdk, réglé comme dans
 * `useVoiceChannel` : l'appareil Rust doit y apparaître comme participant et
 * les clés doivent passer dans les deux sens, sous les identités LiveKit.
 */
import { describe, it, expect } from "vitest";
import * as sdk from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc";

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
const ECHANGE = process.env.SION_TEST_ECHANGE;
const ATTENTE_MS = 120_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (o: Uint8Array) => btoa(String.fromCharCode(...o));

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

async function attendre<T>(quoi: string, essai: () => T | undefined): Promise<T> {
  const fin = Date.now() + ATTENTE_MS;
  while (Date.now() < fin) {
    const v = essai();
    if (v !== undefined) return v;
    await pause(250);
  }
  throw new Error(`${quoi} : jamais arrivé`);
}

describe.skipIf(!SERVEUR || !ID || !MDP || !ECHANGE)("voix moteur JS ↔ moteur Rust (compte réel)", () => {
  it("échange les clés avec l'appareil Rust dans un appel MatrixRTC", async () => {
    const baseUrl = SERVEUR!.startsWith("http") ? SERVEUR! : `https://${SERVEUR}`;
    const connexion = await sdk.createClient({ baseUrl }).loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: ID! },
      password: MDP!,
      initial_device_display_name: "Sion — voix croisée (JS)",
    });
    const client: MatrixClient = sdk.createClient({
      baseUrl,
      accessToken: connexion.access_token,
      userId: connexion.user_id,
      deviceId: connexion.device_id,
    });
    let session: ReturnType<MatrixClient["matrixRTC"]["getRoomSession"]> | null = null;
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      const pret = new Promise<void>((resoudre) => {
        client.on(sdk.ClientEvent.Sync, (etat) => {
          if (etat === sdk.SyncState.Prepared) resoudre();
        });
      });
      await client.startClient({ initialSyncLimit: 1 });
      await pret;
      const moi = client.getUserId()!;
      const identite = `${moi}:${client.getDeviceId()}`;
      await ecrire("js-pret.json", { appareil: client.getDeviceId() });
      const { salon: idSalon, appareil: appareilRust } = await attendreFichier<{ salon: string; appareil: string }>("salon.json");
      const identiteRust = `${moi}:${appareilRust}`;
      const salon = await attendre("salon de test", () => client.getRoom(idSalon) ?? undefined);

      // Comme useVoiceChannel : clés d'appareils à jour, puis la session.
      await client.getCrypto()!.getUserDeviceInfo(salon.getJoinedMembers().map((m) => m.userId), true);
      const cles = new Map<string, { index: number; cle: string }>();
      session = client.matrixRTC.getRoomSession(salon);
      session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (cle: Uint8Array, index: number, _m: unknown, qui: string) => {
        cles.set(qui, { index, cle: b64(cle) });
      });
      session.joinRoomSession(
        [{ type: "livekit", livekit_service_url: "https://livekit.sionchat.fr", livekit_alias: idSalon }],
        undefined,
        { membershipEventExpiryMs: 3_600_000, manageMediaKeys: true },
      );
      await ecrire("js-joint.json", { identite });

      // L'appareil Rust est un participant valable pour le SDK JS…
      const s = session;
      await attendre("appartenance Rust lue par le SDK JS", () =>
        s.memberships.find((m) => m.sender === moi && m.deviceId === appareilRust && m.rtcBackendIdentity === identiteRust),
      );
      // … et sa clé arrive sous son identité.
      const recue = await attendre("clé de l'appareil Rust", () => cles.get(identiteRust));
      const propre = await attendre("clé propre", () => cles.get(identite));
      const rust = await attendreFichier<{ identite: string; propre: { index: number; cle: string } }>("rust-cles.json");
      expect(rust.identite).toBe(identiteRust);
      // La clé courante du Rust est celle que le JS a reçue.
      await attendre("clé courante du Rust reçue", () => {
        const c = cles.get(identiteRust);
        return c && c.index === rust.propre.index && c.cle === rust.propre.cle ? true : undefined;
      });
      await ecrire("js-cles.json", { identite, propre: cles.get(identite) ?? propre, recue });
      const fin = await attendreFichier<{ ok?: boolean; erreur?: string }>("rust-fini.json");
      expect(fin.erreur ?? null).toBeNull();
    } catch (e) {
      await ecrire("js-cles.json", { erreur: String(e) }).catch(() => {});
      throw e;
    } finally {
      await ecrire("js-fini.json", {}).catch(() => {});
      await session?.leaveRoomSession(3000).catch(() => {});
      await client.logout(true).catch(() => {});
      client.stopClient();
    }
  }, 300_000);
});
