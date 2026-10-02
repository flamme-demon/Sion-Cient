import { useTranslation } from "react-i18next";
import { DisconnectIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { arreterReconnexion } from "../../services/reconnexionVocale";

/**
 * Session vocale perdue, en cours de reprise (`reconnexionVocale.ts`) : le
 * salon visé, l'essai en cours, et de quoi abandonner. À la place du bloc
 * vocal (PC) ou de la barre vocale (téléphone, `mobile`).
 */
export function CarteReconnexion({ compact = false, mobile = false }: { compact?: boolean; mobile?: boolean }) {
  const { t } = useTranslation();
  const reprise = useAppStore((s) => s.reconnexionVocale);
  const nom = useMatrixStore((s) => s.channels.find((c) => c.id === reprise?.salon)?.name);
  if (!reprise) return null;
  const texte = t("voice.reconnectingTo", { salon: nom ?? "…" });
  const essai = reprise.essai > 0 ? t("voice.reconnectAttempt", { essai: reprise.essai }) : null;

  const abandonner = (
    <button
      onClick={arreterReconnexion}
      title={t("voice.reconnectCancel")}
      aria-label={t("voice.reconnectCancel")}
      style={{
        flexShrink: 0, border: 'none', cursor: 'pointer', padding: 7, borderRadius: 10, display: 'flex',
        background: 'var(--color-error-container)', color: 'var(--color-error)',
      }}
    >
      <DisconnectIcon />
    </button>
  );
  const point = <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-orange)', flexShrink: 0 }} />;

  if (compact) {
    return (
      <div
        title={essai ? `${texte} (${essai})` : texte}
        style={{
          padding: '8px 0', borderRadius: 12, width: '100%', flexShrink: 0, marginBottom: 10,
          background: 'var(--color-surface-container-high)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        }}
      >
        {point}
        {abandonner}
      </div>
    );
  }
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        ...(mobile
          ? {
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
              padding: '10px 16px max(env(safe-area-inset-bottom), 16px)',
              background: 'var(--color-surface-container)',
              borderTop: '1px solid var(--color-outline-variant)',
            }
          : { marginBottom: 10, padding: 10, borderRadius: 12, background: 'var(--color-surface-container-high)' }),
      }}
    >
      {point}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-orange)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {texte}
        </span>
        {essai && <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{essai}</span>}
      </span>
      {abandonner}
    </div>
  );
}
