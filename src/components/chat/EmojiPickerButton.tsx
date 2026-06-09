import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmojiIcon } from "../icons";
import { EmojiGridPanel } from "./EmojiGridPanel";

interface Props {
  /** The input/textarea the emoji is inserted into (at the caret). */
  targetRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}

/** Emoji button + popover that inserts at the caret of a target field.
 *  Wraps the shared {@link EmojiGridPanel}. */
export function EmojiPickerButton({ targetRef, value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const insert = (emoji: string) => {
    const el = targetRef.current;
    const pos = el && el.selectionStart != null ? el.selectionStart : value.length;
    const next = value.slice(0, pos) + emoji + value.slice(pos);
    onChange(next);
    setTimeout(() => {
      if (!el) return;
      el.focus();
      const caret = pos + emoji.length;
      el.selectionStart = el.selectionEnd = caret;
    });
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={t("chat.react")}
        style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 6 }}>
        <EmojiIcon />
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 6, zIndex: 1100,
          width: 280, height: 320, display: 'flex', flexDirection: 'column',
          background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)',
          borderRadius: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}>
          <EmojiGridPanel onPick={insert} emojiSize={32} />
        </div>
      )}
    </div>
  );
}
