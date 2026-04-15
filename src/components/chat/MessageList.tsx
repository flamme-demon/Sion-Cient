import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "./Message";
import { useAppStore, APP_SESSION_START_TS } from "../../stores/useAppStore";
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

function UnreadSeparator({ count }: { count: number }) {
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
        {t("chat.newMessages", { count })}
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
  // Start as null so the first render after mount (including a reload with
  // an already-restored activeChannel) is treated as a channel switch and
  // triggers the initial scroll positioning. Otherwise the user lands at
  // the scroll container's default (top) on reload.
  const prevChannelRef = useRef<string | null>(null);
  const prevMessagesLenRef = useRef(0);
  const suppressScrollLoadRef = useRef(false);
  const channelJustChangedRef = useRef(false);

  // Track unread state (disabled for admin room)
  const isAdminRoom = activeChannel === findAdminRoom();
  const [showScrollDown, setShowScrollDown] = useState(false);

  const currentUserId = useMatrixStore((s) => s.currentUserId);

  // Snapshot of lastReadId taken when the channel becomes active.
  // The real lastReadId is bumped to the latest message as soon as markAsRead()
  // fires, which would otherwise make the unread separator vanish instantly.
  // We freeze the anchor here so the separator stays visible while the user
  // reads the channel, and clear it once the user has clearly caught up —
  // either by sending a message themselves, or by idling at the bottom.
  const [sepAnchor, setSepAnchor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (activeChannel && !isAdminRoom) {
      setSepAnchor(lastReadMessageId[activeChannel]);
    } else {
      setSepAnchor(undefined);
    }
    // Intentionally NOT depending on lastReadMessageId — we only refresh
    // the anchor on channel switch, not on markAsRead updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel, isAdminRoom]);

  // Dismiss the separator once the user has engaged with the channel —
  // sending a message is the strongest signal that they've caught up.
  // We detect it by watching the last message: if it's from us and arrived
  // after the channel became active, clear the anchor.
  const channelOpenedAtRef = useRef<number>(0);
  useEffect(() => {
    channelOpenedAtRef.current = Date.now();
  }, [activeChannel]);
  useEffect(() => {
    if (!sepAnchor || messages.length === 0 || !currentUserId) return;
    const last = messages[messages.length - 1];
    if (last.senderId === currentUserId && (last.ts ?? 0) >= channelOpenedAtRef.current) {
      setSepAnchor(undefined);
    }
  }, [messages, sepAnchor, currentUserId]);

  // Dismiss the separator 5s after a clear "I've caught up" signal:
  //  - Scrollable chat: user transitioned from "scrolled up" to "at bottom"
  //    (via scroll or the arrow button). The transition check avoids firing
  //    on channel open when a previous channel left us already at bottom.
  //  - Non-scrollable chat: the whole conversation fits on screen, so the
  //    user has seen everything at once. There's no scroll transition to
  //    wait for — dismiss purely on a timer, otherwise the separator would
  //    stay forever.
  const prevShowScrollDownRef = useRef(showScrollDown);
  useEffect(() => {
    const prev = prevShowScrollDownRef.current;
    prevShowScrollDownRef.current = showScrollDown;
    if (!sepAnchor) return;

    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    // Check scrollability on the next frame so layout has settled after the
    // channel-change render / initial scroll positioning.
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      const isScrollable = el ? el.scrollHeight > el.clientHeight + 10 : false;
      const shouldDismiss =
        !isScrollable ||
        (prev === true && showScrollDown === false);
      if (shouldDismiss) {
        dismissTimer = setTimeout(() => setSepAnchor(undefined), 5000);
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      if (dismissTimer) clearTimeout(dismissTimer);
    };
  }, [sepAnchor, showScrollDown]);

  // Find the index of the unread separator (skip our own messages)
  const { unreadSepIndex, unreadCount } = useMemo(() => {
    if (!sepAnchor || messages.length === 0) return { unreadSepIndex: -1, unreadCount: 0 };
    const idx = messages.findIndex((m) => (m.eventId || String(m.id)) === sepAnchor);
    if (idx === -1 || idx >= messages.length - 1) return { unreadSepIndex: -1, unreadCount: 0 };
    // Count only messages from others after the last read
    let othersCount = 0;
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].senderId !== currentUserId) othersCount++;
    }
    if (othersCount === 0) return { unreadSepIndex: -1, unreadCount: 0 };
    // Place separator before the first unread message from someone else
    let sepIdx = idx + 1;
    while (sepIdx < messages.length && messages[sepIdx].senderId === currentUserId) sepIdx++;
    return { unreadSepIndex: sepIdx, unreadCount: othersCount };
  }, [sepAnchor, messages, currentUserId]);

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

  // Has the initial scroll for the current channel-open been performed?
  // We only want to fire the positioning scroll once per channel switch
  // (either to the unread separator or to the bottom), even though the
  // messages-change effect may run several times as sync trickles in.
  const initialScrollDoneRef = useRef(false);

  // Compute whether the active channel has unread messages from someone
  // other than the current user. Reads raw state so it works before the
  // sepAnchor memoization catches up with a channel switch.
  const computeHasUnread = useCallback((): boolean => {
    if (!activeChannel || isAdminRoom) return false;
    if (messages.length === 0) return false;
    const currLastReadId = lastReadMessageId[activeChannel];
    // If we don't know the last-read position, or it's outside the loaded
    // window, consider "unread" only messages that arrived this session —
    // matches the badge-count behavior in ChannelItem/ChannelList.
    if (!currLastReadId) {
      return messages.some((m) => (m.ts ?? 0) > APP_SESSION_START_TS && m.senderId !== currentUserId);
    }
    const idx = messages.findIndex((m) => (m.eventId || String(m.id)) === currLastReadId);
    if (idx === -1) {
      return messages.some((m) => (m.ts ?? 0) > APP_SESSION_START_TS && m.senderId !== currentUserId);
    }
    if (idx >= messages.length - 1) return false;
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].senderId !== currentUserId) return true;
    }
    return false;
  }, [activeChannel, isAdminRoom, lastReadMessageId, messages, currentUserId]);

  // Position the scroll on channel-open: at the unread separator if the
  // user has a backlog of unread, otherwise at the bottom. Falls back to
  // scrollToBottom if the separator hasn't rendered yet (e.g. lastReadId
  // fell outside the currently-loaded message window).
  const positionInitialScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // After any scroll operation, re-check whether we ended up at the bottom.
    // When the chat fits on screen, scrollIntoView/scrollToBottom produce no
    // actual scroll event, so handleScroll never fires and the derived state
    // (isAtBottomRef + showScrollDown) would otherwise stay stuck.
    const syncBottomState = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      isAtBottomRef.current = atBottom;
      setShowScrollDown(!atBottom);
      if (atBottom) markAsRead();
    };

    if (computeHasUnread()) {
      const sep = el.querySelector("[data-unread-sep]");
      if (sep) {
        sep.scrollIntoView({ behavior: "auto", block: "center" });
        // If the chat is short enough that scrolling to the separator leaves
        // us at the bottom, nudge the scroll up a bit so the user is NOT at
        // bottom. That makes the "jump to latest" arrow visible, and the
        // user has to actively reach the bottom (scroll or arrow click) to
        // acknowledge the unread — which is what dismisses the separator.
        requestAnimationFrame(() => {
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
            el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 80);
          }
          syncBottomState();
        });
      } else {
        // Separator not in DOM (e.g. lastReadId outside loaded window).
        // Bottom-scroll so user at least sees the latest.
        scrollToBottom();
        requestAnimationFrame(syncBottomState);
      }
    } else {
      scrollToBottom();
      requestAnimationFrame(syncBottomState);
    }
  }, [computeHasUnread, scrollToBottom, markAsRead]);

  // On channel change: reset per-channel state and schedule initial scroll.
  // We do NOT call markAsRead unconditionally here — if the channel has
  // unread messages, the user needs to actually scroll through them (or
  // reach the bottom) to clear the badge. This matches Discord's model.
  useEffect(() => {
    if (activeChannel !== prevChannelRef.current) {
      prevChannelRef.current = activeChannel;
      prevMessagesLenRef.current = messages.length;
      channelJustChangedRef.current = true;
      initialScrollDoneRef.current = false;
      const timer = setTimeout(() => { channelJustChangedRef.current = false; }, 5000);
      return () => clearTimeout(timer);
    }
  }, [activeChannel, messages.length]);

  // When messages change: preserve scroll or auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const prevLen = prevMessagesLenRef.current;
    const currLen = messages.length;
    prevMessagesLenRef.current = currLen;

    // Own-message fast-path: always scroll to bottom when the user just
    // sent something, even if we're still in the channel-just-changed
    // window. Must run BEFORE the channelJustChanged early-return below,
    // otherwise sending a message within 5s of opening the channel leaves
    // the scroll wherever it was.
    if (currLen > prevLen && currentUserId) {
      const lastMsg = messages[currLen - 1];
      if (lastMsg.senderId === currentUserId && (lastMsg.ts ?? 0) >= channelOpenedAtRef.current) {
        scrollToBottom();
        markAsRead();
        isAtBottomRef.current = true;
        setShowScrollDown(false);
        return;
      }
    }

    if (channelJustChangedRef.current) {
      // First time we have messages (or the array changed) after a channel
      // switch — place the scroll. Guard against multiple triggers so we
      // don't fight the user if they scroll during the 5s window.
      if (!initialScrollDoneRef.current && currLen > 0) {
        initialScrollDoneRef.current = true;
        // Double rAF + short delay: let the sepAnchor state update and the
        // separator render before we try to scroll to it.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(positionInitialScroll, 30);
          });
        });
      } else if (currLen === 0) {
        // No messages yet; just stay at bottom-ready state.
        scrollToBottom();
      }
      return;
    }

    if (currLen <= prevLen) return;

    // (Own-message fast-path handled above, before channelJustChanged early-return.)

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
              {showUnreadSep && <div data-unread-sep><UnreadSeparator count={unreadCount} /></div>}
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
          onClick={() => {
            scrollToBottom();
            markAsRead();
            // Force state update — when the chat fits on screen no scroll
            // event fires after scrollToBottom, so handleScroll never clears
            // showScrollDown and the banner would otherwise stay visible.
            isAtBottomRef.current = true;
            setShowScrollDown(false);
          }}
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
