import type { TranscriptEntry } from "../stores/useTranscriptStore";

/**
 * Scope the transcript view to the session being looked at.
 *
 * - A selected past session (history view) shows only ITS tagged segments.
 * - Live mode scopes to the current (or freshly ended, <12 h) session once
 *   one exists — untagged segments from pre-session clients stay accepted
 *   there so mixed-version meetings still display everyone.
 * - Without any session the live view shows NOTHING: stray pre-session
 *   segments and the past sessions loaded by the deep history backfill both
 *   belong to the history tab. (Regression guard: visiting the history tab
 *   used to leak the most recent past transcript into the live view.)
 */
export function scopeTranscriptEntries(
  allEntries: TranscriptEntry[],
  viewedSession: { id: string } | null,
  liveSession: { id: string } | null | undefined,
): TranscriptEntry[] {
  if (viewedSession) return allEntries.filter((e) => e.sessionId === viewedSession.id);
  if (liveSession) return allEntries.filter((e) => !e.sessionId || e.sessionId === liveSession.id);
  return [];
}
