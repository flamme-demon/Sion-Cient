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
// Même raison que dans lib.rs : ce test attend directement des futurs du
// cœur, dont la taille dépasse la profondeur de calcul par défaut.
#![recursion_limit = "256"]
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

    // T1 : la liste des salons arrive par la boucle de synchro.
    let mut salons = premier.salons();
    let liste = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if !salons.borrow_and_update().is_empty() {
                return salons.borrow().clone();
            }
            salons.changed().await.expect("publication des salons");
        }
    })
    .await
    .expect("aucun salon publié en 30 s");
    println!("   {} salons :", liste.len());
    for s in &liste {
        println!(
            "   - {:<28} vocal={:<5} mp={:<5} soundboard={:<5} en vocal={} activité={}",
            s.name, s.has_voice, s.is_dm, s.is_soundboard, s.voice_users.len(), s.last_activity
        );
    }
    if let Ok(sortie) = std::env::var("SION_TEST_SORTIE_SALONS") {
        std::fs::write(&sortie, serde_json::to_vec_pretty(&liste).unwrap()).unwrap();
        println!("   liste écrite dans {sortie}");
    }

    // T2 : un fil publié par salon.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while premier.fils_actuels().len() < liste.len() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("fils non publiés en 30 s");
    // Historique remonté comme le ferait l'interface à l'ouverture de chaque
    // salon (~30 messages affichables).
    for salon in &liste {
        premier.charger_historique(&salon.id).await.expect("historique");
    }
    let fils = premier.fils_actuels();
    let total: usize = fils.iter().map(|f| f.messages.len()).sum();
    println!("   {} fils, {total} messages", fils.len());
    // Médias : le premier de chaque sorte est réellement servi par le cœur.
    let mut sortes = std::collections::BTreeSet::new();
    for piece in fils.iter().flat_map(|f| &f.messages).flat_map(|m| m.attachments.iter().flatten()) {
        let sorte = piece.mime_type.split('/').next().unwrap_or("").to_owned();
        if !sortes.insert(sorte.clone()) {
            continue;
        }
        for (url, vignette) in [(Some(&piece.url), false), (piece.thumbnail_url.as_ref(), true)] {
            let Some(url) = url else { continue };
            let cle = url.strip_prefix(sion_matrix::PREFIXE_PAR_DEFAUT).expect("URL sion-media").split('?').next().unwrap();
            let octets = premier.media(cle, vignette).await.expect("média servi");
            println!("   {sorte}{} : {} octets, {}", if vignette { " (vignette)" } else { "" }, octets.len(), sion_matrix::type_mime(&octets));
            assert!(!octets.is_empty());
        }
    }
    // Épinglés : un résumé par épinglé lisible, jamais plus.
    for fil in fils.iter().filter(|f| !f.epingles.is_empty()) {
        let resumes = premier.epingles(&fil.salon).await.expect("épinglés");
        assert!(resumes.len() <= fil.epingles.len());
        let charges = resumes.iter().filter(|r| r.loaded).count();
        println!("   {} : {} épinglé(s), {} résumé(s) dont {charges} chargé(s)", fil.salon, fil.epingles.len(), resumes.len());
    }
    if let Ok(sortie) = std::env::var("SION_TEST_SORTIE_MESSAGES") {
        std::fs::write(&sortie, serde_json::to_vec_pretty(&fils).unwrap()).unwrap();
        println!("   messages écrits dans {sortie}");
    }
    premier.fermer().await; // « fermeture de l'appli »
    drop(premier);

    // 2. Reprise au lancement suivant, sans mot de passe.
    let second = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — test T0", coffre.clone());
    assert!(second.reprendre().await.expect("reprise"), "la session aurait dû être reprise");
    // Au lancement suivant, les salons reviennent du magasin local.
    let mut salons = second.salons();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while salons.borrow_and_update().is_empty() {
            salons.changed().await.unwrap();
        }
    })
    .await
    .expect("salons non republiés après reprise");
    println!("2b. salons republiés après reprise : {}", second.salons_actuels().len());
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
