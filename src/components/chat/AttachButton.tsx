import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaperclipIcon, FileIcon, PollIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";
import { PollCreateModal } from "./PollCreateModal";
import { ExternalVideoImport } from "./ExternalVideoImport";

export function AttachButton() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const addPendingFile = useAppStore((s) => s.addPendingFile);
  const activeChannel = useAppStore((s) => s.activeChannel);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [showVideoImport, setShowVideoImport] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) addPendingFile(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8,
    padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--color-on-surface)',
  };

  return (
    <div
      style={{ position: 'relative', display: 'flex' }}
      onMouseEnter={() => setMenuOpen(true)}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 10, display: 'flex', borderRadius: '50%', color: 'var(--color-on-surface-variant)', transition: 'background 200ms' }}
        title={t("chat.attachFile")}
      >
        <PaperclipIcon />
      </button>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={handleChange} />

      {menuOpen && (
        // paddingBottom acts as an invisible bridge so the cursor can travel from
        // the paperclip into the menu without crossing a gap that closes it.
        <div style={{ position: 'absolute', bottom: '100%', left: 0, paddingBottom: 8, zIndex: 51 }}>
          <div style={{ background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)', borderRadius: 12, padding: 6, minWidth: 190, boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}>
            <button type="button" style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { setMenuOpen(false); inputRef.current?.click(); }}>
              <FileIcon /> {t("chat.attachFileItem")}
            </button>
            <button type="button" style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { setMenuOpen(false); setShowVideoImport(true); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg> {t("extVideo.menuItem")}
            </button>
            <button type="button" style={itemStyle} disabled={!activeChannel}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-highest)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { setMenuOpen(false); setShowPoll(true); }}>
              <PollIcon /> {t("poll.menuItem")}
            </button>
          </div>
        </div>
      )}

      {showPoll && activeChannel && <PollCreateModal roomId={activeChannel} onClose={() => setShowPoll(false)} />}
      {showVideoImport && (
        <ExternalVideoImport
          onClose={() => setShowVideoImport(false)}
          onImported={(file) => { addPendingFile(file); setShowVideoImport(false); }}
        />
      )}
    </div>
  );
}
