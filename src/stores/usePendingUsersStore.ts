import { create } from "zustand";
import { getMatrixClient } from "../services/matrixService";
import { checkUserSuspended } from "../services/adminService";
import { sendAdminCommand, parseUserList, findAdminRoom } from "../services/adminCommandService";

interface PendingUsersState {
  pendingCount: number;
  initialized: boolean;
  /** All known user IDs (cached from last full discovery) */
  _knownUserIds: Set<string>;
  /** Quick re-check of suspension status on already-known users. Cheap. */
  refresh: () => Promise<void>;
  /** Full re-discovery: rooms + `!admin users list-users`. Catches users
   *  who registered after the listener started and haven't joined any
   *  room yet (the typical post-registration state with
   *  `suspend_on_register=true`, where Sion auto-joins them nowhere and
   *  they'd otherwise stay invisible until the next app restart). */
  fullDiscover: () => Promise<void>;
  startListening: () => void;
  stopListening: () => void;
}

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let fullDiscoverInterval: ReturnType<typeof setInterval> | null = null;
/** Coarser cadence than the 30 s suspension poll: a full re-discovery runs
 *  `!admin users list-users` (bot round-trip) so we don't want to spam the
 *  admin room. 5 minutes catches new registrations with an acceptable lag. */
const FULL_DISCOVER_INTERVAL_MS = 5 * 60 * 1000;

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

/** Build the list of rooms that count for "is the user integrated yet?".
 *  Mirrors the filter in `PendingUsers.handleApprove` so the validation
 *  decision and the validation action stay aligned: a user is considered
 *  integrated iff they're joined to at least one room that the approve
 *  flow would actually force-join them into. */
export function getPublicRoomIds(): string[] {
  const client = getMatrixClient();
  if (!client) return [];
  const adminRoomId = findAdminRoom();
  const dmRoomIds = new Set<string>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const directEvent = client.getAccountData("m.direct" as any);
    const directContent = (directEvent?.getContent() || {}) as Record<string, string[]>;
    for (const ids of Object.values(directContent)) {
      for (const id of ids) dmRoomIds.add(id);
    }
  } catch { /* ignore */ }

  const result: string[] = [];
  for (const room of client.getRooms()) {
    if (room.roomId === adminRoomId) continue;
    if (dmRoomIds.has(room.roomId)) continue;
    // Defensive: untagged 1:1 rooms with no name look like DMs even when
    // m.direct is stale. Same heuristic as handleApprove.
    if (!room.name && room.getJoinedMemberCount() <= 2) continue;
    const joinRule = room.currentState
      .getStateEvents("m.room.join_rules", "")
      ?.getContent?.()?.join_rule;
    if (joinRule !== "public") continue;
    result.push(room.roomId);
  }
  return result;
}

/** True if `userId` is joined to at least one of the public rooms passed
 *  in. Pass the precomputed list from `getPublicRoomIds()` to avoid
 *  re-walking the room graph for every user during a batch check. */
export function isInAnyPublicRoom(userId: string, publicRoomIds: string[]): boolean {
  const client = getMatrixClient();
  if (!client) return false;
  for (const roomId of publicRoomIds) {
    const room = client.getRoom(roomId);
    if (room?.getMember(userId)?.membership === "join") return true;
  }
  return false;
}

/** Count users that need admin attention. A user is "pending" if either:
 *  - they're suspended (legacy registration with `suspend_on_register`), OR
 *  - they're isolated: in zero public rooms (token registration bypasses
 *    the suspend gate, so the only signal that a token-user hasn't been
 *    integrated yet is that they haven't been force-joined anywhere). */
async function countPending(userIds: Set<string>): Promise<number> {
  const publicRoomIds = getPublicRoomIds();
  let count = 0;
  for (const userId of userIds) {
    let suspended = false;
    try {
      const result = await checkUserSuspended(userId);
      suspended = result.suspended;
    } catch { /* ignore — fall through to isolation check */ }
    if (suspended || !isInAnyPublicRoom(userId, publicRoomIds)) count++;
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
      const count = await countPending(known);
      set({ pendingCount: count });
    }
  },

  fullDiscover: async () => {
    const localUsers = discoverLocalUsers();
    try {
      const response = await sendAdminCommand("!admin users list-users");
      for (const uid of parseUserList(response)) {
        localUsers.add(uid);
      }
    } catch { /* fallback to room members only */ }

    const count = await countPending(localUsers);
    set({ _knownUserIds: localUsers, pendingCount: count, initialized: true });
  },

  startListening: () => {
    if (pollingInterval) return;

    // Initial full discovery
    get().fullDiscover();

    // Fast poll (suspension status only) — every 30 s
    pollingInterval = setInterval(() => get().refresh(), 30000);
    // Slow poll (full re-discovery) — every 5 min, catches new signups
    fullDiscoverInterval = setInterval(() => get().fullDiscover(), FULL_DISCOVER_INTERVAL_MS);
  },

  stopListening: () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    if (fullDiscoverInterval) {
      clearInterval(fullDiscoverInterval);
      fullDiscoverInterval = null;
    }
  },
}));
