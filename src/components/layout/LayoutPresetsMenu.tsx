import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { LayoutIcon } from "../icons";
import { applyLayoutPreset, type LayoutPresetId } from "../../services/layoutPresets";
import { applyLayout, layoutToJson, parseLayoutFile } from "../../services/layoutFile";
import { useLayoutStore } from "../../stores/useLayoutStore";

/**
 * Menu « Dispositions » (roadmap §1.4) : trois présets qui remettent d'aplomb
 * toute la mise en page d'un clic — les tailles personnalisées de l'utilisateur
 * (sidebar, dock) ne sont pas écrasées, seuls les modes et les panneaux ouverts
 * changent.
 */
export function LayoutPresetsMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sidebarSide = useLayoutStore((s) => s.sidebarSide);
  const ref = useRef<HTMLDivElement>(null);
  const fichierRef = useRef<HTMLInputElement>(null);
  // Retour de l'export ou de l'import, affiché au pied du menu, qui reste
  // ouvert pour qu'on le lise.
  const [statut, setStatut] = useState<{ ok: boolean; text: string } | null>(null);
  const basculer = (ouvert: boolean) => {
    setOpen(ouvert);
    setStatut(null);
  };
  const choisirFichier = () => fichierRef.current?.click();

  // Même mécanique que l'export d'un thème : WebKitGTK n'expose pas toujours
  // navigator.clipboard, le textarea + execCommand est le plus compatible.
  const exporter = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = layoutToJson();
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      setStatut({ ok, text: ok ? t("layout.layoutCopied") : t("layout.layoutCopyFailed") });
    } catch {
      setStatut({ ok: false, text: t("layout.layoutCopyFailed") });
    }
  };

  const importer = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    if (fichierRef.current) fichierRef.current.value = "";
    if (!fichier) return;
    try {
      const lu = parseLayoutFile(await fichier.text());
      if ("error" in lu) {
        setStatut({ ok: false, text: `${t("layout.layoutErrInvalid")} (${lu.error})` });
        return;
      }
      applyLayout(lu.disposition);
      setStatut({ ok: true, text: t("layout.layoutImported") });
    } catch {
      setStatut({ ok: false, text: t("layout.layoutErrInvalid") });
    }
  };

  // Fermeture au clic extérieur (le menu vit dans le header, sans overlay :
  // un overlay pleine fenêtre intercepterait les drops de fichiers du chat).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) basculer(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const items: { id: LayoutPresetId; label: string; hint: string }[] = [
    { id: "chat", label: t("layout.presetChat"), hint: t("layout.presetChatHint") },
    { id: "voice", label: t("layout.presetVoice"), hint: t("layout.presetVoiceHint") },
    { id: "stream", label: t("layout.presetStream"), hint: t("layout.presetStreamHint") },
  ];

  const buttonStyle: CSSProperties = {
    padding: 6,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: open ? 'var(--color-surface-container-high)' : 'transparent',
    color: open ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
    display: 'flex',
    alignItems: 'center',
    transition: 'background 200ms',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => basculer(!open)}
        style={buttonStyle}
        title={t("layout.presets")}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <LayoutIcon />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 50,
            minWidth: 240, padding: 6,
            background: 'var(--color-surface-container)',
            border: '1px solid var(--color-outline-variant)',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-outline)', padding: '4px 10px 6px' }}>
            {t("layout.presets")}
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              onClick={() => { applyLayoutPreset(it.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 8, border: 'none',
                background: 'transparent', color: 'var(--color-on-surface)',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{it.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>{it.hint}</span>
            </button>
          ))}
          <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 4px' }} />
          <button
            role="menuitem"
            onClick={() => { useLayoutStore.getState().setLayoutEditing(true); setOpen(false); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 10px', borderRadius: 8, border: 'none',
              background: 'transparent', color: 'var(--color-on-surface)',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {t("layout.editLayout", { defaultValue: "Réorganiser la disposition" })}
          </button>
          <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 4px' }} />
          <button
            role="menuitem"
            onClick={() => { useLayoutStore.getState().toggleSidebarSide(); setOpen(false); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 10px', borderRadius: 8, border: 'none',
              background: 'transparent', color: 'var(--color-on-surface)',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {sidebarSide === "left"
              ? t("layout.moveMenuRight", { defaultValue: "Déplacer le menu à droite" })
              : t("layout.moveMenuLeft", { defaultValue: "Déplacer le menu à gauche" })}
          </button>
          <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '4px 4px' }} />
          {[
            { cle: "export", label: t("layout.exportLayout"), hint: t("layout.exportLayoutHint") },
            { cle: "import", label: t("layout.importLayout"), hint: t("layout.importLayoutHint") },
          ].map((it) => (
            <button
              key={it.cle}
              role="menuitem"
              onClick={it.cle === "export" ? exporter : choisirFichier}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 8, border: 'none',
                background: 'transparent', color: 'var(--color-on-surface)',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{it.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>{it.hint}</span>
            </button>
          ))}
          <input ref={fichierRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={importer} />
          {statut && (
            <div role="status" style={{ fontSize: 11, padding: '4px 10px 6px', color: statut.ok ? 'var(--color-green)' : 'var(--color-error)' }}>
              {statut.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
