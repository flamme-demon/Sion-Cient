import { describe, it, expect, beforeEach, vi } from "vitest";

// adminService keeps module-level state (config, suspend-endpoint support,
// deactivated cache) — reload it fresh for every test.
async function freshService() {
  vi.resetModules();
  const svc = await import("./adminService");
  svc.initAdminService({ homeserverUrl: "https://hs.test", accessToken: "tok" });
  return svc;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("checkUserSuspended", () => {
  it("returns the suspend flag on success", async () => {
    const svc = await freshService();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { suspended: true })));
    expect(await svc.checkUserSuspended("@a:hs")).toEqual({ suspended: true, deactivated: false });
  });

  it("flags deactivated accounts (403 M_USER_DEACTIVATED) and caches them", async () => {
    const svc = await freshService();
    const fetchMock = vi.fn(async () => jsonResponse(403, { errcode: "M_USER_DEACTIVATED" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await svc.checkUserSuspended("@ghost:hs")).toEqual({ suspended: false, deactivated: true });
    // Second check must come from the cache — no new request, no 403 spam.
    expect(await svc.checkUserSuspended("@ghost:hs")).toEqual({ suspended: false, deactivated: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearDeactivatedCache re-queries the server", async () => {
    const svc = await freshService();
    const fetchMock = vi.fn(async () => jsonResponse(403, { errcode: "M_USER_DEACTIVATED" }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.checkUserSuspended("@ghost:hs");
    svc.clearDeactivatedCache();
    await svc.checkUserSuspended("@ghost:hs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats 404 M_NOT_FOUND as deactivated WITHOUT disabling the endpoint", async () => {
    const svc = await freshService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errcode: "M_NOT_FOUND" }))
      .mockResolvedValueOnce(jsonResponse(200, { suspended: false }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await svc.checkUserSuspended("@gone:hs")).toEqual({ suspended: false, deactivated: true });
    // The endpoint itself works — later users must still be queried.
    expect(await svc.checkUserSuspended("@alive:hs")).toEqual({ suspended: false, deactivated: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a bare 404 (endpoint missing) disables further polling", async () => {
    const svc = await freshService();
    const fetchMock = vi.fn(async () => jsonResponse(404, { errcode: "M_UNRECOGNIZED" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await svc.checkUserSuspended("@a:hs")).toEqual({ suspended: false, deactivated: false });
    expect(await svc.checkUserSuspended("@b:hs")).toEqual({ suspended: false, deactivated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("survives a non-JSON error body", async () => {
    const svc = await freshService();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await svc.checkUserSuspended("@a:hs")).toEqual({ suspended: false, deactivated: false });
  });
});

describe("AdminApiError", () => {
  it("carries status and errcode", async () => {
    const svc = await freshService();
    const err = new svc.AdminApiError(403, "Forbidden", "M_FORBIDDEN");
    expect(err.status).toBe(403);
    expect(err.errcode).toBe("M_FORBIDDEN");
    expect(err.message).toContain("M_FORBIDDEN");
  });
});
