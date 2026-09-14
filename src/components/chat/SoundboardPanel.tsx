import { useEffect, useState, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  listSounds,
  getSoundboardRoomId,
  playSoundLocal,
  broadcastSound,
  playErrorBuzzer,
  setPlaybackVolume,
  deleteSound,
  invalidateSoundCache,
  fetchSoundFile,
  SOUNDBOARD_MAX_FILE_SIZE,
  type SoundEntry,
} from "../../services/soundboardService";
import { canSendMessage, getMatrixClient, getMemberPowerLevel } from "../../services/matrixService";
import { SoundboardUploadModal } from "./SoundboardUploadModal";
import { VoicePanel } from "./VoicePanel";
import { TTS_MODEL_LABELS } from "../../services/ttsService";
import { HotkeyCaptureModal } from "./HotkeyCaptureModal";
import { formatCombo } from "../../utils/keyCombo";
import { UserAvatar } from "../sidebar/UserAvatar";
import { loadHotkeys, onHotkeysChange, pruneHotkeys, resyncHotkeys } from "../../services/soundboardHotkeys";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useDockZone } from "../layout/dockZoneContext";

// Build a nested tree from "Films/Kamelott" paths so the pill navigation can
// list top-level categories and drill into sub-categories.
type TreeNode = { name: string; fullPath: string; children: Map<string, TreeNode> };

function buildTree(categories: string[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map() };
  for (const cat of categories) {
    const parts = cat.split("/").filter(Boolean);
    let cur = root;
    let path = "";
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      let next = cur.children.get(p);
      if (!next) {
        next = { name: p, fullPath: path, children: new Map() };
        cur.children.set(p, next);
      }
      cur = next;
    }
  }
  return root;
}

/** Walk the tree to the node at `path` (null = root). */
function findNode(root: TreeNode, path: string | null): TreeNode | null {
  if (!path) return root;
  let cur: TreeNode | undefined = root;
  for (const p of path.split("/").filter(Boolean)) {
    cur = cur?.children.get(p);
    if (!cur) return null;
  }
  return cur || null;
}

const sortedChildren = (node: TreeNode | null) =>
  node ? Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name)) : [];

const parentPath = (path: string): string | null => {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : null;
};

type FilterMode = "all" | "favorites" | "top";

export function SoundboardPanel() {
  const { t } = useTranslation();
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const [sounds, setSounds] = useState<SoundEntry[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Restore the last active view (filter + category) from the persisted store.
  const [selectedCat, setSelectedCat] = useState<string | null>(() => useSettingsStore.getState().soundboardView.category);
  const [filterMode, setFilterMode] = useState<FilterMode>(() => useSettingsStore.getState().soundboardView.mode);
  const setSoundboardView = useSettingsStore((s) => s.setSoundboardView);
  const [showUpload, setShowUpload] = useState(false);
  const [tab, setTab] = useState<"sounds" | "voices" | "members">("sounds");
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [hotkeyTarget, setHotkeyTarget] = useState<SoundEntry | null>(null);
  const [editTarget, setEditTarget] = useState<SoundEntry | null>(null);
  const [hotkeysTick, setHotkeysTick] = useState(0);
  const volume = useSettingsStore((s) => s.soundboardVolume);
  const setVolume = useSettingsStore((s) => s.setSoundboardVolume);
  const enabled = useSettingsStore((s) => s.soundboardEnabled);
  const setEnabled = useSettingsStore((s) => s.setSoundboardEnabled);
  const hiddenCategories = useSettingsStore((s) => s.hiddenCategories);
  const toggleCategoryHidden = useSettingsStore((s) => s.toggleCategoryHidden);
  const favorites = useSettingsStore((s) => s.soundboardFavorites);
  const toggleFavorite = useSettingsStore((s) => s.toggleSoundboardFavorite);
  const playCounts = useSettingsStore((s) => s.soundboardPlayCounts);
  const incrementPlay = useSettingsStore((s) => s.incrementSoundboardPlay);
  const refreshRef = useRef<() => void>(() => {});

  // Apply volume on first render so receivers pick it up
  useEffect(() => {
    setPlaybackVolume(volume);
  }, [volume]);

  // Remember the active view so reopening the panel lands where you left off.
  useEffect(() => {
    setSoundboardView({ mode: filterMode, category: selectedCat });
  }, [filterMode, selectedCat, setSoundboardView]);

  // Subscribe to hotkey changes so the badges re-render + resync on open
  useEffect(() => {
    const unsub = onHotkeysChange(() => setHotkeysTick((n) => n + 1));
    resyncHotkeys();
    return () => { unsub(); };
  }, []);

  // Prune hotkeys that reference deleted sounds
  useEffect(() => {
    if (sounds.length === 0) return;
    pruneHotkeys(new Set(sounds.map((s) => s.eventId)));
  }, [sounds]);

  const hotkeys = useMemo(() => { void hotkeysTick; return loadHotkeys(); }, [hotkeysTick]);

  // Refresh sound list on demand + when soundboard room timeline changes.
  // (See the long comment history: must filter on the soundboard room id and
  // debounce, or busy-room scrollback sature le pool de connexions du webview.)
  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cachedRoomId: string | null = null;

    const refresh = async () => {
      const rid = await getSoundboardRoomId();
      if (cancelled) return;
      cachedRoomId = rid;
      setRoomId(rid);
      const list = await listSounds();
      if (!cancelled) setSounds(list);
    };
    refreshRef.current = refresh;
    refresh();

    const client = getMatrixClient();
    if (!client) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onTimeline = (_event: any, room: any) => {
      if (!room || !cachedRoomId || room.roomId !== cachedRoomId) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void refresh(); }, 200);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRedaction = (event: any, room: any) => {
      if (!room || !cachedRoomId || room.roomId !== cachedRoomId) {
        if (event?.getRoomId?.() !== cachedRoomId) return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void refresh(); }, 200);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cl = client as any;
    cl.on("Room.timeline", onTimeline);
    cl.on("Room.redaction", onRedaction);
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      cl.off("Room.timeline", onTimeline);
      cl.off("Room.redaction", onRedaction);
    };
  }, []);

  // Le salon soundboard peut ne pas être connu au premier essai (panneau
  // monté tôt — au boot ou juste après un changement de salon, sync Matrix en
  // cours) : on retente tant qu'il manque. L'intervalle meurt avec le
  // démontage du panneau (il n'est monté que si un salon soundboard existe).
  useEffect(() => {
    if (roomId) return;
    const id = setInterval(() => { void refreshRef.current(); }, 2000);
    return () => clearInterval(id);
  }, [roomId]);

  const canUpload = roomId ? canSendMessage(roomId) : false;

  const client = getMatrixClient();
  const myUserId = client?.getUserId() || "";
  const myPl = roomId && myUserId ? getMemberPowerLevel(roomId, myUserId) : 0;
  const canManageMembers = myPl >= 100 && !!roomId;

  const members = useMemo(() => {
    void sounds; // re-evaluate when roomId changes
    if (!roomId || !client) return [];
    const room = client.getRoom(roomId);
    if (!room) return [];
    return room.getJoinedMembers()
      .map((m) => ({
        userId: m.userId,
        name: m.name || m.userId,
        avatarUrl: m.getAvatarUrl(client.baseUrl, 64, 64, "crop", true, false) || null,
        pl: getMemberPowerLevel(roomId, m.userId),
      }))
      .sort((a, b) => b.pl - a.pl || a.name.localeCompare(b.name));
  }, [roomId, client, sounds]);

  const handleSetPl = async (userId: string, level: number) => {
    if (!roomId) return;
    try {
      const { setUserPowerLevel } = await import("../../services/matrixService");
      await setUserPowerLevel(roomId, userId, level);
      refreshRef.current();
    } catch (err) {
      console.error("[Sion] setPowerLevel failed:", err);
      setErrorToast(t("soundboard.plError"));
      setTimeout(() => setErrorToast(null), 3000);
    }
  };

  const hiddenCategoriesSet = useMemo(() => new Set(hiddenCategories), [hiddenCategories]);
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);

  const isCategoryHidden = (cat: string): boolean => {
    if (hiddenCategoriesSet.has(cat)) return true;
    const parts = cat.split("/").filter(Boolean);
    let path = "";
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      if (hiddenCategoriesSet.has(path)) return true;
    }
    return false;
  };

  // Les extraits de référence TTS vivent dans la même room mais ne sont pas des
  // sons jouables : ils sont exclus de la grille, des catégories et du compteur.
  const playable = useMemo(() => sounds.filter((s) => s.kind !== "voice"), [sounds]);

  const tree = useMemo(() => buildTree(Array.from(new Set(playable.map((s) => s.category)))), [playable]);
  const topLevels = useMemo(() => sortedChildren(tree), [tree]);
  // Sub-category row anchor: if the selected category has children, we're
  // browsing *inside* it (show its children, "Tout X" active). If it's a leaf,
  // anchor on its parent so the row keeps showing the siblings with the leaf
  // highlighted — otherwise the row would vanish on clicking a leaf.
  const selectedNode = filterMode === "all" ? findNode(tree, selectedCat) : null;
  const anchorNode = !selectedCat
    ? null
    : (selectedNode && selectedNode.children.size > 0 ? selectedNode : findNode(tree, parentPath(selectedCat)));
  const anchorChildren = sortedChildren(anchorNode);
  const showSubRow = filterMode === "all" && !!anchorNode && anchorNode.name !== "" && anchorChildren.length > 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesQuery = (s: SoundEntry) =>
      !q || s.label.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);

    if (filterMode === "favorites") {
      return playable.filter((s) => favoritesSet.has(s.eventId) && matchesQuery(s));
    }
    if (filterMode === "top") {
      // Most-played first; ties broken by label. Only sounds played at least once.
      return playable
        .filter((s) => (playCounts[s.eventId] || 0) > 0 && matchesQuery(s))
        .sort((a, b) => (playCounts[b.eventId] || 0) - (playCounts[a.eventId] || 0) || a.label.localeCompare(b.label));
    }
    // "all" mode: category drill-down + hidden-category handling.
    return playable.filter((s) => {
      if (selectedCat && !s.category.startsWith(selectedCat)) return false;
      if (isCategoryHidden(s.category)) {
        if (!selectedCat || !s.category.startsWith(selectedCat)) return false;
        const selectedIsOrInHidden = Array.from(hiddenCategoriesSet).some(
          (h) => selectedCat === h || selectedCat.startsWith(h + "/"),
        );
        if (!selectedIsOrInHidden) return false;
      }
      return matchesQuery(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable, search, selectedCat, filterMode, hiddenCategoriesSet, favoritesSet, playCounts]);

  const handlePlay = async (s: SoundEntry) => {
    if (!enabled) return;
    incrementPlay(s.eventId);
    try {
      // Durée mesurée à la lecture : `info.duration` peut manquer (sonde
      // d'upload en échec) ou mentir, et c'est elle qui règle la fin du rond
      // chez tout le monde.
      const measuredMs = await playSoundLocal(s.mxcUrl, s.gain);
      if (connectedVoice) broadcastSound(s.mxcUrl, s.emoji, measuredMs ?? s.duration, s.gain);
    } catch (err) {
      console.warn("[Sion] play failed:", err);
      playErrorBuzzer();
      invalidateSoundCache(s.mxcUrl);
      setErrorToast(t("soundboard.playError"));
      setTimeout(() => setErrorToast(null), 5000);
    }
  };

  const handleDelete = async (s: SoundEntry) => {
    if (!window.confirm(t("soundboard.deleteConfirm", { label: s.label }))) return;
    try {
      await deleteSound(s.eventId);
      invalidateSoundCache(s.mxcUrl);
      refreshRef.current();
    } catch (err) {
      console.error("[Sion] delete failed:", err);
      setErrorToast(t("soundboard.deleteError"));
      setTimeout(() => setErrorToast(null), 5000);
    }
  };

  // Translate vertical wheel into horizontal scroll so the pill rows are
  // navigable with a plain mouse wheel (no horizontal trackpad needed).
  const onPillWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
  };

  // ── Reusable pill button ────────────────────────────────────────────────
  const pill = (
    key: string,
    label: React.ReactNode,
    active: boolean,
    onClick: () => void,
    opts?: { onContextMenu?: (e: React.MouseEvent) => void; dim?: boolean; title?: string },
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      onContextMenu={opts?.onContextMenu}
      title={opts?.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
        padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
        border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
        background: active ? 'var(--color-primary)' : 'transparent',
        color: active ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
        opacity: opts?.dim ? 0.5 : 1,
        textDecoration: opts?.dim ? 'line-through' : 'none',
      }}
    >{label}</button>
  );

  // ── Châssis compact quand le panneau vit dans la zone basse ─────────────
  // Le bandeau est large et court : tous les contrôles tiennent sur UNE ligne
  // (titre, onglets, recherche, volume) pour que la hauteur restante aille
  // aux sons, pas au châssis. En colonne droite, la mise en page d'origine
  // reste telle quelle.
  const dockZone = useDockZone();
  const compact = dockZone === "bottom";

  const tabDefs = [
    { key: "sounds" as const, label: t("soundboard.tabSounds"), show: true },
    { key: "voices" as const, label: t("tts.tab"), show: canUpload },
    { key: "members" as const, label: `${t("soundboard.tabMembers")} · ${members.length}`, show: canManageMembers },
  ].filter((x) => x.show);

  const searchBox = (inHeader: boolean) => (
    <div style={{
      position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0,
      flex: inHeader ? '0 1 220px' : 1,
    }}>
      <span style={{ position: 'absolute', left: inHeader ? 10 : 12, color: 'var(--color-on-surface-variant)', display: 'flex', pointerEvents: 'none' }}>
        <svg width={inHeader ? 13 : 15} height={inHeader ? 13 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("soundboard.searchPlaceholder")}
        style={{
          width: '100%', minWidth: 0, boxSizing: 'border-box',
          padding: inHeader ? '4px 10px 4px 28px' : '9px 12px 9px 34px',
          borderRadius: inHeader ? 999 : 12,
          border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container)',
          color: 'var(--color-on-surface)', fontSize: inHeader ? 12 : 13, fontFamily: 'inherit', outline: 'none',
        }}
      />
    </div>
  );

  const volumeControl = (inHeader: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 0, color: 'var(--color-on-surface-variant)' }}>
      <button
        type="button"
        onClick={() => setEnabled(!enabled)}
        title={enabled ? t("soundboard.disableSb") : t("soundboard.enableSb")}
        style={{ flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, borderRadius: 8, display: 'flex', color: enabled ? 'var(--color-on-surface)' : 'var(--color-error)' }}
      >
        {enabled ? (
          <svg width={inHeader ? 15 : 18} height={inHeader ? 15 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        ) : (
          <svg width={inHeader ? 15 : 18} height={inHeader ? 15 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
      </button>
      <input
        type="range" min={0} max={1} step={0.05} value={volume}
        className="sion-range"
        disabled={!enabled}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        style={{
          width: inHeader ? 90 : undefined,
          flex: inHeader ? '0 0 auto' : 1,
          opacity: enabled ? 1 : 0.4,
          cursor: enabled ? 'pointer' : 'not-allowed',
          '--sion-range-progress': `${Math.round(volume * 100)}%`,
        } as React.CSSProperties}
        title={t("soundboard.volume")}
      />
      <span style={{ minWidth: inHeader ? 26 : 30, textAlign: 'right', fontSize: inHeader ? 10 : 11, opacity: enabled ? 1 : 0.4 }}>{Math.round(volume * 100)}%</span>
    </div>
  );

  const uploadButton = (small: boolean) => (
    <button
      onClick={() => setShowUpload(true)}
      title={t("soundboard.upload")}
      style={{
        width: small ? 28 : 38, height: small ? 28 : 38, flexShrink: 0,
        borderRadius: small ? 999 : 12, border: 'none',
        background: 'var(--color-primary)', color: 'var(--color-on-primary)', cursor: 'pointer',
        fontSize: small ? 17 : 20, fontWeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
      }}
    >+</button>
  );

  const closeButton = (size: number) => (
    <button
      onClick={() => useLayoutStore.getState().closeDockPanel("soundboard")}
      title={t("soundboard.close")}
      style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: size, padding: 2, lineHeight: 1 }}
    >×</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <style>{`
        .sound-card:hover .sound-delete-btn { display: flex !important; }
        .sound-card:hover .sound-edit-btn { display: flex !important; }
        /* Scrollbar masquée — navigation à la molette (onPillWheel). */
        .sb-pills { scrollbar-width: none; -ms-overflow-style: none; }
        .sb-pills::-webkit-scrollbar { height: 0; width: 0; }
      `}</style>

      {compact ? (
        /* Bandeau : tout tient sur une ligne — la hauteur restante va aux sons. */
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '5px 10px', borderBottom: '1px solid var(--color-outline-variant)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', flexShrink: 0 }}>{t("soundboard.title")}</span>
          <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', flexShrink: 0 }}>{t("soundboard.soundCount", { count: playable.length })}</span>
          {roomId && tabDefs.length > 1 && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {tabDefs.map((x) => (
                <button
                  key={x.key}
                  onClick={() => setTab(x.key)}
                  style={{
                    padding: '2px 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 11.5, fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap',
                    border: tab === x.key ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
                    background: tab === x.key ? 'var(--color-secondary-container)' : 'transparent',
                    color: tab === x.key ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
                  }}
                >{x.label}</button>
              ))}
            </div>
          )}
          <div style={{ flex: 1 }} />
          {roomId && tab === "sounds" && searchBox(true)}
          {roomId && tab === "sounds" && canUpload && uploadButton(true)}
          {roomId && tab === "sounds" && volumeControl(true)}
          {closeButton(18)}
        </div>
      ) : (
        <>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px 10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t("soundboard.title")}</span>
              <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', flexShrink: 0 }}>{t("soundboard.soundCount", { count: playable.length })}</span>
            </div>
            {closeButton(20)}
          </div>

          {/* Tabs — défilement horizontal (masqué) pour ne jamais rogner quand le
              panneau est étroit. */}
          {roomId && (canUpload || canManageMembers) && (
            <div className="sb-pills" onWheel={onPillWheel} style={{ display: 'flex', gap: 18, padding: '0 16px', borderBottom: '1px solid var(--color-outline-variant)', overflowX: 'auto' }}>
              {tabDefs.map((x) => (
                <button
                  key={x.key}
                  onClick={() => setTab(x.key)}
                  style={{
                    padding: '8px 0', border: 'none', background: 'transparent', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0, whiteSpace: 'nowrap',
                    borderBottom: tab === x.key ? '2px solid var(--color-primary)' : '2px solid transparent',
                    color: tab === x.key ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
                  }}
                >{x.label}</button>
              ))}
            </div>
          )}
        </>
      )}

      {!roomId && (
        <div style={{ padding: 20, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>
          {t("soundboard.notCreated")}
        </div>
      )}

      {roomId && tab === "voices" && canUpload && (
        <VoicePanel
          sounds={sounds}
          resolveSound={fetchSoundFile}
          onUploaded={() => refreshRef.current()}
          connectedVoice={!!connectedVoice}
        />
      )}

      {roomId && tab === "members" && canManageMembers && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {members.map((m) => {
            const isMe = m.userId === myUserId;
            const role = m.pl >= 100 ? "admin" : m.pl >= 50 ? "mod" : "user";
            return (
              <div key={m.userId} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 6,
                borderRadius: 8, marginBottom: 4, background: 'var(--color-surface-container)',
              }}>
                <UserAvatar name={m.name} size="sm" speaking={false} avatarUrl={m.avatarUrl || undefined} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: role !== "user" ? 600 : 400,
                    color: role === "admin" ? 'var(--color-primary)' : role === "mod" ? 'var(--color-tertiary)' : 'var(--color-on-surface)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{m.name} {isMe && "(vous)"}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                    {role === "admin" ? t("contextMenu.roleAdmin") : role === "mod" ? t("contextMenu.roleModerator") : t("contextMenu.roleUser")}
                  </div>
                </div>
                {!isMe && role !== "admin" && (
                  role === "mod" ? (
                    <button onClick={() => handleSetPl(m.userId, 0)}
                      style={{ padding: '4px 10px', fontSize: 11, borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--color-error-container)', color: 'var(--color-error)', fontFamily: 'inherit' }}
                    >{t("soundboard.demote")}</button>
                  ) : (
                    <button onClick={() => handleSetPl(m.userId, 50)}
                      style={{ padding: '4px 10px', fontSize: 11, borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--color-primary-container)', color: 'var(--color-on-primary-container)', fontFamily: 'inherit' }}
                    >{t("soundboard.promote")}</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      {roomId && tab === "sounds" && (
        <>
          {/* Search + add — en zone basse, la recherche et le « + » vivent dans
              la ligne d'en-tête (châssis compact). */}
          {!compact && (
            <div style={{ padding: '12px 16px 8px', display: 'flex', gap: 8, alignItems: 'center' }}>
              {searchBox(false)}
              {canUpload && uploadButton(false)}
            </div>
          )}

          {/* Quick-filter + top-level category pills */}
          <div className="sb-pills" onWheel={onPillWheel} style={{ display: 'flex', gap: 8, padding: compact ? '2px 10px 6px' : '4px 16px 8px', overflowX: 'auto' }}>
            {pill("fav", <>⭐ {t("soundboard.favorites")}</>, filterMode === "favorites", () => { setFilterMode("favorites"); setSelectedCat(null); })}
            {pill("top", <>🔥 {t("soundboard.top")}</>, filterMode === "top", () => { setFilterMode("top"); setSelectedCat(null); })}
            {pill("all", t("soundboard.allCategories"), filterMode === "all" && selectedCat === null, () => { setFilterMode("all"); setSelectedCat(null); })}
            {topLevels.map((c) => pill(
              c.fullPath,
              c.name,
              filterMode === "all" && !!selectedCat && (selectedCat === c.fullPath || selectedCat.startsWith(c.fullPath + "/")),
              () => { setFilterMode("all"); setSelectedCat(c.fullPath); },
              {
                dim: isCategoryHidden(c.fullPath),
                title: isCategoryHidden(c.fullPath) ? t("soundboard.categoryHidden") : t("soundboard.rightClickHide"),
                onContextMenu: (e) => { e.preventDefault(); toggleCategoryHidden(c.fullPath); },
              },
            ))}
          </div>

          {/* Sub-category drill-down */}
          {showSubRow && anchorNode && (
            <div className="sb-pills" onWheel={onPillWheel} style={{ display: 'flex', gap: 8, padding: '0 16px 8px', overflowX: 'auto', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setSelectedCat(parentPath(anchorNode.fullPath))}
                title={t("soundboard.back")}
                style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 999, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              {pill("__all", t("soundboard.allOf", { name: anchorNode.name }), selectedCat === anchorNode.fullPath, () => setSelectedCat(anchorNode.fullPath))}
              {anchorChildren.map((c) => pill(
                c.fullPath,
                c.name,
                selectedCat === c.fullPath || (!!selectedCat && selectedCat.startsWith(c.fullPath + "/")),
                () => setSelectedCat(c.fullPath),
                {
                  dim: isCategoryHidden(c.fullPath),
                  onContextMenu: (e) => { e.preventDefault(); toggleCategoryHidden(c.fullPath); },
                },
              ))}
            </div>
          )}

          {/* Sound cards */}
          <div style={{ flex: 1, overflow: 'auto', padding: compact ? '2px 10px 8px' : '4px 16px 12px' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: compact ? 12 : 24, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>
                {filterMode === "favorites" ? t("soundboard.noFavorites") : filterMode === "top" ? t("soundboard.noTop") : t("soundboard.empty")}
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(230px, 1fr))' : 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: compact ? 6 : 10,
                alignContent: 'start',
              }}>
                {filtered.map((s) => {
                  const hotkey = hotkeys[s.eventId] || null;
                  const isFav = favoritesSet.has(s.eventId);
                  const subtitle = s.category.replace(/\//g, " · ");
                  // Zone basse : carte en pastille (une ligne) — la hauteur est
                  // comptée, chaque son doit tenir dans une rangée de ~30 px.
                  if (compact) {
                    return (
                      <div
                        key={s.eventId}
                        className="sound-card"
                        onClick={() => handlePlay(s)}
                        onContextMenu={(ev) => { ev.preventDefault(); setHotkeyTarget(s); }}
                        title={!enabled ? t("soundboard.disabledHint") : `${s.label} — ${s.category}${s.ttsModel ? `\n${t("tts.generatedWith", { model: TTS_MODEL_LABELS[s.ttsModel] || s.ttsModel })}` : ""}\n${t("soundboard.rightClickAssign")}${hotkey ? `\n${t("soundboard.currentHotkey", { combo: formatCombo(hotkey) })}` : ""}`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 8px', borderRadius: 10,
                          border: '1px solid var(--color-outline-variant)',
                          background: 'var(--color-surface-container)',
                          cursor: 'pointer', opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none',
                          transition: 'background 120ms, border-color 120ms',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-container)'; e.currentTarget.style.borderColor = 'var(--color-outline-variant)'; }}
                      >
                        <span style={{
                          width: 22, height: 22, flexShrink: 0, borderRadius: 6,
                          background: 'var(--color-surface-container-highest)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                        }}>{s.emoji || '🔊'}</span>
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{s.label}</span>
                        {hotkey && (
                          <span style={{
                            flexShrink: 0, background: 'var(--color-primary)', color: 'var(--color-on-primary)',
                            fontSize: 9, padding: '1px 5px', borderRadius: 5, fontWeight: 700, letterSpacing: '0.02em', pointerEvents: 'none',
                          }}>{formatCombo(hotkey)}</span>
                        )}
                        {s.ttsModel && (
                          <span style={{
                            flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: 0.4, padding: '1px 5px',
                            borderRadius: 999, background: 'var(--color-primary)', color: 'var(--color-on-primary)',
                          }}>{t("tts.badge")}</span>
                        )}
                        {canUpload && (
                          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
                              title={t("soundboard.deleteHint")}
                              className="sound-delete-btn"
                              style={{ width: 20, height: 20, borderRadius: 10, border: 'none', background: 'var(--color-error-container)', color: 'var(--color-error)', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'none', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}
                            >×</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditTarget(s); }}
                              title={t("soundboard.editHint")}
                              className="sound-edit-btn"
                              style={{ width: 20, height: 20, borderRadius: 10, border: 'none', background: 'var(--color-secondary-container)', color: 'var(--color-on-secondary-container)', fontSize: 10, cursor: 'pointer', display: 'none', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}
                            >✎</button>
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(s.eventId); }}
                          title={isFav ? t("soundboard.unfavorite") : t("soundboard.favorite")}
                          style={{ flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 2, color: isFav ? 'var(--color-orange)' : 'var(--color-outline)', opacity: isFav ? 1 : 0.5 }}
                        >{isFav ? '★' : '☆'}</button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={s.eventId}
                      className="sound-card"
                      onClick={() => handlePlay(s)}
                      onContextMenu={(ev) => { ev.preventDefault(); setHotkeyTarget(s); }}
                      title={!enabled ? t("soundboard.disabledHint") : `${s.label} — ${s.category}${s.ttsModel ? `\n${t("tts.generatedWith", { model: TTS_MODEL_LABELS[s.ttsModel] || s.ttsModel })}` : ""}\n${t("soundboard.rightClickAssign")}${hotkey ? `\n${t("soundboard.currentHotkey", { combo: formatCombo(hotkey) })}` : ""}`}
                      style={{
                        position: 'relative', display: 'flex', flexDirection: 'column', gap: 8,
                        padding: 12, borderRadius: 14,
                        border: '1px solid var(--color-outline-variant)',
                        background: 'var(--color-surface-container)',
                        cursor: 'pointer', opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none',
                        transition: 'background 120ms, border-color 120ms',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-container)'; e.currentTarget.style.borderColor = 'var(--color-outline-variant)'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-surface-container-highest)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                          {s.emoji || '🔊'}
                        </div>
                        {/* Un son de synthèse ne se distingue autrement en rien
                            d'un extrait enregistré : sans marqueur, l'origine
                            se perd dès la séance suivante. */}
                        {s.ttsModel && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 0.4, padding: '1px 5px',
                            borderRadius: 999, background: 'var(--color-primary)',
                            color: 'var(--color-on-primary)', alignSelf: 'flex-start', marginLeft: 'auto', marginRight: 4,
                          }}>{t("tts.badge")}</span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(s.eventId); }}
                          title={isFav ? t("soundboard.unfavorite") : t("soundboard.favorite")}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2, color: isFav ? 'var(--color-orange)' : 'var(--color-outline)', opacity: isFav ? 1 : 0.5 }}
                        >{isFav ? '★' : '☆'}</button>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{s.label}</div>
                        <div style={{
                          fontSize: 11, color: 'var(--color-on-surface-variant)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{subtitle}</div>
                        {s.ttsModel && (
                          <div style={{
                            fontSize: 10, color: 'var(--color-outline)', marginTop: 2,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{TTS_MODEL_LABELS[s.ttsModel] || s.ttsModel}</div>
                        )}
                      </div>
                      {hotkey && (
                        <span style={{
                          position: 'absolute', bottom: 8, right: 8,
                          background: 'var(--color-primary)', color: 'var(--color-on-primary)',
                          fontSize: 9, padding: '1px 5px', borderRadius: 5, fontWeight: 700, letterSpacing: '0.02em', pointerEvents: 'none',
                        }}>{formatCombo(hotkey)}</span>
                      )}
                      {canUpload && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
                            title={t("soundboard.deleteHint")}
                            className="sound-delete-btn"
                            style={{ position: 'absolute', bottom: 8, left: 8, width: 22, height: 22, borderRadius: 11, border: 'none', background: 'var(--color-error-container)', color: 'var(--color-error)', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'none', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}
                          >×</button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditTarget(s); }}
                            title={t("soundboard.editHint")}
                            className="sound-edit-btn"
                            style={{ position: 'absolute', bottom: 8, left: 34, width: 22, height: 22, borderRadius: 11, border: 'none', background: 'var(--color-secondary-container)', color: 'var(--color-on-secondary-container)', fontSize: 11, cursor: 'pointer', display: 'none', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}
                          >✎</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer: enable + volume — en zone basse, le volume vit déjà dans
              la ligne d'en-tête (châssis compact). */}
          {!compact && (
            <div style={{
              padding: '8px 16px', borderTop: '1px solid var(--color-outline-variant)',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-on-surface-variant)',
            }}>
              {volumeControl(false)}
            </div>
          )}
        </>
      )}

      {errorToast && (
        <div style={{
          position: 'absolute', bottom: 60, right: 20, padding: '8px 14px', borderRadius: 10,
          background: 'var(--color-error-container)', color: 'var(--color-error)', fontSize: 12, maxWidth: 280,
        }}>{errorToast}</div>
      )}

      {showUpload && roomId && (
        <SoundboardUploadModal
          existingCategories={Array.from(new Set(playable.map((s) => s.category)))}
          maxSize={SOUNDBOARD_MAX_FILE_SIZE}
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); refreshRef.current(); }}
        />
      )}

      {hotkeyTarget && (
        <HotkeyCaptureModal
          eventId={hotkeyTarget.eventId}
          label={hotkeyTarget.label}
          currentCombo={hotkeys[hotkeyTarget.eventId] || null}
          onClose={() => setHotkeyTarget(null)}
        />
      )}

      {editTarget && (
        <SoundboardUploadModal
          existingCategories={Array.from(new Set(playable.map((s) => s.category)))}
          maxSize={SOUNDBOARD_MAX_FILE_SIZE}
          editing={editTarget}
          onClose={() => setEditTarget(null)}
          onUploaded={() => { setEditTarget(null); refreshRef.current(); }}
        />
      )}
    </div>
  );
}
