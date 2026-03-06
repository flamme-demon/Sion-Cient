import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { PaperclipIcon } from "../icons";
import { useAppStore } from "../../stores/useAppStore";

export function AttachButton() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const addPendingFile = useAppStore((s) => s.addPendingFile);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      addPendingFile(file);
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 10,
          display: 'flex',
          borderRadius: '50%',
          color: 'var(--color-on-surface-variant)',
          transition: 'background 200ms',
        }}
        title={t("chat.attachFile")}
      >
        <PaperclipIcon />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </>
  );
}
