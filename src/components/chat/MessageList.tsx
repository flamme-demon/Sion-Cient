import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { Message } from "./Message";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";

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

export function MessageList() {
  const activeChannel = useAppStore((s) => s.activeChannel);
  const messagesMap = useMatrixStore((s) => s.messages);
  const roomHasMore = useMatrixStore((s) => s.roomHasMore);
  const roomLoadingHistory = useMatrixStore((s) => s.roomLoadingHistory);
  const loadRoomHistory = useMatrixStore((s) => s.loadRoomHistory);

  const messages = useMemo(() => messagesMap[activeChannel] || EMPTY_MESSAGES, [messagesMap, activeChannel]);
  const isLoading = activeChannel ? roomLoadingHistory[activeChannel] ?? false : false;
  // Only allow pagination if loadRoomHistory has been called at least once (roomHasMore is explicitly set)
  const hasMore = activeChannel ? roomHasMore[activeChannel] ?? false : false;

  const scrollToMessageId = useAppStore((s) => s.scrollToMessageId);
  const setScrollToMessageId = useAppStore((s) => s.setScrollToMessageId);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevChannelRef = useRef(activeChannel);
  const prevMessagesLenRef = useRef(0);
  // Guard against triggering loadRoomHistory during programmatic scrolls
  const suppressScrollLoadRef = useRef(false);
  // After channel change, force scroll-to-bottom on every message update for a short period
  const channelJustChangedRef = useRef(false);

  // Scroll to bottom helper — uses double rAF + setTimeout fallback for reliability
  const scrollToBottom = useCallback(() => {
    const doScroll = () => {
      const el = containerRef.current;
      if (el) {
        suppressScrollLoadRef.current = true;
        el.scrollTop = el.scrollHeight;
        suppressScrollLoadRef.current = false;
      }
    };
    // Double rAF ensures DOM is painted, setTimeout as fallback
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
    setTimeout(doScroll, 50);
  }, []);

  // On channel change: scroll to bottom and mark as just changed
  useEffect(() => {
    if (activeChannel !== prevChannelRef.current) {
      prevChannelRef.current = activeChannel;
      prevMessagesLenRef.current = messages.length;
      isAtBottomRef.current = true;
      channelJustChangedRef.current = true;
      scrollToBottom();
      // Keep forcing scroll-to-bottom for 5s after channel change
      // to handle loadRoomHistory multi-round loading + decryption reloads
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

    // After channel change, always snap to bottom regardless
    if (channelJustChangedRef.current) {
      scrollToBottom();
      return;
    }

    if (currLen <= prevLen) return;

    // New messages were prepended (history load) — preserve scroll position
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

    // Auto-scroll to bottom for new messages if user is at bottom
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Keep the chat anchored to the bottom when content height grows AFTER
  // the initial render. This happens when LinkPreview cards finish loading,
  // images decode, GIFs render their first frame, etc. — without this, the
  // newest message gets pushed off-screen as previews fill in.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastHeight = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      const currHeight = el.scrollHeight;
      if (currHeight !== lastHeight) {
        if (isAtBottomRef.current) {
          scrollToBottom();
        }
        lastHeight = currHeight;
      }
    });
    // Observe each direct child so we catch height changes from any message
    for (const child of Array.from(el.children)) {
      ro.observe(child);
    }
    // Re-observe whenever children change
    const mo = new MutationObserver(() => {
      ro.disconnect();
      for (const child of Array.from(el.children)) {
        ro.observe(child);
      }
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollToBottom]);

  // Track whether the user has manually scrolled away from bottom at least once
  const userHasScrolledRef = useRef(false);

  // Reset on channel change
  useEffect(() => {
    userHasScrolledRef.current = false;
  }, [activeChannel]);

  // Auto-load initial history when a channel has no messages and hasn't been loaded yet
  // This is critical for voice channels where the initial sync timeline only contains signaling events
  useEffect(() => {
    if (!activeChannel) return;
    const alreadyLoaded = roomHasMore[activeChannel] !== undefined;
    if (alreadyLoaded) return; // Already loaded history for this room
    if (roomLoadingHistory[activeChannel]) return; // Already loading
    loadRoomHistory(activeChannel);
  }, [activeChannel, roomHasMore, roomLoadingHistory, loadRoomHistory]);

  // Scroll handler: detect near-top for lazy loading + track if at bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Track if user is at bottom (within 50px)
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    // If user scrolled away from bottom, stop forcing scroll-to-bottom
    if (!isAtBottomRef.current) {
      channelJustChangedRef.current = false;
      userHasScrolledRef.current = true;
    }

    // Don't trigger history load during programmatic scrolls
    if (suppressScrollLoadRef.current) return;

    // Don't trigger pagination right after channel change (content may be short/empty)
    if (channelJustChangedRef.current) return;

    // Only trigger pagination when user has manually scrolled up, content is scrollable, and near top
    if (!userHasScrolledRef.current) return;
    const isScrollable = el.scrollHeight > el.clientHeight + 10;
    if (isScrollable && el.scrollTop < SCROLL_TOP_THRESHOLD && activeChannel && hasMore && !isLoading) {
      loadRoomHistory(activeChannel);
    }
  }, [activeChannel, hasMore, isLoading, loadRoomHistory]);

  // Scroll to a specific message when requested (e.g. from PinnedBar)
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
        // After a day separator we want the message header to show again,
        // even if the previous message was from the same user.
        const showHeader = i === 0 || showDaySeparator || messages[i - 1].user !== msg.user;
        const eventId = msg.eventId || String(msg.id);
        return (
          <div key={msg.id} data-event-id={eventId} style={{ minWidth: 0 }}>
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
  );
}
