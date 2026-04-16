import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { keyEventToString } from "../../hooks/useKeyboardShortcuts";
import { findConflict, setHotkey, validateCombo, normalizeManualCombo } from "../../services/soundboardHotkeys";

interface Props {
  eventId: string;
  label: string;
  currentCombo: string | null;
  onClose: () => void;
}

export function HotkeyCaptureModal({ eventId, label, currentCombo, onClose }: Props) {
  const { t } = useTranslation();
  const muteShortcut = useSettingsStore((s) => s.muteShortcut);
  const deafenShortcut = useSettingsStore((s) => s.deafenShortcut);
  const [capturing, setCapturing] = useState(true);
  const [captured, setCaptured] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Skip pure modifier presses
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") { onClose(); return; }
      const combo = keyEventToString(e);
      const invalid = validateCombo(combo, muteShortcut, deafenShortcut);
      if (invalid) {
        setError(invalid);
        return;
      }
      const conflict = findConflict(combo, eventId);
      if (conflict) {
        setError(t("hotkey.conflict"));
        setConflictId(conflict);
      } else {
        setError(null);
        setConflictId(null);
      }
      setCaptured(combo);
      setCapturing(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, eventId, muteShortcut, deafenShortcut, onClose, t]);

  const handleAssign = () => {
    if (!captured || error) return;
    setHotkey(eventId, captured);
    onClose();
  };

  const handleManualAssign = () => {
    const normalized = normalizeManualCombo(manualInput);
    if (!normalized) {
      setError(t("hotkey.manualInvalid"));
      return;
    }
    const invalid = validateCombo(normalized, muteShortcut, deafenShortcut);
    if (invalid) {
      setError(invalid);
      return;
    }
    const conflict = findConflict(normalized, eventId);
    if (conflict) {
      setError(t("hotkey.conflict"));
      return;
    }
    setHotkey(eventId, normalized);
    onClose();
  };

  const handleClear = () => {
    setHotkey(eventId, null);
    onClose();
  };

  const handleRetry = () => {
    setCaptured(null);
    setError(null);
    setConflictId(null);
    setCapturing(true);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10001,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, maxWidth: '92%',
          background: 'var(--color-surface-container)',
          borderRadius: 20, padding: 24,
          display: 'flex', flexDirection: 'column', gap: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t("hotkey.title", { label })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
          {capturing ? t("hotkey.pressKey") : t("hotkey.captured", { combo: captured || "" })}
        </div>
        {currentCombo && capturing && (
          <div style={{ fontSize: 11, color: 'var(--color-outline)' }}>
            {t("hotkey.currentBinding", { combo: currentCombo })}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: 'var(--color-error)', background: 'var(--color-error-container)', padding: '6px 10px', borderRadius: 8 }}>
            {error}{conflictId && ` (event ${conflictId.slice(0, 12)}…)`}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', marginBottom: 4 }}>
            {t("hotkey.manualTitle")}
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-outline)', marginBottom: 6 }}>
            {t("hotkey.manualHint")}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={manualInput}
              onChange={(e) => { setManualInput(e.target.value); setError(null); }}
              placeholder="Ctrl+F1"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleManualAssign(); } }}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--color-outline-variant)',
                background: 'var(--color-surface-container-high)',
                color: 'var(--color-on-surface)',
                fontSize: 12,
                fontFamily: 'monospace',
                outline: 'none',
              }}
            />
            <button
              onClick={handleManualAssign}
              disabled={!manualInput.trim()}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: 'none',
                cursor: manualInput.trim() ? 'pointer' : 'not-allowed',
                background: 'var(--color-primary)',
                color: 'var(--color-on-primary)',
                fontSize: 11,
                fontFamily: 'inherit',
                fontWeight: 600,
                opacity: manualInput.trim() ? 1 : 0.5,
              }}
            >{t("hotkey.manualAssign")}</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          {currentCombo ? (
            <button
              onClick={handleClear}
              style={{
                padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                background: 'var(--color-error-container)', color: 'var(--color-error)',
                fontSize: 13, fontFamily: 'inherit',
              }}
            >{t("hotkey.clear")}</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
                fontSize: 13, fontFamily: 'inherit',
              }}
            >{t("auth.cancel")}</button>
            {!capturing && (
              <button
                onClick={handleRetry}
                style={{
                  padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                  background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)',
                  fontSize: 13, fontFamily: 'inherit',
                }}
              >{t("hotkey.retry")}</button>
            )}
            {!capturing && !error && (
              <button
                onClick={handleAssign}
                style={{
                  padding: '8px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                  background: 'var(--color-primary)', color: 'var(--color-on-primary)',
                  fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
                }}
              >{t("hotkey.assign")}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
