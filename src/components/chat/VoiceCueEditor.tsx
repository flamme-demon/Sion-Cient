import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioTrimmer } from "./AudioTrimmer";
import type { VoiceSoundCfg } from "../../stores/useSettingsStore";

const MAX_CUE_SEC = 5;

interface Props {
  /** The picked file (built from the chosen path's bytes). */
  file: File;
  /** Absolute path of the picked file (stored in the cfg, read at play time). */
  path: string;
  title: string;
  initial?: VoiceSoundCfg | null;
  onSave: (cfg: VoiceSoundCfg) => void;
  onClose: () => void;
}

/**
 * Editor shown after picking a custom voice-channel cue sound: trim the
 * duration (waveform + draggable region, like the soundboard) and set the
 * playback volume (Web Audio gain), with a preview. Saves {path, start, end,
 * gain}; the cue is played from the trimmed region at that gain at runtime.
 */
export function VoiceCueEditor({ file, path, title, initial, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [gain, setGain] = useState<number>(initial?.gain ?? 1);
  const regionRef = useRef<{ start: number; end: number; buffer: AudioBuffer } | null>(null);

  const save = () => {
    const r = regionRef.current;
    if (r) onSave({ path, start: r.start, end: r.end, gain: Math.max(0, gain) });
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--color-surface-container-high)', borderRadius: 16, padding: 20, width: 460, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("settings.cueEditorHint")}</div>

        <AudioTrimmer
          file={file}
          maxSec={MAX_CUE_SEC}
          gain={gain}
          onChange={(start, end, buffer) => { regionRef.current = { start, end, buffer }; }}
        />

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-on-surface)' }}>
            <span>{t("settings.cueVolume")}</span>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{Math.round(gain * 100)}%</span>
          </div>
          <input
            type="range" min={0} max={3} step={0.05} value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button" onClick={onClose}
            style={{ padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)' }}
          >
            {t("settings.cueCancel")}
          </button>
          <button
            type="button" onClick={save}
            style={{ padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}
          >
            {t("settings.cueSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
