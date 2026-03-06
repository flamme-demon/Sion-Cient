import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMatrixStore } from "../../stores/useMatrixStore";
import type { VerificationStep, EmojiData } from "../../stores/useMatrixStore";
import { CloseIcon } from "../icons";

export function VerificationBanner() {
  const { t } = useTranslation();
  const needsVerification = useMatrixStore((s) => s.needsVerification);
  const hasUndecryptableMessages = useMatrixStore((s) => s.hasUndecryptableMessages);
  const isRestoringKeys = useMatrixStore((s) => s.isRestoringKeys);
  const restoreWithRecoveryKey = useMatrixStore((s) => s.restoreWithRecoveryKey);
  const dismissVerification = useMatrixStore((s) => s.dismissVerification);

  // Cross-device verification
  const verificationStep = useMatrixStore((s) => s.verificationStep);
  const verificationEmojis = useMatrixStore((s) => s.verificationEmojis);
  const verificationError = useMatrixStore((s) => s.verificationError);
  const startCrossDeviceVerification = useMatrixStore((s) => s.startCrossDeviceVerification);
  const confirmVerificationEmojis = useMatrixStore((s) => s.confirmVerificationEmojis);
  const rejectVerificationEmojis = useMatrixStore((s) => s.rejectVerificationEmojis);
  const cancelVerification = useMatrixStore((s) => s.cancelVerification);

  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"choose" | "recovery" | "cross-device">("choose");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryError, setRecoveryError] = useState("");

  // Show banner if device needs verification OR if an incoming verification flow is active
  const hasActiveIncomingVerification = !needsVerification &&
    verificationStep !== "idle" && verificationStep !== "done";
  const isVisible = needsVerification || hasActiveIncomingVerification;

  // Auto-expand and switch to cross-device mode when an incoming verification arrives
  const prevStepRef = useRef(verificationStep);
  useEffect(() => {
    if (!needsVerification && prevStepRef.current === "idle" && verificationStep === "waiting") {
      // Incoming verification just started — auto-expand in cross-device mode
      setExpanded(true);
      setMode("cross-device");
    }
    prevStepRef.current = verificationStep;
  }, [verificationStep, needsVerification]);

  if (!isVisible) return null;

  const handleRestore = async () => {
    if (!recoveryKey.trim()) return;
    setRecoveryError("");
    try {
      await restoreWithRecoveryKey(recoveryKey.trim());
    } catch {
      setRecoveryError(t("auth.errorRecoveryKey"));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRestore();
    }
  };

  const handleStartCrossDevice = () => {
    setMode("cross-device");
    startCrossDeviceVerification();
  };

  const handleBack = () => {
    if (verificationStep !== "idle" && verificationStep !== "done" && verificationStep !== "cancelled" && verificationStep !== "error") {
      cancelVerification();
    }
    setMode("choose");
  };

  const colors = {
    container: "var(--color-tertiary-container, #3a3000)",
    text: "var(--color-on-tertiary-container, #ffe08a)",
    dot: "var(--color-warning, #ffb74d)",
  };

  const renderCrossDeviceContent = (step: VerificationStep, emojis: EmojiData[], error: string | null) => {
    if (step === "requesting" || step === "waiting") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
            {t("auth.crossDeviceWaiting")}
          </div>
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <div style={{
              width: 24, height: 24,
              border: `2px solid ${colors.text}`,
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
          </div>
          <button onClick={handleBack} style={smallBtnStyle(false)}>
            {t("auth.cancel")}
          </button>
        </div>
      );
    }

    if (step === "comparing") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
            {t("auth.crossDeviceCompare")}
          </div>
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            justifyContent: "center",
            padding: "8px 0",
            marginBottom: 8,
          }}>
            {emojis.map((e, i) => (
              <div key={i} style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                padding: "6px 4px",
                minWidth: 48,
                borderRadius: 12,
                background: "var(--color-surface-container-high)",
              }}>
                <span style={{ fontSize: 22 }}>{e.emoji}</span>
                <span style={{ fontSize: 9, color: "var(--color-on-surface-variant)", textAlign: "center", lineHeight: 1.2 }}>
                  {e.name}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={confirmVerificationEmojis} style={{
              ...actionBtnStyle,
              flex: 1,
              background: "var(--color-primary)",
              color: "var(--color-on-primary)",
            }}>
              {t("auth.crossDeviceMatch")}
            </button>
            <button onClick={rejectVerificationEmojis} style={{
              ...actionBtnStyle,
              flex: 1,
              background: "var(--color-error-container)",
              color: "var(--color-on-error-container)",
            }}>
              {t("auth.crossDeviceNoMatch")}
            </button>
          </div>
        </div>
      );
    }

    if (step === "confirmed") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, lineHeight: 1.4 }}>
            {t("auth.crossDeviceConfirmed")}
          </div>
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <div style={{
              width: 24, height: 24,
              border: `2px solid ${colors.text}`,
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
          </div>
        </div>
      );
    }

    if (step === "done") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{
            fontSize: 12, fontWeight: 600,
            color: "var(--color-primary)",
            textAlign: "center",
            padding: "8px 0",
          }}>
            {t("auth.crossDeviceDone")}
          </div>
        </div>
      );
    }

    if (step === "cancelled" || step === "error") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          {error && (
            <div style={{
              fontSize: 11, color: "var(--color-error)",
              marginBottom: 8, padding: "6px 8px",
              borderRadius: 8, background: "var(--color-error-container)",
            }}>
              {error}
            </div>
          )}
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 8 }}>
            {step === "cancelled" ? t("auth.crossDeviceCancelled") : t("auth.crossDeviceError")}
          </div>
          <button onClick={handleBack} style={smallBtnStyle(false)}>
            {t("auth.crossDeviceRetry")}
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div style={{
      margin: "0 12px",
      borderRadius: 16,
      overflow: "hidden",
      background: colors.container,
    }}>
      {/* Banner header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: colors.dot, flexShrink: 0,
        }} />
        <span style={{
          flex: 1, fontSize: 12, fontWeight: 600,
          color: colors.text, lineHeight: 1.3,
        }}>
          {hasActiveIncomingVerification
            ? t("auth.incomingVerification")
            : hasUndecryptableMessages ? t("auth.keysNeeded") : t("auth.verificationNeeded")}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); hasActiveIncomingVerification ? cancelVerification() : dismissVerification(); }}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            padding: 4, borderRadius: 8, display: "flex",
            color: colors.text, opacity: 0.6,
          }}
          title={t("auth.dismiss")}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <>
          {mode === "choose" && !hasActiveIncomingVerification && (
            <div style={{ padding: "0 12px 12px 12px" }}>
              <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
                {t("auth.verificationHint")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button onClick={handleStartCrossDevice} style={{
                  ...actionBtnStyle,
                  background: "var(--color-primary)",
                  color: "var(--color-on-primary)",
                }}>
                  {t("auth.crossDeviceButton")}
                </button>
                <button onClick={() => setMode("recovery")} style={{
                  ...actionBtnStyle,
                  background: "var(--color-surface-container-high)",
                  color: "var(--color-on-surface)",
                }}>
                  {t("auth.recoveryKeyButton")}
                </button>
              </div>
            </div>
          )}

          {mode === "recovery" && (
            <div style={{ padding: "0 12px 12px 12px" }}>
              <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 8, lineHeight: 1.4 }}>
                {t("auth.encryptionHint")}
              </div>
              <button
                onClick={() => setMode("choose")}
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  fontSize: 11, color: colors.text, opacity: 0.6,
                  padding: "0 0 8px 0", fontFamily: "inherit",
                }}
              >
                ← {t("auth.back")}
              </button>

              {recoveryError && (
                <div style={{
                  fontSize: 11, color: "var(--color-error)",
                  marginBottom: 8, padding: "6px 8px",
                  borderRadius: 8, background: "var(--color-error-container)",
                }}>
                  {recoveryError}
                </div>
              )}

              <input
                type="password"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="EsT9 M5a5 ..."
                autoComplete="off"
                style={{
                  width: "100%", padding: "10px 12px",
                  border: "none", outline: "none",
                  borderRadius: "10px 10px 4px 4px",
                  fontSize: 12, fontFamily: "monospace",
                  color: "var(--color-on-surface)",
                  background: "var(--color-surface-container-high)",
                  boxSizing: "border-box",
                }}
              />

              <button
                onClick={handleRestore}
                disabled={isRestoringKeys || !recoveryKey.trim()}
                style={{
                  ...actionBtnStyle,
                  width: "100%", marginTop: 8,
                  background: "var(--color-primary)",
                  color: "var(--color-on-primary)",
                  opacity: isRestoringKeys || !recoveryKey.trim() ? 0.6 : 1,
                  cursor: isRestoringKeys ? "wait" : "pointer",
                }}
              >
                {isRestoringKeys ? t("auth.restoring") : t("auth.restoreKeys")}
              </button>
            </div>
          )}

          {(mode === "cross-device" || hasActiveIncomingVerification) && renderCrossDeviceContent(verificationStep, verificationEmojis, verificationError)}
        </>
      )}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  padding: "9px 0",
  border: "none",
  cursor: "pointer",
  borderRadius: 20,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "inherit",
  transition: "opacity 200ms",
};

function smallBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    ...actionBtnStyle,
    width: "100%",
    background: "var(--color-surface-container-high)",
    color: "var(--color-on-surface)",
    opacity: disabled ? 0.6 : 1,
  };
}
