import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/useSettingsStore";

interface Props {
  onConfirm: () => void;
  onClose: () => void;
  /** When true, the button label becomes "Apply" instead of "Start sharing" */
  editing?: boolean;
}

type Resolution = "720p" | "1080p" | "1440p";
type Framerate = 5 | 15 | 30 | 60;

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "1440p", label: "1440p" },
];

const FRAMERATES: { value: Framerate; label: string }[] = [
  { value: 5, label: "5 fps" },
  { value: 15, label: "15 fps" },
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
];

export function ScreenShareOptionsModal({ onConfirm, onClose, editing = false }: Props) {
  const { t } = useTranslation();
  const resolution = useSettingsStore((s) => s.screenShareResolution);
  const framerate = useSettingsStore((s) => s.screenShareFramerate);
  const audio = useSettingsStore((s) => s.screenShareAudio);
  const setResolution = useSettingsStore((s) => s.setScreenShareResolution);
  const setFramerate = useSettingsStore((s) => s.setScreenShareFramerate);
  const setAudio = useSettingsStore((s) => s.setScreenShareAudio);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, maxWidth: '92%',
          background: 'var(--color-surface-container)',
          borderRadius: 20, padding: 24,
          display: 'flex', flexDirection: 'column', gap: 14,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t("screenShare.title")}
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 6 }}>
            {t("screenShare.resolution")}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {RESOLUTIONS.map((r) => (
              <button
                key={r.value}
                onClick={() => setResolution(r.value)}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 10,
                  border: 'none',
                  background: resolution === r.value ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: resolution === r.value ? 'var(--color-on-primary)' : 'var(--color-on-surface)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >{r.label}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 6 }}>
            {t("screenShare.framerate")}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {FRAMERATES.map((f) => (
              <button
                key={f.value}
                onClick={() => setFramerate(f.value)}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 10,
                  border: 'none',
                  background: framerate === f.value ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                  color: framerate === f.value ? 'var(--color-on-primary)' : 'var(--color-on-surface)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >{f.label}</button>
            ))}
          </div>
        </div>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px',
          background: 'var(--color-surface-container-high)',
          borderRadius: 10,
          cursor: 'pointer',
          fontSize: 13,
          color: 'var(--color-on-surface)',
        }}>
          <input
            type="checkbox"
            checked={audio}
            onChange={(e) => setAudio(e.target.checked)}
          />
          {t("screenShare.audio")}
        </label>

        <div style={{ fontSize: 11, color: 'var(--color-outline)', lineHeight: 1.4 }}>
          {t("screenShare.hint")}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
              background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
              fontSize: 13, fontFamily: 'inherit',
            }}
          >{t("auth.cancel")}</button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
              background: 'var(--color-primary)', color: 'var(--color-on-primary)',
              fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
            }}
          >{editing ? t("screenShare.apply") : t("screenShare.start")}</button>
        </div>
      </div>
    </div>
  );
}
