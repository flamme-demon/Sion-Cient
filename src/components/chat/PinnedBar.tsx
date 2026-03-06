import { useState, useEffect, useRef, useCallback } from "react";
import { PinIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import * as matrixService from "../../services/matrixService";

export function PinnedBar() {
  const activeChannel = useAppStore((s) => s.activeChannel);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  const messages = useMatrixStore((s) => s.messages);
  // Subscribe to pinnedVersion to re-render when pins change
  useMatrixStore((s) => s.pinnedVersion);

  const pinnedIds = activeChannel ? matrixService.getPinnedEventIds(activeChannel) : [];
  const channelMessages = messages[activeChannel] || [];

  // Match pinned IDs to actual messages
  const pinnedMessages = pinnedIds
    .map((id) => channelMessages.find((m) => m.eventId === id || m.id === id))
    .filter(Boolean) as typeof channelMessages;

  const [activeIndex, setActiveIndex] = useState(0);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPaused = useRef(false);

  // Reset index when channel or pinned messages change
  useEffect(() => {
    setActiveIndex(0);
  }, [activeChannel, pinnedMessages.length]);

  // Auto-scroll every 5s if multiple pins
  const startAutoScroll = useCallback(() => {
    if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
    if (pinnedMessages.length <= 1) return;
    autoScrollTimer.current = setInterval(() => {
      if (!isPaused.current) {
        setActiveIndex((i) => (i + 1) % pinnedMessages.length);
      }
    }, 5000);
  }, [pinnedMessages.length]);

  useEffect(() => {
    startAutoScroll();
    return () => { if (autoScrollTimer.current) clearInterval(autoScrollTimer.current); };
  }, [startAutoScroll]);

  if (pinnedMessages.length === 0) return null;

  const currentPinned = pinnedMessages[activeIndex % pinnedMessages.length];
  if (!currentPinned) return null;

  const handleClick = () => {
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
          {currentPinned.user}
        </span>
        <span style={{
          fontSize: 12,
          color: 'var(--color-on-surface-variant)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {currentPinned.text || (currentPinned.attachments?.length ? "Fichier joint" : "...")}
        </span>
      </div>

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
