import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { Message } from "./Message";
import type { ChatMessage } from "../../types/matrix";

type Etat = { etat: "chargement" } | { etat: "pret"; message: ChatMessage } | { etat: "introuvable" };
/** Résultat rangé avec le message qu'il concerne : tant qu'il ne correspond
 *  pas au message demandé, c'est un chargement. */
type Resultat = { id: string; etat: Etat };

/** Un message affiché en entier, hors du fil : un épinglé ou une réponse
 *  trop ancienne pour être atteinte en remontant (voir `allerAuMessage`).
 *  Rendu par le même composant que dans le fil : texte, images, vidéos. */
export function ApercuMessage() {
  const { t } = useTranslation();
  const eventId = useAppStore((s) => s.apercuMessage);
  const salon = useAppStore((s) => s.activeChannel);
  const fermer = () => useAppStore.getState().setApercuMessage(null);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const etat: Etat = resultat && resultat.id === eventId ? resultat.etat : { etat: "chargement" };

  useEffect(() => {
    if (!eventId || !salon) return;
    let actif = true;
    void import("../../services/matrixCore")
      .then((core) => core.message(salon, eventId))
      .then((m) => { if (actif) setResultat({ id: eventId, etat: m ? { etat: "pret", message: m } : { etat: "introuvable" } }); })
      .catch(() => { if (actif) setResultat({ id: eventId, etat: { etat: "introuvable" } }); });
    return () => { actif = false; };
  }, [eventId, salon]);

  useEffect(() => {
    if (!eventId) return;
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") useAppStore.getState().setApercuMessage(null); };
    window.addEventListener("keydown", echap);
    return () => window.removeEventListener("keydown", echap);
  }, [eventId]);

  // Un changement de salon ferme l'aperçu : il appartient à l'ancien.
  useEffect(() => () => useAppStore.getState().setApercuMessage(null), [salon]);

  if (!eventId) return null;

  const date = etat.etat === "pret" && etat.message.ts
    ? new Date(etat.message.ts).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })
    : "";

  return createPortal(
    <div
      onClick={fermer}
      style={{
        position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720, maxWidth: "100%", maxHeight: "85vh", overflowY: "auto",
          background: "var(--color-surface-container)", borderRadius: 20, padding: "16px 20px 20px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)", display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 13, color: "var(--color-on-surface-variant)" }}>
            {date ? t("chat.previewFrom", { date }) : t("chat.previewTitle")}
          </div>
          <button
            onClick={fermer}
            aria-label={t("auth.cancel")}
            style={{
              border: "none", background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
              width: 32, height: 32, borderRadius: "50%", cursor: "pointer", fontSize: 15, flexShrink: 0,
            }}
          >✕</button>
        </div>
        {etat.etat === "chargement" && (
          <div style={{ fontSize: 13, color: "var(--color-outline)", padding: "12px 0" }}>{t("chat.loading")}</div>
        )}
        {etat.etat === "introuvable" && (
          <div style={{ fontSize: 13, color: "var(--color-error)", padding: "12px 0" }}>{t("chat.previewMissing")}</div>
        )}
        {etat.etat === "pret" && (
          <div style={{ minWidth: 0 }}>
            <Message message={etat.message} showHeader isFirst highlighted={false} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
