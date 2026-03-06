import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { Message } from "./Message";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";

const EMPTY_MESSAGES: never[] = [];
const SCROLL_TOP_THRESHOLD = 100;

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
      className="flex-1 overflow-y-auto px-6 py-5 flex flex-col"
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
        const showHeader = i === 0 || messages[i - 1].user !== msg.user;
        const eventId = msg.eventId || String(msg.id);
        return (
          <div key={msg.id} data-event-id={eventId}>
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
