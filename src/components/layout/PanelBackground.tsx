import { useTranslation } from "react-i18next";
import { useLayoutStore, type BackgroundScope } from "../../stores/useLayoutStore";
import { pickPanelBackground, usePanelBackgroundUrl, bgAnchorCss } from "../../services/panelBackground";

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
          <button
            type="button"
            onClick={() => {
              const next = cfg.mode === "blur" ? "veil" : "blur";
              setPanelBackground(scope, { ...cfg, mode: next });
            }}
            title={t("layout.bgMode", { defaultValue: "Voile de lisibilité / fond flouté (image pleine)" })}
            aria-label={t("layout.bgMode", { defaultValue: "Voile de lisibilité / fond flouté (image pleine)" })}
            style={{
              border: '1px solid var(--color-outline-variant)', background: 'transparent',
              cursor: 'pointer', padding: '1px 8px', borderRadius: 999,
              color: 'var(--color-on-surface-variant)', fontSize: 11.5, lineHeight: 1.3,
            }}
          >
            {cfg.mode === "blur"
              ? t("layout.bgModeBlur", { defaultValue: "Flou" })
              : t("layout.bgModeVeil", { defaultValue: "Voile" })}
          </button>
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
          {/* Ancrage : « cover » recadre l'image — choisir la zone conservée
              (une photo portrait dans un panneau large : garder le haut). */}
          <div
            role="group"
            aria-label={t("layout.bgAnchor", { defaultValue: "Zone de l'image conservée quand elle est recadrée" })}
            title={t("layout.bgAnchor", { defaultValue: "Zone de l'image conservée quand elle est recadrée" })}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 11px)', gap: 2 }}
          >
            {(["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-label={a}
                aria-pressed={(cfg.anchor ?? "mc") === a}
                onClick={() => setPanelBackground(scope, { ...cfg, anchor: a })}
                style={{
                  width: 11, height: 11, padding: 0, borderRadius: 3, cursor: 'pointer',
                  border: '1px solid var(--color-outline-variant)',
                  background: (cfg.anchor ?? "mc") === a ? 'var(--color-primary)' : 'transparent',
                }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPanelBackground(scope, null)}
            title={t("layout.bgRemove", { defaultValue: "Retirer le fond" })}
            aria-label={t("layout.bgRemove", { defaultValue: "Retirer le fond" })}
            style={{
              border: '1px solid var(--color-outline-variant)', background: 'transparent',
              cursor: 'pointer', padding: '1px 6px', borderRadius: 999,
              color: 'var(--color-on-surface-variant)', fontSize: 12, lineHeight: 1.2,
            }}
          >✕</button>
        </>
      )}
    </div>
  );
}

/**
 * Couche d'image floutée (mode « flou ») : l'image est peinte dans un calque
 * flouté SOUS le contenu — on ne peut pas flouter un `background-image` posé
 * sur le conteneur, d'où cette couche dédiée. À monter en **premier enfant**
 * d'un conteneur `position: relative` : le contenu, peint après dans le DOM,
 * passe naturellement au-dessus.
 */
export function PanelBackgroundLayer({ scope }: { scope: BackgroundScope }) {
  const cfg = useLayoutStore((s) => s.panelBackgrounds[scope]);
  const url = usePanelBackgroundUrl(scope);
  if (!cfg || !url || cfg.mode !== "blur") return null;
  const veil = `color-mix(in srgb, var(--color-surface-container-low) ${Math.round((1 - cfg.opacity) * 100)}%, transparent)`;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        // Déborde du conteneur : les bords adoucis par le flou restent hors
        // champ (sinon on voit une bande claire sur les bords).
        inset: -32,
        zIndex: 0,
        pointerEvents: 'none',
        backgroundImage: `linear-gradient(${veil}, ${veil}), url(${url})`,
        backgroundSize: 'cover',
        backgroundPosition: bgAnchorCss(cfg.anchor),
        backgroundRepeat: 'no-repeat',
        filter: 'blur(16px)',
      }}
    />
  );
}
