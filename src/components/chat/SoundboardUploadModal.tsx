import { useState, useRef, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { uploadSound, editSound, type SoundEntry } from "../../services/soundboardService";
import { EMOJI_DATA, EMOJI_GROUPS, EMOJI_BY_GROUP } from "../../utils/emojiData";

interface Props {
  existingCategories: string[];
  maxSize: number;
  onClose: () => void;
  onUploaded: () => void;
  /** If provided, the modal acts as an editor for this existing sound. */
  editing?: SoundEntry | null;
}

export function SoundboardUploadModal({ existingCategories, maxSize, onClose, onUploaded, editing = null }: Props) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState(editing?.label || "");
  const [category, setCategory] = useState(editing?.category || "");
  const [emoji, setEmoji] = useState(editing?.emoji || "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState("");
  const [emojiGroup, setEmojiGroup] = useState<number>(EMOJI_GROUPS[0].id);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke the preview blob URL when the modal unmounts — leaving it alive
  // holds the File in memory until GC, which never runs on inactive tabs.
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  const emojiResults = useMemo(() => {
    const q = emojiSearch.trim().toLowerCase();
    if (q) {
      return EMOJI_DATA.filter((e) => e.shortcode.includes(q)).slice(0, 200);
    }
    return EMOJI_BY_GROUP.get(emojiGroup) || [];
  }, [emojiSearch, emojiGroup]);

  const handleFile = (f: File) => {
    setError(null);
    if (!f.type.startsWith("audio/")) {
      setError(t("soundboard.errorNotAudio"));
      return;
    }
    if (f.size > maxSize) {
      setError(t("soundboard.errorTooBig", { max: Math.round(maxSize / 1024) }));
      return;
    }
    setFile(f);
    if (!label) setLabel(f.name.replace(/\.[^.]+$/, "").slice(0, 60));
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const handleSubmit = async () => {
    if (!label.trim() || busy) return;
    if (!editing && !file) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await editSound(editing, label.trim(), category.trim() || "Autre", emoji.trim() || null);
      } else if (file) {
        await uploadSound(file, label.trim(), category.trim() || "Autre", emoji.trim() || null);
      }
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      // Backdrop is non-dismissive: users have complained that the upload
      // / edit dialog vanished the moment they clicked slightly outside —
      // especially disruptive when dragging a file, selecting text in the
      // category field, or interacting with native file pickers that fire
      // click events on their dismiss. The close button inside the modal
      // stays available for intentional cancellation.
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400,
          maxWidth: '92%',
          background: 'var(--color-surface-container)',
          borderRadius: 20,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {editing ? t("soundboard.editTitle") : t("soundboard.uploadTitle")}
        </div>

        {!editing && (
          <>
            <div
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: 16,
                borderRadius: 12,
                border: '2px dashed var(--color-outline-variant)',
                textAlign: 'center',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--color-on-surface-variant)',
                background: 'var(--color-surface-container-high)',
              }}
            >
              {file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : t("soundboard.dropHint", { max: Math.round(maxSize / 1024) })}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {previewUrl && (
              <audio controls src={previewUrl} style={{ width: '100%', height: 32 }} />
            )}
          </>
        )}

        <label style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
          {t("soundboard.label")}
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("soundboard.labelPlaceholder")}
          maxLength={60}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid var(--color-outline-variant)',
            background: 'var(--color-surface-container-high)',
            color: 'var(--color-on-surface)',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />

        <label style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
          {t("soundboard.category")}
        </label>
        <input
          list="soundboard-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={t("soundboard.categoryPlaceholder")}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid var(--color-outline-variant)',
            background: 'var(--color-surface-container-high)',
            color: 'var(--color-on-surface)',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <datalist id="soundboard-categories">
          {existingCategories.map((c) => <option key={c} value={c} />)}
        </datalist>

        <label style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
          {t("soundboard.emoji")}
        </label>
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => setShowEmojiPicker((v) => !v)}
              style={{
                width: 44, height: 44,
                borderRadius: 10,
                border: '1px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 22,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {emoji || "🔊"}
            </button>
            {emoji && (
              <button
                type="button"
                onClick={() => setEmoji("")}
                style={{
                  padding: '4px 10px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--color-surface-container-high)',
                  color: 'var(--color-on-surface-variant)',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >{t("auth.cancel")}</button>
            )}
          </div>

          {showEmojiPicker && (
            <div style={{
              position: 'absolute',
              top: 52,
              left: 0,
              right: 0,
              maxHeight: 280,
              background: 'var(--color-surface-container-high)',
              border: '1px solid var(--color-outline-variant)',
              borderRadius: 12,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}>
              <input
                autoFocus
                value={emojiSearch}
                onChange={(e) => setEmojiSearch(e.target.value)}
                placeholder={t("chat.searchEmoji")}
                style={{
                  margin: 6,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-outline-variant)',
                  background: 'var(--color-surface-container)',
                  color: 'var(--color-on-surface)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
              />
              {!emojiSearch && (
                <div style={{ display: 'flex', gap: 2, padding: '0 6px 6px', flexWrap: 'wrap' }}>
                  {EMOJI_GROUPS.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setEmojiGroup(g.id)}
                      title={g.label}
                      style={{
                        width: 28, height: 28,
                        borderRadius: 6,
                        border: 'none',
                        background: emojiGroup === g.id ? 'var(--color-primary-container)' : 'transparent',
                        fontSize: 16,
                        cursor: 'pointer',
                      }}
                    >{g.icon}</button>
                  ))}
                </div>
              )}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0 6px 6px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(32px, 1fr))',
                gap: 2,
              }}>
                {emojiResults.map((e, i) => (
                  <button
                    key={`${e.shortcode}-${i}`}
                    type="button"
                    onClick={() => { setEmoji(e.emoji); setShowEmojiPicker(false); setEmojiSearch(""); }}
                    title={`:${e.shortcode}:`}
                    style={{
                      width: 32, height: 32,
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      fontSize: 20,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--color-surface-container)'; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                  >{e.emoji}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--color-error)', background: 'var(--color-error-container)', padding: '6px 10px', borderRadius: 8 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: 16,
              border: 'none',
              cursor: 'pointer',
              background: 'var(--color-surface-container-high)',
              color: 'var(--color-on-surface)',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          >{t("auth.cancel")}</button>
          <button
            onClick={handleSubmit}
            disabled={(!editing && !file) || !label.trim() || busy}
            style={{
              padding: '8px 16px',
              borderRadius: 16,
              border: 'none',
              cursor: ((!editing && !file) || !label.trim() || busy) ? 'not-allowed' : 'pointer',
              background: 'var(--color-primary)',
              color: 'var(--color-on-primary)',
              fontSize: 13,
              fontFamily: 'inherit',
              fontWeight: 600,
              opacity: ((!editing && !file) || !label.trim() || busy) ? 0.5 : 1,
            }}
          >{busy ? '…' : editing ? t("soundboard.editBtn") : t("soundboard.uploadBtn")}</button>
        </div>
      </div>
    </div>
  );
}
