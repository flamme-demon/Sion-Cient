//! Test d'intégration sur un VRAI compte — ignoré par défaut, jamais en CI.
//!
//! Valide le critère de T0 sur le serveur : connexion d'un nouvel appareil,
//! reprise sans mot de passe après « fermeture », déconnexion, puis reprise
//! impossible. L'appareil créé est supprimé à la fin.
//!
//! ```sh
//! SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
//!   cargo test -p sion-matrix --test compte_reel -- --ignored --nocapture
//! ```
use std::sync::Arc;

use sion_matrix::{CoeurMatrix, CoffreMemoire, EtatConnexion};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : variables SION_TEST_* requises"]
async fn connexion_reprise_deconnexion() {
    let (Ok(serveur), Ok(identifiant), Ok(mot_de_passe)) = (
        std::env::var("SION_TEST_SERVEUR"),
        std::env::var("SION_TEST_IDENTIFIANT"),
        std::env::var("SION_TEST_MOT_DE_PASSE"),
    ) else {
        panic!("SION_TEST_SERVEUR, SION_TEST_IDENTIFIANT et SION_TEST_MOT_DE_PASSE sont requis");
    };
    let dossier = tempfile::tempdir().unwrap();
    // Le même coffre d'un « lancement » à l'autre, comme le trousseau du système.
    let coffre = Arc::new(CoffreMemoire::default());

    // 1. Connexion d'un nouvel appareil.
    let premier = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — test T0", coffre.clone());
    premier.connecter(&serveur, &identifiant, &mot_de_passe).await.expect("connexion");
    let EtatConnexion::Connecte { utilisateur, appareil } = premier.etat_actuel() else {
        panic!("état après connexion : {:?}", premier.etat_actuel());
    };
    println!("1. connecté : {utilisateur}, appareil {appareil}");
    let texte = std::fs::read_to_string(dossier.path().join("session.json")).unwrap();
    assert!(!texte.contains(&mot_de_passe), "le mot de passe ne doit jamais être écrit");
    drop(premier); // « fermeture de l'appli »

    // 2. Reprise au lancement suivant, sans mot de passe.
    let second = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — test T0", coffre.clone());
    assert!(second.reprendre().await.expect("reprise"), "la session aurait dû être reprise");
    match second.etat_actuel() {
        EtatConnexion::Connecte { appareil: repris, .. } => {
            assert_eq!(repris, appareil, "la reprise doit garder le même appareil");
            println!("2. repris sans mot de passe : même appareil {repris}");
        }
        autre => panic!("état après reprise : {autre:?}"),
    }

    // 3. Déconnexion : appareil supprimé, session effacée.
    second.deconnecter().await.expect("déconnexion");
    assert_eq!(second.etat_actuel(), EtatConnexion::Deconnecte);
    assert!(!dossier.path().join("session.json").exists());
    drop(second);
    println!("3. déconnecté, session effacée");

    // 4. Plus rien à reprendre.
    let troisieme = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — test T0", coffre);
    assert!(!troisieme.reprendre().await.expect("reprise vide"));
    println!("4. reprise impossible après déconnexion : correct");
}
