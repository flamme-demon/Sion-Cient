import { useMatrixStore } from "../stores/useMatrixStore";
import { useLiveKitStore } from "../stores/useLiveKitStore";

/**
 * Top-of-app banner that surfaces network problems on either of the two
 * upstream services Sion depends on:
 *  - Matrix server (Continuwuity) for chat/state
 *  - LiveKit SFU for voice/video — only relevant when the user is in a vocal channel
 *
 * Hidden when both connections are healthy or when the user isn't in a vocal channel
 * (we don't want to spam disconnected-LiveKit warnings when nobody's in voice).
 */
export function ConnectionStatusBanner() {
  const matrixStatus = useMatrixStore((s) => s.connectionStatus);
  const livekitConnected = useLiveKitStore((s) => s.connected);
  const livekitState = useLiveKitStore((s) => s.connectionState);

  // Build the message and severity from whichever side is currently degraded.
  // Matrix issues take priority because chat is always relevant; LiveKit
  // issues are only surfaced when the user is actually using voice.
  let message: string | null = null;
  let severity: "warning" | "error" = "warning";

  if (matrixStatus === "error") {
    message = "Connexion au serveur perdue — tentative de reconnexion...";
    severity = "error";
  } else if (matrixStatus === "reconnecting") {
    message = "Reconnexion au serveur en cours...";
    severity = "warning";
  } else if (livekitConnected && livekitState === "reconnecting") {
    message = "Reconnexion au serveur vocal en cours...";
    severity = "warning";
  } else if (livekitConnected && livekitState === "disconnected") {
    message = "Connexion au serveur vocal perdue";
    severity = "error";
  }

  if (!message) return null;

  const bg = severity === "error" ? "var(--color-error-container)" : "var(--color-tertiary-container)";
  const fg = severity === "error" ? "var(--color-on-error-container)" : "var(--color-on-tertiary-container)";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "8px 16px",
        background: bg,
        color: fg,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: severity === "error" ? "var(--color-error)" : "var(--color-tertiary)",
          animation: "pulse-dot 1.4s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span>{message}</span>
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
}
