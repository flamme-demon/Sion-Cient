//! Connexion d'un téléphone par QR code, puis vérification par QR (29/09),
//! sur le serveur Continuwuity JETABLE de `banc_local.rs` — ignoré par défaut,
//! jamais en CI.
//!
//! ```sh
//! SION_BANC_SERVEUR=http://127.0.0.1:6167 SION_BANC_JETON=<jeton d'inscription> \
//!   cargo test -p sion-matrix --test banc_qr -- --ignored --nocapture
//! ```
#![recursion_limit = "256"]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use sion_matrix::{CoeurMatrix, CoffreMemoire, EtatVerification};

const ATTENTE: Duration = Duration::from_secs(60);

fn variable(nom: &str) -> String {
    std::env::var(nom).unwrap_or_else(|_| panic!("{nom} requis"))
}

struct Appareil {
    coeur: CoeurMatrix,
    _dossier: tempfile::TempDir,
}

fn appareil(nom: &str) -> Appareil {
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(PathBuf::from(dossier.path()), nom, Arc::new(CoffreMemoire::default()));
    Appareil { coeur, _dossier: dossier }
}

async fn etape_de_verification(coeur: &CoeurMatrix, etape: &str) -> EtatVerification {
    let mut suivi = coeur.verification();
    tokio::time::timeout(ATTENTE, async {
        loop {
            let e = suivi.borrow_and_update().clone();
            if e.etape == etape {
                return e;
            }
            assert!(!matches!(e.etape, "error" | "cancelled"), "vérification interrompue : {e:?}");
            suivi.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("étape « {etape} » jamais atteinte (état : {:?})", coeur.verification_actuelle()))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "serveur jetable : variables SION_BANC_* requises"]
async fn connexion_et_verification_par_qr() {
    let serveur = variable("SION_BANC_SERVEUR");
    let jeton_inscription = variable("SION_BANC_JETON");
    let nonce = std::process::id();
    let bob = format!("bob{nonce}");
    let mdp = format!("mdp-de-test-{nonce}");

    // Le PC : compte neuf, amorcé (identité de signature croisée).
    let pc = appareil("Sion — PC de Bob");
    pc.coeur.inscrire(&serveur, &bob, &mdp, Some(&jeton_inscription), None).await.expect("inscription");
    pc.coeur.amorcer(Some(&mdp)).await.expect("amorçage");
    assert!(pc.coeur.appareil_verifie().await.unwrap());

    // ── Scan 1 : jeton de connexion (mot de passe exigé), téléphone connecté.
    assert!(pc.coeur.jeton_connexion("mauvais").await.is_err(), "mauvais mot de passe refusé");
    let (jeton, expire_ms) = pc.coeur.jeton_connexion(&mdp).await.expect("jeton de connexion");
    println!("1. jeton de connexion obtenu, valable {} s", expire_ms / 1000);
    assert!(expire_ms > 0);

    let tel = appareil("Sion Android");
    tel.coeur.definir_camera(true);
    tel.coeur.connecter_par_jeton(&serveur, &jeton).await.expect("connexion par jeton");
    assert!(!tel.coeur.appareil_verifie().await.unwrap(), "téléphone pas encore vérifié");
    let autre = appareil("Sion — intrus");
    assert!(autre.coeur.connecter_par_jeton(&serveur, &jeton).await.is_err(), "jeton à usage unique");
    println!("2. téléphone connecté par le jeton ; second usage refusé");

    // ── Scan 2 : vérification par QR. Le téléphone la demande dès sa connexion
    // (son identité n'est peut-être pas encore arrivée par la synchro).
    tel.coeur.demarrer_verification().await.expect("demande de vérification");
    let e_pc = etape_de_verification(&pc.coeur, "pret").await;
    let e_tel = etape_de_verification(&tel.coeur, "pret").await;
    let qr = e_pc.qr.clone().expect("le PC affiche un QR");
    assert!(!e_pc.scanner, "le PC n'a pas de caméra");
    assert!(e_tel.scanner && e_tel.qr.is_none(), "le téléphone scanne : {e_tel:?}");
    println!("3. prêts : QR sur le PC ({} caractères base64), scanner sur le téléphone", qr.len());

    let octets = base64::engine::general_purpose::STANDARD.decode(&qr).unwrap();
    assert!(octets.starts_with(b"MATRIX"));
    assert!(tel.coeur.verification_scanner(b"pas un QR").await.is_err(), "QR étranger refusé");
    tel.coeur.verification_scanner(&octets).await.expect("QR scanné");
    etape_de_verification(&pc.coeur, "qr-scanne").await;
    assert_eq!(tel.coeur.verification_actuelle().etape, "qr-attente");
    pc.coeur.verification_confirmer_qr().await.expect("confirmation du scan");
    etape_de_verification(&tel.coeur, "done").await;
    etape_de_verification(&pc.coeur, "done").await;
    assert!(tel.coeur.appareil_verifie().await.unwrap(), "téléphone vérifié par le QR");
    println!("4. vérification par QR aboutie : téléphone vérifié");

    // ── Les emojis restent proposés : un second téléphone les choisit à
    // l'étape du QR. Le premier, déconnecté, ne reçoit pas la demande.
    let _ = tel.coeur.deconnecter().await;
    let (jeton, _) = pc.coeur.jeton_connexion(&mdp).await.expect("second jeton");
    let tel2 = appareil("Sion Android 2");
    tel2.coeur.definir_camera(true);
    tel2.coeur.connecter_par_jeton(&serveur, &jeton).await.expect("second téléphone");
    tel2.coeur.demarrer_verification().await.expect("demande");
    etape_de_verification(&pc.coeur, "pret").await;
    etape_de_verification(&tel2.coeur, "pret").await;
    tel2.coeur.verification_emojis().await.expect("emojis plutôt que le QR");
    let e_tel = etape_de_verification(&tel2.coeur, "comparing").await;
    let e_pc = etape_de_verification(&pc.coeur, "comparing").await;
    assert_eq!(e_tel.emojis, e_pc.emojis);
    pc.coeur.confirmer_emojis().await.expect("confirmation PC");
    tel2.coeur.confirmer_emojis().await.expect("confirmation téléphone");
    etape_de_verification(&tel2.coeur, "done").await;
    etape_de_verification(&pc.coeur, "done").await;
    // La confiance en sa propre identité suit la fin de l'échange de peu.
    let mut verifie = false;
    for _ in 0..40 {
        verifie = tel2.coeur.appareil_verifie().await.unwrap();
        if verifie {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(verifie, "second téléphone vérifié par emojis");
    println!("5. alternative : emojis choisis à l'étape du QR, téléphone vérifié");

    let _ = tel2.coeur.deconnecter().await;
    let _ = pc.coeur.deconnecter().await;
}
