import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";

export function DropZone() {
  const { t } = useTranslation();
  const isDraggingOver = useAppStore((s) => s.isDraggingOver);

  if (!isDraggingOver) return null;

  return (
    <div style={{
      position: 'absolute' as const,
      inset: 12,
      zIndex: 50,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--color-surface-container)',
      border: '2px dashed var(--color-primary)',
      borderRadius: 28,
      pointerEvents: 'none' as const,
      animation: 'fade-in 150ms ease-out',
      opacity: 0.95,
    }}>
      <span style={{ color: 'var(--color-primary)', fontSize: 18, fontWeight: 600 }}>{t("chat.dropFiles")}</span>
      <span style={{ color: 'var(--color-outline)', fontSize: 12, marginTop: 6 }}>{t("chat.dropFilesHint")}</span>
    </div>
  );
}
