import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "./Message";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { findAdminRoom } from "../../services/adminCommandService";

const EMPTY_MESSAGES: never[] = [];
const SCROLL_TOP_THRESHOLD = 100;

/** Returns true if both timestamps fall on the same calendar day (local time). */
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Format a date for the day separator chip: "Aujourd'hui" / "Hier" / "8 avril" / "8 avril 2025". */
function formatDaySeparator(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (isSameDay(ts, now.getTime())) return "Aujourd'hui";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(ts, yesterday.getTime())) return "Hier";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function DaySeparator({ ts }: { ts: number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        margin: "12px 0 8px",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          padding: "4px 12px",
          borderRadius: 999,
          background: "var(--color-surface-container-high)",
          color: "var(--color-on-surface-variant)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
          textTransform: "capitalize",
          boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
        }}
      >
        {formatDaySeparator(ts)}
      </span>
    </div>
  );
}

function UnreadSeparator() {
  const { t } = useTranslation();
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      margin: "8px 0",
      pointerEvents: "none",
    }}>
      <div style={{ flex: 1, height: 1, background: "var(--color-error)" }} />
      <span style={{
        fontSize: 10,
        fontWeight: 700,
        color: "var(--color-error)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        whiteSpace: "nowrap",
      }}>
        {t("chat.newMessages")}
      </span>
      <div style={{ flex: 1, height: 1, background: "var(--color-error)" }} />
    </div>
  );
}

export function MessageList() {
  const { t } = useTranslation();
  const activeChannel = useAppStore((s) => s.activeChannel);
  const messagesMap = useMatrixStore((s) => s.messages);
  const roomHasMore = useMatrixStore((s) => s.roomHasMore);
  const roomLoadingHistory = useMatrixStore((s) => s.roomLoadingHistory);
  const loadRoomHistory = useMatrixStore((s) => s.loadRoomHistory);
  const lastReadMessageId = useAppStore((s) => s.lastReadMessageId);
  const setLastReadMessageId = useAppStore((s) => s.setLastReadMessageId);

  const messages = useMemo(() => messagesMap[activeChannel] || EMPTY_MESSAGES, [messagesMap, activeChannel]);
  const isLoading = activeChannel ? roomLoadingHistory[activeChannel] ?? false : false;
  const hasMore = activeChannel ? roomHasMore[activeChannel] ?? false : false;


  const scrollToMessageId = useAppStore((s) => s.scrollToMessageId);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevChannelRef = useRef(activeChannel);
  const prevMessagesLenRef = useRef(0);
  const suppressScrollLoadRef = useRef(false);
  const channelJustChangedRef = useRef(false);

  // Track unread state (disabled for admin room)
  const isAdminRoom = activeChannel === findAdminRoom();
  const lastReadId = !isAdminRoom && activeChannel ? lastReadMessageId[activeChannel] : undefined;
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Find the index of the unread separator
  const unreadSepIndex = useMemo(() => {
    if (!lastReadId || messages.length === 0) return -1;
    const idx = messages.findIndex((m) => (m.eventId || String(m.id)) === lastReadId);
    if (idx === -1 || idx >= messages.length - 1) return -1; // All read or last message
    return idx + 1; // Separator goes AFTER the last read message
  }, [lastReadId, messages]);

  const unreadCount = unreadSepIndex >= 0 ? messages.length - unreadSepIndex : 0;

  // Mark messages as read when at bottom
  const markAsRead = useCallback(() => {
    if (!activeChannel || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    const lastId = lastMsg.eventId || String(lastMsg.id);
    if (lastId && lastId !== lastReadMessageId[activeChannel]) {
      setLastReadMessageId(activeChannel, lastId);
    }
  }, [activeChannel, messages, lastReadMessageId, setLastReadMessageId]);

  // Scroll to bottom helper
  const scrollToBottom = useCallback(() => {
    const doScroll = () => {
      const el = containerRef.current;
      if (el) {
        suppressScrollLoadRef.current = true;
        el.scrollTop = el.scrollHeight;
        suppressScrollLoadRef.current = false;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
    setTimeout(doScroll, 50);
  }, []);

  // Scroll to unread separator
  const scrollToUnread = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const sep = el.querySelector("[data-unread-sep]");
    if (sep) {
      sep.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  // On channel change: scroll to bottom and mark as just changed
  useEffect(() => {
    if (activeChannel !== prevChannelRef.current) {
      prevChannelRef.current = activeChannel;
      prevMessagesLenRef.current = messages.length;
      isAtBottomRef.current = true;
      channelJustChangedRef.current = true;
      scrollToBottom();
      const timer = setTimeout(() => { channelJustChangedRef.current = false; }, 5000);
      return () => clearTimeout(timer);
    }
  }, [activeChannel, messages.length, scrollToBottom]);

  // When messages change: preserve scroll or auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const prevLen = prevMessagesLenRef.current;
    const currLen = messages.length;
    prevMessagesLenRef.current = currLen;

    if (channelJustChangedRef.current) {
      scrollToBottom();
      return;
    }

    if (currLen <= prevLen) return;

    const newCount = currLen - prevLen;
    if (!isAtBottomRef.current && prevLen > 0) {
      suppressScrollLoadRef.current = true;
      requestAnimationFrame(() => {
        const children = el.children;
        let addedHeight = 0;
        for (let i = 0; i < newCount && i < children.length; i++) {
          addedHeight += (children[i] as HTMLElement).offsetHeight;
        }
        el.scrollTop += addedHeight;
        requestAnimationFrame(() => { suppressScrollLoadRef.current = false; });
      });
      return;
    }

    if (isAtBottomRef.current) {
      scrollToBottom();
      markAsRead();
    }
  }, [messages, scrollToBottom, markAsRead]);

  // ResizeObserver — observe only the scroll container itself (not each child).
  // This is much lighter than observing 150+ children individually.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastHeight = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      const currHeight = el.scrollHeight;
      if (currHeight !== lastHeight) {
        if (isAtBottomRef.current) scrollToBottom();
        lastHeight = currHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const userHasScrolledRef = useRef(false);
  useEffect(() => { userHasScrolledRef.current = false; }, [activeChannel]);

  // Auto-load initial history
  useEffect(() => {
    if (!activeChannel) return;
    const alreadyLoaded = roomHasMore[activeChannel] !== undefined;
    if (alreadyLoaded || roomLoadingHistory[activeChannel]) return;
    loadRoomHistory(activeChannel);
  }, [activeChannel, roomHasMore, roomLoadingHistory, loadRoomHistory]);

  // Scroll handler
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    const wasAtBottom = isAtBottomRef.current;
    isAtBottomRef.current = atBottom;

    // Only update state when it actually changes (avoids re-rendering 158 messages)
    if (wasAtBottom !== atBottom) {
      setShowScrollDown(!atBottom);
      if (atBottom) markAsRead();
    }

    if (!atBottom) {
      channelJustChangedRef.current = false;
      userHasScrolledRef.current = true;
    }

    if (suppressScrollLoadRef.current || channelJustChangedRef.current) return;
    if (!userHasScrolledRef.current) return;
    const isScrollable = el.scrollHeight > el.clientHeight + 10;
    if (isScrollable && el.scrollTop < SCROLL_TOP_THRESHOLD && activeChannel && hasMore && !isLoading) {
      loadRoomHistory(activeChannel);
    }
  }, [activeChannel, hasMore, isLoading, loadRoomHistory, markAsRead]);

  // Scroll to specific message (from PinnedBar)
  useEffect(() => {
    if (!scrollToMessageId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-event-id="${scrollToMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedId(scrollToMessageId);
      setTimeout(() => setHighlightedId(null), 2000);
    }
    setScrollToMessageId(null);
  }, [scrollToMessageId, setScrollToMessageId]);

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* Unread messages banner (top) */}
      {unreadCount > 0 && showScrollDown && (
        <button
          onClick={scrollToUnread}
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            padding: "5px 16px",
            borderRadius: "0 0 12px 12px",
            border: "none",
            background: "var(--color-primary)",
            color: "var(--color-on-primary)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          {t("chat.unreadCount", { count: unreadCount })}
        </button>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-5 flex flex-col min-w-0"
        onScroll={handleScroll}
      >
        {/* Top indicator */}
        {isLoading && (
          <div className="text-center text-text-muted text-sm py-3">Chargement...</div>
        )}
        {!isLoading && !hasMore && messages.length > 0 && (
          <div className="text-center text-text-muted text-sm py-3">Début de la conversation</div>
        )}

        {messages.map((msg, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const showDaySeparator =
            msg.ts !== undefined && (i === 0 || (prev?.ts !== undefined && !isSameDay(prev.ts, msg.ts)));
          const showHeader = i === 0 || showDaySeparator || messages[i - 1].user !== msg.user;
          const eventId = msg.eventId || String(msg.id);
          const showUnreadSep = i === unreadSepIndex;
          return (
            <div key={msg.id} data-event-id={eventId} style={{ minWidth: 0 }}>
              {showUnreadSep && <div data-unread-sep><UnreadSeparator /></div>}
              {showDaySeparator && msg.ts !== undefined && <DaySeparator ts={msg.ts} />}
              <Message
                message={msg}
                showHeader={showHeader}
                isFirst={i === 0}
                highlighted={highlightedId === eventId}
              />
            </div>
          );
        })}
      </div>

      {/* Scroll to bottom button */}
      {showScrollDown && (
        <button
          onClick={() => { scrollToBottom(); markAsRead(); }}
          style={{
            position: "absolute",
            bottom: 12,
            right: 24,
            zIndex: 10,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "none",
            background: "var(--color-surface-container-high)",
            color: "var(--color-on-surface)",
            fontSize: 16,
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
}
