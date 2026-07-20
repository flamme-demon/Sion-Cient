import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { armTranscription, disarmTranscription, endSessionForAll, summarizeMeeting } from "../../services/transcriptionService";
import { backfillTranscript } from "../../services/matrixService";
import { scopeTranscriptEntries } from "../../utils/transcriptScope";

/** Stable per-identity hue (same trick as the cursor overlay) so each
 *  speaker keeps a recognizable color in the transcript. */
function colorForIdentity(identity: string): string {
  let h = 0;
  for (let i = 0; i < identity.length; i++) h = ((h << 5) - h + identity.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 65%, 60%)`;
}

function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Stable fallbacks: `?? []` in a zustand selector would build a fresh value
 * on every store update and re-render the panel for unrelated rooms. */
const NO_ENTRIES: never[] = [];
const NO_SESSIONS: never[] = [];
const NO_SUMMARIES: Record<string, { text: string; ts: number }> = {};

/** Meeting transcript — right side panel (MemberPanel-style column),
 *  organized around the session lifecycle: the "Direct" tab shows ONE
 *  primary action matching the current state (start / join invitation /
 *  waiting / recording), and the summary/export artifacts only surface
 *  once a session is over. The "Historique" tab lists past sessions
 *  (durable Matrix events, visible to every room member). */
export function TranscriptPanel() {
  const { t } = useTranslation();
  const panelOpen = useTranscriptStore((s) => s.panelOpen);
  const setPanelOpen = useTranscriptStore((s) => s.setPanelOpen);
  const engineState = useTranscriptStore((s) => s.state);
  const engineError = useTranscriptStore((s) => s.error);
  const downloadPct = useTranscriptStore((s) => s.downloadPct);
  const summaryState = useTranscriptStore((s) => s.summaryState);
  const summaryPct = useTranscriptStore((s) => s.summaryPct);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const armedPeers = useTranscriptStore((s) => s.armedPeers);
  const allEntries = useTranscriptStore((s) => (connectedVoice ? s.entries[connectedVoice] : undefined) ?? NO_ENTRIES);
  const session = useTranscriptStore((s) => (connectedVoice ? s.sessions[connectedVoice] : undefined)) || null;
  const history = useTranscriptStore((s) => (connectedVoice ? s.history[connectedVoice] : undefined) ?? NO_SESSIONS);
  const summaries = useTranscriptStore((s) => (connectedVoice ? s.summaries[connectedVoice] : undefined) ?? NO_SUMMARIES);

  const [tab, setTab] = useState<"live" | "history">("live");
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exported, setExported] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const viewedSession = viewedId ? history.find((h) => h.id === viewedId) || null : null;
  // One pass over the entries instead of one filter per listed session.
  const segmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of allEntries) {
      if (e.sessionId) counts.set(e.sessionId, (counts.get(e.sessionId) || 0) + 1);
    }
    return counts;
  }, [allEntries]);
  // The summary linked to the session being looked at (past or live).
  const scopedSession = viewedSession ?? session;
  const linkedSummary = scopedSession ? summaries[scopedSession.id] : undefined;
  const entries = scopeTranscriptEntries(allEntries, viewedSession, session);

  // Auto-scroll on new entries unless the user scrolled up to read back.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current && tab === "live") el.scrollTop = el.scrollHeight;
  }, [entries.length, tab]);

  // Reload the transcript from the room history: a page reload wipes the
  // in-memory store and a late joiner has nothing — but every segment and
  // session event is durable in the Matrix timeline. Idempotent (store
  // dedups), bounded to the last 12 h.
  useEffect(() => {
    if (!connectedVoice) return;
    backfillTranscript(connectedVoice, Date.now() - 12 * 3600 * 1000).catch((err) => {
      console.warn("[Sion][transcribe] backfill failed:", err);
    });
  }, [connectedVoice]);

  // Back to the live tab when switching voice channel.
  useEffect(() => {
    setTab("live");
    setViewedId(null);
    setMenuOpen(false);
  }, [connectedVoice]);

  // A past session reads top-down; don't auto-stick to the bottom.
  useEffect(() => {
    setShowSummary(false);
    if (viewedId && listRef.current) {
      pinnedToBottom.current = false;
      listRef.current.scrollTop = 0;
    }
  }, [viewedId]);

  if (!panelOpen || !connectedVoice) return null;

  const busy = engineState === "starting";
  const armed = engineState === "armed";
  const running = engineState === "on" || busy;
  const sessionActive = !!session && !session.endedAt;
  const summaryBusy = summaryState !== "idle";
  // The local engines live in the Rust backend — web/mobile builds still SEE
  // everyone's transcript (it arrives over Matrix) but can't feed/summarize.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canTranscribe = typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
  const micCount = armedPeers.length + (running || armed ? 1 : 0);

  const openHistoryTab = () => {
    setTab("history");
    setViewedId(null);
    setHistLoading(true);
    // Deep backfill: sessions live in the durable timeline, go look for
    // them (bounded: 30 days / 40 pages).
    backfillTranscript(connectedVoice, Date.now() - 30 * 24 * 3600 * 1000, 40)
      .catch((err) => console.warn("[Sion][transcribe] history backfill failed:", err))
      .finally(() => setHistLoading(false));
  };

  const handleArm = () => {
    armTranscription(connectedVoice).catch((err) => {
      console.error("[Sion][transcribe] arm failed:", err);
      useTranscriptStore.getState().setState("error", String(err?.message || err));
    });
  };

  const handleStopMine = () => disarmTranscription(connectedVoice);

  const handleEndForAll = () => {
    endSessionForAll(connectedVoice).catch((err) => {
      console.error("[Sion][transcribe] end-for-all failed:", err);
    });
  };

  const handleSummarize = () => {
    setSummaryError(null);
    summarizeMeeting(connectedVoice, viewedSession?.id).catch((err) => {
      console.error("[Sion][summary] failed:", err);
      setSummaryError(String(err?.message || err));
    });
  };

  const handleExport = async () => {
    if (!entries.length) return;
    const channelName = useMatrixStore.getState().channels.find((c) => c.id === connectedVoice)?.name || "reunion";
    const refDate = viewedSession ? new Date(viewedSession.ts) : new Date();
    const lines = entries.map((e) => `- **${e.senderName}** (${fmtTime(e.t0)}) : ${e.text}`);
    const md = `# ${t("transcript.exportTitle", { defaultValue: "Transcription" })} — ${channelName} — ${refDate.toLocaleDateString()}\n\n${lines.join("\n")}\n`;
    const file = new File([md], `transcript-${channelName}-${refDate.toISOString().slice(0, 10)}.md`, { type: "text/markdown" });
    try {
      await useMatrixStore.getState().sendFile(connectedVoice, file);
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch (err) {
      console.error("[Sion][transcribe] export failed:", err);
    }
  };

  const statusDot = running ? "var(--color-error)" : armed ? "#ff9800" : engineState === "error" ? "var(--color-error)" : "var(--color-outline)";

  const primaryBtn = (label: string, onClick: () => void, opts?: { disabled?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={opts?.disabled}
      style={{
        width: '100%', padding: '9px 12px', borderRadius: 10, border: 'none',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        cursor: opts?.disabled ? 'default' : 'pointer',
        opacity: opts?.disabled ? 0.55 : 1,
        background: 'var(--color-primary)', color: 'var(--color-on-primary)',
      }}
    >{label}</button>
  );

  const smallBtn = (label: string, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean; title?: string; grow?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={opts?.disabled}
      title={opts?.title}
      style={{
        flex: opts?.grow ? 1 : undefined,
        width: opts?.grow ? undefined : '100%',
        padding: '7px 10px', borderRadius: 8, border: 'none',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        cursor: opts?.disabled ? 'default' : 'pointer',
        opacity: opts?.disabled ? 0.55 : 1,
        background: opts?.danger ? 'var(--color-error-container)' : 'var(--color-surface-container-highest)',
        color: opts?.danger ? 'var(--color-error)' : 'var(--color-on-surface)',
        transition: 'background 150ms',
      }}
    >{label}</button>
  );

  const tabBtn = (key: "live" | "history", label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        borderRadius: 8,
        background: tab === key ? 'var(--color-surface-container-highest)' : 'transparent',
        color: tab === key ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
      }}
    >{label}</button>
  );

  /** Summary / export actions — surfaced once there is something to act on. */
  const artifactsFooter = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderTop: '1px solid var(--color-outline-variant)' }}>
      {!viewedSession && session?.endedAt != null && (
        <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
          ✓ {t("transcript.sessionEnded", { time: fmtTime(session.endedAt), defaultValue: "Session terminée à {{time}}" })}
        </div>
      )}
      {linkedSummary && smallBtn(
        showSummary
          ? t("transcript.hideSummary", { defaultValue: "Masquer le résumé" })
          : t("transcript.viewSummary", { defaultValue: "Voir le résumé" }),
        () => setShowSummary((v) => !v),
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {canTranscribe && smallBtn(
          summaryState === "downloading"
            ? `${t("transcript.summaryDownloading", { defaultValue: "Téléchargement IA…" })} ${summaryPct ?? 0}%`
            : summaryState === "running"
              ? t("transcript.summarizing", { defaultValue: "Résumé en cours…" })
              : t("transcript.summarize", { defaultValue: "Résumer" }),
          handleSummarize,
          { grow: true, disabled: summaryBusy || !entries.length, title: t("transcript.summarizeHint", { defaultValue: "Génère un compte-rendu (IA locale) et le poste dans le chat" }) },
        )}
        {smallBtn(
          exported ? "✓" : t("transcript.export", { defaultValue: "Exporter .md" }),
          handleExport,
          { grow: true, disabled: !entries.length, title: t("transcript.exportHint", { defaultValue: "Envoie le transcript en .md dans le chat" }) },
        )}
      </div>
      {summaryError && (
        <div style={{ fontSize: 11, color: 'var(--color-error)' }}>{summaryError}</div>
      )}
    </div>
  );

  const transcriptList = (
    <div
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      style={{ overflowY: 'auto', flex: 1, padding: '8px 12px 12px', fontSize: 13, color: 'var(--color-on-surface)' }}
    >
      {showSummary && linkedSummary && (
        <div style={{
          marginBottom: 10, padding: '8px 10px', borderRadius: 10,
          background: 'var(--color-surface-container-high)',
          fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
        }}>
          {linkedSummary.text}
        </div>
      )}
      {entries.length === 0 ? (
        <div style={{ paddingTop: 8, fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
          {viewedSession
            ? t("transcript.sessionNoSegments", { defaultValue: "Aucun segment retrouvé pour cette session." })
            : t("transcript.empty", { defaultValue: "Aucun segment pour l'instant." })}
        </div>
      ) : (
        entries.map((e) => (
          <div key={e.id} style={{ marginBottom: 8, lineHeight: 1.4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: colorForIdentity(e.senderId), fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.senderName}</span>
              <span style={{ color: 'var(--color-outline)', fontSize: 10, flexShrink: 0 }}>{fmtTime(e.t0)}</span>
            </div>
            <div style={{ overflowWrap: 'break-word' }}>{e.text}</div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <aside style={{
      width: 300,
      flexShrink: 0,
      background: 'var(--color-surface-container-low)',
      borderLeft: '1px solid var(--color-outline-variant)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--color-outline-variant)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', flex: 1 }}>
            {t("transcript.title", { defaultValue: "Transcription" })}
          </span>
          <button
            onClick={() => setPanelOpen(false)}
            title={t("members.close", { defaultValue: "Fermer" })}
            style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 18, padding: 2, lineHeight: 1 }}
          >×</button>
        </div>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-container)', borderRadius: 10, padding: 3 }}>
          {tabBtn("live", t("transcript.tabLive", { defaultValue: "Direct" }), () => { setTab("live"); setViewedId(null); })}
          {tabBtn("history", t("transcript.tabHistory", { defaultValue: "Historique" }), openHistoryTab)}
        </div>
      </div>

      {tab === "live" ? (
        <>
          {/* State zone — one primary action per lifecycle state. */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-outline-variant)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sessionActive ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-error)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--color-on-surface)', flex: 1, minWidth: 0 }}>
                  {t("transcript.sessionSince", { time: fmtTime(session!.ts), defaultValue: "Session depuis {{time}}" })}
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--color-on-surface-variant)' }}>
                    {t("transcript.micCount", { count: micCount, defaultValue: "{{count}} micros actifs" })}
                    {!running && !armed ? ` · ${t("transcript.notTranscribing", { defaultValue: "votre micro n'est pas transcrit" })}` : ""}
                  </span>
                </span>
                {canTranscribe && (
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    title={t("transcript.sessionActions", { defaultValue: "Actions de session" })}
                    style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
                  >⋯</button>
                )}
                {menuOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                    <div style={{
                      position: 'absolute', right: 0, top: '100%', zIndex: 41, marginTop: 4,
                      background: 'var(--color-surface-container-high)', borderRadius: 10,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', padding: 4, minWidth: 180,
                      display: 'flex', flexDirection: 'column', gap: 2,
                    }}>
                      {smallBtn(
                        running
                          ? t("transcript.stopMine", { defaultValue: "Arrêter mon micro" })
                          : t("transcript.startMine", { defaultValue: "Transcrire mon micro" }),
                        () => { setMenuOpen(false); if (running) handleStopMine(); else handleArm(); },
                        { disabled: busy },
                      )}
                      {smallBtn(
                        t("transcript.endForAll", { defaultValue: "Terminer pour tous" }),
                        () => { setMenuOpen(false); handleEndForAll(); },
                        { danger: true, title: t("transcript.endForAllHint", { defaultValue: "Met fin à la session de transcription pour tous les participants" }) },
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : armed ? (
              <>
                <div style={{ fontSize: 12, lineHeight: 1.45, padding: '8px 10px', borderRadius: 8, background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface-variant)' }}>
                  {t("transcript.waitingPeer", { defaultValue: "La transcription démarrera quand un 2e participant cliquera « Participer »." })}
                </div>
                {smallBtn(t("transcript.cancel", { defaultValue: "Annuler" }), handleStopMine, { danger: true })}
              </>
            ) : (
              <>
                {armedPeers.length > 0 && (
                  <div style={{
                    fontSize: 12, lineHeight: 1.45, padding: '8px 10px', borderRadius: 8,
                    background: 'var(--color-secondary-container)', color: 'var(--color-on-secondary-container)',
                  }}>
                    {t("transcript.invitation", {
                      name: armedPeers.map((p) => p.name).join(", "),
                      defaultValue: "{{name}} souhaite lancer la transcription.",
                    })}
                  </div>
                )}
                {canTranscribe && primaryBtn(
                  armedPeers.length > 0
                    ? t("transcript.joinInvite", { defaultValue: "Rejoindre la transcription" })
                    : t("transcript.start", { defaultValue: "Démarrer la transcription" }),
                  handleArm,
                  { disabled: busy },
                )}
                {canTranscribe && armedPeers.length === 0 && (
                  <div style={{ fontSize: 10, color: 'var(--color-on-surface-variant)', lineHeight: 1.4 }}>
                    {t("transcript.startHint", { defaultValue: "Démarre dès que deux participants l'ont activée — chacun transcrit sa propre voix, localement." })}
                  </div>
                )}
              </>
            )}
            {downloadPct != null && downloadPct < 100 && (
              <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                {t("transcript.downloading", { defaultValue: "téléchargement du modèle…" })} {downloadPct}%
              </div>
            )}
            {engineState === "error" && engineError && (
              <div style={{ fontSize: 11, color: 'var(--color-error)' }}>{engineError}</div>
            )}
          </div>

          {transcriptList}

          {/* Artifacts appear once the meeting is over (or for leftover
              segments outside any active session). */}
          {entries.length > 0 && !sessionActive && artifactsFooter}
        </>
      ) : viewedSession ? (
        <>
          {/* One past session */}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-outline-variant)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {smallBtn(`← ${t("transcript.backToSessions", { defaultValue: "Toutes les sessions" })}`, () => setViewedId(null))}
            <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
              {new Date(viewedSession.ts).toLocaleDateString()} · {fmtTime(viewedSession.ts)}
              {viewedSession.endedAt != null ? `–${fmtTime(viewedSession.endedAt)}` : ""}
            </div>
          </div>
          {transcriptList}
          {artifactsFooter}
        </>
      ) : (
        /* Session list */
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 12px 12px' }}>
          {histLoading && (
            <div style={{ padding: '6px 0', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
              {t("transcript.historyLoading", { defaultValue: "Recherche des sessions…" })}
            </div>
          )}
          {!histLoading && history.length === 0 ? (
            <div style={{ paddingTop: 8, fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
              {t("transcript.historyEmpty", { defaultValue: "Aucune session de transcription trouvée dans les 30 derniers jours." })}
            </div>
          ) : (
            history.map((h) => {
              const count = segmentCounts.get(h.id) || 0;
              const ongoing = h.endedAt == null && session?.id === h.id && sessionActive;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setViewedId(h.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    width: '100%', textAlign: 'left', marginBottom: 6,
                    padding: '8px 10px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
                    fontFamily: 'inherit',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                      {new Date(h.ts).toLocaleDateString()} · {fmtTime(h.ts)}
                      {h.endedAt != null
                        ? `–${fmtTime(h.endedAt)}`
                        : ongoing
                          ? ` · ${t("transcript.sessionOngoing", { defaultValue: "en cours" })}`
                          : ""}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>
                      {t("transcript.segmentCount", { count, defaultValue: "{{count}} segments" })}
                      {h.startedBy ? ` · ${h.startedBy.replace(/^@/, "").split(":")[0]}` : ""}
                    </div>
                  </div>
                  {summaries[h.id] && (
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      background: 'var(--color-tertiary-container)',
                      color: 'var(--color-on-tertiary-container)',
                      borderRadius: 6,
                      padding: '1px 6px',
                      flexShrink: 0,
                    }}>
                      {t("transcript.summaryAvailable", { defaultValue: "résumé" })}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}
