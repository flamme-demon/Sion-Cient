import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as matrixService from "../../services/matrixService";
import { EmojiPickerButton } from "./EmojiPickerButton";

interface Props {
  roomId: string;
  onClose: () => void;
}

const MAX_OPTIONS = 12;

/** Telegram-style poll creation: a question + 2–12 options, optional
 *  multiple-answers. Sends an MSC3381 m.poll.start. */
export function PollCreateModal({ roomId, onClose }: Props) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [duration, setDuration] = useState<string>(""); // "" = none, "custom", or ms preset
  const [customEnd, setCustomEnd] = useState<string>(""); // datetime-local value
  const [busy, setBusy] = useState(false);
  const questionRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLInputElement | null)[]>([]);

  const PRESETS: { value: string; label: string }[] = [
    { value: "", label: t("poll.autoEndNone") },
    { value: String(60 * 60 * 1000), label: t("poll.duration1h") },
    { value: String(6 * 60 * 60 * 1000), label: t("poll.duration6h") },
    { value: String(24 * 60 * 60 * 1000), label: t("poll.duration24h") },
    { value: String(3 * 24 * 60 * 60 * 1000), label: t("poll.duration3d") },
    { value: String(7 * 24 * 60 * 60 * 1000), label: t("poll.duration7d") },
    { value: "custom", label: t("poll.autoEndCustom") },
  ];

  const computeEndsTs = (): number | undefined => {
    if (!duration) return undefined;
    if (duration === "custom") {
      const ts = customEnd ? new Date(customEnd).getTime() : NaN;
      return Number.isFinite(ts) && ts > Date.now() ? ts : undefined;
    }
    return Date.now() + Number(duration);
  };

  const setOption = (i: number, v: string) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  const addOption = () => setOptions((o) => (o.length < MAX_OPTIONS ? [...o, ""] : o));
  const removeOption = (i: number) => setOptions((o) => (o.length > 2 ? o.filter((_, j) => j !== i) : o));

  const clean = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && clean.length >= 2;

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await matrixService.createPoll(roomId, question.trim(), clean, "disclosed", multiple ? clean.length : 1, computeEndsTs());
      onClose();
    } catch (e) {
      console.warn("[Sion] createPoll failed:", e);
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 10, boxSizing: 'border-box',
    border: '1px solid var(--color-outline)', background: 'var(--color-surface-container-high)',
    color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit',
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-container-high)', borderRadius: 16, padding: 20, width: 420, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>{t("poll.create")}</div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            ref={questionRef} autoFocus value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("poll.questionPlaceholder")} style={{ ...inputStyle, flex: 1 }}
          />
          <EmojiPickerButton targetRef={questionRef} value={question} onChange={setQuestion} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={(el) => { optionRefs.current[i] = el; }}
                value={opt} onChange={(e) => setOption(i, e.target.value)}
                placeholder={`${t("poll.option")} ${i + 1}`} style={{ ...inputStyle, flex: 1 }}
                onKeyDown={(e) => { if (e.key === "Enter" && i === options.length - 1 && opt.trim()) addOption(); }}
              />
              <EmojiPickerButton targetRef={{ get current() { return optionRefs.current[i]; } }} value={opt} onChange={(v) => setOption(i, v)} />
              {options.length > 2 && (
                <button type="button" onClick={() => removeOption(i)} title={t("poll.removeOption")}
                  style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 16, padding: '0 6px' }}>×</button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button type="button" onClick={addOption}
              style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', padding: '2px 0' }}>
              + {t("poll.addOption")}
            </button>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-on-surface)', cursor: 'pointer' }}>
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} style={{ accentColor: 'var(--color-primary)' }} />
          {t("poll.multiple")}
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-on-surface)' }}>
          <span style={{ flexShrink: 0 }}>{t("poll.autoEnd")}</span>
          <select value={duration} onChange={(e) => setDuration(e.target.value)} style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}>
            {PRESETS.map((p) => (
              <option key={p.value || "none"} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        {duration === "custom" && (
          <input type="datetime-local" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={inputStyle} />
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}
            style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)' }}>
            {t("poll.cancel")}
          </button>
          <button type="button" onClick={create} disabled={!valid || busy}
            style={{ padding: '8px 16px', borderRadius: 10, border: 'none', cursor: valid && !busy ? 'pointer' : 'default', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: 'var(--color-primary)', color: 'var(--color-on-primary)', opacity: valid && !busy ? 1 : 0.5 }}>
            {t("poll.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
