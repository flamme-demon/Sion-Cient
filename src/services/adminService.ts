interface AdminConfig {
  homeserverUrl: string;
  accessToken: string;
}

export class AdminApiError extends Error {
  status: number;
  constructor(status: number, statusText: string) {
    super(`Admin API error: ${status} ${statusText}`);
    this.status = status;
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
    throw new AdminApiError(response.status, response.statusText);
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

export async function checkUserSuspended(userId: string): Promise<{ suspended: boolean }> {
  if (!config) throw new Error("Admin service not initialized");
  // If we already know the endpoint isn't supported, skip
  if (suspendEndpointSupported === false) return { suspended: false };

  try {
    const result = await fetchJson<{ suspended: boolean }>(
      `${config.homeserverUrl}/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/${encodeURIComponent(userId)}`,
      { auth: true }
    );
    suspendEndpointSupported = true;
    return result;
  } catch {
    // Mark as unsupported to stop spamming 404s
    if (suspendEndpointSupported === null) suspendEndpointSupported = false;
    return { suspended: false };
  }
}

export async function suspendUser(userId: string, suspend: boolean) {
  if (!config) throw new Error("Admin service not initialized");
  return fetchJson<unknown>(
    `${config.homeserverUrl}/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/${encodeURIComponent(userId)}`,
    { auth: true, method: "PUT", body: { suspended: suspend } }
  );
}
