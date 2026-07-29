import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("serverClock", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clock: any;
  beforeEach(async () => {
    vi.resetModules();
    clock = await import("./serverClock");
  });
  afterEach(() => vi.useRealTimers());

  it("fait confiance à l'horloge locale tant qu'aucun horodatage n'a été vu", () => {
    expect(clock.getClockSkewMs()).toBe(0);
    expect(Math.abs(clock.serverNow() - Date.now())).toBeLessThan(1000);
  });

  it("ignore une dérive ordinaire : l'horloge locale reste la référence", () => {
    // Le serveur a horodaté il y a 30 s — délai réseau et fraîcheur normale.
    clock.noteServerTimestamp(Date.now() - 30_000);
    expect(Math.abs(clock.getClockSkewMs())).toBeLessThan(clock.CLOCK_SKEW_TOLERANCE_MS);
    expect(Math.abs(clock.serverNow() - Date.now())).toBeLessThan(1000);
  });

  /**
   * Cas réel : une machine avançait de 9 h 58. Les appartenances vocales
   * expirant au bout d'une heure, toutes celles des autres paraissaient
   * périmées et l'utilisateur se retrouvait seul dans un salon peuplé.
   */
  it("corrige une horloge en avance de dix heures", () => {
    const realServerTs = Date.now() - 10 * 3600_000;
    clock.noteServerTimestamp(realServerTs);
    expect(clock.getClockSkewMs()).toBeGreaterThan(9 * 3600_000);
    // Une appartenance écrite par le serveur il y a 2 min doit rester valide.
    const membership = realServerTs - 120_000;
    expect(membership + 3600_000).toBeGreaterThan(clock.serverNow());
  });

  it("ne retient que l'horodatage le plus récent", () => {
    const recent = Date.now() - 1000;
    clock.noteServerTimestamp(recent);
    clock.noteServerTimestamp(recent - 3600_000); // plus ancien : ignoré
    expect(Math.abs(clock.getClockSkewMs())).toBeLessThan(5000);
  });
});
