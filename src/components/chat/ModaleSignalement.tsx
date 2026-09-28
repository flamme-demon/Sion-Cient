import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface Props {
  salon: string;
  eventId: string;
  auteur: string;
  onClose: () => void;
}

/** Signaler un message aux administrateurs du serveur : Continuwuity relaie
 *  le signalement dans son salon d'administration. */
export function ModaleSignalement({ salon, eventId, auteur, onClose }: Props) {
  const { t } = useTranslation();
  const [raison, setRaison] = useState("");
  const [etat, setEtat] = useState<"saisie" | "envoi" | "envoye" | "erreur">("saisie");

  useEffect(() => {
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", echap);
    return () => window.removeEventListener("keydown", echap);
  }, [onClose]);

  const envoyer = async () => {
    setEtat("envoi");
    try {
      const core = await import("../../services/matrixCore");
      await core.signaler(salon, eventId, raison);
      setEtat("envoye");
      setTimeout(onClose, 1500);
    } catch (e) {
      console.warn("[Sion] signalement impossible :", e);
      setEtat("erreur");
    }
  };

  const bouton: React.CSSProperties = {
    padding: "8px 16px", borderRadius: 16, border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400, maxWidth: "92%", background: "var(--color-surface-container)", borderRadius: 20, padding: 24,
          display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-on-surface)" }}>{t("report.title", { nom: auteur })}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-on-surface-variant)" }}>{t("report.explain")}</div>
        {etat === "envoye" ? (
          <div style={{ fontSize: 13, color: "var(--color-green)" }}>{t("report.sent")}</div>
        ) : (
          <>
            <textarea
              autoFocus
              value={raison}
              onChange={(e) => setRaison(e.target.value)}
              placeholder={t("report.reasonPlaceholder")}
              rows={3}
              maxLength={1000}
              style={{
                padding: "10px 12px", borderRadius: 12, border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
                fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none",
              }}
            />
            {etat === "erreur" && <div style={{ fontSize: 12, color: "var(--color-error)" }}>{t("report.error")}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ ...bouton, background: "var(--color-surface-container-high)", color: "var(--color-on-surface)" }}>
                {t("auth.cancel")}
              </button>
              <button
                onClick={() => void envoyer()}
                disabled={etat === "envoi"}
                style={{ ...bouton, background: "var(--color-error)", color: "var(--color-on-error)", fontWeight: 600, opacity: etat === "envoi" ? 0.5 : 1 }}
              >
                {t("report.send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
