import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { startTranscription, stopTranscription } from "../../services/transcriptionService";
import { CloseIcon } from "../icons";

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

/** Live meeting transcript. Renders `com.sion.transcript` events for the
 *  voice channel we're connected to (they arrive over Matrix whether or not
 *  WE transcribe). The toggle controls OUR OWN mic transcription only. */
export function TranscriptPanel() {
  const { t } = useTranslation();
  const panelOpen = useTranscriptStore((s) => s.panelOpen);
  const setPanelOpen = useTranscriptStore((s) => s.setPanelOpen);
  const engineState = useTranscriptStore((s) => s.state);
  const engineError = useTranscriptStore((s) => s.error);
  const downloadPct = useTranscriptStore((s) => s.downloadPct);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const entries = useTranscriptStore((s) => (connectedVoice ? s.entries[connectedVoice] : undefined)) || [];
  const sendFile = useMatrixStore((s) => s.sendFile);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [exported, setExported] = useState(false);

  // Auto-scroll on new entries unless the user scrolled up to read back.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  if (!panelOpen || !connectedVoice) return null;

  const busy = engineState === "starting";
  const running = engineState === "on" || busy;
  // The local whisper engine lives in the Rust backend — web/mobile builds
  // still SEE everyone's transcript (it arrives over Matrix) but can't feed it.
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

  const statusDot = engineState === "on" ? "#4caf50" : engineState === "starting" ? "#ff9800" : engineState === "error" ? "var(--color-error)" : "var(--color-outline)";

  return (
    <div
      className="border-b border-[var(--color-border)] flex flex-col"
      style={{ background: "var(--color-surface-container-low)", maxHeight: "30vh" }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: "var(--color-on-surface-variant)" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusDot, flexShrink: 0 }} />
        <span className="font-semibold">{t("transcript.title", { defaultValue: "Transcription" })}</span>
        {downloadPct != null && downloadPct < 100 && (
          <span>{t("transcript.downloading", { defaultValue: "téléchargement du modèle…" })} {downloadPct}%</span>
        )}
        {engineState === "error" && engineError && (
          <span style={{ color: "var(--color-error)" }} className="truncate">{engineError}</span>
        )}
        <span className="flex-1" />
        {canTranscribe && (
          <button
            type="button"
            onClick={handleToggleEngine}
            disabled={busy}
            className="px-2 py-0.5 rounded transition-colors"
            style={{
              border: "1px solid var(--color-outline-variant)",
              background: running ? "var(--color-error)" : "var(--color-primary)",
              color: "white",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {running
              ? t("transcript.stopMine", { defaultValue: "Arrêter mon micro" })
              : t("transcript.startMine", { defaultValue: "Transcrire mon micro" })}
          </button>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={!entries.length}
          title={t("transcript.exportHint", { defaultValue: "Envoie le transcript en .md dans le chat" })}
          className="px-2 py-0.5 rounded transition-colors"
          style={{
            border: "1px solid var(--color-outline-variant)",
            background: "transparent",
            color: "var(--color-on-surface-variant)",
            cursor: entries.length ? "pointer" : "default",
            opacity: entries.length ? 1 : 0.5,
          }}
        >
          {exported ? "✓" : t("transcript.export", { defaultValue: "Exporter .md" })}
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          aria-label={t("common.close", { defaultValue: "Fermer" })}
          style={{ border: "none", background: "transparent", color: "var(--color-on-surface-variant)", cursor: "pointer", display: "flex" }}
        >
          <CloseIcon />
        </button>
      </div>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="overflow-y-auto px-3 pb-2 text-sm"
        style={{ color: "var(--color-on-surface)" }}
      >
        {entries.length === 0 ? (
          <div className="py-3 text-xs" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("transcript.empty", { defaultValue: "Aucun segment pour l'instant. Activez « Transcrire mon micro » — chaque participant transcrit sa propre voix, localement." })}
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="py-0.5 leading-snug">
              <span style={{ color: "var(--color-outline)", fontSize: 11, marginRight: 6 }}>{fmtTime(e.t0)}</span>
              <span style={{ color: colorForIdentity(e.senderId), fontWeight: 600, marginRight: 6 }}>{e.senderName}</span>
              <span>{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
