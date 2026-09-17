import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PinIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import * as matrixService from "../../services/matrixService";
import { plainPreview } from "../../utils/plainPreview";
import { PinnedListPanel } from "./PinnedListPanel";

export function PinnedBar() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  const messages = useMatrixStore((s) => s.messages);
  // Subscribe to pinnedVersion to re-render when pins change
  useMatrixStore((s) => s.pinnedVersion);

  const pinnedIds = activeChannel ? matrixService.getPinnedEventIds(activeChannel) : [];
  const channelMessages = messages[activeChannel] || [];

  // Match pinned IDs to actual messages
  // Du plus récent au plus ancien, comme la liste complète. L'ordre brut de
  // l'événement d'état Matrix est celui des ajouts successifs, donc la plus
  // ancienne d'abord : le bandeau et la liste présentaient les mêmes épingles
  // en sens inverse l'un de l'autre.
  const pinnedMessages = (pinnedIds
    .map((id) => channelMessages.find((m) => m.eventId === id || m.id === id))
    .filter(Boolean) as typeof channelMessages)
    .slice()
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const [activeIndex, setActiveIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const isPaused = useRef(false);

  // Reset index when channel or pinned messages change
  useEffect(() => {
    setActiveIndex(0);
  }, [activeChannel, pinnedMessages.length]);

  // Rotation automatique toutes les 5 s quand plusieurs épinglés sont chargés.
  // Le minuteur vit dans l'effet plutôt que dans un `useCallback` mémoïsé : la
  // mémoïsation manuelle n'apportait rien et empêchait le compilateur React de
  // traiter le composant.
  const pinnedCount = pinnedMessages.length;
  useEffect(() => {
    if (pinnedCount <= 1) return;
    const minuteur = setInterval(() => {
      if (!isPaused.current) setActiveIndex((i) => (i + 1) % pinnedCount);
    }, 5000);
    return () => clearInterval(minuteur);
  }, [pinnedCount]);

  // On se base sur les IDs, pas sur les messages chargés : un épinglé ancien
  // n'est pas dans le fil local, et faire disparaître la barre pour autant
  // rendait ces épingles totalement inaccessibles.
  if (pinnedIds.length === 0) return null;

  const currentPinned = pinnedMessages.length > 0
    ? pinnedMessages[activeIndex % pinnedMessages.length]
    : null;

  const handleClick = () => {
    if (!currentPinned) { setListOpen(true); return; }
    const eventId = currentPinned.eventId || String(currentPinned.id);
    setScrollToMessageId(eventId);
  };

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    isPaused.current = true;
    setActiveIndex((i) => (i - 1 + pinnedMessages.length) % pinnedMessages.length);
    // Resume auto-scroll after 10s of no manual interaction
    setTimeout(() => { isPaused.current = false; }, 10000);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    isPaused.current = true;
    setActiveIndex((i) => (i + 1) % pinnedMessages.length);
    setTimeout(() => { isPaused.current = false; }, 10000);
  };

  return (
    <div
      onClick={handleClick}
      style={{
        // Ancre du panneau de liste : sans `relative`, son `top: 100%` se
        // calait sur le conteneur de toute la colonne de chat et le plaçait
        // sous la zone visible.
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 24px',
        background: 'var(--color-surface-container)',
        borderBottom: '1px solid var(--color-outline-variant)',
        cursor: 'pointer',
        transition: 'background 150ms',
        minHeight: 40,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-container)'; }}
    >
      <PinIcon />

      {/* Progress dots for multiple pins */}
      {pinnedMessages.length > 1 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          marginRight: 4,
          flexShrink: 0,
        }}>
          {pinnedMessages.map((_, i) => (
            <div
              key={i}
              style={{
                width: 3,
                height: i === activeIndex ? 10 : 6,
                borderRadius: 2,
                background: i === activeIndex ? 'var(--color-primary)' : 'var(--color-outline-variant)',
                transition: 'all 200ms',
              }}
            />
          ))}
        </div>
      )}

      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-primary)',
        }}>
          {currentPinned ? currentPinned.user : t("chat.pinnedList", { defaultValue: "Messages épinglés" })}
        </span>
        <span style={{
          fontSize: 12,
          color: 'var(--color-on-surface-variant)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {currentPinned
            ? (plainPreview(currentPinned.text)
               // Un message sans texte est une pièce jointe : son nom est plus
               // parlant qu'un libellé générique, et c'est ce que montre déjà
               // la liste complète.
               || currentPinned.attachments?.[0]?.name
               || (currentPinned.attachments?.length
                   ? t("chat.attachedFile", { defaultValue: "Fichier joint" })
                   : "..."))
            : t("chat.pinnedCount", { defaultValue: "{{count}} épinglé(s) — cliquer pour voir la liste", count: pinnedIds.length })}
        </span>
      </div>

      {/* Liste complète : la rotation ne montre que les épinglés chargés. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setListOpen((v) => !v); }}
        title={t("chat.pinnedList", { defaultValue: "Messages épinglés" })}
        style={{
          width: 24, height: 24, borderRadius: 6, border: 'none', flexShrink: 0,
          background: listOpen ? 'var(--color-secondary-container)' : 'transparent',
          color: 'var(--color-on-surface-variant)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
        onMouseLeave={(e) => { if (!listOpen) e.currentTarget.style.background = 'transparent'; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
      {listOpen && <PinnedListPanel onClose={() => setListOpen(false)} />}

      {/* Nav arrows for multiple pins */}
      {pinnedMessages.length > 1 && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            onClick={handlePrev}
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-on-surface-variant)',
              cursor: 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            ▲
          </button>
          <button
            onClick={handleNext}
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-on-surface-variant)',
              cursor: 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            ▼
          </button>
        </div>
      )}

      {pinnedMessages.length > 1 && (
        <span style={{
          fontSize: 10,
          color: 'var(--color-outline)',
          flexShrink: 0,
        }}>
          {activeIndex + 1}/{pinnedMessages.length}
        </span>
      )}
    </div>
  );
}
