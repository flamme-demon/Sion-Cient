/** @vitest-environment jsdom */
/**
 * Parité entre le moteur JS et le moteur Rust — salons (T1) et messages (T2),
 * docs/plan-matrix-rust-sdk.md — sur un VRAI compte, ignoré par défaut.
 *
 * Fait tourner le vrai `mapRoomToChannel` et le vrai `extractMessagesFromEvents`
 * du moteur JS sur le compte et écrit ce qu'ils produisent ;
 * `sion-matrix/tests/compte_reel.rs` écrit l'équivalent Rust ;
 * `build-scripts/parite-moteurs.sh` compare champ par champ. L'appareil créé
 * est supprimé à la fin.
 *
 *   SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
 *   SION_TEST_SORTIE_SALONS_JS=/chemin/salons-js.json bunx vitest run src/stores/pariteSalons.test.ts
 */
import { describe, it, expect, vi } from "vitest";

// Ce test tourne sous Node (vitest), mais le projet TypeScript de l'appli ne
// charge pas les types de Node : déclarations minimales, locales au fichier.
declare const process: { env: Record<string, string | undefined> };
async function ecrireFichier(chemin: string, donnees: string): Promise<void> {
  const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as {
    writeFileSync(chemin: string, donnees: string): void;
  };
  fs.writeFileSync(chemin, donnees);
}

// Mêmes simulacres que extractVoiceUsers.test.ts : `useMatrixStore` touche ces
// modules à l'import.
// Médias résolus (sinon le moteur JS ignore les messages de médias) ; l'URL
// elle-même n'est pas comparée, elle diffère par construction.
// Le vrai module, sauf les URL de médias (non comparées : elles diffèrent par
// construction) ; ses fonctions servent à T4 et T6 (soundboard, memes).
vi.mock("../services/matrixService", async () => ({
  ...(await vi.importActual<typeof import("../services/matrixService")>("../services/matrixService")),
  mxcToHttp: (mxc: string) => (mxc ? `https://parite/${mxc}` : null),
  mxcToThumbnail: (mxc: string) => (mxc ? `https://parite/vignette/${mxc}` : null),
}));
vi.mock("../services/soundService", () => ({ playMessageReceived: vi.fn() }));
vi.mock("../services/voiceChannelSounds", () => ({
  playPokeCue: vi.fn(), playKickCue: vi.fn(), playMemberKickedCue: vi.fn(), noteKicked: vi.fn(),
}));
vi.mock("../services/adminCommandService", () => ({ findAdminRoom: vi.fn() }));
vi.mock("../utils/messageCache", () => ({
  setCachedRoom: vi.fn(), appendCachedEventIds: vi.fn(), clearCache: vi.fn(),
}));
vi.mock("./useAppStore", () => ({
  useAppStore: { getState: () => ({ clockSkewMin: 0, setClockSkewMin: vi.fn() }), subscribe: vi.fn() },
}));
vi.mock("./useSettingsStore", () => ({ useSettingsStore: { getState: () => ({}), subscribe: vi.fn() } }));

import * as sdk from "matrix-js-sdk";
import { extractMessagesFromEvents, mapRoomToChannel } from "./useMatrixStore";

const SERVEUR = process.env.SION_TEST_SERVEUR;
const ID = process.env.SION_TEST_IDENTIFIANT;
const MDP = process.env.SION_TEST_MOT_DE_PASSE;
const SORTIE = process.env.SION_TEST_SORTIE_SALONS_JS;
const SORTIE_MESSAGES = process.env.SION_TEST_SORTIE_MESSAGES_JS;
const SORTIE_DETAILS = process.env.SION_TEST_SORTIE_DETAILS_JS;
const SORTIE_SONS = process.env.SION_TEST_SORTIE_SONS_JS;

describe.skipIf(!SERVEUR || !ID || !MDP || !SORTIE)("parité des salons (compte réel)", () => {
  it("écrit la liste des salons du moteur JS", async () => {
    const baseUrl = SERVEUR!.startsWith("http") ? SERVEUR! : `https://${SERVEUR}`;
    const connexion = await sdk.createClient({ baseUrl }).loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: ID! },
      password: MDP!,
      initial_device_display_name: "Sion — parité JS",
    });
    const client = sdk.createClient({
      baseUrl,
      accessToken: connexion.access_token,
      userId: connexion.user_id,
      deviceId: connexion.device_id,
    });
    try {
      const pret = new Promise<void>((resoudre) => {
        client.on(sdk.ClientEvent.Sync, (etat) => {
          if (etat === sdk.SyncState.Prepared) resoudre();
        });
      });
      // Crypto en mémoire, comme le vrai Sion : un message chiffré devient un
      // échec de déchiffrement affiché (appareil neuf, sans les clés), à
      // comparer au substitut « 🔒 » du cœur Rust.
      await client.initRustCrypto({ useIndexedDB: false });
      await client.startClient({ initialSyncLimit: 20 });
      await pret;
      const salons = client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .map((r) => mapRoomToChannel(r, client))
        .sort((a, b) => a.id.localeCompare(b.id));
      await ecrireFichier(SORTIE!, JSON.stringify(salons, null, 2));
      if (SORTIE_MESSAGES) {
        // Historique remonté comme `loadRoomHistory` : pages de 30 événements
        // jusqu'à 30 messages affichables, au plus 50 pages.
        const affichable = (e: { getType(): string; getContent(): { msgtype?: string } }) =>
          e.getType() === "m.room.message" || !!e.getContent()?.msgtype;
        const salonsRejoints = client.getRooms().filter((r) => r.getMyMembership() === "join");
        for (const r of salonsRejoints) {
          for (let i = 0; i < 50; i++) {
            // `getEvents()` rend le tableau interne, qui grandit en place.
            const avant = r.getLiveTimeline().getEvents();
            const longueur = avant.length;
            if (avant.filter(affichable).length >= 30) break;
            await client.scrollback(r, 30);
            if (r.getLiveTimeline().getEvents().length === longueur) break;
          }
        }
        const fils = salonsRejoints
          .map((r) => ({
            salon: r.roomId,
            messages: extractMessagesFromEvents(r.getLiveTimeline().getEvents(), r, client),
            epingles: (r.currentState.getStateEvents("m.room.pinned_events", "")?.getContent()?.pinned ?? []) as string[],
            // Les éditions, pour reconnaître celles que le JS affiche en double.
            editions: r
              .getLiveTimeline()
              .getEvents()
              .filter((e) => e.getRelation()?.rel_type === "m.replace")
              .map((e) => e.getId()),
          }))
          .sort((a, b) => a.salon.localeCompare(b.salon));
        await ecrireFichier(SORTIE_MESSAGES, JSON.stringify(fils, null, 2));
      }
      if (SORTIE_DETAILS) {
        // T4 : membres et niveaux par les VRAIES fonctions de matrixService
        // (le module est simulé plus haut pour useMatrixStore).
        const reel = await vi.importActual<typeof import("../services/matrixService")>("../services/matrixService");
        reel.__setMatrixClientForTest(client);
        const details = client
          .getRooms()
          .filter((r) => r.getMyMembership() === "join")
          .map((r) => ({
            salon: r.roomId,
            membres: reel.getRoomMembers(r.roomId).map((m) => ({
              userId: m.userId,
              displayName: m.displayName,
              avatar: !!m.avatarUrl,
              powerLevel: reel.getMemberPowerLevel(r.roomId, m.userId),
            })),
            moi: reel.getUserPowerLevel(r.roomId),
            niveauEtat: reel.getStatePowerLevel(r.roomId),
            niveauInvitation: reel.getInvitePowerLevel(r.roomId),
            peutEcrire: reel.canSendMessage(r.roomId),
            regleAcces: r.getJoinRule() ?? null,
          }));
        reel.__setMatrixClientForTest(null);
        await ecrireFichier(SORTIE_DETAILS, JSON.stringify(details, null, 2));
      }
      if (SORTIE_SONS) {
        // T6 : soundboard et memes par les VRAIES fonctions de l'appli.
        const reel = await vi.importActual<typeof import("../services/matrixService")>("../services/matrixService");
        reel.__setMatrixClientForTest(client);
        const { listSounds } = await import("../services/soundboardService");
        const { listMemes } = await import("../services/memeboardService");
        const resultat = { sons: await listSounds(), memes: await listMemes() };
        reel.__setMatrixClientForTest(null);
        await ecrireFichier(SORTIE_SONS, JSON.stringify(resultat, null, 2));
      }
      expect(salons.length).toBeGreaterThan(0);
    } finally {
      client.stopClient();
      await client.logout(true);
    }
  }, 240_000);
});
