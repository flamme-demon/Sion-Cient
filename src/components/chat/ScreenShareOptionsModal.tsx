import { useEffect, useState } from "react";
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

interface MonitorInfo {
  name: string | null;
  size: { width: number; height: number };
  position: { x: number; y: number };
}

// Windows/CEF can't use the Chrome desktop source picker (it crashes), so we
// list the monitors ourselves and capture the chosen one via
// `chromeMediaSourceId: "screen:N:0"`. Linux uses the xdg portal picker and
// macOS the native getDisplayMedia picker — the selector is hidden there.
const isWindowsTauri =
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes("Windows") &&
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in window;

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
  const cursorOverlay = useSettingsStore((s) => s.screenShareCursorOverlay);
  const setResolution = useSettingsStore((s) => s.setScreenShareResolution);
  const setFramerate = useSettingsStore((s) => s.setScreenShareFramerate);
  const setAudio = useSettingsStore((s) => s.setScreenShareAudio);
  const setCursorOverlay = useSettingsStore((s) => s.setScreenShareCursorOverlay);
  const sourceId = useSettingsStore((s) => s.screenShareSourceId) ?? "screen:0:0";
  const setSourceId = useSettingsStore((s) => s.setScreenShareSourceId);

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    if (!isWindowsTauri) return;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ availableMonitors }) => availableMonitors())
      .then((list) => {
        if (cancelled) return;
        setMonitors(list as unknown as MonitorInfo[]);
        // First time (no saved choice): default to the primary screen.
        if (useSettingsStore.getState().screenShareSourceId == null) {
          setSourceId("screen:0:0");
        }
      })
      .catch((e) => console.warn("[Sion][Share] availableMonitors failed:", e));
    return () => { cancelled = true; };
  }, [setSourceId]);

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

        {isWindowsTauri && monitors.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', marginBottom: 6 }}>
              {t("screenShare.monitor", { defaultValue: "Écran à partager" })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {monitors.map((m, i) => {
                const id = `screen:${i}:0`;
                const selected = sourceId === id;
                const isPrimary = m.position.x === 0 && m.position.y === 0;
                return (
                  <button
                    key={id}
                    onClick={() => setSourceId(id)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      padding: '8px 12px',
                      borderRadius: 10,
                      border: selected ? '2px solid var(--color-primary)' : '2px solid transparent',
                      background: selected ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)',
                      color: selected ? 'var(--color-on-primary-container)' : 'var(--color-on-surface)',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span>
                      {t("screenShare.monitorN", { defaultValue: "Écran {{n}}", n: i + 1 })}
                      {isPrimary && (
                        <span style={{ fontWeight: 400, color: 'var(--color-outline)' }}>
                          {" · " + t("screenShare.monitorPrimary", { defaultValue: "principal" })}
                        </span>
                      )}
                    </span>
                    <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                      {m.size.width}×{m.size.height}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 6, lineHeight: 1.4 }}>
              {t("screenShare.monitorHint", { defaultValue: "Le partage de fenêtre unique n'est pas disponible sur Windows — choisis un écran entier." })}
            </div>
          </div>
        )}

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
            checked={cursorOverlay}
            onChange={(e) => setCursorOverlay(e.target.checked)}
          />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span>{t("screenShare.cursorOverlay", { defaultValue: "Voir les curseurs des viewers" })}</span>
            <span style={{ fontSize: 11, color: 'var(--color-outline)' }}>
              {t("screenShare.cursorOverlayDesc", { defaultValue: "Affiche les curseurs/clics des viewers sur ton écran. Activable même en cours de partage." })}
            </span>
          </div>
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
