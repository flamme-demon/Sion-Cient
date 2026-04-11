import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SendIcon, CloseIcon, EmojiIcon } from "../icons";
import { AttachButton } from "./AttachButton";
import { FilePreview } from "./FilePreview";
import { UserAvatar } from "../sidebar/UserAvatar";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useIsMobile } from "../../hooks/useIsMobile";
import * as matrixService from "../../services/matrixService";
import { EMOJI_DATA, EMOJI_GROUPS, EMOJI_BY_GROUP } from "../../utils/emojiData";
import { useRecentEmojisStore } from "../../stores/useRecentEmojisStore";

const TENOR_API_KEY = "LIVDSRZULELA";
const TENOR_BASE = "https://g.tenor.com/v1";
// Match VOICE_BAR_HEIGHT from MobileVoiceBar (avoid circular import)
const VOICE_BAR_HEIGHT = 120;

export function ChatInput() {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeChannel = useAppStore((s) => s.activeChannel);
  const sendMessage = useMatrixStore((s) => s.sendMessage);
  const sendReply = useMatrixStore((s) => s.sendReply);
  const editMessageStore = useMatrixStore((s) => s.editMessage);
  const sendFile = useMatrixStore((s) => s.sendFile);
  const channels = useMatrixStore((s) => s.channels);
  const addPendingFile = useAppStore((s) => s.addPendingFile);
  const pendingFiles = useAppStore((s) => s.pendingFiles);
  const fileError = useAppStore((s) => s.fileError);
  const clearPendingFiles = useAppStore((s) => s.clearPendingFiles);
  const editingMessage = useAppStore((s) => s.editingMessage);
  const clearEditingMessage = useAppStore((s) => s.clearEditingMessage);
  const replyingTo = useAppStore((s) => s.replyingTo);
  const clearReplyingTo = useAppStore((s) => s.clearReplyingTo);

  // Mention autocomplete
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<{ userId: string; displayName: string; avatarUrl: string | null }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Emoji autocomplete
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiResults, setEmojiResults] = useState<{ shortcode: string; emoji: string }[]>([]);
  const [emojiIndex, setEmojiIndex] = useState(0);

  // Emoji/GIF picker panel
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "gif">("emoji");
  const [emojiPickerSearch, setEmojiPickerSearch] = useState("");
  const recentEmojis = useRecentEmojisStore((s) => s.recent);
  const addRecentEmoji = useRecentEmojisStore((s) => s.add);
  const [emojiPickerGroup, setEmojiPickerGroup] = useState<number>(0);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const enableGifs = useSettingsStore((s) => s.enableGifs);

  // GIF state
  const [gifSearch, setGifSearch] = useState("");
  const [gifResults, setGifResults] = useState<{ id: string; url: string; preview: string; width: number; height: number }[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const gifDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Message history (session-only)
  const messageHistory = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInput = useRef("");

  const isMobile = useIsMobile();
  const channelName = channels.find((c) => c.id === activeChannel)?.name || "general";

  // Close emoji picker on outside click/touch
  // Fetch GIFs from Tenor (only when enabled and tab is active)
  useEffect(() => {
    if (!showEmojiPicker || pickerTab !== "gif" || !enableGifs) return;
    clearTimeout(gifDebounceRef.current);
    gifDebounceRef.current = setTimeout(async () => {
      setGifLoading(true);
      try {
        const endpoint = gifSearch.trim() ? "search" : "trending";
        const params = new URLSearchParams({ key: TENOR_API_KEY, limit: "30", media_filter: "minimal" });
        if (gifSearch.trim()) params.set("q", gifSearch.trim());
        const res = await fetch(`${TENOR_BASE}/${endpoint}?${params}`);
        const data = await res.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setGifResults((data.results || []).map((r: any) => {
          const media = r.media?.[0] || {};
          return {
            id: r.id,
            url: media.gif?.url || media.mediumgif?.url || "",
            preview: media.tinygif?.url || media.nanogif?.url || "",
            width: media.tinygif?.dims?.[0] || 200,
            height: media.tinygif?.dims?.[1] || 150,
          };
        }));
      } catch {
        setGifResults([]);
      } finally {
        setGifLoading(false);
      }
    }, gifSearch.trim() ? 400 : 0);
    return () => clearTimeout(gifDebounceRef.current);
  }, [showEmojiPicker, pickerTab, gifSearch, enableGifs]);

  const sendGif = async (gifUrl: string) => {
    if (!activeChannel || !gifUrl) return;
    setShowEmojiPicker(false);
    try {
      await matrixService.sendImageUrl(activeChannel, gifUrl);
    } catch (err) {
      console.error("[Sion] Failed to send GIF:", err);
    }
  };

  useEffect(() => {
    if (!showEmojiPicker) return;
    const handleClick = (e: MouseEvent | TouchEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
        setEmojiPickerSearch("");
      }
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("touchstart", handleClick);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("touchstart", handleClick);
    };
  }, [showEmojiPicker]);

  // Pre-fill input when editing a message
  useEffect(() => {
    if (editingMessage) {
      setInputText(editingMessage.text);
      setHistoryIndex(-1);
      textareaRef.current?.focus();
    }
  }, [editingMessage]);

  // Focus textarea when replying to a message
  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const handleSend = async () => {
    if (!inputText.trim() && pendingFiles.length === 0) return;

    // Edit mode
    if (editingMessage) {
      if (inputText.trim()) {
        await editMessageStore(activeChannel, editingMessage.eventId, inputText.trim());
      }
      clearEditingMessage();
      setInputText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }

    // Send files first
    for (const pf of pendingFiles) {
      await sendFile(activeChannel, pf.file);
    }
    if (inputText.trim()) {
      // Add to history
      messageHistory.current = [...messageHistory.current.slice(-49), inputText.trim()];
      if (replyingTo) {
        await sendReply(activeChannel, replyingTo.eventId, inputText);
        clearReplyingTo();
      } else {
        await sendMessage(activeChannel, inputText);
      }
    }
    clearPendingFiles();
    setInputText("");
    setHistoryIndex(-1);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete keyboard navigation
    if (mentionQuery !== null && mentionResults.length > 0) {
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionResults.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mentionResults[mentionIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMentionQuery(null); setMentionResults([]); return; }
    }
    if (emojiQuery !== null && emojiResults.length > 0) {
      if (e.key === "ArrowUp") { e.preventDefault(); setEmojiIndex((i) => (i - 1 + emojiResults.length) % emojiResults.length); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setEmojiIndex((i) => (i + 1) % emojiResults.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertEmoji(emojiResults[emojiIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setEmojiQuery(null); setEmojiResults([]); return; }
    }

    if (e.key === "Escape" && editingMessage) {
      e.preventDefault();
      clearEditingMessage();
      setInputText("");
      return;
    }

    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      clearReplyingTo();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Arrow Up - navigate history
    if (e.key === "ArrowUp" && !editingMessage) {
      const history = messageHistory.current;
      if (history.length === 0) return;
      if (historyIndex === -1 && inputText.trim() !== "") return; // Don't override typed text

      e.preventDefault();
      if (historyIndex === -1) {
        savedInput.current = inputText;
      }
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIndex);
      setInputText(history[history.length - 1 - newIndex]);
      return;
    }

    // Arrow Down - navigate history
    if (e.key === "ArrowDown" && historyIndex >= 0 && !editingMessage) {
      e.preventDefault();
      const newIndex = historyIndex - 1;
      if (newIndex < 0) {
        setHistoryIndex(-1);
        setInputText(savedInput.current);
      } else {
        setHistoryIndex(newIndex);
        setInputText(messageHistory.current[messageHistory.current.length - 1 - newIndex]);
      }
      return;
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) addPendingFile(file);
      }
    }
  };

  const handleChange = (value: string) => {
    setInputText(value);
    autoGrow();

    // Detect @mention query
    const textarea = textareaRef.current;
    if (textarea) {
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);

      // Check for @mention
      const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
      if (mentionMatch) {
        const query = mentionMatch[1].toLowerCase();
        setMentionQuery(query);
        setEmojiQuery(null);
        const members = matrixService.getRoomMembers(activeChannel);
        const filtered = members
          .filter((m) => m.displayName.toLowerCase().includes(query) || m.userId.toLowerCase().includes(query))
          .slice(0, 8);
        setMentionResults(filtered);
        setMentionIndex(0);
      } else {
        setMentionQuery(null);
        setMentionResults([]);

        // Check for :emoji query (only if no mention active)
        const emojiMatch = textBeforeCursor.match(/:(\w{2,})$/);
        if (emojiMatch) {
          const query = emojiMatch[1].toLowerCase();
          setEmojiQuery(query);
          // Prioritize shortcodes starting with the query, then contains
          const startsWith = EMOJI_DATA.filter((e) => e.shortcode.startsWith(query));
          const contains = EMOJI_DATA.filter((e) => !e.shortcode.startsWith(query) && e.shortcode.includes(query));
          const filtered = [...startsWith, ...contains].slice(0, 8);
          setEmojiResults(filtered);
          setEmojiIndex(0);
        } else {
          setEmojiQuery(null);
          setEmojiResults([]);
        }
      }
    }
  };

  const insertMention = (member: { userId: string; displayName: string }) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const textBefore = inputText.slice(0, cursorPos);
    const textAfter = inputText.slice(cursorPos);
    const newBefore = textBefore.replace(/@\w*$/, `@${member.displayName} `);
    setInputText(newBefore + textAfter);
    setMentionQuery(null);
    setMentionResults([]);
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = newBefore.length;
      textarea.focus();
    });
  };

  const insertEmoji = (entry: { shortcode: string; emoji: string }) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const textBefore = inputText.slice(0, cursorPos);
    const textAfter = inputText.slice(cursorPos);
    const newBefore = textBefore.replace(/:\w+$/, entry.emoji);
    setInputText(newBefore + textAfter);
    setEmojiQuery(null);
    setEmojiResults([]);
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = newBefore.length;
      textarea.focus();
    });
  };

  const pickEmoji = (emoji: string) => {
    addRecentEmoji(emoji);
    const textarea = textareaRef.current;
    const cursorPos = textarea ? textarea.selectionStart : inputText.length;
    const newText = inputText.slice(0, cursorPos) + emoji + inputText.slice(cursorPos);
    setInputText(newText);
    setShowEmojiPicker(false);
    setEmojiPickerSearch("");
    setTimeout(() => {
      if (textarea) {
        textarea.selectionStart = textarea.selectionEnd = cursorPos + emoji.length;
        textarea.focus();
      }
    });
  };

  const filteredPickerEmojis = emojiPickerSearch.length >= 2
    ? (() => {
        const q = emojiPickerSearch.toLowerCase();
        const starts = EMOJI_DATA.filter((e) => e.shortcode.startsWith(q));
        const contains = EMOJI_DATA.filter((e) => !e.shortcode.startsWith(q) && e.shortcode.includes(q));
        return [...starts, ...contains];
      })()
    : (EMOJI_BY_GROUP.get(emojiPickerGroup) || []);

  const hasContent = inputText.trim().length > 0 || pendingFiles.length > 0;

  return (
    <div style={{ padding: '8px 20px 20px 20px' }}>
      {/* File error banner */}
      {fileError && (
        <div style={{
          padding: '8px 16px',
          marginBottom: 4,
          borderRadius: 12,
          background: 'var(--color-error-container)',
          color: 'var(--color-on-error-container)',
          fontSize: 12,
          fontWeight: 500,
        }}>
          {fileError}
        </div>
      )}
      {/* Reply preview */}
      {replyingTo && !editingMessage && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 16px',
          marginBottom: 4,
          borderRadius: '12px 12px 0 0',
          background: 'var(--color-secondary-container)',
          color: 'var(--color-on-secondary-container)',
          fontSize: 12,
        }}>
          <span>
            {t("chat.replyingTo")} <strong>{replyingTo.user}</strong>
            {replyingTo.text ? ` : ${replyingTo.text.slice(0, 60)}${replyingTo.text.length > 60 ? "..." : ""}` : ""}
          </span>
          <button
            onClick={clearReplyingTo}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--color-on-secondary-container)',
              cursor: 'pointer',
              padding: '2px 4px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {/* Edit mode indicator */}
      {editingMessage && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 16px',
          marginBottom: 4,
          borderRadius: '12px 12px 0 0',
          background: 'var(--color-primary-container)',
          color: 'var(--color-on-primary-container)',
          fontSize: 12,
        }}>
          <span>{t("chat.editing")}</span>
          <button
            onClick={() => { clearEditingMessage(); setInputText(""); }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--color-on-primary-container)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
              padding: '2px 8px',
              borderRadius: 6,
            }}
          >
            {t("auth.cancel")}
          </button>
        </div>
      )}
      {/* M3 Filled text field container */}
      <div style={{
        background: 'var(--color-surface-container-high)',
        borderRadius: (editingMessage || replyingTo) ? '0 0 28px 28px' : 28,
        transition: 'all 200ms',
        border: editingMessage
          ? '2px solid var(--color-primary)'
          : focused ? '2px solid var(--color-primary)' : '2px solid transparent',
        position: 'relative',
      }}>
        {/* Mention autocomplete dropdown */}
        {mentionQuery !== null && mentionResults.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            background: 'var(--color-surface-container-high)',
            borderRadius: 16,
            boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
            padding: 4,
            marginBottom: 4,
            maxHeight: 320,
            overflowY: 'auto',
            zIndex: 100,
          }}>
            {mentionResults.map((member, i) => (
              <button
                key={member.userId}
                onMouseDown={(e) => { e.preventDefault(); insertMention(member); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '8px 12px',
                  border: 'none',
                  borderRadius: 12,
                  background: i === mentionIndex ? 'var(--color-secondary-container)' : 'transparent',
                  color: 'var(--color-on-surface)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <UserAvatar name={member.displayName} speaking={false} size="sm" avatarUrl={member.avatarUrl ?? undefined} />
                <span style={{ fontWeight: 500 }}>{member.displayName}</span>
                <span style={{ color: 'var(--color-outline)', fontSize: 11 }}>{member.userId}</span>
              </button>
            ))}
          </div>
        )}

        {/* Emoji autocomplete dropdown */}
        {emojiQuery !== null && emojiResults.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            background: 'var(--color-surface-container-high)',
            borderRadius: 16,
            boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
            padding: 4,
            marginBottom: 4,
            maxHeight: 320,
            overflowY: 'auto',
            zIndex: 100,
          }}>
            {emojiResults.map((entry, i) => (
              <button
                key={entry.shortcode}
                onMouseDown={(e) => { e.preventDefault(); insertEmoji(entry); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '8px 12px',
                  border: 'none',
                  borderRadius: 12,
                  background: i === emojiIndex ? 'var(--color-secondary-container)' : 'transparent',
                  color: 'var(--color-on-surface)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 20 }}>{entry.emoji}</span>
                <span>:{entry.shortcode}:</span>
              </button>
            ))}
          </div>
        )}

        <FilePreview />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, padding: '6px 8px 6px 4px' }}>
          {!editingMessage && <AttachButton />}
          {!editingMessage && (
            <div ref={emojiPickerRef} style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setShowEmojiPicker((v) => !v); setEmojiPickerSearch(""); setEmojiPickerGroup(0); }}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  padding: 8,
                  display: 'flex',
                  flexShrink: 0,
                  borderRadius: '50%',
                  background: showEmojiPicker ? 'var(--color-secondary-container)' : 'transparent',
                  color: showEmojiPicker ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => { if (!showEmojiPicker) e.currentTarget.style.background = 'var(--color-surface-container)'; }}
                onMouseLeave={(e) => { if (!showEmojiPicker) e.currentTarget.style.background = 'transparent'; }}
                title="Emoji"
              >
                <EmojiIcon />
              </button>

              {/* Emoji/GIF picker panel */}
              {showEmojiPicker && (
                <div
                  style={{
                    position: isMobile ? 'fixed' : 'absolute',
                    bottom: isMobile ? `${VOICE_BAR_HEIGHT + 60}px` : '100%',
                    left: isMobile ? 0 : 0,
                    right: isMobile ? 0 : undefined,
                    marginBottom: isMobile ? 0 : 4,
                    width: isMobile ? 'auto' : 352,
                    height: isMobile ? '45dvh' : 400,
                    background: 'var(--color-surface-container)',
                    borderRadius: 16,
                    boxShadow: '0 -4px 24px rgba(0,0,0,0.3)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    zIndex: 200,
                  }}
                >
                  {/* Tab bar: Emoji | GIF */}
                  <div style={{ display: 'flex', borderBottom: '1px solid var(--color-outline-variant)' }}>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); setPickerTab("emoji"); }}
                      style={{
                        flex: 1, padding: '10px 0', border: 'none', background: 'transparent',
                        fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                        color: pickerTab === "emoji" ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                        borderBottom: pickerTab === "emoji" ? '2px solid var(--color-primary)' : '2px solid transparent',
                      }}
                    >Emoji</button>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); setPickerTab("gif"); }}
                      style={{
                        flex: 1, padding: '10px 0', border: 'none', background: 'transparent',
                        fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                        color: pickerTab === "gif" ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                        borderBottom: pickerTab === "gif" ? '2px solid var(--color-primary)' : '2px solid transparent',
                      }}
                    >GIF</button>
                  </div>

                  {/* === EMOJI TAB === */}
                  {pickerTab === "emoji" && (<>
                    <div style={{ padding: '10px 10px 6px 10px' }}>
                      <input
                        value={emojiPickerSearch}
                        onChange={(e) => setEmojiPickerSearch(e.target.value)}
                        placeholder={t("chat.searchEmoji")}
                        autoFocus={!isMobile}
                        style={{
                          width: '100%', padding: '8px 12px', borderRadius: 12,
                          border: '1px solid var(--color-outline-variant)',
                          background: 'var(--color-surface-container-high)',
                          color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit',
                          outline: 'none', boxSizing: 'border-box',
                        }}
                      />
                    </div>

                    {emojiPickerSearch.length < 2 && recentEmojis.length > 0 && (
                      <div style={{
                        display: 'flex', flexWrap: 'nowrap', gap: 2, padding: '4px 8px 6px 8px',
                        overflowX: 'auto', borderBottom: '1px solid var(--color-outline-variant)',
                      }}>
                        {recentEmojis.map((emoji, i) => (
                          <button
                            key={`recent-${i}`}
                            onMouseDown={(e) => { e.preventDefault(); pickEmoji(emoji); }}
                            title={t("chat.recentEmojis", { defaultValue: "Récemment utilisés" })}
                            style={{
                              width: 32, height: 32, flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 20, border: 'none', borderRadius: 6,
                              background: 'transparent', cursor: 'pointer',
                              transition: 'background 100ms', padding: 0,
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >{emoji}</button>
                        ))}
                      </div>
                    )}

                    {emojiPickerSearch.length < 2 && (
                      <div style={{ display: 'flex', gap: 0, padding: '0 6px', borderBottom: '1px solid var(--color-outline-variant)' }}>
                        {EMOJI_GROUPS.map((g) => (
                          <button key={g.id} onMouseDown={(e) => { e.preventDefault(); setEmojiPickerGroup(g.id); }} title={g.label}
                            style={{ flex: 1, padding: '6px 0', border: 'none', background: 'transparent', fontSize: 16, cursor: 'pointer',
                              borderBottom: emojiPickerGroup === g.id ? '2px solid var(--color-primary)' : '2px solid transparent',
                              opacity: emojiPickerGroup === g.id ? 1 : 0.5, transition: 'all 150ms',
                            }}
                          >{g.icon}</button>
                        ))}
                      </div>
                    )}

                    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px 8px', display: 'flex', flexWrap: 'wrap', gap: 2, alignContent: 'flex-start' }}>
                      {filteredPickerEmojis.map((entry) => (
                        <button key={entry.shortcode} onMouseDown={(e) => { e.preventDefault(); pickEmoji(entry.emoji); }} title={`:${entry.shortcode}:`}
                          style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                            border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', transition: 'background 100ms', padding: 0,
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >{entry.emoji}</button>
                      ))}
                    </div>
                  </>)}

                  {/* === GIF TAB === */}
                  {pickerTab === "gif" && (<>
                    {!enableGifs ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
                        <div>
                          <div style={{ fontSize: 32, marginBottom: 8 }}>🚫</div>
                          <div style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
                            {t("chat.gifDisabled")}
                          </div>
                        </div>
                      </div>
                    ) : (<>
                      <div style={{ padding: '10px 10px 6px 10px' }}>
                        <input
                          value={gifSearch}
                          onChange={(e) => setGifSearch(e.target.value)}
                          placeholder={t("chat.searchGif")}
                          autoFocus={!isMobile}
                          style={{
                            width: '100%', padding: '8px 12px', borderRadius: 12,
                            border: '1px solid var(--color-outline-variant)',
                            background: 'var(--color-surface-container-high)',
                            color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit',
                            outline: 'none', boxSizing: 'border-box',
                          }}
                        />
                      </div>

                      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px 8px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, alignContent: 'flex-start', gridAutoRows: 100 }}>
                        {gifLoading && (
                          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 20, color: 'var(--color-on-surface-variant)', fontSize: 13 }}>
                            {t("chat.loading")}
                          </div>
                        )}
                        {!gifLoading && gifResults.map((gif) => (
                          <button
                            key={gif.id}
                            onMouseDown={(e) => { e.preventDefault(); sendGif(gif.url); }}
                            style={{
                              border: 'none', padding: 0, borderRadius: 8, overflow: 'hidden',
                              cursor: 'pointer', background: 'var(--color-surface-container-high)',
                              transition: 'opacity 150ms', width: '100%', height: '100%',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                          >
                            <img src={gif.preview} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: 8 }} />
                          </button>
                        ))}
                      </div>

                      <div style={{ padding: '4px 10px 6px', fontSize: 9, color: 'var(--color-outline)', textAlign: 'right' }}>
                        Powered by Tenor
                      </div>
                    </>)}
                  </>)}
                </div>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={t("chat.placeholder", { channel: channelName })}
            rows={1}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--color-on-surface)',
              fontSize: 14,
              fontFamily: 'inherit',
              resize: 'none' as const,
              lineHeight: 1.5,
              maxHeight: 120,
              padding: '8px 4px',
              letterSpacing: '0.01em',
            }}
          />
          {/* M3 FAB-style send */}
          <button
            type="button"
            onClick={handleSend}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: 10,
              display: 'flex',
              flexShrink: 0,
              borderRadius: '50%',
              transition: 'all 200ms',
              background: hasContent ? 'var(--color-primary)' : 'transparent',
              color: hasContent ? 'var(--color-on-primary)' : 'var(--color-outline)',
              opacity: hasContent ? 1 : 0.4,
            }}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
