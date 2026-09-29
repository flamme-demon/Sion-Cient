import { Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLayoutStore, type DockPanelId } from "../../stores/useLayoutStore";
import { PANEL_BODIES, PANEL_TITLE_KEYS, panneauxOuverts } from "../layout/dockPanels";
import { CloseIcon } from "../icons";

/**
 * Téléphone : les panneaux de la dock (épinglés, membres, soundboard…)
 * s'ouvrent en feuille qui monte du bas. Sans elle, la dock n'étant pas
 * rendue sur mobile, leurs boutons ouvraient des panneaux invisibles
 * (29/09 : « les épingles ne marchent pas »). Le dernier ouvert est affiché ;
 * fermer la feuille le ferme (croix, fond, retour d'Android).
 */
export function MobilePanelSheet() {
  const { t } = useTranslation();
  const [courant, setCourant] = useState<DockPanelId | null>(null);
  const connusRef = useRef<Set<DockPanelId>>(new Set());

  useEffect(() => {
    const suivre = () => {
      const ouverts = panneauxOuverts();
      const nouveau = ouverts.find((p) => !connusRef.current.has(p));
      connusRef.current = new Set(ouverts);
      setCourant((c) => nouveau ?? (c && ouverts.includes(c) ? c : ouverts[ouverts.length - 1] ?? null));
    };
    suivre();
    return useLayoutStore.subscribe(suivre);
  }, []);

  if (!courant) return null;
  const Corps = PANEL_BODIES[courant];
  const fermer = () => useLayoutStore.getState().closeDockPanel(courant);

  return (
    <div
      onClick={fermer}
      style={{
        position: "fixed", inset: 0, zIndex: 900,
        background: "rgba(0,0,0,0.45)",
        display: "flex", flexDirection: "column", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          height: "85vh",
          background: "var(--color-surface-container-low)",
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -8px 32px rgba(0,0,0,0.4)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 2px" }}>
          <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--color-outline-variant)" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "4px 8px 8px 16px", gap: 8 }}>
          <span style={{ flex: 1, fontSize: 16, fontWeight: 600, color: "var(--color-on-surface)" }}>
            {t(PANEL_TITLE_KEYS[courant])}
          </span>
          <button
            onClick={fermer}
            aria-label={t("chat.close", { defaultValue: "Fermer" })}
            style={{
              width: 44, height: 44, borderRadius: 22, border: "none", background: "transparent",
              color: "var(--color-on-surface-variant)", display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <CloseIcon />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <Suspense fallback={null}>
            <Corps />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

