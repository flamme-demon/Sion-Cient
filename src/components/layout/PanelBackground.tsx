import { useTranslation } from "react-i18next";
import { useLayoutStore, type BackgroundScope } from "../../stores/useLayoutStore";
import { pickPanelBackground } from "../../services/panelBackground";

/**
 * Contrôle d'édition d'un fond d'image : choisir / remplacer, régler
 * l'opacité, retirer. N'apparaît qu'en mode « Réorganiser » — le rendu du fond
 * lui-même est un simple style de conteneur, posé par
 * `usePanelBackgroundStyle` (services/panelBackground).
 */
export function BackgroundControls({ scope }: { scope: BackgroundScope }) {
  const { t } = useTranslation();
  const layoutEditing = useLayoutStore((s) => s.layoutEditing);
  const cfg = useLayoutStore((s) => s.panelBackgrounds[scope]);
  const setPanelBackground = useLayoutStore((s) => s.setPanelBackground);
  if (!layoutEditing) return null;

  const hasImage = !!cfg;
  return (
    <div style={{
      position: 'absolute', top: 4, right: 4, zIndex: 6,
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 6px', borderRadius: 999,
      background: 'var(--color-surface-container-high)',
      border: '1px solid var(--color-outline-variant)',
    }}>
      <button
        type="button"
        onClick={() => void pickPanelBackground(scope)}
        title={hasImage
          ? t("layout.bgReplace", { defaultValue: "Remplacer l'image de fond" })
          : t("layout.bgPick", { defaultValue: "Choisir une image de fond" })}
        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--color-on-surface-variant)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </button>
      {hasImage && (
        <>
          <input
            type="range" min={0.05} max={1} step={0.05} value={cfg.opacity}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              const current = useLayoutStore.getState().panelBackgrounds[scope];
              if (current) setPanelBackground(scope, { ...current, opacity: next });
            }}
            title={t("layout.bgOpacity", { defaultValue: "Opacité du fond" })}
            style={{ width: 64, accentColor: 'var(--color-primary)' }}
          />
          <button
            type="button"
            onClick={() => setPanelBackground(scope, null)}
            title={t("layout.bgRemove", { defaultValue: "Retirer le fond" })}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, color: 'var(--color-on-surface-variant)', fontSize: 12, lineHeight: 1 }}
          >✕</button>
        </>
      )}
    </div>
  );
}
