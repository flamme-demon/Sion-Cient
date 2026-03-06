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

async function fetchJson<T>(url: string, auth = false): Promise<T> {
  if (!config) throw new Error("Admin service not initialized");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) {
    headers["Authorization"] = `Bearer ${config.accessToken}`;
  }

  const response = await fetch(url, { headers });

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
    true
  );
}
