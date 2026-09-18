import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { DOCK_ZONE_IDS, useLayoutStore } from "../../stores/useLayoutStore";
import * as matrixService from "../../services/matrixService";
import { plainPreview } from "../../utils/plainPreview";
import type { PinnedSummary } from "../../services/matrixService";

/**
 * Liste complète des messages épinglés d'un salon.
 *
 * La barre des épinglés fait défiler les pins un par un, et seulement ceux dont
 * le message est déjà chargé : un épinglé de plusieurs mois en disparaissait.
 * Ce panneau les montre tous, en allant chercher sur le serveur ceux que le fil
 * local ne contient pas, et permet d'en rejoindre un directement.
 *
 * **Panneau ancrable, et non bulle flottante.** La première version s'ancrait
 * sous son bandeau en `position: absolute`. Or la vidéo d'un partage n'est pas
 * un élément de la page mais une fenêtre NATIVE posée par-dessus — sous-surface
 * Wayland, fenêtre enfant Win32 — qu'aucun `z-index` ne peut franchir : la
 * liste passait dessous dès qu'un partage était affiché (18/09). En panneau,
 * elle se déplace hors de la zone vidéo, comme la soundboard.
 */
export function PinnedListPanel() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  // Re-lire quand les épingles changent pendant que le panneau est ouvert.
  const pinnedVersion = useMatrixStore((s) => s.pinnedVersion);
  const [pins, setPins] = useState<PinnedSummary[] | null>(null);
  // Mise en forme selon la zone d'accueil : une colonne à droite, une
  // pellicule horizontale dans un bandeau. Le bandeau est large et bas ; une
  // liste verticale n'y montrerait qu'une entrée, alors qu'une rangée de
  // vignettes s'y parcourt d'un coup d'œil.
  const enBandeau = useLayoutStore((s) => {
    const zone = DOCK_ZONE_IDS.find((id) => s.dockZones[id].panels.includes("pinned"));
    return zone === "bottom" || zone === "top";
  });

  useEffect(() => {
    if (!activeChannel) return;
    let annule = false;
    setPins(null);
    void matrixService.getPinnedSummaries(activeChannel)
      .then((liste) => { if (!annule) setPins(liste); })
      .catch(() => { if (!annule) setPins([]); });
    return () => { annule = true; };
  }, [activeChannel, pinnedVersion]);

  const dateCourte = (ts: number) => ts
    ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "";

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface-variant)',
        padding: '6px 8px', flex: '0 0 auto',
      }}>
        {t("chat.pinnedList")}
        {pins ? ` (${pins.length})` : ""}
      </div>

      <div style={enBandeau
        ? {
          flex: '1 1 auto', minHeight: 0, padding: '0 6px 6px',
          display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden',
        }
        : { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '0 6px 6px' }}>
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
            onClick={() => setScrollToMessageId(pin.eventId)}
            style={enBandeau
              ? {
                display: 'flex', flexDirection: 'column', gap: 6,
                width: 168, flex: '0 0 auto', textAlign: 'left',
                border: '1px solid var(--color-outline-variant)',
                background: 'transparent', cursor: 'pointer',
                padding: 8, borderRadius: 10, fontFamily: 'inherit',
                alignItems: 'stretch',
              }
              : {
                display: 'flex', gap: 8, width: '100%', textAlign: 'left',
                border: 'none', background: 'transparent', cursor: 'pointer',
                padding: '8px', borderRadius: 8, fontFamily: 'inherit',
                alignItems: 'flex-start',
              }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {/* Vignette du média : une image et une vidéo se reconnaissent d'un
                coup d'œil, là où le libellé « Fichier joint » ne disait rien de
                leur nature. La vidéo passe par un `<video preload="metadata">`,
                qui affiche sa première image sans télécharger le fichier. */}
            {pin.mediaUrl && pin.media === "image" && (
              <img
                src={pin.mediaUrl}
                alt=""
                loading="lazy"
                style={{
                  width: enBandeau ? '100%' : 56, height: enBandeau ? 84 : 56,
                  flex: '0 0 auto', objectFit: 'cover',
                  borderRadius: 6, background: 'var(--color-surface-container)',
                }}
              />
            )}
            {pin.mediaUrl && pin.media === "video" && (
              <video
                src={pin.mediaUrl}
                muted
                playsInline
                preload="metadata"
                style={{
                  width: enBandeau ? '100%' : 56, height: enBandeau ? 84 : 56,
                  flex: '0 0 auto', objectFit: 'cover',
                  borderRadius: 6, background: 'var(--color-surface-container-highest)',
                }}
              />
            )}

            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
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
                {plainPreview(pin.text) || t("chat.attachedFile", { defaultValue: "Fichier joint" })}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
