import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { copierImage, enregistrerImage } from "../../services/actionsImage";

interface Props {
  url: string;
  nom: string;
  x: number;
  y: number;
  onClose: () => void;
}

/** Menu du clic droit sur une image du fil. Celui de WebKit ne savait que
 *  copier l'adresse interne et échouait à l'enregistrement (2.0 beta 2). */
export function MenuImage({ url, nom, x, y, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const dehors = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const echap = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", dehors);
    window.addEventListener("keydown", echap);
    return () => {
      window.removeEventListener("mousedown", dehors);
      window.removeEventListener("keydown", echap);
    };
  }, [onClose]);

  const agir = (action: () => Promise<void>) => () => {
    onClose();
    action().catch((e) => useAppStore.getState().setFileError(String(e)));
  };

  const item: React.CSSProperties = {
    display: "block", width: "100%", padding: "9px 14px", border: "none", borderRadius: 8,
    background: "transparent", color: "var(--color-on-surface)", fontSize: 13,
    fontFamily: "inherit", textAlign: "left", cursor: "pointer",
  };

  return createPortal(
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed", left: pos.left, top: pos.top, zIndex: 10001, minWidth: 190, padding: 4,
        background: "var(--color-surface-container-high)", borderRadius: 12,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      }}
    >
      <button style={item} onClick={agir(() => copierImage(url))}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-surface-container-highest)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        {t("chat.copyImage")}
      </button>
      <button style={item} onClick={agir(() => enregistrerImage(url, nom))}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-surface-container-highest)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        {t("chat.saveImage")}
      </button>
    </div>,
    document.body,
  );
}
