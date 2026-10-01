import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage simulé (l'environnement de test n'en fournit pas ici).
const stockage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stockage[k] ?? null,
    setItem: (k: string, v: string) => { stockage[k] = v; },
    removeItem: (k: string) => { delete stockage[k]; },
    clear: () => { for (const k of Object.keys(stockage)) delete stockage[k]; },
  },
});

describe("pushService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("se charge sans VITE_NTFY_BASE_URL (build de CI, sans .env)", async () => {
    vi.stubEnv("VITE_NTFY_BASE_URL", "");
    const push = await import("./pushService");
    expect(push.NTFY_BASE_URL).toBe("https://push.sionchat.fr");
  });

  it("garde la variable si elle est définie", async () => {
    vi.stubEnv("VITE_NTFY_BASE_URL", "https://ntfy.ailleurs.test");
    expect((await import("./pushService")).NTFY_BASE_URL).toBe("https://ntfy.ailleurs.test");
  });
});

describe("sujet ntfy de l'appareil", () => {
  beforeEach(() => localStorage.clear());

  it("est tiré au hasard (128 bits), puis gardé pour le même appareil", async () => {
    const { sujetAppareil } = await import("./pushService");
    const sujet = sujetAppareil("@flamme:sionchat.fr", "ABCDEF");
    expect(sujet).toMatch(/^sion_[0-9a-f]{32}$/);
    expect(sujetAppareil("@flamme:sionchat.fr", "ABCDEF")).toBe(sujet);
  });

  it("change avec l'appareil ou le compte", async () => {
    const { sujetAppareil } = await import("./pushService");
    const sujet = sujetAppareil("@flamme:sionchat.fr", "ABCDEF");
    expect(sujetAppareil("@flamme:sionchat.fr", "GHIJKL")).not.toBe(sujet);
    expect(sujetAppareil("@picsou:sionchat.fr", "GHIJKL")).not.toBe(sujet);
  });

  it("ne se déduit plus du compte : deux tirages diffèrent", async () => {
    const { sujetAppareil } = await import("./pushService");
    const premier = sujetAppareil("@flamme:sionchat.fr", "ABCDEF");
    localStorage.clear();
    expect(sujetAppareil("@flamme:sionchat.fr", "ABCDEF")).not.toBe(premier);
  });

  it("ignore un sujet gardé illisible ou à l'ancienne forme", async () => {
    const { sujetAppareil } = await import("./pushService");
    localStorage.setItem("sion-push-sujet", "{pas du json");
    expect(sujetAppareil("@a:b", "D")).toMatch(/^sion_[0-9a-f]{32}$/);
    localStorage.setItem("sion-push-sujet", JSON.stringify({ compte: "@a:b|D", sujet: "sion_o10e2u" }));
    expect(sujetAppareil("@a:b", "D")).toMatch(/^sion_[0-9a-f]{32}$/);
  });

  it("n'apparaît pas en entier dans les journaux", async () => {
    const { sujetMasque } = await import("./pushService");
    const url = "https://push.sionchat.fr/sion_0123456789abcdef0123456789abcdef";
    expect(sujetMasque(url)).toBe("https://push.sionchat.fr/sion_0123…");
  });
});
