//! Session sauvegardée : ce qu'il faut pour reprendre sans se reconnecter.
//!
//! Le fichier `session.json` ne contient que l'adresse du serveur, le
//! compte et l'appareil. Les secrets (jetons, phrase de passe des magasins)
//! vont au [`Coffre`] ; ils ne restent dans le fichier que si le coffre n'a pas
//! pu les garder — même règle que la session JS (`session_json_for_disk`).
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Coffre, Erreur, Resultat};

pub(crate) const FICHIER_SESSION: &str = "session.json";
pub(crate) const DOSSIER_MAGASIN: &str = "magasin";
/// Dernière activité par salon (voir `synchro.rs`).
pub(crate) const FICHIER_ACTIVITE: &str = "activite.json";
/// Base du magasin de chiffrement de matrix-sdk-sqlite.
const BASE_CHIFFREMENT: &str = "matrix-sdk-crypto.sqlite3";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Secrets {
    pub jeton_acces: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jeton_rafraichissement: Option<String>,
    /// Phrase de passe qui chiffre les magasins SQLite, tirée au hasard à la
    /// connexion (comme Element X).
    pub phrase_magasin: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Fichier {
    serveur: String,
    utilisateur: String,
    appareil: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secrets: Option<Secrets>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Session {
    /// URL du serveur, déjà résolue : la reprise se passe de `.well-known`.
    pub serveur: String,
    pub utilisateur: String,
    pub appareil: String,
    pub secrets: Secrets,
}

impl Session {
    pub fn enregistrer(&self, dossier: &Path, coffre: &dyn Coffre) -> Resultat<()> {
        let au_coffre = coffre.ecrire(&serde_json::to_string(&self.secrets)?);
        if !au_coffre {
            log::warn!("[Sion][matrix] coffre indisponible : les secrets restent dans le fichier de session");
        }
        let fichier = Fichier {
            serveur: self.serveur.clone(),
            utilisateur: self.utilisateur.clone(),
            appareil: self.appareil.clone(),
            secrets: (!au_coffre).then(|| self.secrets.clone()),
        };
        ecrire_prive(&dossier.join(FICHIER_SESSION), &serde_json::to_vec_pretty(&fichier)?)?;
        Ok(())
    }

    /// La session sauvegardée, ou `None` s'il n'y en a pas — ou si elle ne
    /// peut pas être reprise sans danger, auquel cas elle est effacée.
    pub fn charger(dossier: &Path, coffre: &dyn Coffre) -> Resultat<Option<Session>> {
        let octets = match std::fs::read(dossier.join(FICHIER_SESSION)) {
            Ok(o) => o,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let fichier: Fichier = serde_json::from_slice(&octets)?;
        // Invariant : un magasin de chiffrement disparu n'est JAMAIS remplacé
        // par un neuf sous le même appareil — c'est ce qui a vidé le
        // chiffrement d'un utilisateur (purge de cache, 709af50). On repart
        // d'une connexion, donc d'un nouvel appareil.
        if !magasin_present(dossier) {
            log::warn!(
                "[Sion][matrix] magasin de chiffrement absent pour l'appareil {} : session abandonnée",
                fichier.appareil
            );
            effacer(dossier, coffre)?;
            return Ok(None);
        }
        let secrets = fichier
            .secrets
            .or_else(|| coffre.lire().and_then(|s| serde_json::from_str(&s).ok()));
        let Some(secrets) = secrets else {
            log::warn!("[Sion][matrix] secrets de session introuvables (coffre vidé ?) : session abandonnée");
            effacer(dossier, coffre)?;
            return Ok(None);
        };
        Ok(Some(Session {
            serveur: fichier.serveur,
            utilisateur: fichier.utilisateur,
            appareil: fichier.appareil,
            secrets,
        }))
    }
}

pub(crate) fn magasin_present(dossier: &Path) -> bool {
    dossier.join(DOSSIER_MAGASIN).join(BASE_CHIFFREMENT).is_file()
}

/// Efface la session, ses secrets et les magasins. Irréversible pour
/// l'appareil local : le client doit avoir été libéré avant (SQLite ouvert).
pub(crate) fn effacer(dossier: &Path, coffre: &dyn Coffre) -> Resultat<()> {
    coffre.effacer();
    for resultat in [
        std::fs::remove_file(dossier.join(FICHIER_SESSION)),
        std::fs::remove_file(dossier.join(FICHIER_ACTIVITE)),
        std::fs::remove_dir_all(dossier.join(DOSSIER_MAGASIN)),
    ] {
        match resultat {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// 32 octets aléatoires en hexadécimal.
pub(crate) fn phrase_aleatoire() -> Resultat<String> {
    let mut octets = [0u8; 32];
    getrandom::fill(&mut octets).map_err(|e| Erreur::Autre(format!("aléa indisponible : {e}")))?;
    Ok(octets.iter().map(|o| format!("{o:02x}")).collect())
}

/// Écrit un fichier lisible par le seul utilisateur, sans jamais exposer une
/// version partielle : voisin temporaire, flush, puis remplacement atomique.
pub(crate) fn ecrire_prive(chemin: &Path, contenu: &[u8]) -> std::io::Result<()> {
    let dossier = chemin.parent().expect("fichier de session sans dossier");
    std::fs::create_dir_all(dossier)?;
    let temporaire = dossier.join(format!(".{}.tmp-{}", FICHIER_SESSION, std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&temporaire)?;
    f.write_all(contenu)?;
    f.sync_all()?;
    std::fs::rename(&temporaire, chemin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoffreMemoire;

    fn session() -> Session {
        Session {
            serveur: "https://sionchat.fr/".into(),
            utilisateur: "@test:sionchat.fr".into(),
            appareil: "APPAREIL".into(),
            secrets: Secrets {
                jeton_acces: "jeton".into(),
                jeton_rafraichissement: None,
                phrase_magasin: "phrase".into(),
            },
        }
    }

    fn avec_magasin(dossier: &Path) {
        std::fs::create_dir_all(dossier.join(DOSSIER_MAGASIN)).unwrap();
        std::fs::write(dossier.join(DOSSIER_MAGASIN).join(BASE_CHIFFREMENT), b"").unwrap();
    }

    #[test]
    fn les_secrets_vont_au_coffre_et_pas_dans_le_fichier() {
        let d = tempfile::tempdir().unwrap();
        let coffre = CoffreMemoire::default();
        avec_magasin(d.path());
        session().enregistrer(d.path(), &coffre).unwrap();
        let texte = std::fs::read_to_string(d.path().join(FICHIER_SESSION)).unwrap();
        assert!(!texte.contains("jeton") && !texte.contains("phrase"), "secret sur disque : {texte}");
        assert_eq!(Session::charger(d.path(), &coffre).unwrap(), Some(session()));
    }

    #[test]
    fn sans_coffre_les_secrets_restent_dans_le_fichier() {
        let d = tempfile::tempdir().unwrap();
        let coffre = CoffreMemoire::refusant();
        avec_magasin(d.path());
        session().enregistrer(d.path(), &coffre).unwrap();
        assert_eq!(Session::charger(d.path(), &coffre).unwrap(), Some(session()));
    }

    #[cfg(unix)]
    #[test]
    fn le_fichier_de_session_est_prive() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        session().enregistrer(d.path(), &CoffreMemoire::default()).unwrap();
        let mode = std::fs::metadata(d.path().join(FICHIER_SESSION)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn magasin_disparu_la_session_n_est_pas_reprise_et_tout_est_efface() {
        // L'invariant qui protège le chiffrement : jamais un magasin neuf
        // sous un appareil existant.
        let d = tempfile::tempdir().unwrap();
        let coffre = CoffreMemoire::default();
        session().enregistrer(d.path(), &coffre).unwrap();
        assert_eq!(Session::charger(d.path(), &coffre).unwrap(), None);
        assert!(!d.path().join(FICHIER_SESSION).exists());
        assert_eq!(coffre.lire(), None);
    }

    #[test]
    fn coffre_vide_la_session_est_abandonnee() {
        let d = tempfile::tempdir().unwrap();
        let coffre = CoffreMemoire::default();
        avec_magasin(d.path());
        session().enregistrer(d.path(), &coffre).unwrap();
        coffre.effacer();
        assert_eq!(Session::charger(d.path(), &coffre).unwrap(), None);
        assert!(!d.path().join(FICHIER_SESSION).exists());
        assert!(!magasin_present(d.path()));
    }

    #[test]
    fn pas_de_session_pas_d_erreur() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Session::charger(d.path(), &CoffreMemoire::default()).unwrap(), None);
    }

    #[test]
    fn la_phrase_de_passe_est_longue_et_change() {
        let (a, b) = (phrase_aleatoire().unwrap(), phrase_aleatoire().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
