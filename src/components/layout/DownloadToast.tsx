import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { openLocalFile, showInFolder } from "../../utils/openExternal";

export function DownloadToast() {
  const { t } = useTranslation();
  const notification = useAppStore((s) => s.downloadNotification);
  const dismiss = useAppStore((s) => s.dismissDownloadNotification);

  if (!notification) return null;

  const { filename, path } = notification;

  const handleOpen = () => {
    openLocalFile(path);
    dismiss();
  };

  const handleShowFolder = () => {
    showInFolder(path);
    dismiss();
  };

  return (
    <div style={{
      position: "fixed",
      top: 8,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 10000,
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 16px",
      background: "var(--color-surface-container-highest)",
      color: "var(--color-on-surface)",
      borderRadius: 12,
      fontSize: 12,
      fontWeight: 500,
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      animation: "slideDown 250ms ease-out",
      maxWidth: "min(500px, 90vw)",
    }}>
      <span style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        flex: 1,
        minWidth: 0,
      }}>
        {t("download.saved", { filename })}
      </span>
      <button
        onClick={handleOpen}
        style={{
          padding: "3px 10px",
          borderRadius: 8,
          border: "none",
          background: "var(--color-primary)",
          color: "var(--color-on-primary)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {t("download.open")}
      </button>
      <button
        onClick={handleShowFolder}
        style={{
          padding: "3px 10px",
          borderRadius: 8,
          border: "1px solid var(--color-outline-variant)",
          background: "transparent",
          color: "var(--color-on-surface-variant)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {t("download.showFolder")}
      </button>
      <button
        onClick={dismiss}
        style={{
          padding: "2px 6px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "var(--color-on-surface)",
          fontSize: 13,
          cursor: "pointer",
          opacity: 0.5,
        }}
      >
        ✕
      </button>
    </div>
  );
}
