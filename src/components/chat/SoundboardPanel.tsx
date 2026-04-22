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
  SOUNDBOARD_MAX_FILE_SIZE,
  type SoundEntry,
} from "../../services/soundboardService";
import { canSendMessage, getMatrixClient, getMemberPowerLevel } from "../../services/matrixService";
import { SoundboardUploadModal } from "./SoundboardUploadModal";
import { HotkeyCaptureModal } from "./HotkeyCaptureModal";
import { UserAvatar } from "../sidebar/UserAvatar";
import { loadHotkeys, onHotkeysChange, pruneHotkeys, resyncHotkeys } from "../../services/soundboardHotkeys";

// Build a nested tree from "Films/Kamelott" paths
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

function TreeNodeView({
  node,
  selected,
  onSelect,
  hiddenCategories,
  onToggleHide,
  depth = 0,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (path: string | null) => void;
  hiddenCategories: Set<string>;
  onToggleHide: (path: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (node.name === "") {
    return (
      <>
        {children.map((c) => (
          <TreeNodeView key={c.fullPath} node={c} selected={selected} onSelect={onSelect} hiddenCategories={hiddenCategories} onToggleHide={onToggleHide} depth={0} />
        ))}
      </>
    );
  }
  // A category is hidden either explicitly, or because an ancestor is
  // hidden (child categories inherit the parent's hidden state).
  const isExplicitlyHidden = hiddenCategories.has(node.fullPath);
  const hasHiddenAncestor = Array.from(hiddenCategories).some(
    (p) => p !== node.fullPath && node.fullPath.startsWith(p + "/"),
  );
  const isHidden = isExplicitlyHidden || hasHiddenAncestor;
  return (
    <div>
      <div
        className="soundboard-tree-node"
        onClick={() => onSelect(selected === node.fullPath ? null : node.fullPath)}
        onDoubleClick={() => setOpen((o) => !o)}
        style={{
          padding: `4px 6px 4px ${6 + depth * 12}px`,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 12,
          cursor: 'pointer',
          borderRadius: 6,
          background: selected === node.fullPath ? 'var(--color-primary-container)' : 'transparent',
          color: selected === node.fullPath ? 'var(--color-on-primary-container)' : 'var(--color-on-surface-variant)',
          opacity: isHidden ? 0.55 : 1,
        }}
      >
        {children.length > 0 ? (
          <span
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            style={{ cursor: 'pointer', width: 10, display: 'inline-block', fontSize: 10 }}
          >{open ? '▾' : '▸'}</span>
        ) : <span style={{ width: 10 }} />}
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textDecoration: isHidden ? 'line-through' : 'none',
          }}
        >{node.name}</span>
        {/* Explicit hidden marker: always visible when self-hidden, so the
            user knows it's them who hid this category (vs inherited from
            parent). Inherited-hidden stays greyed/strikethrough but no icon. */}
        {isExplicitlyHidden && (
          <span
            title="Cette catégorie est masquée"
            style={{ fontSize: 10, opacity: 0.8 }}
          >🙈</span>
        )}
        {/* Hide/unhide toggle — visible on hover via CSS. Click stops
            propagation so selecting the category isn't a side-effect. */}
        <button
          className="soundboard-tree-hide-btn"
          onClick={(e) => { e.stopPropagation(); onToggleHide(node.fullPath); }}
          title={isExplicitlyHidden ? "Ré-afficher cette catégorie" : hasHiddenAncestor ? "Parent masqué — impossible de ré-afficher individuellement" : "Masquer cette catégorie"}
          disabled={hasHiddenAncestor && !isExplicitlyHidden}
          style={{
            display: isExplicitlyHidden ? 'flex' : 'none',
            width: 18,
            height: 18,
            borderRadius: 9,
            border: 'none',
            background: 'var(--color-surface-container-high)',
            color: 'var(--color-on-surface-variant)',
            fontSize: 10,
            cursor: hasHiddenAncestor && !isExplicitlyHidden ? 'not-allowed' : 'pointer',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            padding: 0,
            opacity: hasHiddenAncestor && !isExplicitlyHidden ? 0.4 : 1,
          }}
        >{isExplicitlyHidden ? '👁' : '🙈'}</button>
      </div>
      {open && children.map((c) => (
        <TreeNodeView key={c.fullPath} node={c} selected={selected} onSelect={onSelect} hiddenCategories={hiddenCategories} onToggleHide={onToggleHide} depth={depth + 1} />
      ))}
    </div>
  );
}

export function SoundboardPanel() {
  const { t } = useTranslation();
  const show = useAppStore((s) => s.showSoundboardPanel);
  const close = useAppStore((s) => s.toggleSoundboardPanel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const [sounds, setSounds] = useState<SoundEntry[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
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
  const refreshRef = useRef<() => void>(() => {});

  // Apply volume on first render so receivers pick it up
  useEffect(() => {
    setPlaybackVolume(volume);
  }, [volume]);

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
  //
  // The Matrix `Room.timeline` event fires for *every* room — text channels,
  // voice signaling rooms, scrollback batches, the lot. We MUST filter on
  // the soundboard room id, otherwise every inbound event triggers a
  // `findSoundboardRoom()` + `listSounds()` cycle. During initial scrollback
  // of a busy voice room that's 1000+ alias resolutions in a burst, which
  // saturates CEF's connection pool (`ERR_INSUFFICIENT_RESOURCES`). The
  // refresh is also debounced (200 ms) so a burst of edits/redactions in
  // the soundboard itself coalesces into a single re-list.
  useEffect(() => {
    if (!show) return;
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
        // matrix-js-sdk also fires `Room.redaction` with (event, room)
        // where `room` may be undefined for older sdk paths — bail safely.
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
  }, [show]);

  const canUpload = roomId ? canSendMessage(roomId) : false;

  // Current user's PL in the soundboard room — admins (PL >= 100) can manage
  // member roles (promote mods, demote users).
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

  // A sound is hidden if its category (or any ancestor path) is in the
  // hidden list. E.g. hiding "Films" hides "Films/Kamelott/*" too.
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sounds.filter((s) => {
      if (selectedCat && !s.category.startsWith(selectedCat)) return false;
      // When a specific hidden category is selected, show its sounds (so
      // the user can still browse/play/unhide them). Otherwise skip.
      if (isCategoryHidden(s.category)) {
        if (!selectedCat || !s.category.startsWith(selectedCat)) return false;
        // Further: only show if the selected category itself is the hidden one
        // (or an ancestor) — we're in "inspect the hidden branch" mode.
        const selectedIsOrInHidden = Array.from(hiddenCategoriesSet).some(
          (h) => selectedCat === h || selectedCat.startsWith(h + "/"),
        );
        if (!selectedIsOrInHidden) return false;
      }
      if (!q) return true;
      return s.label.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sounds, search, selectedCat, hiddenCategoriesSet]);

  const tree = useMemo(() => buildTree(Array.from(new Set(sounds.map((s) => s.category)))), [sounds]);

  const handlePlay = async (s: SoundEntry) => {
    // Le toggle "Activé" désactive la soundboard complètement : on ne joue
    // plus rien localement et on ne broadcast plus aux autres. Rien ne part
    // dans le canal vocal non plus.
    if (!enabled) return;
    try {
      await playSoundLocal(s.mxcUrl);
      if (connectedVoice) broadcastSound(s.mxcUrl, s.emoji, s.duration);
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

  if (!show) return null;

  return (
    <aside style={{
      width: 340,
      flexShrink: 0,
      background: 'var(--color-surface-container-low)',
      borderLeft: '1px solid var(--color-outline-variant)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <style>{`
        .sound-card:hover .sound-delete-btn { display: flex !important; }
        .sound-card:hover .sound-edit-btn { display: flex !important; }
        /* Hide/unhide toggle on category rows — visible on hover. When a
           category is already hidden, the button stays visible (see inline
           style) so the user can always recover. */
        .soundboard-tree-node:hover .soundboard-tree-hide-btn { display: flex !important; }
      `}</style>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-outline-variant)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t("soundboard.title")} ({sounds.length})
        </span>
        <button
          onClick={close}
          title={t("soundboard.close")}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--color-on-surface-variant)',
            cursor: 'pointer',
            fontSize: 18,
            padding: 2,
            lineHeight: 1,
          }}
        >×</button>
      </div>

      {!roomId && (
        <div style={{ padding: 20, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>
          {t("soundboard.notCreated")}
        </div>
      )}

      {roomId && canManageMembers && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-outline-variant)' }}>
          <button
            onClick={() => setShowMembers(false)}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: 'none',
              borderBottom: !showMembers ? '2px solid var(--color-primary)' : '2px solid transparent',
              background: 'transparent',
              color: !showMembers ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >{t("soundboard.tabSounds")}</button>
          <button
            onClick={() => setShowMembers(true)}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: 'none',
              borderBottom: showMembers ? '2px solid var(--color-primary)' : '2px solid transparent',
              background: 'transparent',
              color: showMembers ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >{t("soundboard.tabMembers")} ({members.length})</button>
        </div>
      )}

      {roomId && showMembers && canManageMembers && (
        <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
          {members.map((m) => {
            const isMe = m.userId === myUserId;
            const role = m.pl >= 100 ? "admin" : m.pl >= 50 ? "mod" : "user";
            return (
              <div key={m.userId} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 6,
                borderRadius: 8,
                marginBottom: 4,
                background: 'var(--color-surface-container)',
              }}>
                <UserAvatar name={m.name} size="sm" speaking={false} avatarUrl={m.avatarUrl || undefined} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12,
                    fontWeight: role !== "user" ? 600 : 400,
                    color: role === "admin" ? 'var(--color-primary)' : role === "mod" ? 'var(--color-tertiary)' : 'var(--color-on-surface)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{m.name} {isMe && "(vous)"}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                    {role === "admin" ? t("contextMenu.roleAdmin") : role === "mod" ? t("contextMenu.roleModerator") : t("contextMenu.roleUser")}
                  </div>
                </div>
                {!isMe && role !== "admin" && (
                  role === "mod" ? (
                    <button
                      onClick={() => handleSetPl(m.userId, 0)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        borderRadius: 10,
                        border: 'none',
                        cursor: 'pointer',
                        background: 'var(--color-error-container)',
                        color: 'var(--color-error)',
                        fontFamily: 'inherit',
                      }}
                    >{t("soundboard.demote")}</button>
                  ) : (
                    <button
                      onClick={() => handleSetPl(m.userId, 50)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        borderRadius: 10,
                        border: 'none',
                        cursor: 'pointer',
                        background: 'var(--color-primary-container)',
                        color: 'var(--color-on-primary-container)',
                        fontFamily: 'inherit',
                      }}
                    >{t("soundboard.promote")}</button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      {roomId && !showMembers && (
        <>
          <div style={{ padding: '8px 12px', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("soundboard.searchPlaceholder")}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 10,
                border: '1px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container)',
                color: 'var(--color-on-surface)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            {canUpload && (
              <button
                onClick={() => setShowUpload(true)}
                title={t("soundboard.upload")}
                style={{
                  padding: '6px 10px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--color-primary)',
                  color: 'var(--color-on-primary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >+</button>
            )}
          </div>

          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div style={{
              width: 120,
              flexShrink: 0,
              borderRight: '1px solid var(--color-outline-variant)',
              overflow: 'auto',
              padding: '4px 2px',
            }}>
              <div
                onClick={() => setSelectedCat(null)}
                style={{
                  padding: '4px 6px',
                  fontSize: 12,
                  cursor: 'pointer',
                  borderRadius: 6,
                  background: selectedCat === null ? 'var(--color-primary-container)' : 'transparent',
                  color: selectedCat === null ? 'var(--color-on-primary-container)' : 'var(--color-on-surface-variant)',
                }}
              >{t("soundboard.allCategories")}</div>
              <TreeNodeView node={tree} selected={selectedCat} onSelect={setSelectedCat} hiddenCategories={hiddenCategoriesSet} onToggleHide={toggleCategoryHidden} />
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: 20, fontSize: 12, color: 'var(--color-outline)', textAlign: 'center' }}>
                  {t("soundboard.empty")}
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                  gap: 8,
                }}>
                  {filtered.map((s) => {
                    const hotkey = hotkeys[s.eventId] || null;
                    const inHiddenBranch = isCategoryHidden(s.category);
                    return (
                    <div
                      key={s.eventId}
                      className="sound-card"
                      onClick={() => handlePlay(s)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        setHotkeyTarget(s);
                      }}
                      title={!enabled ? t("soundboard.disabledHint") : `${s.label} — ${s.category}\n${t("soundboard.rightClickAssign")}${hotkey ? `\n${t("soundboard.currentHotkey", { combo: hotkey })}` : ""}${inHiddenBranch ? "\n(catégorie masquée — visible parce que tu l'as sélectionnée)" : ""}`}
                      style={{
                        position: 'relative',
                        opacity: !enabled ? 0.4 : (inHiddenBranch ? 0.5 : 1),
                        pointerEvents: enabled ? 'auto' : 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '10px 4px',
                        borderRadius: 10,
                        border: inHiddenBranch
                          ? '1px dashed var(--color-outline-variant)'
                          : '1px solid var(--color-outline-variant)',
                        background: 'var(--color-surface-container)',
                        color: 'var(--color-on-surface)',
                        cursor: 'pointer',
                        fontSize: 11,
                        fontFamily: 'inherit',
                        gap: 4,
                        aspectRatio: '1 / 1',
                        transition: 'background 120ms',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-primary-container)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-container)'; }}
                    >
                      <span style={{ fontSize: 22, lineHeight: 1 }}>{s.emoji || '🔊'}</span>
                      <span style={{
                        fontSize: 10,
                        lineHeight: 1.15,
                        textAlign: 'center',
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}>{s.label}</span>
                      {hotkey && (
                        <span style={{
                          position: 'absolute',
                          top: 3,
                          right: 3,
                          background: 'var(--color-primary)',
                          color: 'var(--color-on-primary)',
                          fontSize: 8,
                          padding: '1px 4px',
                          borderRadius: 4,
                          fontWeight: 700,
                          letterSpacing: '0.02em',
                          pointerEvents: 'none',
                        }}>{hotkey}</span>
                      )}
                      {canUpload && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
                            title={t("soundboard.deleteHint")}
                            style={{
                              position: 'absolute',
                              top: 2,
                              left: 2,
                              width: 16,
                              height: 16,
                              borderRadius: 8,
                              border: 'none',
                              background: 'var(--color-error-container)',
                              color: 'var(--color-error)',
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'none',
                              alignItems: 'center',
                              justifyContent: 'center',
                              lineHeight: 1,
                              padding: 0,
                            }}
                            className="sound-delete-btn"
                          >×</button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditTarget(s); }}
                            title={t("soundboard.editHint")}
                            style={{
                              position: 'absolute',
                              bottom: 2,
                              left: 2,
                              width: 16,
                              height: 16,
                              borderRadius: 8,
                              border: 'none',
                              background: 'var(--color-secondary-container)',
                              color: 'var(--color-on-secondary-container)',
                              fontSize: 10,
                              cursor: 'pointer',
                              display: 'none',
                              alignItems: 'center',
                              justifyContent: 'center',
                              lineHeight: 1,
                              padding: 0,
                            }}
                            className="sound-edit-btn"
                          >✎</button>
                        </>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{
            padding: '8px 12px',
            borderTop: '1px solid var(--color-outline-variant)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: 'var(--color-on-surface-variant)',
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t("soundboard.enabled")}
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              style={{ flex: 1 }}
              title={t("soundboard.volume")}
            />
            <span style={{ minWidth: 30, textAlign: 'right' }}>{Math.round(volume * 100)}%</span>
          </div>
        </>
      )}

      {errorToast && (
        <div style={{
          position: 'absolute',
          bottom: 60,
          right: 20,
          padding: '8px 14px',
          borderRadius: 10,
          background: 'var(--color-error-container)',
          color: 'var(--color-error)',
          fontSize: 12,
          maxWidth: 280,
        }}>{errorToast}</div>
      )}

      {showUpload && roomId && (
        <SoundboardUploadModal
          existingCategories={Array.from(new Set(sounds.map((s) => s.category)))}
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
          existingCategories={Array.from(new Set(sounds.map((s) => s.category)))}
          maxSize={SOUNDBOARD_MAX_FILE_SIZE}
          editing={editTarget}
          onClose={() => setEditTarget(null)}
          onUploaded={() => { setEditTarget(null); refreshRef.current(); }}
        />
      )}
    </aside>
  );
}
