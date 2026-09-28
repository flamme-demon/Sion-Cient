import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/useAuthStore";
import { useEntreMembresStore, rafraichirIgnores } from "../../stores/useEntreMembresStore";

const bouton: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 12,
  border: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-high)",
  color: "var(--color-on-surface)", fontSize: 13, fontFamily: "inherit", cursor: "pointer", textAlign: "left",
};
const petitBouton: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 16, border: "1px solid var(--color-outline-variant)",
  background: "transparent", color: "var(--color-on-surface)", fontSize: 11, fontFamily: "inherit", cursor: "pointer",
};
const champ: React.CSSProperties = {
  width: "100%", padding: "6px 10px", borderRadius: 10, border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface-container)", color: "var(--color-on-surface)", fontSize: 12,
  fontFamily: "inherit", outline: "none", boxSizing: "border-box",
};

/** Bannière de profil (MSC4427) : image large, en tête de la fiche d'un membre. */
function Banniere() {
  const { t } = useTranslation();
  const moi = useAuthStore((s) => s.credentials?.userId);
  const [url, setUrl] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState(false);
  const fichierRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!moi) return;
    let actif = true;
    void import("../../services/matrixCore").then((core) => core.banniere(moi)).then((u) => { if (actif) setUrl(u); }).catch(() => {});
    return () => { actif = false; };
  }, [moi]);

  const changer = async (fichier: File | null) => {
    setOccupe(true);
    setErreur(false);
    try {
      const core = await import("../../services/matrixCore");
      setUrl(await core.changerBanniere(fichier));
    } catch (e) {
      console.warn("[Sion] bannière non changée :", e);
      setErreur(true);
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{t("account.banner")}</div>
      <div
        onClick={() => !occupe && fichierRef.current?.click()}
        title={t("account.bannerChange")}
        style={{
          width: "100%", aspectRatio: "3 / 1", borderRadius: 10, overflow: "hidden", cursor: "pointer",
          background: "var(--color-surface-container-high)", border: "1px dashed var(--color-outline-variant)",
          display: "flex", alignItems: "center", justifyContent: "center", opacity: occupe ? 0.5 : 1,
          color: "var(--color-outline)", fontSize: 12,
        }}
      >
        {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : t("account.bannerChange")}
      </div>
      <input
        ref={fichierRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void changer(f); }}
      />
      {url && (
        <button style={{ ...petitBouton, alignSelf: "flex-start" }} disabled={occupe} onClick={() => void changer(null)}>
          {t("account.bannerRemove")}
        </button>
      )}
      {erreur && <div style={{ fontSize: 11, color: "var(--color-error)" }}>{t("account.bannerError")}</div>}
    </div>
  );
}

/** Utilisateurs ignorés, pour revenir sur sa décision. */
function Ignores() {
  const { t } = useTranslation();
  const ignores = useEntreMembresStore((s) => s.ignores);
  const [ouvert, setOuvert] = useState(false);
  const [occupe, setOccupe] = useState<string | null>(null);
  useEffect(() => { if (ouvert) void rafraichirIgnores().catch(() => {}); }, [ouvert]);

  const liberer = async (id: string) => {
    setOccupe(id);
    try {
      const core = await import("../../services/matrixCore");
      await core.nePlusIgnorer(id);
      await rafraichirIgnores();
    } catch (e) {
      console.warn("[Sion] impossible de ne plus ignorer :", e);
    } finally {
      setOccupe(null);
    }
  };

  return (
    <>
      <button style={bouton} onClick={() => setOuvert(!ouvert)}>
        {t("account.ignoredUsers", { count: ignores.length })}
      </button>
      {ouvert && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ignores.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--color-on-surface-variant)", textAlign: "center", padding: 8 }}>{t("account.noIgnored")}</div>
          )}
          {ignores.map((id) => (
            <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderRadius: 10, background: "var(--color-surface-container-high)" }}>
              <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</span>
              <button style={petitBouton} disabled={occupe === id} onClick={() => void liberer(id)}>{t("contextMenu.unignore")}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Suppression définitive du compte : mot de passe exigé, effacement des
 *  messages au choix. */
function SuppressionCompte() {
  const { t } = useTranslation();
  const [ouvert, setOuvert] = useState(false);
  const [motDePasse, setMotDePasse] = useState("");
  const [effacer, setEffacer] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState(false);

  const supprimer = async () => {
    if (!motDePasse || occupe) return;
    setOccupe(true);
    setErreur(false);
    try {
      const core = await import("../../services/matrixCore");
      await core.supprimerCompte(motDePasse, effacer);
      useAuthStore.getState().logout();
    } catch (e) {
      console.warn("[Sion] suppression du compte refusée :", e);
      setErreur(true);
      setOccupe(false);
    }
  };

  return (
    <>
      <button style={{ ...bouton, color: "var(--color-error)" }} onClick={() => { setOuvert(!ouvert); setErreur(false); }}>
        {t("account.deleteAccount")}
      </button>
      {ouvert && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, borderRadius: 12, border: "1px solid var(--color-error)" }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-on-surface)" }}>{t("account.deleteWarning")}</div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--color-on-surface-variant)", cursor: "pointer" }}>
            <input type="checkbox" checked={effacer} onChange={(e) => setEffacer(e.target.checked)} />
            {t("account.deleteErase")}
          </label>
          <input
            type="password"
            placeholder={t("account.deletePassword")}
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.target.value)}
            style={champ}
          />
          {erreur && <div style={{ fontSize: 11, color: "var(--color-error)" }}>{t("account.deleteError")}</div>}
          <button
            onClick={() => void supprimer()}
            disabled={!motDePasse || occupe}
            style={{
              padding: "8px 16px", borderRadius: 20, border: "none", background: "var(--color-error)", color: "var(--color-on-error)",
              fontSize: 13, fontFamily: "inherit", fontWeight: 600,
              cursor: !motDePasse || occupe ? "default" : "pointer", opacity: !motDePasse || occupe ? 0.5 : 1,
            }}
          >
            {occupe ? t("account.deleting") : t("account.deleteConfirm")}
          </button>
        </div>
      )}
    </>
  );
}

/** Ce que le panneau du compte gagne avec le moteur Rust. */
export function SectionsCompteRust() {
  return (
    <>
      <Banniere />
      <Ignores />
      <SuppressionCompte />
    </>
  );
}
