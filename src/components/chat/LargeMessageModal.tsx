import { useTranslation } from "react-i18next";

interface Props {
  /** Size of the pending message, in KB, for display. */
  sizeKb: number;
  /** Send the message as a .txt attachment. */
  onConfirm: () => void;
  /** Dismiss without sending — the draft is kept in the input. */
  onClose: () => void;
}

// Shown when a message exceeds the server's event-size limit. Rather than
// failing the send with M_TOO_LARGE, we offer to ship the text as a .txt
// attachment (which goes through media upload). Styled like the other Sion
// modals (see ScreenShareOptionsModal) instead of the native window.confirm.
export function LargeMessageModal({ sizeKb, onConfirm, onClose }: Props) {
  const { t } = useTranslation();

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '92%',
          background: 'var(--color-surface-container)',
          borderRadius: 20, padding: 24,
          display: 'flex', flexDirection: 'column', gap: 14,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t("chat.tooLargeTitle")}
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-on-surface-variant)' }}>
          {t("chat.tooLargeBody", { size: sizeKb })}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
              background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
              fontSize: 13, fontFamily: 'inherit',
            }}
          >{t("auth.cancel")}</button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
              background: 'var(--color-primary)', color: 'var(--color-on-primary)',
              fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
            }}
          >{t("chat.tooLargeSendAsFile")}</button>
        </div>
      </div>
    </div>
  );
}
