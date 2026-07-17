interface AdminConfig {
  homeserverUrl: string;
  accessToken: string;
}

export class AdminApiError extends Error {
  status: number;
  errcode?: string;
  constructor(status: number, statusText: string, errcode?: string) {
    super(`Admin API error: ${status} ${statusText}${errcode ? ` (${errcode})` : ""}`);
    this.status = status;
    this.errcode = errcode;
  }
}

let config: AdminConfig | null = null;

export function initAdminService(adminConfig: AdminConfig) {
  config = adminConfig;
}

async function fetchJson<T>(url: string, opts: { auth?: boolean; method?: string; body?: unknown } = {}): Promise<T> {
  if (!config) throw new Error("Admin service not initialized");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.auth) {
    headers["Authorization"] = `Bearer ${config.accessToken}`;
  }

  const response = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    let errcode: string | undefined;
    try {
      errcode = (await response.json())?.errcode;
    } catch { /* body not JSON */ }
    throw new AdminApiError(response.status, response.statusText, errcode);
  }

  return response.json();
}

// GET /_continuwuity/server_version (no auth required)
export async function getServerVersion() {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<{ name: string; version: string }>(
    `${config.homeserverUrl}/_continuwuity/server_version`
  );
}

// GET /_continuwuity/local_user_count (no auth, requires federation enabled)
export async function getLocalUserCount() {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<{ count: number }>(
    `${config.homeserverUrl}/_continuwuity/local_user_count`
  );
}

// GET /_continuwuity/admin/rooms/list (admin auth required)
export async function getRoomsList() {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<unknown>(
    `${config.homeserverUrl}/_continuwuity/admin/rooms/list`,
    { auth: true }
  );
}

// PUT /_continuwuity/admin/rooms/{roomId}/ban (admin auth required)
export async function banRoom(roomId: string, ban: boolean) {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<unknown>(
    `${config.homeserverUrl}/_continuwuity/admin/rooms/${encodeURIComponent(roomId)}/ban`,
    { auth: true, method: "PUT", body: { banned: ban } }
  );
}

// Check if user is suspended — tries MSC4323 endpoint, falls back gracefully
let suspendEndpointSupported: boolean | null = null;

/** Users the suspend endpoint reported as deactivated (403 M_USER_DEACTIVATED)
 *  or nonexistent (404 M_NOT_FOUND). Continuwuity's `list-users` keeps listing
 *  deactivated accounts forever, so cache them to avoid re-hitting a
 *  guaranteed 403 on every poll. Cleared by clearDeactivatedCache() so a
 *  manual refresh can pick up reactivated accounts. */
const deactivatedUserIds = new Set<string>();

export function clearDeactivatedCache() {
  deactivatedUserIds.clear();
}

export interface SuspendStatus {
  suspended: boolean;
  /** True when the account is deactivated or doesn't exist (not a real user anymore). */
  deactivated: boolean;
}

export async function checkUserSuspended(userId: string): Promise<SuspendStatus> {
  if (!config) throw new Error("Admin service not initialized");
  // If we already know the endpoint isn't supported, skip
  if (suspendEndpointSupported === false) return { suspended: false, deactivated: false };
  if (deactivatedUserIds.has(userId)) return { suspended: false, deactivated: true };

  try {
    const result = await fetchJson<{ suspended: boolean }>(
      `${config.homeserverUrl}/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/${encodeURIComponent(userId)}`,
      { auth: true }
    );
    suspendEndpointSupported = true;
    return { suspended: result.suspended, deactivated: false };
  } catch (err) {
    if (err instanceof AdminApiError) {
      // The endpoint answered about the *target* user: it exists but is
      // deactivated, or it doesn't exist at all. The endpoint itself works.
      if (err.errcode === "M_USER_DEACTIVATED" || err.errcode === "M_NOT_FOUND") {
        suspendEndpointSupported = true;
        deactivatedUserIds.add(userId);
        return { suspended: false, deactivated: true };
      }
      // 404 without M_NOT_FOUND (e.g. M_UNRECOGNIZED) = endpoint missing on
      // this server — stop spamming it.
      if (err.status === 404 && suspendEndpointSupported === null) {
        suspendEndpointSupported = false;
      }
    }
    return { suspended: false, deactivated: false };
  }
}

export async function suspendUser(userId: string, suspend: boolean) {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<unknown>(
    `${config.homeserverUrl}/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/${encodeURIComponent(userId)}`,
    { auth: true, method: "PUT", body: { suspended: suspend } }
  );
}
