/**
 * Parse @display-name mentions from a plaintext message body and produce a
 * Matrix-compliant formatted_body (HTML) with proper matrix.to links.
 *
 * Used by sendTextMessage / sendReply to enrich outgoing messages so that
 * other clients (and our own renderer) can highlight mentions as pills.
 *
 * Format follows Matrix MSC3952 (intentional mentions): the returned object
 * also includes the user IDs that should be put in `content["m.mentions"]`.
 */

interface RoomMember {
  userId: string;
  name: string;
}

interface RoomLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getJoinedMembers: () => any[];
}

export interface ParsedMentions {
  /** Plain text body, kept identical to input. */
  body: string;
  /** HTML formatted body with <a href="matrix.to/..."> links, or null if no mention found. */
  formattedBody: string | null;
  /** List of mentioned Matrix user IDs (for content["m.mentions"]). */
  mentionedUserIds: string[];
}

/**
 * Escape an HTML string so we can safely interleave plain text and `<a>` tags.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a longest-first sorted list of room members so that "@John Doe" is
 * matched before "@John". Display names are normalized (trim, lowercase).
 */
function getMembersForMatching(room: RoomLike): RoomMember[] {
  const members: RoomMember[] = [];
  for (const m of room.getJoinedMembers()) {
    const name = m.name || m.rawDisplayName || m.userId;
    if (name && m.userId) {
      members.push({ userId: m.userId, name });
    }
  }
  // Longest names first so that "@John Doe" wins over "@John"
  members.sort((a, b) => b.name.length - a.name.length);
  return members;
}

export function parseMentions(body: string, room: RoomLike): ParsedMentions {
  if (!body || body.indexOf("@") === -1) {
    return { body, formattedBody: null, mentionedUserIds: [] };
  }

  const members = getMembersForMatching(room);
  if (members.length === 0) {
    return { body, formattedBody: null, mentionedUserIds: [] };
  }

  // Walk the body once and collect (start, end, member) hits.
  // Names may contain spaces and Unicode, so we use indexOf rather than a regex.
  type Hit = { start: number; end: number; member: RoomMember };
  const hits: Hit[] = [];
  const taken = new Array<boolean>(body.length).fill(false);

  for (const member of members) {
    const needle = "@" + member.name;
    let from = 0;
    while (true) {
      const idx = body.indexOf(needle, from);
      if (idx === -1) break;
      from = idx + 1;

      // Reject if range overlaps with an already-taken hit
      const end = idx + needle.length;
      let overlap = false;
      for (let i = idx; i < end; i++) {
        if (taken[i]) { overlap = true; break; }
      }
      if (overlap) continue;

      // Reject if preceded by a word character (avoid matching "email@picsou")
      const prev = body[idx - 1];
      if (prev && /\w/.test(prev)) continue;

      // Reject if followed by a word character that would make the name
      // longer than expected (e.g. "@picsouz")
      const next = body[end];
      if (next && /\w/.test(next)) continue;

      hits.push({ start: idx, end, member });
      for (let i = idx; i < end; i++) taken[i] = true;
    }
  }

  if (hits.length === 0) {
    return { body, formattedBody: null, mentionedUserIds: [] };
  }

  // Build the formatted_body by replacing mentions with <a> tags, in order.
  hits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  const mentionedSet = new Set<string>();

  for (const hit of hits) {
    if (hit.start > cursor) {
      parts.push(escapeHtml(body.slice(cursor, hit.start)));
    }
    const href = `https://matrix.to/#/${encodeURIComponent(hit.member.userId)}`;
    parts.push(
      `<a href="${href}">${escapeHtml(hit.member.name)}</a>`,
    );
    mentionedSet.add(hit.member.userId);
    cursor = hit.end;
  }
  if (cursor < body.length) {
    parts.push(escapeHtml(body.slice(cursor)));
  }

  return {
    body,
    formattedBody: parts.join(""),
    mentionedUserIds: Array.from(mentionedSet),
  };
}
