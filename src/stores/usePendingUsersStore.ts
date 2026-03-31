import { create } from "zustand";
import { getMatrixClient } from "../services/matrixService";
import { checkUserSuspended } from "../services/adminService";
import { sendAdminCommand, parseUserList } from "../services/adminCommandService";

interface PendingUsersState {
  pendingCount: number;
  initialized: boolean;
  /** All known user IDs (cached from last full discovery) */
  _knownUserIds: Set<string>;
  refresh: () => Promise<void>;
  startListening: () => void;
  stopListening: () => void;
}

let pollingInterval: ReturnType<typeof setInterval> | null = null;

/** Discover all local users from rooms + SDK store */
function discoverLocalUsers(): Set<string> {
  const client = getMatrixClient();
  if (!client) return new Set();

  const serverName = client.getDomain() || "";
  const ids = new Set<string>();

  for (const room of client.getRooms()) {
    for (const m of room.getJoinedMembers()) {
      if (m.userId.endsWith(`:${serverName}`) && !m.userId.includes("conduit")) {
        ids.add(m.userId);
      }
    }
    try {
      for (const m of room.getMembersWithMembership("invite")) {
        if (m.userId.endsWith(`:${serverName}`) && !m.userId.includes("conduit")) {
          ids.add(m.userId);
        }
      }
    } catch { /* ignore */ }
  }
  try {
    for (const u of client.getUsers()) {
      if (u.userId.endsWith(`:${serverName}`) && !u.userId.includes("conduit")) {
        ids.add(u.userId);
      }
    }
  } catch { /* ignore */ }

  return ids;
}

/** Count suspended users from a set of IDs */
async function countSuspended(userIds: Set<string>): Promise<number> {
  let count = 0;
  for (const userId of userIds) {
    try {
      const result = await checkUserSuspended(userId);
      if (result.suspended) count++;
    } catch { /* ignore */ }
  }
  return count;
}

export const usePendingUsersStore = create<PendingUsersState>((set, get) => ({
  pendingCount: 0,
  initialized: false,
  _knownUserIds: new Set(),

  refresh: async () => {
    // Check suspension for all cached known users (fast, API REST only)
    const known = get()._knownUserIds;
    if (known.size > 0) {
      const count = await countSuspended(known);
      set({ pendingCount: count });
    }
  },

  startListening: () => {
    if (pollingInterval) return;

    // Initial full discovery: rooms + admin command (once)
    (async () => {
      const localUsers = discoverLocalUsers();

      // Admin command to discover suspended users invisible in rooms
      try {
        const response = await sendAdminCommand("!admin users list-users");
        for (const uid of parseUserList(response)) {
          localUsers.add(uid);
        }
      } catch { /* fallback to room members only */ }

      set({ _knownUserIds: localUsers });

      const count = await countSuspended(localUsers);
      set({ pendingCount: count, initialized: true });
    })();

    // Polling: recheck suspension status every 30s (API REST, no admin command)
    pollingInterval = setInterval(() => get().refresh(), 30000);
  },

  stopListening: () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  },
}));
