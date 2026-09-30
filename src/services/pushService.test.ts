import { afterEach, describe, expect, it, vi } from "vitest";

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
