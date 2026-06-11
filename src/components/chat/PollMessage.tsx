import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import * as matrixService from "../../services/matrixService";
import type { PollData } from "../../types/matrix";

interface Props {
  poll: PollData;
  /** Server event id of the m.poll.start (target for responses/end). */
  pollEventId: string;
  roomId: string;
  currentUserId: string;
  /** Whether the current user may end the poll (creator or moderator). */
  canEnd: boolean;
}

const VOTER_STACK_MAX = 5;

/** Overlapping mini-avatars of the voters for one option (capped, with a
 *  "+N" overflow chip). Names show on hover via the title attribute. */
function VoterStack({ voters, roomId }: { voters: string[]; roomId: string }) {
  if (voters.length === 0) return null;
  const shown = voters.slice(0, VOTER_STACK_MAX);
  const extra = voters.length - shown.length;
  const chip: CSSProperties = {
    width: 18, height: 18, borderRadius: '50%', overflow: 'hidden',
    border: '1.5px solid var(--color-surface-container)', background: 'var(--color-surface-container-highest)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 9, fontWeight: 600, color: 'var(--color-on-surface-variant)', flexShrink: 0,
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((uid, i) => {
        const info = matrixService.getRoomMemberInfo(roomId, uid);
        return (
          <span key={uid} title={info.displayName} style={{ ...chip, marginLeft: i === 0 ? 0 : -6 }}>
            {info.avatarUrl
              ? <img src={info.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (Array.from(info.displayName.replace(/^@/, ""))[0]?.toUpperCase() || "?")}
          </span>
        );
      })}
      {extra > 0 && (
        <span style={{ ...chip, marginLeft: -6, width: 'auto', minWidth: 18, padding: '0 4px', borderRadius: 9 }}>+{extra}</span>
      )}
    </span>
  );
}

/** Renders an MSC3381 poll: question, options with live results, vote on click,
 *  and an end button for the creator/moderators. */
export function PollMessage({ poll, pollEventId, roomId, currentUserId, canEnd }: Props) {
  const { t, i18n } = useTranslation();

  // Re-render once the auto-close deadline passes (single timer, no per-second tick).
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!poll.endsTs) return;
    const remaining = poll.endsTs - Date.now();
    if (remaining <= 0) { setNowTs(Date.now()); return; }
    const id = setTimeout(() => setNowTs(Date.now()), remaining + 250);
    return () => clearTimeout(id);
  }, [poll.endsTs]);

  const ended = poll.ended || (poll.endsTs != null && nowTs >= poll.endsTs);

  const { tally, totalVoters, myVote, votersByAnswer } = useMemo(() => {
    const tally: Record<string, number> = {};
    const votersByAnswer: Record<string, string[]> = {};
    let totalVoters = 0;
    for (const [voter, ids] of Object.entries(poll.votes)) {
      if (!ids.length) continue;
      totalVoters += 1;
      for (const id of ids) {
        tally[id] = (tally[id] || 0) + 1;
        (votersByAnswer[id] ||= []).push(voter);
      }
    }
    return { tally, totalVoters, myVote: poll.votes[currentUserId] || [], votersByAnswer };
  }, [poll.votes, currentUserId]);

  // Disclosed polls show results live; undisclosed hide them until ended.
  const showResults = ended || poll.kind === "disclosed";

  const vote = (answerId: string) => {
    if (ended || pollEventId.startsWith("~")) return;
    const isSingle = poll.maxSelections <= 1;
    let next: string[];
    if (isSingle) {
      next = myVote.includes(answerId) ? [] : [answerId]; // click your choice again = retract
    } else {
      next = myVote.includes(answerId) ? myVote.filter((id) => id !== answerId) : [...myVote, answerId].slice(0, poll.maxSelections);
    }
    matrixService.votePoll(roomId, pollEventId, next).catch((e) => console.warn("[Sion] votePoll failed:", e));
  };

  return (
    <div style={{
      marginTop: 6, background: 'var(--color-surface-container-high)', borderRadius: 16,
      padding: '14px 16px', width: 420, maxWidth: '100%',
      border: '1px solid var(--color-outline-variant)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-on-surface)', wordBreak: 'break-word' }}>
          {poll.question}
        </div>
        {ended && (
          <span style={{ fontSize: 11, color: 'var(--color-outline)', whiteSpace: 'nowrap', flexShrink: 0 }}>{t("poll.ended")}</span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {poll.answers.map((ans) => {
          const count = tally[ans.id] || 0;
          const pct = showResults && totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
          const mine = myVote.includes(ans.id);
          return (
            <button
              key={ans.id}
              onClick={() => vote(ans.id)}
              disabled={ended}
              style={{
                position: 'relative', textAlign: 'left', border: `1px solid ${mine ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                background: 'var(--color-surface-container)', color: 'var(--color-on-surface)',
                borderRadius: 10, padding: '8px 12px', cursor: ended ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 13, overflow: 'hidden',
              }}
            >
              {showResults && (
                <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: mine ? 'var(--color-primary-container)' : 'var(--color-surface-container-highest)', opacity: 0.6, transition: 'width 200ms' }} />
              )}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ width: 14, height: 14, borderRadius: poll.maxSelections > 1 ? 4 : '50%', border: `2px solid ${mine ? 'var(--color-primary)' : 'var(--color-outline)'}`, background: mine ? 'var(--color-primary)' : 'transparent', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ans.text}</span>
                </span>
                {showResults && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <VoterStack voters={votersByAnswer[ans.id] || []} roomId={roomId} />
                    <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', whiteSpace: 'nowrap' }}>{pct}%</span>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--color-outline)' }}>
          <span>{showResults ? t("poll.totalVotes", { count: totalVoters }) : t("poll.hiddenUntilEnd")}</span>
          {poll.endsTs != null && !poll.ended && (
            <span>
              {ended
                ? t("poll.closedOn", { date: new Date(poll.endsTs).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) })
                : t("poll.endsAt", { date: new Date(poll.endsTs).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) })}
            </span>
          )}
        </span>
        {canEnd && !ended && !pollEventId.startsWith("~") && (
          <button
            onClick={() => matrixService.endPoll(roomId, pollEventId).catch((e) => console.warn("[Sion] endPoll failed:", e))}
            title={t("poll.endHint")}
            style={{ border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {t("poll.end")}
          </button>
        )}
      </div>
    </div>
  );
}
