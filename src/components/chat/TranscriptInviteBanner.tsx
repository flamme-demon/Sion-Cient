import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useTranscriptStore } from "../../stores/useTranscriptStore";
import { armTranscription } from "../../services/transcriptionService";
import { MicIcon } from "../icons";

/** Transcription invitation — a slim PinnedBar-style banner under the pins:
 *  someone in our voice channel armed transcription and waits for a second
 *  participant. Replaces the old auto-opening of the side panel (too
 *  intrusive). Dismissable; reappears if the armed set changes. */
export function TranscriptInviteBanner() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const armedPeers = useTranscriptStore((s) => s.armedPeers);
  const session = useTranscriptStore((s) => (connectedVoice ? s.sessions[connectedVoice] : undefined)) || null;
  const engineState = useTranscriptStore((s) => s.state);
  const setPanelOpen = useTranscriptStore((s) => s.setPanelOpen);
  const [dismissed, setDismissed] = useState(false);

  // A new/changed invitation cancels a previous dismissal.
  const armedKey = armedPeers.map((p) => p.identity).sort().join("|");
  useEffect(() => {
    setDismissed(false);
  }, [armedKey]);

  const sessionActive = !!session && !session.endedAt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canTranscribe = typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";

  if (
    dismissed ||
    !connectedVoice ||
    activeChannel !== connectedVoice ||
    armedPeers.length === 0 ||
    sessionActive ||
    engineState === "armed" || engineState === "on" || engineState === "starting"
  ) {
    return null;
  }

  const handleJoin = () => {
    setPanelOpen(true);
    armTranscription(connectedVoice).catch((err) => {
      console.error("[Sion][transcribe] arm failed:", err);
      useTranscriptStore.getState().setState("error", String((err as Error)?.message || err));
    });
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 24px',
      background: 'var(--color-secondary-container)',
      color: 'var(--color-on-secondary-container)',
      borderBottom: '1px solid var(--color-outline-variant)',
      minHeight: 40,
    }}>
      <MicIcon />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t("transcript.invitation", {
          name: armedPeers.map((p) => p.name).join(", "),
          defaultValue: "{{name}} souhaite lancer la transcription.",
        })}
      </span>
      {canTranscribe && (
        <button
          type="button"
          onClick={handleJoin}
          style={{
            padding: '5px 14px', borderRadius: 14, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0,
            background: 'var(--color-primary)', color: 'var(--color-on-primary)',
          }}
        >
          {t("transcript.joinShort", { defaultValue: "Rejoindre" })}
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title={t("members.close", { defaultValue: "Fermer" })}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0,
          color: 'var(--color-on-secondary-container)', fontSize: 16, padding: 2, lineHeight: 1, opacity: 0.7,
        }}
      >×</button>
    </div>
  );
}
