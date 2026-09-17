import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import * as matrixService from "../../services/matrixService";
import type { PinnedSummary } from "../../services/matrixService";

/**
 * Liste complète des messages épinglés d'un salon.
 *
 * La barre des épinglés fait défiler les pins un par un, et seulement ceux dont
 * le message est déjà chargé : un épinglé de plusieurs mois en disparaissait.
 * Ce panneau les montre tous, en allant chercher sur le serveur ceux que le fil
 * local ne contient pas, et permet d'en rejoindre un directement.
 */
export function PinnedListPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  // Re-lire quand les épingles changent pendant que le panneau est ouvert.
  const pinnedVersion = useMatrixStore((s) => s.pinnedVersion);
  const [pins, setPins] = useState<PinnedSummary[] | null>(null);

  useEffect(() => {
    if (!activeChannel) return;
    let annule = false;
    setPins(null);
    void matrixService.getPinnedSummaries(activeChannel)
      .then((liste) => { if (!annule) setPins(liste); })
      .catch(() => { if (!annule) setPins([]); });
    return () => { annule = true; };
  }, [activeChannel, pinnedVersion]);

  useEffect(() => {
    const surEchap = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", surEchap);
    return () => window.removeEventListener("keydown", surEchap);
  }, [onClose]);

  const dateCourte = (ts: number) => ts
    ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "";

  return (
    <>
      {/* Voile de fermeture : un clic à côté referme, sans bloquer la vue. */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 40 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', top: '100%', right: 8, marginTop: 4, zIndex: 41,
          width: 380, maxWidth: 'calc(100vw - 32px)', maxHeight: 420, overflowY: 'auto',
          background: 'var(--color-surface-container-high)',
          border: '1px solid var(--color-outline-variant)',
          borderRadius: 12, padding: 6,
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface-variant)',
          padding: '6px 8px',
        }}>
          {t("chat.pinnedList", { defaultValue: "Messages épinglés" })}
          {pins ? ` (${pins.length})` : ""}
        </div>

        {pins === null && (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--color-outline)' }}>
            {t("chat.loading")}
          </div>
        )}

        {pins?.length === 0 && (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--color-outline)' }}>
            {t("chat.pinnedNone", { defaultValue: "Aucun message épinglé" })}
          </div>
        )}

        {pins?.map((pin) => (
          <button
            key={pin.eventId}
            type="button"
            onClick={() => { setScrollToMessageId(pin.eventId); onClose(); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              border: 'none', background: 'transparent', cursor: 'pointer',
              padding: '8px', borderRadius: 8, fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>
                {pin.sender}
              </span>
              <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                {dateCourte(pin.ts)}
              </span>
            </div>
            <div style={{
              fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {pin.text || t("chat.attachedFile", { defaultValue: "Fichier joint" })}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
