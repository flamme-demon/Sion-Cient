import { useEffect, useState } from "react";
import { connecter, deconnecter, reprendre, surEtat, type EtatConnexion } from "../../services/matrixCore";

/**
 * Écran de développement du moteur Matrix Rust (tranche T0).
 *
 * Affiché à la place de Sion quand l'appli est lancée avec
 * `SION_MATRIX_MOTEUR=rust` et compilée avec la feature `moteur-matrix-rust`.
 * Il valide les fondations — connexion d'un nouvel appareil, reprise de la
 * session au lancement suivant, déconnexion — avant que le reste de
 * l'interface ne soit branché sur ce moteur (T1 et suivantes). Textes non
 * traduits : c'est un outil de développement, pas un écran livré.
 */
export function MoteurRustApercu() {
  const [etat, setEtat] = useState<EtatConnexion>({ etat: "connexion" });
  const [serveur, setServeur] = useState("sionchat.fr");
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let desabonner: (() => void) | undefined;
    let actif = true;
    void surEtat((e) => actif && setEtat(e)).then((d) => {
      if (actif) desabonner = d;
      else d();
    });
    // Reprise automatique : c'est le critère de T0 (relancer sans se reconnecter).
    reprendre().catch((e) => actif && setErreur(String(e)));
    return () => {
      actif = false;
      desabonner?.();
    };
  }, []);

  const agir = async (action: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await action();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(false);
    }
  };

  const champ = {
    padding: '8px 10px', borderRadius: 8, width: '100%', boxSizing: 'border-box' as const,
    border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-high)',
    color: 'var(--color-on-surface)', fontSize: 14,
  };
  const bouton = {
    padding: '8px 14px', borderRadius: 999, border: 'none', cursor: occupe ? 'wait' : 'pointer',
    background: 'var(--color-primary)', color: 'var(--color-on-primary)', fontWeight: 700,
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-surface)', color: 'var(--color-on-surface)', fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        width: 420, padding: 24, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 14,
        background: 'var(--color-surface-container)', border: '1px solid var(--color-outline-variant)',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Moteur Matrix Rust</div>
          <div style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
            Écran de développement (T0). Le reste de Sion n'est pas encore branché sur ce moteur.
          </div>
        </div>

        <div style={{ fontSize: 14 }}>
          <b>État :</b>{" "}
          {etat.etat === "connecte" && <>connecté — {etat.utilisateur}, appareil <code>{etat.appareil}</code></>}
          {etat.etat === "connexion" && "connexion…"}
          {etat.etat === "deconnecte" && "déconnecté"}
          {etat.etat === "erreur" && <span style={{ color: 'var(--color-error)' }}>erreur — {etat.message}</span>}
        </div>

        {etat.etat === "connecte" ? (
          <button style={bouton} disabled={occupe} onClick={() => void agir(deconnecter)}>
            Se déconnecter (supprime cet appareil)
          </button>
        ) : (
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              void agir(() => connecter(serveur, identifiant, motDePasse).then(() => setMotDePasse("")));
            }}
          >
            <input style={champ} value={serveur} onChange={(e) => setServeur(e.target.value)} placeholder="Serveur" />
            <input style={champ} value={identifiant} onChange={(e) => setIdentifiant(e.target.value)} placeholder="Identifiant" autoComplete="username" />
            <input style={champ} type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} placeholder="Mot de passe" autoComplete="current-password" />
            <button style={bouton} type="submit" disabled={occupe || !identifiant || !motDePasse}>
              Se connecter comme nouvel appareil
            </button>
          </form>
        )}

        {erreur && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{erreur}</div>}
      </div>
    </div>
  );
}
