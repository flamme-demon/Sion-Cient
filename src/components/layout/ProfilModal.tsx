import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  appliquerProfil,
  contenuExportable,
  exporterProfil,
  lireProfil,
  SECTIONS_PAR_DEFAUT,
  sectionsPresentes,
  type ProfilLu,
  type SectionProfil,
  type SectionsProfil,
} from "../../services/profilService";
import { findTheme } from "../../services/themeService";
import { ACCENTS_PROPOSES } from "../../themes/accent";

interface Props {
  mode: "export" | "import";
  onClose: () => void;
}

const ORDRE: SectionProfil[] = ["disposition", "theme", "fonds", "sons"];

/**
 * Fenêtre d'export ou d'import d'un profil Sion : une case par section.
 *
 * À l'export, les sons d'événements sont décochés par défaut — plus lourds,
 * plus personnels. À l'import, rien n'est appliqué avant « Appliquer », et
 * seules les sections que le profil contient sont proposées.
 */
export function ProfilModal({ mode, onClose }: Props) {
  const { t } = useTranslation();
  const [exportable] = useState(contenuExportable);
  const [profil, setProfil] = useState<ProfilLu | null>(null);
  const [cases, setCases] = useState<SectionsProfil>(() => ({
    ...SECTIONS_PAR_DEFAUT,
    fonds: SECTIONS_PAR_DEFAUT.fonds && exportable.fonds > 0,
  }));
  const [occupe, setOccupe] = useState(mode === "import");
  const [fini, setFini] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // L'import commence par choisir le fichier : renoncer ferme la fenêtre.
  useEffect(() => {
    if (mode !== "import") return;
    let vivant = true;
    void lireProfil().then((lu) => {
      if (!vivant) return;
      if (!lu) {
        onClose();
        return;
      }
      setOccupe(false);
      if ("error" in lu) {
        const cle = lu.error === "notAProfile" || lu.error === "tooRecent" ? `profile.${lu.error}` : null;
        setMessage({ ok: false, text: cle ? t(cle) : t("profile.error", { message: lu.error }) });
        setFini(true);
        return;
      }
      setProfil(lu.profil);
      setCases(sectionsPresentes(lu.profil));
    });
    return () => { vivant = false; };
  }, [mode, onClose, t]);

  const nomAccent = (hex: string | null) => {
    if (!hex) return t("profile.accentOwn");
    const propose = ACCENTS_PROPOSES.find((a) => a.hex === hex);
    return t("profile.accentNamed", { name: propose ? t(`settings.accentName.${propose.id}`) : hex });
  };

  /** Libellé et détail d'une section, selon le mode. `null` : absente. */
  const decrire = (s: SectionProfil): { titre: string; detail: string | null } => {
    const titre = t(`profile.section.${s}`);
    if (mode === "export") {
      switch (s) {
        case "disposition": return { titre, detail: t("profile.layoutHint") };
        case "theme": return { titre, detail: `${findTheme(exportable.themeId).name} — ${nomAccent(exportable.accent)}` };
        case "fonds": return { titre, detail: exportable.fonds > 0 ? t("profile.images", { count: exportable.fonds }) : null };
        case "sons": return { titre, detail: exportable.sons > 0 ? t("profile.sounds", { count: exportable.sons }) : null };
      }
    }
    if (!profil) return { titre, detail: null };
    switch (s) {
      case "disposition": return { titre, detail: profil.disposition ? t("profile.layoutHint") : null };
      case "theme": return { titre, detail: profil.theme ? `${profil.theme.theme.name} — ${nomAccent(profil.theme.accent)}` : null };
      case "fonds": {
        const n = Object.keys(profil.fonds ?? {}).length;
        return { titre, detail: n > 0 ? t("profile.images", { count: n }) : null };
      }
      case "sons": {
        const n = Object.keys(profil.sons ?? {}).length;
        return { titre, detail: n > 0 ? t("profile.sounds", { count: n }) : null };
      }
    }
  };

  const valider = async () => {
    setOccupe(true);
    setMessage(null);
    try {
      if (mode === "export") {
        const r = await exporterProfil(cases);
        if (!r) {
          setOccupe(false);
          return;
        }
        const mo = (r.taille / 1_048_576).toLocaleString(i18n.language, { maximumFractionDigits: 1 });
        setMessage({ ok: true, text: t("profile.exported", { size: `${mo} Mo` }) });
      } else if (profil) {
        await appliquerProfil(profil, cases);
        setMessage({ ok: true, text: t("profile.applied") });
      }
      setFini(true);
    } catch (err) {
      setMessage({ ok: false, text: t("profile.error", { message: String(err) }) });
    } finally {
      setOccupe(false);
    }
  };

  const bouton = (principal: boolean) => ({
    padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
    background: principal ? 'var(--color-primary)' : 'transparent',
    color: principal ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
  });
  const aucuneCase = !ORDRE.some((s) => cases[s]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(mode === "export" ? "profile.exportTitle" : "profile.importTitle")}
        style={{ background: 'var(--color-surface-container-high)', borderRadius: 16, padding: 20, width: 420, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {t(mode === "export" ? "profile.exportTitle" : "profile.importTitle")}
        </div>

        {mode === "import" && profil?.app && (
          <div style={{ fontSize: 11, color: 'var(--color-outline)' }}>
            {t("profile.origin", {
              app: profil.app,
              date: profil.createdAt ? new Date(profil.createdAt).toLocaleDateString(i18n.language) : "?",
            })}
          </div>
        )}

        {(mode === "export" || profil) && !fini && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ORDRE.map((s) => {
              const { titre, detail } = decrire(s);
              const possible = detail !== null;
              return (
                <label
                  key={s}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 6px', borderRadius: 8,
                    cursor: possible ? 'pointer' : 'default', opacity: possible ? 1 : 0.5,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={possible && cases[s]}
                    disabled={!possible || occupe}
                    onChange={(e) => setCases((c) => ({ ...c, [s]: e.target.checked }))}
                    style={{ marginTop: 2, accentColor: 'var(--color-primary)' }}
                  />
                  <span>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--color-on-surface)' }}>{titre}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
                      {detail ?? t(mode === "export" ? "profile.nothing" : "profile.absent")}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {mode === "import" && profil && !fini && (cases.fonds || cases.sons) && (
          <div style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{t("profile.replaceNote")}</div>
        )}

        {occupe && mode === "import" && !profil && (
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{t("profile.reading")}</div>
        )}

        {message && (
          <div role="status" style={{ fontSize: 12, color: message.ok ? 'var(--color-green)' : 'var(--color-error)' }}>{message.text}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          {fini ? (
            <button type="button" onClick={onClose} style={bouton(true)}>{t("profile.close")}</button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={occupe} style={bouton(false)}>{t("profile.cancel")}</button>
              <button
                type="button"
                onClick={() => void valider()}
                disabled={occupe || aucuneCase || (mode === "import" && !profil)}
                style={{ ...bouton(true), opacity: occupe || aucuneCase ? 0.6 : 1 }}
              >
                {t(mode === "export" ? "profile.export" : "profile.apply")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
