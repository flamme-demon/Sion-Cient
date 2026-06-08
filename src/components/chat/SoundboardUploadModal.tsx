import { useState, useRef, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  uploadSound,
  editSound,
  playSoundLocal,
  previewSoundFile,
  SOUND_GAIN_MIN,
  SOUND_GAIN_MAX,
  SOUND_GAIN_DEFAULT,
  type SoundEntry,
} from "../../services/soundboardService";
import { EMOJI_DATA, EMOJI_GROUPS, EMOJI_BY_GROUP } from "../../utils/emojiData";
import { AudioTrimmer } from "./AudioTrimmer";
import { trimToClip } from "../../services/audioTrim";

// Soundboard sounds are capped at 20s; the trimmer cuts longer files down to a
// chosen ≤20s window + re-encodes to opus, so the input file can be large even
// though the uploaded clip must stay under `maxSize`. Cap the input only to
// avoid decoding absurdly large files into memory.
const MAX_INPUT_SIZE = 30 * 1024 * 1024; // 30 MB
const MAX_CLIP_SEC = 20;

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
  const [gain, setGain] = useState<number>(editing?.gain ?? SOUND_GAIN_DEFAULT);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState("");
  const [emojiGroup, setEmojiGroup] = useState<number>(EMOJI_GROUPS[0].id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Current trim selection + decoded buffer, reported by <AudioTrimmer>.
  const regionRef = useRef<{ start: number; end: number; buffer: AudioBuffer } | null>(null);

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
    // The input can be larger than the upload cap — we trim + re-encode below.
    // Only reject truly huge files to protect decodeAudioData's memory use.
    if (f.size > MAX_INPUT_SIZE) {
      setError(`Fichier trop lourd (max ${Math.round(MAX_INPUT_SIZE / 1024 / 1024)} MB)`);
      return;
    }
    regionRef.current = null;
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
        await editSound(editing, label.trim(), category.trim() || "Autre", emoji.trim() || null, gain);
      } else if (file) {
        let toUpload = file;
        const r = regionRef.current;
        if (r) {
          // Trim+re-encode unless the file is already a small, full-length
          // ≤20s clip (then keep the original to preserve its quality/format).
          const isFullFile = r.start <= 0.05 && Math.abs(r.end - r.buffer.duration) < 0.05;
          const needsTrim = !isFullFile || r.buffer.duration > MAX_CLIP_SEC + 0.05 || file.size > maxSize;
          if (needsTrim) {
            const end = Math.min(r.end, r.start + MAX_CLIP_SEC);
            toUpload = await trimToClip(r.buffer, r.start, end, file.name);
          }
        }
        await uploadSound(toUpload, label.trim(), category.trim() || "Autre", emoji.trim() || null, gain);
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
            {file && (
              <AudioTrimmer
                key={`${file.name}:${file.size}:${file.lastModified}`}
                file={file}
                maxSec={MAX_CLIP_SEC}
                onChange={(start, end, buffer) => { regionRef.current = { start, end, buffer }; }}
              />
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

        <label style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t("soundboard.gain.label")}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-on-surface)' }}>
            {Math.round(gain * 100)}%
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={SOUND_GAIN_MIN}
            max={SOUND_GAIN_MAX}
            step={0.05}
            value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--color-primary)' }}
          />
          <button
            type="button"
            disabled={previewBusy || (!editing && !file)}
            onClick={async () => {
              if (previewBusy) return;
              setPreviewBusy(true);
              try {
                if (editing) {
                  await playSoundLocal(editing.mxcUrl, gain);
                } else if (file) {
                  await previewSoundFile(file, gain);
                }
              } catch (err) {
                console.warn("[Sion] preview failed:", err);
              } finally {
                // Re-enable quickly — playback is non-blocking; the button
                // mostly debounces accidental rapid clicks.
                setTimeout(() => setPreviewBusy(false), 200);
              }
            }}
            title={t("soundboard.gain.test")}
            style={{
              padding: '6px 12px',
              borderRadius: 12,
              border: 'none',
              cursor: (previewBusy || (!editing && !file)) ? 'not-allowed' : 'pointer',
              background: 'var(--color-surface-container-high)',
              color: 'var(--color-on-surface)',
              fontSize: 12,
              fontFamily: 'inherit',
              opacity: (previewBusy || (!editing && !file)) ? 0.5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            ▶ {t("soundboard.gain.test")}
          </button>
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
