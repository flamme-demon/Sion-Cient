import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Réponse minimale à `/_matrix/client/versions`, seul l'en-tête `Date` compte. */
function serverAt(iso: string) {
  return {
    headers: { get: (h: string) => (h.toLowerCase() === "date" ? iso : null) },
  } as unknown as Response;
}

describe("serverClock", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clock: any;
  beforeEach(async () => {
    vi.resetModules();
    clock = await import("./serverClock");
    clock.resetServerClock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fait confiance à l'horloge locale tant que rien n'est établi", () => {
    expect(clock.getClockSkewMs()).toBe(0);
    expect(Math.abs(clock.serverNow() - Date.now())).toBeLessThan(1000);
  });

  /**
   * Le défaut que la sonde corrige : `maintenant - dernier horodatage` prenait
   * un salon simplement calme pour une horloge déréglée. Vingt minutes sans le
   * moindre événement suffisaient à déclencher le bandeau sur une machine juste.
   */
  it("ne crie pas au décalage dans un salon resté calme", () => {
    clock.noteServerTimestamp(Date.now() - 20 * 60_000);
    expect(clock.getClockSkewMs()).toBe(0);
    expect(Math.abs(clock.serverNow() - Date.now())).toBeLessThan(1000);
  });

  it("déduit un retard d'un événement daté dans le futur", () => {
    // Rien ne peut avoir été créé après maintenant : l'horloge locale retarde.
    clock.noteServerTimestamp(Date.now() + 2 * 3600_000);
    expect(clock.getClockSkewMs()).toBeLessThan(-3600_000);
    expect(clock.serverNow() - Date.now()).toBeGreaterThan(3600_000);
  });

  it("mesure l'écart sur l'en-tête Date de la réponse", async () => {
    const now = new Date("2026-07-29T14:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(serverAt("Wed, 29 Jul 2026 14:00:00 GMT")),
    );
    expect(await clock.probeServerClock("https://sionchat.fr")).toBe(0);
    expect(clock.getClockSkewMs()).toBe(0);
  });

  /**
   * Cas réel — Windows 11, fuseau corrompu et service de temps arrêté :
   * l'horloge avançait de dix heures. Les appartenances vocales expirant au
   * bout d'une heure, toutes celles des autres paraissaient périmées et
   * l'utilisateur se retrouvait seul dans un salon peuplé.
   */
  it("corrige une horloge en avance de dix heures", async () => {
    const trueUtc = new Date("2026-07-29T14:15:41Z").getTime();
    const local = new Date("2026-07-30T00:13:57Z").getTime(); // ce que voyait sa machine
    vi.spyOn(Date, "now").mockReturnValue(local);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(serverAt(new Date(trueUtc).toUTCString())),
    );

    await clock.probeServerClock("https://sionchat.fr");
    expect(clock.getClockSkewMs()).toBeGreaterThan(9.5 * 3600_000);

    // Une appartenance écrite par le serveur il y a 2 min doit rester valide.
    const membership = trueUtc - 120_000;
    expect(membership + 3600_000).toBeGreaterThan(clock.serverNow());
  });

  it("garde l'écart connu quand le serveur est injoignable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await clock.probeServerClock("https://sionchat.fr")).toBeNull();
    expect(clock.getClockSkewMs()).toBe(0);
  });

  it("ignore un en-tête Date absent ou illisible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(serverAt("pas une date")),
    );
    expect(await clock.probeServerClock("https://sionchat.fr")).toBeNull();
    expect(clock.getClockSkewMs()).toBe(0);
  });
});
