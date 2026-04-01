import { getMatrixClient } from "./matrixService";

/**
 * Find the admin room (Continuwuity's admin room).
 */
export function findAdminRoom(): string | null {
  const client = getMatrixClient();
  if (!client) return null;

  const serverName = client.getDomain() || "";
  const botId = `@conduit:${serverName}`;

  // Single pass: score each room and pick the best match
  let bestRoom: string | null = null;
  let bestScore = 0;

  for (const room of client.getRooms()) {
    const members = room.getJoinedMembers();
    const name = (room.name || "").toLowerCase();
    const alias = room.getCanonicalAlias() || "";
    const hasBot = members.some((m) => m.userId === botId);
    const hasConduitMember = members.some((m) => m.userId.includes("conduit"));

    let score = 0;

    // Priority 1: exact bot member match
    if (hasBot) score += 10;
    // Priority 2: admin room name
    if (name.includes("admin") && (name.includes("conduit") || name.includes("continuwuity"))) score += 8;
    // Priority 3: admin alias
    if (alias.includes("#admins:") || alias.includes("#conduit:")) score += 6;
    // Priority 4: DM with bot (2 members only)
    if (hasBot && members.length === 2) score += 4;
    // Priority 5: any conduit-related member
    if (hasConduitMember && score === 0) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestRoom = room.roomId;
    }
  }

  return bestRoom;
}

/**
 * Get the bot user ID for the current server.
 */
function getBotId(): string {
  const client = getMatrixClient();
  const serverName = client?.getDomain() || "";
  return `@conduit:${serverName}`;
}

/**
 * Send an admin command and wait for the bot's response by polling the timeline.
 */
export async function sendAdminCommand(command: string, timeoutMs = 15000): Promise<string> {
  const client = getMatrixClient();
  if (!client) throw new Error("Matrix client not initialized");

  const adminRoomId = findAdminRoom();
  if (!adminRoomId) throw new Error("Admin room not found");

  const botId = getBotId();
  const room = client.getRoom(adminRoomId);
  if (!room) throw new Error("Admin room not accessible");

  // Remember the timestamp before sending
  const sendTime = Date.now();

  // Send the command
  await client.sendTextMessage(adminRoomId, command);

  // Poll the timeline for the bot's response
  const pollInterval = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollInterval));

    // Check recent timeline events
    const timeline = room.getLiveTimeline().getEvents();
    for (let j = timeline.length - 1; j >= 0; j--) {
      const event = timeline[j];
      const ts = event.getTs?.() || 0;

      // Only look at events after we sent the command
      if (ts < sendTime - 2000) break;

      if (event.getType?.() !== "m.room.message") continue;
      if (event.getSender?.() !== botId) continue;

      const content = event.getContent?.();
      const body = content?.formatted_body || content?.body || "";
      if (body) return body;
    }
  }

  throw new Error("Admin command timeout");
}

/**
 * Parse the user list response from admin commands.
 * Returns user IDs found in the response.
 */
export function parseUserList(response: string): string[] {
  const userIds: string[] = [];
  const text = response.replace(/<[^>]+>/g, " ");
  const matches = text.matchAll(/@[a-zA-Z0-9._=-]+:[a-zA-Z0-9.-]+/g);
  for (const match of matches) {
    if (!match[0].includes("conduit") && !match[0].includes("continuwuity")) {
      if (!userIds.includes(match[0])) {
        userIds.push(match[0]);
      }
    }
  }
  return userIds;
}
