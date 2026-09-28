import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "./Message";
import { LecteursMessage } from "./LecteursMessage";
import { useAppStore, APP_SESSION_START_TS } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { findAdminRoom } from "../../services/adminCommandService";
import { moteurRust } from "../../services/moteur";

const EMPTY_MESSAGES: never[] = [];
const SCROLL_TOP_THRESHOLD = 100;
/** Plafond de paginations pour rejoindre un message épinglé ancien. */
const MAX_JUMP_PAGES = 25;
/** Pages remontées au plus pour retrouver le dernier message lu à l'ouverture
 *  d'un salon (~30 messages chacune ; le cœur Rust n'en garde de toute façon
 *  que 300). */
const MAX_PAGES_DERNIER_LU = 12;
/** Sans souris ni clavier depuis ce délai, l'utilisateur est considéré
 *  absent : les messages qui arrivent ne sont plus « lus » d'office. */
const DELAI_ABSENCE_MS = 60_000;

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
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Start as null so the first render after mount (including a reload with
  // an already-restored activeChannel) is treated as a channel switch and
  // triggers the initial scroll positioning. Otherwise the user lands at
  // the scroll container's default (top) on reload.
  const prevChannelRef = useRef<string | null>(null);
  const prevMessagesLenRef = useRef(0);
  /** Dernier message de la liste au rendu précédent : c'est LUI qui distingue
   *  un ajout en bas (nouveau message) d'un ajout en HAUT (historique chargé
   *  en remontant) — les deux font grandir le tableau, mais seul le premier
   *  justifie de coller au bas. */
  const prevLastIdRef = useRef<string | null>(null);
  const suppressScrollLoadRef = useRef(false);
  /** Hauteur et position juste avant une pagination vers le haut. */
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const channelJustChangedRef = useRef(false);
  /** Vrai une fois la vue placée à l'ouverture du salon : avant, arriver en
   *  bas (défilement recalé par le changement de contenu) ne vaut pas
   *  lecture — c'était marquer lus des messages jamais montrés. */
  const positionneRef = useRef(false);
  /** Jusqu'à quand garder le bandeau « nouveaux messages » en haut de la vue
   *  (horodatage ms) ; 0 = plus d'ancrage. */
  const ancreJusquaRef = useRef(0);
  /** À l'ouverture, le dernier message lu n'était pas chargé : on remonte
   *  l'historique jusqu'à lui pour placer le bandeau des non-lus. */
  const chercheDernierLuRef = useRef(false);
  const pagesDernierLuRef = useRef(0);

  // Track unread state (disabled for admin room)
  const isAdminRoom = activeChannel === findAdminRoom();
  const [showScrollDown, setShowScrollDown] = useState(false);

  const currentUserId = useMatrixStore((s) => s.currentUserId);

  // ── Présence : un message n'est lu que si quelqu'un est là pour le voir.
  // Sion ouvert sur un salon, en bas du fil, pendant qu'on est parti : chaque
  // message arrivé était marqué lu aussitôt, et au retour rien ne distinguait
  // ce qu'on avait manqué (28/09). Absent = fenêtre sans le focus, cachée,
  // ou sans souris ni clavier depuis une minute.
  const presentRef = useRef(true);
  const [present, setPresent] = useState(true);
  /** Dernière souris ou touche (ms) ; posée au montage, dans l'effet des
   *  écouteurs — pas pendant le rendu, qui doit rester pur. */
  const derniereActiviteRef = useRef(0);

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
    // Personne devant l'écran : rien n'est lu (voir « Présence » plus bas).
    if (!presentRef.current) return;
    if (!activeChannel || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    const lastId = lastMsg.eventId || String(lastMsg.id);
    if (lastId && lastId !== lastReadMessageId[activeChannel]) {
      setLastReadMessageId(activeChannel, lastId);
    }
  }, [activeChannel, messages, lastReadMessageId, setLastReadMessageId]);

  /** Valeurs du dernier rendu, pour les écouteurs de la fenêtre. */
  const courantRef = useRef<{ salon: string | null; dernierLu: string | undefined; lire: () => void }>({
    salon: null, dernierLu: undefined, lire: () => {},
  });
  useEffect(() => {
    courantRef.current = {
      salon: activeChannel && !isAdminRoom ? activeChannel : null,
      dernierLu: activeChannel ? lastReadMessageId[activeChannel] : undefined,
      lire: markAsRead,
    };
  });
  useEffect(() => {
    derniereActiviteRef.current = Date.now();
    const evaluer = () => {
      const p = document.visibilityState === "visible"
        && document.hasFocus()
        && Date.now() - derniereActiviteRef.current < DELAI_ABSENCE_MS;
      if (p === presentRef.current) return;
      presentRef.current = p;
      setPresent(p);
      const { salon, dernierLu, lire } = courantRef.current;
      if (!p) {
        // Départ : ce qui arrivera désormais est nouveau, le bandeau se
        // posera juste avant (sans écraser un bandeau déjà affiché).
        if (salon) setSepAnchor((a) => a ?? dernierLu);
      } else if (isAtBottomRef.current) {
        // Retour, en bas du fil : tout est sous les yeux. Le bandeau reste.
        lire();
      }
    };
    const activite = () => {
      derniereActiviteRef.current = Date.now();
      evaluer();
    };
    const evenements = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;
    for (const e of evenements) window.addEventListener(e, activite, { passive: true });
    window.addEventListener("blur", evaluer);
    document.addEventListener("visibilitychange", evaluer);
    const minuterie = window.setInterval(evaluer, 5000);
    const premier = window.setTimeout(evaluer, 0);
    return () => {
      for (const e of evenements) window.removeEventListener(e, activite);
      window.removeEventListener("blur", evaluer);
      document.removeEventListener("visibilitychange", evaluer);
      window.clearInterval(minuterie);
      window.clearTimeout(premier);
    };
  }, []);

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

  /** Place le bandeau « nouveaux messages » en BAS de la vue : on le voit en
   *  arrivant, les nouveaux messages sont dessous, hors de la vue, et il faut
   *  descendre pour les lire — c'est ce geste qui les marque lus. En haut de
   *  la vue, peu de nouveaux messages ne pouvaient pas y monter (le fil
   *  s'arrête à son dernier message) : on arrivait en bas, tout déjà affiché
   *  et lu (28/09). Faux s'il n'est pas dans le fil. */
  const placerSurSeparateur = useCallback((): boolean => {
    const el = containerRef.current;
    const sep = el?.querySelector<HTMLElement>("[data-unread-sep]");
    if (!el || !sep) return false;
    const basDuBandeau = sep.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = Math.max(0, basDuBandeau - el.clientHeight + 8);
    return true;
  }, []);

  /** Fin du placement à l'ouverture : l'état « en bas » est relu — quand
   *  tout tient à l'écran, aucun évènement de défilement ne le ferait — et
   *  la lecture enregistrée si l'on y est. */
  const finirPositionnement = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    positionneRef.current = true;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    isAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
    if (atBottom) markAsRead();
  }, [markAsRead]);

  /** Une page d'historique de plus, vue ancrée, pour retrouver le dernier lu. */
  const remonterPourDernierLu = useCallback(() => {
    if (!activeChannel) return;
    const el = containerRef.current;
    pagesDernierLuRef.current += 1;
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    suppressScrollLoadRef.current = true;
    loadRoomHistory(activeChannel);
  }, [activeChannel, loadRoomHistory]);

  // Position the scroll on channel-open: at the unread separator if the
  // user has a backlog of unread, otherwise at the bottom.
  const positionInitialScroll = useCallback(() => {
    // Le bandeau fait foi : s'il est dans le fil, on y va — en bas de la vue,
    // les nouveaux messages dessous (voir `placerSurSeparateur`).
    if (placerSurSeparateur()) {
      // WebKit n'ancre pas le défilement : un aperçu de lien ou une image qui
      // prend sa taille au-dessus pousserait le bandeau hors de vue. On le
      // replace pendant quelques secondes, tant que l'utilisateur ne touche
      // à rien (voir `arreterAncre` et l'observateur de hauteur).
      ancreJusquaRef.current = Date.now() + 4000;
      requestAnimationFrame(finirPositionnement);
      return;
    }
    // Le dernier lu n'est pas chargé (après un redémarrage, le cœur ne
    // recharge que les messages récents) alors que d'autres ont écrit : tout
    // le chargé est plus récent que lui, donc non lu. On remonte jusqu'à lui
    // (effet « recherche du dernier lu »), sans rien marquer comme lu en
    // attendant — avant, on arrivait en bas, bandeau introuvable.
    const dernierLu = activeChannel ? lastReadMessageId[activeChannel] : undefined;
    const charge = (id: string) => messages.some((m) => (m.eventId || String(m.id)) === id);
    if (dernierLu && !charge(dernierLu) && hasMore && messages.some((m) => m.senderId !== currentUserId)) {
      chercheDernierLuRef.current = true;
      pagesDernierLuRef.current = 0;
      scrollToBottom();
      remonterPourDernierLu();
      return;
    }
    // Rien de nouveau : en bas.
    scrollToBottom();
    requestAnimationFrame(finirPositionnement);
  }, [placerSurSeparateur, finirPositionnement, activeChannel, lastReadMessageId, messages, hasMore, currentUserId, scrollToBottom, remonterPourDernierLu]);

  // Recherche du dernier lu (voir `positionInitialScroll`) : à chaque page
  // chargée, le bandeau est-il apparu ?
  useEffect(() => {
    if (!chercheDernierLuRef.current) return;
    if (placerSurSeparateur()) {
      chercheDernierLuRef.current = false;
      ancreJusquaRef.current = Date.now() + 4000;
      requestAnimationFrame(finirPositionnement);
      return;
    }
    const dernierLu = activeChannel ? lastReadMessageId[activeChannel] : undefined;
    const trouve = !!dernierLu && messages.some((m) => (m.eventId || String(m.id)) === dernierLu);
    if (isLoading && !trouve) return;
    if (trouve || !hasMore || pagesDernierLuRef.current >= MAX_PAGES_DERNIER_LU) {
      // Trouvé sans non-lu d'autrui après lui, ou hors d'atteinte : en bas.
      chercheDernierLuRef.current = false;
      scrollToBottom();
      requestAnimationFrame(finirPositionnement);
      return;
    }
    remonterPourDernierLu();
  }, [messages, isLoading, hasMore, activeChannel, lastReadMessageId, placerSurSeparateur, finirPositionnement, scrollToBottom, remonterPourDernierLu]);

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
      positionneRef.current = false;
      ancreJusquaRef.current = 0;
      chercheDernierLuRef.current = false;
    }
  }, [activeChannel, messages.length]);

  // Fin de la fenêtre « salon tout juste ouvert », 5 s après le changement de
  // salon — et lui seul. Le minuteur vivait dans l'effet ci-dessus, qui dépend
  // aussi du nombre de messages : un message arrivé pendant ces 5 s annulait
  // le minuteur (nettoyage) sans qu'aucun autre ne soit posé. La fenêtre ne se
  // refermait jamais, et plus aucun message reçu n'était marqué comme lu —
  // point rouge et « 1 nouveau message » sur un message déjà vu (28/09 ; au
  // démarrage, les fils arrivent justement dans ces 5 s).
  useEffect(() => {
    const timer = setTimeout(() => { channelJustChangedRef.current = false; }, 5000);
    return () => clearTimeout(timer);
  }, [activeChannel]);

  // When messages change: preserve scroll or auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const prevLen = prevMessagesLenRef.current;
    const currLen = messages.length;
    prevMessagesLenRef.current = currLen;
    // Ajout en HAUT (historique paginé) : le dernier message ne change pas.
    // Dans ce cas on ne colle JAMAIS au bas — c'est le bug « je remonte, ça me
    // renvoie en bas » (les deux cas font grandir le tableau).
    const lastId = currLen > 0 ? String(messages[currLen - 1].id ?? "") : null;
    const prevLastId = prevLastIdRef.current;
    prevLastIdRef.current = lastId;
    const isPrepend = prevLen > 0 && currLen > prevLen && !!lastId && lastId === prevLastId;

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

    if ((!isAtBottomRef.current || isPrepend) && prevLen > 0) {
      suppressScrollLoadRef.current = true;
      const ancre = prependAnchorRef.current;
      // On replace la vue sur le contenu qu'elle montrait : tout ce qui s'est
      // ajouté au-dessus a poussé la hauteur totale d'autant, et `scrollTop`
      // n'a pas bougé — d'où l'impression d'être redescendu.
      const restaurer = () => {
        if (!ancre) return;
        const delta = el.scrollHeight - ancre.height;
        if (delta > 0) el.scrollTop = ancre.top + delta;
      };
      restaurer();
      // Les médias prennent leur hauteur définitive après coup (image décodée,
      // métadonnées vidéo). On réajuste tant que la hauteur bouge, brièvement,
      // au lieu de figer une correction sur une mesure prématurée.
      const observer = new ResizeObserver(restaurer);
      for (const enfant of Array.from(el.children).slice(0, 40)) {
        observer.observe(enfant);
      }
      window.setTimeout(() => {
        observer.disconnect();
        prependAnchorRef.current = null;
        suppressScrollLoadRef.current = false;
      }, 1200);
      return;
    }

    // Jamais de collage en bas pour un ajout en HAUT (historique paginé).
    if (isAtBottomRef.current && !isPrepend) {
      // Absent : la vue ne suit plus le bas du fil, elle s'arrête sur le
      // bandeau ; au retour, on descend lire ce qui est arrivé.
      if (!presentRef.current && placerSurSeparateur()) return;
      scrollToBottom();
      markAsRead();
    }
  }, [messages, scrollToBottom, markAsRead, placerSurSeparateur]);

  // ResizeObserver — observe the inner CONTENT wrapper, not the scroll viewport.
  // The viewport's box size is fixed, so observing it never fires when a child
  // grows (e.g. a reaction chip added to the last message, an edit making it
  // taller, an image finishing load). Observing the content wrapper catches
  // those height changes; when pinned to the bottom we re-stick. Still one
  // observer total, not 150+ per-child.
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    let lastHeight = contentEl.offsetHeight;
    const ro = new ResizeObserver(() => {
      const currHeight = contentEl.offsetHeight;
      if (currHeight !== lastHeight) {
        lastHeight = currHeight;
        // Le bandeau des non-lus reste en haut de la vue pendant que le
        // contenu prend ses dimensions (voir `positionInitialScroll`).
        if (ancreJusquaRef.current > Date.now() && placerSurSeparateur()) return;
        if (isAtBottomRef.current) scrollToBottom();
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [scrollToBottom, placerSurSeparateur]);

  const userHasScrolledRef = useRef(false);
  useEffect(() => { userHasScrolledRef.current = false; }, [activeChannel]);

  // Auto-load initial history
  useEffect(() => {
    if (!activeChannel) return;
    const alreadyLoaded = roomHasMore[activeChannel] !== undefined;
    if (alreadyLoaded || roomLoadingHistory[activeChannel]) return;
    loadRoomHistory(activeChannel);
  }, [activeChannel, roomHasMore, roomLoadingHistory, loadRoomHistory]);

  // Recoller au bas quand la HAUTEUR DISPONIBLE change.
  //
  // Le positionnement initial se fait sur la hauteur du moment. La vue du
  // partage d'écran, elle, se monte après — chargée paresseusement — et prend
  // sa place au-dessus de la liste : le bas se déplace, `scrollTop` ne bouge
  // pas, et on se retrouve plusieurs messages trop haut. Même effet en
  // redimensionnant la fenêtre ou en ouvrant un panneau du dock.
  //
  // On ne recolle que si on était déjà en bas : quelqu'un qui lit l'historique
  // ne doit pas être ramené de force. Et jamais pendant une pagination vers le
  // haut, qui gère sa propre position.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let hauteurPrecedente = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const courant = containerRef.current;
      if (!courant) return;
      if (courant.clientHeight === hauteurPrecedente) return;
      hauteurPrecedente = courant.clientHeight;
      if (prependAnchorRef.current || suppressScrollLoadRef.current) return;
      if (!isAtBottomRef.current) return;
      courant.scrollTop = courant.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** L'utilisateur prend la main : le bandeau des non-lus n'est plus
   *  maintenu en haut de la vue. */
  const arreterAncre = useCallback(() => { ancreJusquaRef.current = 0; }, []);

  /** Des messages d'autrui non lus restent plus bas : point rouge sur la
   *  flèche « tout en bas ». */
  const nonLusEnDessous = useMemo(() => computeHasUnread(), [computeHasUnread]);

  // Le bandeau disparaît 5 s après que TOUT a été lu (arrivée en bas, en
  // présence) — pas avant : il marque où commençaient les nouveaux messages.
  // L'ancienne règle guettait le passage « flèche visible → cachée » : le
  // moindre retour de la flèche dans ces 5 s (image qui finit de charger,
  // bandeau replacé) annulait le minuteur sans le relancer, et le bandeau
  // restait pour de bon (28/09).
  useEffect(() => {
    if (!sepAnchor || !present || nonLusEnDessous) return;
    const minuteur = setTimeout(() => setSepAnchor(undefined), 5000);
    return () => clearTimeout(minuteur);
  }, [sepAnchor, present, nonLusEnDessous]);

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
      // Pas avant que la vue ait été placée à l'ouverture du salon : un
      // recalage du défilement n'est pas une lecture.
      if (atBottom && positionneRef.current) markAsRead();
    }

    if (!atBottom) {
      channelJustChangedRef.current = false;
      userHasScrolledRef.current = true;
    }

    if (suppressScrollLoadRef.current || channelJustChangedRef.current) return;
    if (!userHasScrolledRef.current) return;
    const isScrollable = el.scrollHeight > el.clientHeight + 10;
    if (isScrollable && el.scrollTop < SCROLL_TOP_THRESHOLD && activeChannel && hasMore && !isLoading) {
      // Instantané AVANT la pagination : la seule mesure qui survit à tout ce
      // qui va s'insérer en tête. Additionner la hauteur des premiers enfants
      // du DOM, comme on le faisait, suppose qu'ils correspondent un pour un
      // aux messages ajoutés — faux dès qu'il y a l'indicateur de chargement,
      // un séparateur de date, ou un média dont la hauteur arrive plus tard.
      prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      loadRoomHistory(activeChannel);
    }
  }, [activeChannel, hasMore, isLoading, loadRoomHistory, markAsRead]);

  // Aller à un message précis (barre des épinglés).
  //
  // Un épinglé peut dater de plusieurs mois : il n'est alors pas dans la
  // portion chargée du fil. L'ancienne version ne faisait rien dans ce cas —
  // elle effaçait la demande sans bouger. L'utilisateur restait en haut de
  // liste, où la pagination automatique s'enchaînait toute seule, d'où
  // l'impression de « remonter tout en haut sans raison ».
  //
  // On remonte donc l'historique jusqu'à trouver la cible, par paginations
  // successives et avec un plafond : sans lui, un épinglé supprimé ou hors
  // d'atteinte ferait défiler le salon entier.
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const jumpPagesRef = useRef(0);
  useEffect(() => {
    if (!scrollToMessageId) return;
    jumpPagesRef.current = 0;
    setPendingJump(scrollToMessageId);
    setScrollToMessageId(null);
  }, [scrollToMessageId, setScrollToMessageId]);

  useEffect(() => {
    if (!pendingJump) return;
    const el = containerRef.current;
    if (!el) return;
    const cible = el.querySelector(`[data-event-id="${pendingJump}"]`);
    if (cible) {
      // Pas de défilement animé : la cible vient peut-être d'arriver au milieu
      // d'une insertion en tête, et une animation partirait d'une position qui
      // n'existera plus à son terme.
      suppressScrollLoadRef.current = true;
      cible.scrollIntoView({ block: "center" });
      setHighlightedId(pendingJump);
      setTimeout(() => setHighlightedId(null), 2000);
      setPendingJump(null);
      window.setTimeout(() => { suppressScrollLoadRef.current = false; }, 600);
      return;
    }
    if (!activeChannel || !hasMore || jumpPagesRef.current >= MAX_JUMP_PAGES) {
      // Hors d'atteinte : on abandonne sans laisser la pagination s'emballer,
      // et on montre le message en entier plutôt que rien (moteur Rust).
      if (moteurRust()) useAppStore.getState().setApercuMessage(pendingJump);
      setPendingJump(null);
      return;
    }
    if (isLoading) return;
    jumpPagesRef.current += 1;
    suppressScrollLoadRef.current = true;
    // Même ancrage qu'une remontée à la main : sans lui, chaque page ajoutée
    // en tête laissait la vue « collée au bas » redescendre — la liste
    // montait et descendait sans jamais montrer la cible.
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    isAtBottomRef.current = false;
    loadRoomHistory(activeChannel);
  }, [pendingJump, messages, activeChannel, hasMore, isLoading, loadRoomHistory, setScrollToMessageId]);

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
        onWheel={arreterAncre}
        onTouchStart={arreterAncre}
        onMouseDown={arreterAncre}
        onKeyDown={arreterAncre}
        className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-5 flex flex-col min-w-0"
        onScroll={handleScroll}
      >
        <div ref={contentRef} className="flex flex-col min-w-0">
        {/* Top indicator */}
        {isLoading && (
          <div className="text-center text-text-muted text-sm py-3">{t("chat.loading")}</div>
        )}
        {!isLoading && !hasMore && messages.length > 0 && (
          <div className="text-center text-text-muted text-sm py-3">{t("chat.conversationStart")}</div>
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
              {activeChannel && <LecteursMessage salon={activeChannel} eventId={eventId} />}
            </div>
          );
        })}
        </div>
      </div>

      {/* Scroll to bottom button */}
      {showScrollDown && (
        <button
          onClick={() => {
            // La main à l'utilisateur : le bandeau n'est plus maintenu en vue.
            ancreJusquaRef.current = 0;
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
          {nonLusEnDessous && (
            <span
              aria-label={t("chat.unreadBelow")}
              style={{
                position: "absolute", top: 0, right: 0, width: 10, height: 10, borderRadius: "50%",
                background: "var(--color-error)", border: "2px solid var(--color-surface-container-high)",
              }}
            />
          )}
        </button>
      )}
    </div>
  );
}
