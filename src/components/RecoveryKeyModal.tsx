import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMatrixStore } from "../stores/useMatrixStore";

export function RecoveryKeyModal() {
  const { t } = useTranslation();
  const bootstrapStep = useMatrixStore((s) => s.bootstrapStep);
  const generatedRecoveryKey = useMatrixStore((s) => s.generatedRecoveryKey);
  const dismissRecoveryKey = useMatrixStore((s) => s.dismissRecoveryKey);

  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  if (bootstrapStep !== "bootstrapping" && bootstrapStep !== "showRecoveryKey") return null;

  const handleCopy = async () => {
    if (!generatedRecoveryKey) return;
    try {
      await navigator.clipboard.writeText(generatedRecoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.7)",
      backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "var(--color-surface-container)",
        borderRadius: 20,
        padding: 32,
        maxWidth: 480,
        width: "90%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
        boxShadow: "0 16px 64px rgba(0,0,0,0.5)",
      }}>
        {bootstrapStep === "bootstrapping" && (
          <>
            <div style={{
              width: 40, height: 40,
              border: "3px solid var(--color-surface-container-high)",
              borderTopColor: "var(--color-primary)",
              borderRadius: "50%",
              animation: "spin 0.7s linear infinite",
            }} />
            <div style={{ fontSize: 15, color: "var(--color-on-surface)", fontWeight: 500 }}>
              {t("auth.bootstrapping")}
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </>
        )}

        {bootstrapStep === "showRecoveryKey" && generatedRecoveryKey && (
          <>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-on-surface)" }}>
              {t("auth.recoveryKeyTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--color-on-surface-variant)", textAlign: "center", lineHeight: 1.5 }}>
              {t("auth.recoveryKeyDescription")}
            </div>

            {/* Recovery key display */}
            <div style={{
              width: "100%",
              padding: "16px",
              borderRadius: 12,
              background: "var(--color-surface-container-high)",
              border: "1px solid var(--color-outline-variant)",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 13,
              color: "var(--color-on-surface)",
              wordBreak: "break-all",
              lineHeight: 1.6,
              textAlign: "center",
              userSelect: "all",
            }}>
              {generatedRecoveryKey}
            </div>

            {/* Copy button */}
            <button
              onClick={handleCopy}
              style={{
                width: "100%",
                padding: "10px 16px",
                borderRadius: 12,
                border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-container-high)",
                color: "var(--color-on-surface)",
                fontSize: 13,
                fontFamily: "inherit",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {copied ? t("auth.copied") : t("auth.copyKey")}
            </button>

            {/* Checkbox */}
            <label style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 13,
              color: "var(--color-on-surface-variant)",
              cursor: "pointer",
              userSelect: "none",
            }}>
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                style={{ accentColor: "var(--color-primary)", width: 16, height: 16 }}
              />
              {t("auth.recoveryKeySaved")}
            </label>

            {/* Continue button */}
            <button
              onClick={dismissRecoveryKey}
              disabled={!saved}
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 20,
                border: "none",
                background: saved ? "var(--color-primary)" : "var(--color-surface-container-high)",
                color: saved ? "var(--color-on-primary)" : "var(--color-on-surface-variant)",
                fontSize: 14,
                fontFamily: "inherit",
                fontWeight: 600,
                cursor: saved ? "pointer" : "default",
                opacity: saved ? 1 : 0.5,
                transition: "all 200ms",
              }}
            >
              {t("auth.continue")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
