/**
 * Aller-retour ENTRE LES DEUX MOTEURS sur un vrai compte (critère de T3,
 * docs/plan-matrix-rust-sdk.md) — côté JS. Ignoré sans `SION_TEST_ECHANGE` ;
 * lancé par `build-scripts/aller-retour.sh` en même temps que
 * `src-tauri/sion-matrix/tests/aller_retour.rs`, qui décrit le déroulé.
 *
 * Les envois passent par les VRAIES fonctions de `matrixService.ts` (client
 * injecté), la lecture par le vrai `extractMessagesFromEvents`, avec la crypto
 * comme dans Sion : le salon de test est chiffré.
 */
import { describe, it, expect, vi } from "vitest";

declare const process: { env: Record<string, string | undefined> };
type Fs = {
  writeFileSync(chemin: string, donnees: string): void;
  readFileSync(chemin: string, codage: string): string;
  renameSync(de: string, vers: string): void;
};
const fs = async () => (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;

// `useMatrixStore` touche ces modules à l'import (voir pariteSalons.test.ts).
// `matrixService`, lui, est le vrai.
vi.mock("./soundService", () => ({ playMessageReceived: vi.fn() }));
vi.mock("./voiceChannelSounds", () => ({
  playPokeCue: vi.fn(), playKickCue: vi.fn(), playMemberKickedCue: vi.fn(), noteKicked: vi.fn(),
}));
vi.mock("./adminCommandService", () => ({ findAdminRoom: vi.fn() }));
vi.mock("../utils/messageCache", () => ({
  setCachedRoom: vi.fn(), appendCachedEventIds: vi.fn(), clearCache: vi.fn(),
}));
vi.mock("../stores/useAppStore", () => ({
  useAppStore: { getState: () => ({ clockSkewMin: 0, setClockSkewMin: vi.fn() }), subscribe: vi.fn() },
}));
vi.mock("../stores/useSettingsStore", () => ({ useSettingsStore: { getState: () => ({}), subscribe: vi.fn() } }));

import * as sdk from "matrix-js-sdk";
import type { MatrixClient, Room } from "matrix-js-sdk";
import * as service from "./matrixService";
import { extractMessagesFromEvents } from "../stores/useMatrixStore";
import type { ChatMessage } from "../types/matrix";

const SERVEUR = process.env.SION_TEST_SERVEUR;
const ID = process.env.SION_TEST_IDENTIFIANT;
const MDP = process.env.SION_TEST_MOT_DE_PASSE;
const ECHANGE = process.env.SION_TEST_ECHANGE;
const ATTENTE_MS = 180_000;

/** Même PNG 1×1 que le test Rust. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ecrire(nom: string, valeur: unknown): Promise<void> {
  const f = await fs();
  f.writeFileSync(`${ECHANGE}/${nom}.tmp`, JSON.stringify(valeur, null, 2));
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

/** Répète `verifier` jusqu'à ce qu'il ne lève plus ; la dernière erreur sinon. */
async function attendre(verifier: () => void | Promise<void>): Promise<void> {
  const fin = Date.now() + ATTENTE_MS;
  let derniere: unknown = null;
  while (Date.now() < fin) {
    try {
      await verifier();
      return;
    } catch (e) {
      derniere = e;
      await pause(500);
    }
  }
  throw derniere;
}

function exiger(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Identifiant du dernier événement du fil qui satisfait `critere` (les
 *  fonctions d'envoi de `matrixService` ne le rendent pas toutes). */
function dernier(salon: Room, critere: (contenu: Record<string, unknown>, type: string) => boolean): string {
  const evenements = salon.getLiveTimeline().getEvents();
  for (let i = evenements.length - 1; i >= 0; i--) {
    const e = evenements[i];
    if (critere(e.getContent(), e.getType())) {
      const id = e.getId();
      if (id?.startsWith("$")) return id;
    }
  }
  throw new Error("envoi introuvable dans le fil");
}

describe.skipIf(!SERVEUR || !ID || !MDP || !ECHANGE)("aller-retour moteur Rust ↔ moteur JS (compte réel)", () => {
  it("lit les envois du moteur Rust et lui envoie la même série", async () => {
    const baseUrl = SERVEUR!.startsWith("http") ? SERVEUR! : `https://${SERVEUR}`;
    const connexion = await sdk.createClient({ baseUrl }).loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: ID! },
      password: MDP!,
      initial_device_display_name: "Sion — aller-retour (JS)",
    });
    const client: MatrixClient = sdk.createClient({
      baseUrl,
      accessToken: connexion.access_token,
      userId: connexion.user_id,
      deviceId: connexion.device_id,
    });
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      const pret = new Promise<void>((resoudre) => {
        client.on(sdk.ClientEvent.Sync, (etat) => {
          if (etat === sdk.SyncState.Prepared) resoudre();
        });
      });
      await client.startClient({ initialSyncLimit: 20 });
      await pret;
      service.__setMatrixClientForTest(client);
      const moi = client.getUserId()!;
      await ecrire("js-pret.json", { appareil: client.getDeviceId() });

      const { appareil: appareilRust } = await attendreFichier<{ appareil: string }>("rust-pret.json");
      const { salon: idSalon, nonce, nom } = await attendreFichier<{ salon: string; nonce: string; nom: string }>("salon.json");
      const envois = await attendreFichier<Record<string, string>>("rust-envois.json");
      let salon: Room | null = null;
      await attendre(() => {
        salon = client.getRoom(idSalon);
        exiger(salon?.getMyMembership() === "join", "salon de test pas encore reçu");
      });
      const s = salon as unknown as Room;
      const messages = (): ChatMessage[] => extractMessagesFromEvents(s.getLiveTimeline().getEvents(), s, client);
      const trouver = (id: string) => messages().find((m) => m.eventId === id);

      // ── 1. Lecture des envois du moteur Rust ───────────────────────────────
      await attendre(() => {
        const r0 = trouver(envois.r0);
        exiger(r0?.formattedBody?.includes("https://matrix.to/#/"), `mention Rust : ${r0?.formattedBody}`);
        const r1 = trouver(envois.r1);
        exiger(r1?.text === `R1 ${nonce} bonjour (corrigé)` && r1.edited, `édition Rust : ${r1?.text}`);
        exiger(trouver(envois.reponse)?.replyTo?.eventId === envois.r1, "réponse Rust mal rattachée");
        exiger(r1.reactions?.some((r) => r.emoji === "👍"), "réaction Rust absente");
        exiger(trouver(envois.poke)?.msgtype === "m.poke", "poke Rust absent");
        const sondage = trouver(envois.sondage)?.poll;
        exiger(sondage?.ended && JSON.stringify(sondage.votes[moi]) === '["0"]', "sondage Rust incomplet");
        const piece = trouver(envois.fichier)?.attachments?.[0];
        exiger(piece?.name === "rust.png" && piece.mimeType === "image/png", "fichier Rust absent");
        // Salon chiffré : le moteur Rust chiffre le fichier (clés dans `file`).
        exiger(piece.encryptedFile, "fichier Rust non chiffré");
        exiger(!trouver(envois.supprime), "message supprimé par Rust encore affiché");
        const epingles = s.currentState.getStateEvents("m.room.pinned_events", "")?.getContent()?.pinned ?? [];
        exiger(epingles.includes(envois.r1), "épinglage Rust absent");
      });

      // Le moteur JS ne chiffre qu'en connaissant l'appareil Rust.
      await attendre(async () => {
        const appareils = await client.getCrypto()!.getUserDeviceInfo([moi], true);
        exiger(appareils.get(moi)?.has(appareilRust), "appareil Rust inconnu");
      });

      // ── 2. Envois du moteur JS, par les fonctions de l'appli ───────────────
      await service.sendTextMessage(idSalon, `J0 ${nonce} coucou @${nom}`);
      const j1 = (await service.sendTextMessage(idSalon, `J1 ${nonce} salut`)).event_id;
      await service.sendReply(idSalon, envois.r1, `J2 ${nonce} réponse`);
      await service.editMessage(idSalon, j1, `J1 ${nonce} salut (corrigé)`);
      await service.sendReaction(idSalon, envois.r1, "🎉");
      await service.sendPoke(idSalon);
      const poke = dernier(s, (c) => c.msgtype === "m.poke");
      await service.createPoll(idSalon, `J-sondage ${nonce} ?`, ["A", "B"]);
      await attendre(() => void dernier(s, (_c, type) => type === "m.poll.start"));
      const sondage = dernier(s, (_c, type) => type === "m.poll.start");
      await service.votePoll(idSalon, sondage, ["1"]);
      await service.endPoll(idSalon, sondage);
      // Le `File` de jsdom : matrix-js-sdk téléverse par le `XMLHttpRequest`
      // de jsdom, qui réduirait un `File` de Node à « [object File] ».
      await service.sendFileMessage(idSalon, new File([PNG], "js.png", { type: "image/png" }));
      const aSupprimer = (await service.sendTextMessage(idSalon, `J-à-supprimer ${nonce}`)).event_id;
      await service.redactMessage(idSalon, aSupprimer);
      // Bascule : Rust l'avait épinglé, le JS le désépingle.
      await service.pinMessage(idSalon, envois.r1);
      await ecrire("js-envois.json", { poke, sondage, j1 });

      const verdict = await attendreFichier<{ ok?: boolean; erreur?: string }>("rust-verifie.json");
      expect(verdict.erreur ?? null).toBeNull();
    } catch (e) {
      await ecrire("js-envois.json", { erreur: String(e) }).catch(() => {});
      throw e;
    } finally {
      service.__setMatrixClientForTest(null);
      await client.logout(true).catch(() => {});
      client.stopClient();
    }
  }, 600_000);
});
