import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkForUpdate, type UpdateInfo } from "../../services/updateService";

export function UpdateBanner() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check on mount, then every hour
    checkForUpdate().then(setUpdate);
    const timer = setInterval(() => {
      checkForUpdate().then(setUpdate);
    }, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!update || dismissed) return null;

  const handleDownload = () => {
    if (update.downloadUrl) {
      // Open in default browser
      if (window.__TAURI_INTERNALS__) {
        import("../../utils/openExternal").then(({ openExternalUrl }) => openExternalUrl(update.downloadUrl));
      } else {
        window.open(update.downloadUrl, "_blank");
      }
    }
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: "8px 16px",
      background: "var(--color-primary-container)",
      color: "var(--color-on-primary-container)",
      fontSize: 12,
      fontWeight: 500,
    }}>
      <span>{t("update.available", { version: update.version })}</span>
      <button
        onClick={handleDownload}
        style={{
          padding: "4px 12px",
          borderRadius: 8,
          border: "none",
          background: "var(--color-primary)",
          color: "var(--color-on-primary)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {t("update.download")}
      </button>
      <button
        onClick={() => setDismissed(true)}
        style={{
          padding: "2px 6px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "var(--color-on-primary-container)",
          fontSize: 14,
          cursor: "pointer",
          opacity: 0.6,
        }}
      >
        ✕
      </button>
    </div>
  );
}
