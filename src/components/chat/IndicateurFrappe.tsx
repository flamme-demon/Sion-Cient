import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useEntreMembresStore } from "../../stores/useEntreMembresStore";
import type { Personne } from "../../services/matrixCore";

const PERSONNE: Personne[] = [];

/** « X écrit… » au bas du fil, par-dessus : sans hauteur propre, il ne
 *  fait pas sauter les messages en apparaissant. */
export function IndicateurFrappe() {
  const { t } = useTranslation();
  const salon = useAppStore((s) => s.activeChannel);
  const personnes = useEntreMembresStore((s) => (salon ? s.frappes[salon] : undefined)) ?? PERSONNE;
  if (!salon || personnes.length === 0) return null;
  const noms = personnes.map((p) => p.nom);
  const texte =
    noms.length === 1
      ? t("chat.typingOne", { nom: noms[0] })
      : noms.length === 2
        ? t("chat.typingTwo", { a: noms[0], b: noms[1] })
        : noms.length === 3
          ? t("chat.typingThree", { a: noms[0], b: noms[1], c: noms[2] })
          : t("chat.typingMany");
  return (
    <div style={{ position: "relative", height: 0 }}>
      <div
        aria-live="polite"
        style={{
          position: "absolute", bottom: 4, left: 16, maxWidth: "calc(100% - 32px)",
          display: "flex", alignItems: "center", gap: 6,
          padding: "3px 10px", borderRadius: 12,
          background: "var(--color-surface-container-high)",
          color: "var(--color-on-surface-variant)", fontSize: 12,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)", pointerEvents: "none",
          animation: "fade-in 0.15s ease-out",
        }}
      >
        <span className="points-frappe" aria-hidden><span /><span /><span /></span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{texte}</span>
      </div>
    </div>
  );
}
