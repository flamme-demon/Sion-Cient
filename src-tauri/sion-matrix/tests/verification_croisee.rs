//! Vérification par emojis ENTRE LES DEUX MOTEURS, sur un vrai compte — côté
//! Rust. Ignoré par défaut ; lancé par `build-scripts/verification-croisee.sh`
//! avec `src/services/verificationCroisee.test.ts`.
//!
//! Le cas de la migration : ce NOUVEL appareil (moteur Rust) demande la
//! vérification ; l'appareil JS du compte, déjà vérifié, l'accepte. Les deux
//! comparent les mêmes emojis et confirment ; cet appareil devient vérifié,
//! reçoit les secrets et relit l'historique chiffré depuis la sauvegarde.
#![recursion_limit = "256"]
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::{json, Value};
use sion_matrix::{CoeurMatrix, CoffreMemoire, EtatVerification};

const ATTENTE: Duration = Duration::from_secs(120);

fn ecrire(chemin: &Path, valeur: Value) {
    let provisoire = chemin.with_extension("tmp");
    std::fs::write(&provisoire, serde_json::to_vec(&valeur).unwrap()).unwrap();
    std::fs::rename(provisoire, chemin).unwrap();
}

async fn attendre_fichier(chemin: &Path) -> Value {
    tokio::time::timeout(ATTENTE, async {
        loop {
            if let Ok(Ok(v)) = std::fs::read(chemin).map(|o| serde_json::from_slice::<Value>(&o)) {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} jamais écrit", chemin.display()))
}

async fn etape(coeur: &CoeurMatrix, voulue: &str) -> EtatVerification {
    let mut suivi = coeur.verification();
    tokio::time::timeout(ATTENTE, async {
        loop {
            let e = suivi.borrow_and_update().clone();
            if e.etape == voulue {
                return e;
            }
            assert!(!matches!(e.etape, "error" | "cancelled"), "vérification interrompue : {e:?}");
            suivi.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("étape « {voulue} » jamais atteinte ({:?})", coeur.verification_actuelle()))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : lancé par build-scripts/verification-croisee.sh"]
async fn verification_par_le_moteur_js() {
    let v = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("{n} requis"));
    let echange = PathBuf::from(v("SION_TEST_ECHANGE"));
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — vérification croisée (Rust)", Arc::new(CoffreMemoire::default()));
    coeur.connecter(&v("SION_TEST_SERVEUR"), &v("SION_TEST_IDENTIFIANT"), &v("SION_TEST_MOT_DE_PASSE")).await.expect("connexion");
    let resultat = AssertUnwindSafe(deroule(&coeur, &echange)).catch_unwind().await;
    if resultat.is_err() && !echange.join("rust-verifie.json").exists() {
        ecrire(&echange.join("rust-verifie.json"), json!({ "erreur": "échec côté Rust" }));
    }
    coeur.deconnecter().await.expect("déconnexion");
    if let Err(p) = resultat {
        std::panic::resume_unwind(p);
    }
}

async fn deroule(coeur: &CoeurMatrix, echange: &Path) {
    assert!(!coeur.appareil_verifie().await.unwrap(), "nouvel appareil : pas encore vérifié");
    attendre_fichier(&echange.join("js-pret.json")).await;
    // L'appareil JS doit être connu de ce côté avant la demande.
    tokio::time::sleep(Duration::from_secs(3)).await;
    coeur.demarrer_verification().await.expect("demande");
    let e = etape(coeur, "comparing").await;
    ecrire(&echange.join("rust-emojis.json"), serde_json::to_value(&e.emojis).unwrap());
    let js = attendre_fichier(&echange.join("js-emojis.json")).await;
    if let Some(err) = js.get("erreur") {
        panic!("le moteur JS a échoué : {err}");
    }
    assert_eq!(js, serde_json::to_value(&e.emojis).unwrap(), "mêmes emojis des deux côtés");
    println!("emojis : {}", e.emojis.iter().map(|x| x.emoji.as_str()).collect::<Vec<_>>().join(" "));
    coeur.confirmer_emojis().await.expect("confirmation");
    etape(coeur, "done").await;
    let mut verifie = false;
    for _ in 0..40 {
        if coeur.appareil_verifie().await.unwrap() {
            verifie = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(verifie, "appareil Rust vérifié par l'appareil JS");
    println!("appareil Rust vérifié par l'appareil JS");
    // Secrets reçus de l'appareil JS : la sauvegarde s'ouvre et l'historique
    // chiffré se relit.
    let mut restaures = 0;
    for _ in 0..20 {
        restaures = coeur.restaurer_automatiquement().await.unwrap_or(0);
        if restaures > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    println!("sauvegarde ouverte avec les secrets reçus : {restaures} salon(s) restauré(s)");
    assert!(restaures > 0, "la clé de sauvegarde doit arriver de l'appareil JS");
    ecrire(&echange.join("rust-verifie.json"), json!({ "ok": true }));
}
