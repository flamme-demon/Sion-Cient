import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkForUpdate, type UpdateInfo } from "../../services/updateService";

export function UpdateBanner() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkForUpdate().then(setUpdate);
    const timer = setInterval(() => {
      checkForUpdate().then(setUpdate);
    }, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!update || dismissed) return null;

  const handleDownload = () => {
    if (update.releaseUrl) {
      if (window.__TAURI_INTERNALS__) {
        import("../../utils/openExternal").then(({ openExternalUrl }) => openExternalUrl(update.releaseUrl));
      } else {
        window.open(update.releaseUrl, "_blank");
      }
    }
  };

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: "6px 16px",
      background: "linear-gradient(135deg, var(--color-primary), var(--color-tertiary, var(--color-primary)))",
      color: "var(--color-on-primary)",
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: "0.01em",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    }}>
      <span style={{ opacity: 0.9 }}>
        {t("update.available", { version: update.version })}
      </span>
      <button
        onClick={handleDownload}
        style={{
          padding: "3px 14px",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.3)",
          background: "rgba(255,255,255,0.15)",
          color: "var(--color-on-primary)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          transition: "background 150ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.25)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.15)")}
      >
        {t("update.download")}
      </button>
      <button
        onClick={() => setDismissed(true)}
        style={{
          position: "absolute",
          right: 12,
          padding: "2px 6px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "var(--color-on-primary)",
          fontSize: 13,
          cursor: "pointer",
          opacity: 0.6,
          transition: "opacity 150ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
      >
        ✕
      </button>
    </div>
  );
}
