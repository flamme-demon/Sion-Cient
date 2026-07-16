import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { startTranscription, stopTranscription, summarizeMeeting } from "../../services/transcriptionService";

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

/** Live meeting transcript — right side panel (MemberPanel-style column).
 *  Renders `com.sion.transcript` events for the voice channel we're
 *  connected to (they arrive over Matrix whether or not WE transcribe).
 *  "Transcrire mon micro" only controls OUR OWN engine; "Résumer" runs the
 *  local LLM over everything received and posts the minutes to the chat. */
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
  const entries = useTranscriptStore((s) => (connectedVoice ? s.entries[connectedVoice] : undefined)) || [];
  const sendFile = useMatrixStore((s) => s.sendFile);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [exported, setExported] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Auto-scroll on new entries unless the user scrolled up to read back.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  if (!panelOpen || !connectedVoice) return null;

  const busy = engineState === "starting";
  const running = engineState === "on" || busy;
  const summaryBusy = summaryState !== "idle";
  // The local engines live in the Rust backend — web/mobile builds still SEE
  // everyone's transcript (it arrives over Matrix) but can't feed/summarize.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canTranscribe = typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";

  const handleToggleEngine = () => {
    if (running) {
      stopTranscription();
    } else {
      startTranscription(connectedVoice).catch((err) => {
        console.error("[Sion][transcribe] start failed:", err);
        useTranscriptStore.getState().setState("error", String(err?.message || err));
      });
    }
  };

  const handleSummarize = () => {
    setSummaryError(null);
    summarizeMeeting(connectedVoice).catch((err) => {
      console.error("[Sion][summary] failed:", err);
      setSummaryError(String(err?.message || err));
    });
  };

  const handleExport = async () => {
    if (!entries.length) return;
    const channelName = useMatrixStore.getState().channels.find((c) => c.id === connectedVoice)?.name || "reunion";
    const lines = entries.map((e) => `- **${e.senderName}** (${fmtTime(e.t0)}) : ${e.text}`);
    const md = `# ${t("transcript.exportTitle", { defaultValue: "Transcription" })} — ${channelName} — ${new Date().toLocaleDateString()}\n\n${lines.join("\n")}\n`;
    const file = new File([md], `transcript-${channelName}-${new Date().toISOString().slice(0, 10)}.md`, { type: "text/markdown" });
    try {
      await sendFile(connectedVoice, file);
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch (err) {
      console.error("[Sion][transcribe] export failed:", err);
    }
  };

  const statusDot = engineState === "on" ? "var(--color-green)" : engineState === "starting" ? "#ff9800" : engineState === "error" ? "var(--color-error)" : "var(--color-outline)";

  const actionBtn = (label: string, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean; title?: string }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={opts?.disabled}
      title={opts?.title}
      style={{
        width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        cursor: opts?.disabled ? 'default' : 'pointer',
        opacity: opts?.disabled ? 0.55 : 1,
        background: opts?.danger ? 'var(--color-error-container)' : 'var(--color-surface-container-highest)',
        color: opts?.danger ? 'var(--color-error)' : 'var(--color-on-surface)',
        transition: 'background 150ms',
      }}
    >{label}</button>
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
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-outline-variant)',
      }}>
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

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderBottom: '1px solid var(--color-outline-variant)' }}>
        {canTranscribe && actionBtn(
          running
            ? t("transcript.stopMine", { defaultValue: "Arrêter mon micro" })
            : t("transcript.startMine", { defaultValue: "Transcrire mon micro" }),
          handleToggleEngine,
          { danger: running, disabled: busy },
        )}
        {canTranscribe && actionBtn(
          summaryState === "downloading"
            ? `${t("transcript.summaryDownloading", { defaultValue: "Téléchargement IA…" })} ${summaryPct ?? 0}%`
            : summaryState === "running"
              ? t("transcript.summarizing", { defaultValue: "Résumé en cours…" })
              : t("transcript.summarize", { defaultValue: "Résumer la réunion" }),
          handleSummarize,
          {
            disabled: summaryBusy || !entries.length,
            title: t("transcript.summarizeHint", { defaultValue: "Génère un compte-rendu (IA locale) et le poste dans le chat" }),
          },
        )}
        {actionBtn(
          exported ? "✓" : t("transcript.export", { defaultValue: "Exporter .md" }),
          handleExport,
          { disabled: !entries.length, title: t("transcript.exportHint", { defaultValue: "Envoie le transcript en .md dans le chat" }) },
        )}
        {downloadPct != null && downloadPct < 100 && (
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
            {t("transcript.downloading", { defaultValue: "téléchargement du modèle…" })} {downloadPct}%
          </div>
        )}
        {engineState === "error" && engineError && (
          <div style={{ fontSize: 11, color: 'var(--color-error)' }}>{engineError}</div>
        )}
        {summaryError && (
          <div style={{ fontSize: 11, color: 'var(--color-error)' }}>{summaryError}</div>
        )}
      </div>

      {/* Entries */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        style={{ overflowY: 'auto', flex: 1, padding: '8px 12px 12px', fontSize: 13, color: 'var(--color-on-surface)' }}
      >
        {entries.length === 0 ? (
          <div style={{ paddingTop: 8, fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
            {t("transcript.empty", { defaultValue: "Aucun segment pour l'instant. Activez « Transcrire mon micro » — chaque participant transcrit sa propre voix, localement." })}
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
    </aside>
  );
}
