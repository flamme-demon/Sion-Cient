import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntreMembresStore } from "../../stores/useEntreMembresStore";
import type { Personne } from "../../services/matrixCore";

/** Au-delà, un « +N ». */
const VISIBLES = 5;

function Pastille({ p }: { p: Personne }) {
  const [echec, setEchec] = useState(false);
  const commun: React.CSSProperties = {
    width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
    border: "1.5px solid var(--color-surface)", marginLeft: -4,
  };
  if (p.avatar && !echec) {
    return <img src={p.avatar} alt="" onError={() => setEchec(true)} style={{ ...commun, objectFit: "cover", display: "block" }} />;
  }
  return (
    <span style={{
      ...commun, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--color-primary-container, var(--color-surface-container-highest))",
      color: "var(--color-on-primary-container, var(--color-on-surface))", fontSize: 9, fontWeight: 700,
    }}>
      {Array.from(p.nom)[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** « Vu par » : les membres dont la lecture s'arrête à ce message. */
export function LecteursMessage({ salon, eventId }: { salon: string; eventId: string }) {
  const { t } = useTranslation();
  const lecteurs = useEntreMembresStore((s) => s.lectures[salon]?.[eventId]);
  if (!lecteurs || lecteurs.length === 0) return null;
  const noms = lecteurs.map((p) => p.nom).join(", ");
  const reste = lecteurs.length - VISIBLES;
  return (
    <div
      title={t("chat.seenBy", { noms })}
      aria-label={t("chat.seenBy", { noms })}
      style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", padding: "1px 4px 2px 0", paddingLeft: 4 }}
    >
      {lecteurs.slice(0, VISIBLES).map((p) => <Pastille key={p.id} p={p} />)}
      {reste > 0 && (
        <span style={{ marginLeft: 3, fontSize: 10, color: "var(--color-outline)" }}>+{reste}</span>
      )}
    </div>
  );
}
