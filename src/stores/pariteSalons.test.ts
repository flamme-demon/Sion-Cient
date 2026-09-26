/** @vitest-environment jsdom */
/**
 * Parité des salons entre le moteur JS et le moteur Rust (T1,
 * docs/plan-matrix-rust-sdk.md) — sur un VRAI compte, ignoré par défaut.
 *
 * Fait tourner le vrai `mapRoomToChannel` du moteur JS sur le compte et écrit
 * la liste obtenue ; `sion-matrix/tests/compte_reel.rs` écrit la sienne ; un
 * script les compare champ par champ. L'appareil créé est supprimé à la fin.
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
vi.mock("../services/matrixService", () => ({ mxcToHttp: vi.fn() }));
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
import { mapRoomToChannel } from "./useMatrixStore";

const SERVEUR = process.env.SION_TEST_SERVEUR;
const ID = process.env.SION_TEST_IDENTIFIANT;
const MDP = process.env.SION_TEST_MOT_DE_PASSE;
const SORTIE = process.env.SION_TEST_SORTIE_SALONS_JS;

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
      await client.startClient({ initialSyncLimit: 20 });
      await pret;
      const salons = client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .map((r) => mapRoomToChannel(r, client))
        .sort((a, b) => a.id.localeCompare(b.id));
      await ecrireFichier(SORTIE!, JSON.stringify(salons, null, 2));
      expect(salons.length).toBeGreaterThan(0);
    } finally {
      client.stopClient();
      await client.logout(true);
    }
  }, 90_000);
});
