/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eviterSynchroCryptoInutile } from "./matrixService";

// Faux RustCrypto : seules comptent les deux entrées que la boucle /sync
// appelle à chaque réponse. Chaque appel réel coûtait un deep_clone du compte
// Olm (0,4 à 0,9 s de fil principal mesurés le 26/09) — le filtre ne doit
// laisser passer que ce qui change.
function fauxCrypto() {
  const compteurs = vi.fn().mockResolvedValue(undefined);
  const appareils = vi.fn().mockResolvedValue(undefined);
  const crypto = { processKeyCounts: compteurs, processDeviceLists: appareils };
  eviterSynchroCryptoInutile(crypto);
  return { crypto, compteurs, appareils };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("eviterSynchroCryptoInutile — compteurs de clés", () => {
  it("transmet la première réponse puis ignore les compteurs identiques", async () => {
    const { crypto, compteurs } = fauxCrypto();
    await crypto.processKeyCounts({ signed_curve25519: 50 }, ["signed_curve25519"]);
    await crypto.processKeyCounts({ signed_curve25519: 50 }, ["signed_curve25519"]);
    await crypto.processKeyCounts({ signed_curve25519: 50 }, ["signed_curve25519"]);
    expect(compteurs).toHaveBeenCalledTimes(1);
  });

  it("transmet dès qu'un compteur bouge — le compte doit pouvoir regénérer ses clés", async () => {
    const { crypto, compteurs } = fauxCrypto();
    await crypto.processKeyCounts({ signed_curve25519: 50 }, ["signed_curve25519"]);
    await crypto.processKeyCounts({ signed_curve25519: 49 }, ["signed_curve25519"]);
    expect(compteurs).toHaveBeenCalledTimes(2);
    expect(compteurs).toHaveBeenLastCalledWith({ signed_curve25519: 49 }, ["signed_curve25519"]);
  });

  it("transmet quand la clé de secours est consommée", async () => {
    const { crypto, compteurs } = fauxCrypto();
    await crypto.processKeyCounts({ signed_curve25519: 50 }, ["signed_curve25519"]);
    await crypto.processKeyCounts({ signed_curve25519: 50 }, []);
    expect(compteurs).toHaveBeenCalledTimes(2);
  });

  it("repasse tout de même au bout de 10 min, par sécurité", async () => {
    const { crypto, compteurs } = fauxCrypto();
    await crypto.processKeyCounts({ signed_curve25519: 50 }, undefined);
    vi.advanceTimersByTime(9 * 60_000);
    await crypto.processKeyCounts({ signed_curve25519: 50 }, undefined);
    expect(compteurs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60_000);
    await crypto.processKeyCounts({ signed_curve25519: 50 }, undefined);
    expect(compteurs).toHaveBeenCalledTimes(2);
  });

  it("réessaie à la réponse suivante si la crypto a échoué", async () => {
    const { crypto, compteurs } = fauxCrypto();
    compteurs.mockRejectedValueOnce(new Error("IndexedDB occupée"));
    await expect(crypto.processKeyCounts({ signed_curve25519: 50 }, undefined)).rejects.toThrow();
    await crypto.processKeyCounts({ signed_curve25519: 50 }, undefined);
    expect(compteurs).toHaveBeenCalledTimes(2);
  });
});

describe("eviterSynchroCryptoInutile — listes d'appareils", () => {
  it("ignore une liste vide ou absente", async () => {
    const { crypto, appareils } = fauxCrypto();
    await crypto.processDeviceLists({});
    await crypto.processDeviceLists({ changed: [], left: [] });
    expect(appareils).not.toHaveBeenCalled();
  });

  it("transmet tout changement d'appareils, même répété", async () => {
    const { crypto, appareils } = fauxCrypto();
    await crypto.processDeviceLists({ changed: ["@picsou:hs"] });
    await crypto.processDeviceLists({ changed: ["@picsou:hs"] });
    await crypto.processDeviceLists({ left: ["@greg:hs"] });
    expect(appareils).toHaveBeenCalledTimes(3);
  });
});
