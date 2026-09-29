import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import type { VerificationStep, EmojiData } from "../../stores/useMatrixStore";
import { CloseIcon } from "../icons";
import * as core from "../../services/matrixCore";
import { QrImage } from "../qr/QrImage";
import { ScannerQr, type QrLu } from "../qr/ScannerQr";

export function VerificationBanner({ compact = false }: { compact?: boolean }) {
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
  const verificationQr = useMatrixStore((s) => s.verificationQr);
  const verificationScanner = useMatrixStore((s) => s.verificationScanner);
  const [scan, setScan] = useState(false);
  // Le scanner ne survit pas à l'étape `pret` (vérification annulée, emojis…).
  const [etapeVue, setEtapeVue] = useState(verificationStep);
  if (etapeVue !== verificationStep) {
    setEtapeVue(verificationStep);
    if (verificationStep !== "pret") setScan(false);
  }

  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"choose" | "recovery" | "cross-device">("choose");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryError, setRecoveryError] = useState("");

  // Show banner if device needs verification OR if an incoming verification flow is active
  const hasActiveIncomingVerification = !needsVerification &&
    verificationStep !== "idle" && verificationStep !== "done";
  const isVisible = needsVerification || hasActiveIncomingVerification;

  // Une vérification qui démarre — reçue d'un autre appareil, ou lancée
  // d'elle-même après une connexion par QR code — déploie la bannière.
  const prevStepRef = useRef(verificationStep);
  useEffect(() => {
    const avant = prevStepRef.current;
    const auRepos = avant === "idle" || avant === "done" || avant === "cancelled" || avant === "error";
    if (auRepos && (verificationStep === "requesting" || verificationStep === "waiting" || verificationStep === "pret")) {
      setExpanded(true);
      setMode("cross-device");
    }
    prevStepRef.current = verificationStep;
  }, [verificationStep]);

  if (!isVisible) return null;

  // Rail : la bannière (flux de vérification, saisie de clé) ne tient pas
  // dans 72px. Une pastille la signale — la masquer tout à fait rendait une
  // demande de vérification invisible (29/09) ; un clic déploie le menu.
  if (compact) {
    const libelle = hasActiveIncomingVerification
      ? t("auth.incomingVerification")
      : hasUndecryptableMessages ? t("auth.keysNeeded") : t("auth.verificationNeeded");
    return (
      <button
        onClick={() => useLayoutStore.getState().setSidebarMode("full")}
        title={libelle}
        aria-label={libelle}
        style={{
          margin: "4px auto", width: 40, height: 40, borderRadius: 12, flexShrink: 0,
          background: "var(--color-tertiary-container)", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--color-warning)" }} />
      </button>
    );
  }

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

  /** QR lu par la caméra : un QR de vérification Matrix commence par « MATRIX ». */
  const lireQrVerification = async ({ octets }: QrLu): Promise<string | null> => {
    const entete = String.fromCharCode(...octets.slice(0, 6));
    if (entete !== "MATRIX") return t("qr.notVerificationCode");
    try {
      await core.verificationScanner(octets);
      return null;
    } catch (e) {
      return String(e);
    }
  };

  const colors = {
    container: "var(--color-tertiary-container)",
    text: "var(--color-on-tertiary-container)",
    dot: "var(--color-warning)",
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

    if (step === "pret") {
      return (
        <div style={{ padding: "0 12px 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {verificationQr && (
            <>
              <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, lineHeight: 1.4 }}>
                {t("qr.verifyShowHint")}
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <QrImage octetsBase64={verificationQr} taille={200} alt={t("qr.verifyShowHint")} />
              </div>
            </>
          )}
          {verificationScanner && (
            <button onClick={() => setScan(true)} style={{
              ...actionBtnStyle,
              background: "var(--color-primary)",
              color: "var(--color-on-primary)",
            }}>
              {t("qr.verifyScan")}
            </button>
          )}
          <button onClick={() => void core.verificationParEmojis().catch(() => {})} style={smallBtnStyle(false)}>
            {t("qr.verifyEmojis")}
          </button>
          <button onClick={handleBack} style={{ ...smallBtnStyle(false), background: "transparent" }}>
            {t("auth.cancel")}
          </button>
          {scan && (
            <ScannerQr
              titre={t("qr.verifyScan")}
              aide={t("qr.verifyScanHint")}
              onLu={lireQrVerification}
              onFermer={() => setScan(false)}
            />
          )}
        </div>
      );
    }

    if (step === "qr-scanne") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
            {t("qr.verifyScannedQuestion")}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => void core.verificationConfirmerQr().catch(() => {})} style={{
              ...actionBtnStyle,
              flex: 1,
              background: "var(--color-primary)",
              color: "var(--color-on-primary)",
            }}>
              {t("qr.yes")}
            </button>
            <button onClick={cancelVerification} style={{
              ...actionBtnStyle,
              flex: 1,
              background: "var(--color-error-container)",
              color: "var(--color-on-error-container)",
            }}>
              {t("qr.no")}
            </button>
          </div>
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

    if (step === "confirmed" || step === "qr-attente") {
      return (
        <div style={{ padding: "0 12px 12px 12px" }}>
          <div style={{ fontSize: 11, color: colors.text, opacity: 0.75, lineHeight: 1.4 }}>
            {step === "qr-attente" ? t("qr.verifyWaitingOther") : t("auth.crossDeviceConfirmed")}
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
          onClick={(e) => {
            e.stopPropagation();
            if (hasActiveIncomingVerification) cancelVerification();
            else dismissVerification();
          }}
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
                type="text"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="EsT9 M5a5 ..."
                autoComplete="off"
                name="sion-recovery"
                style={{
                  width: "100%", padding: "10px 12px",
                  border: "none", outline: "none",
                  borderRadius: "10px 10px 4px 4px",
                  fontSize: 12, fontFamily: "monospace",
                  color: "var(--color-on-surface)",
                  background: "var(--color-surface-container-high)",
                  boxSizing: "border-box",
                  WebkitTextSecurity: "disc",
                } as React.CSSProperties}
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
