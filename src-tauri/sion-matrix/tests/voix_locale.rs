//! La voix côté Matrix (étape 3) entre deux comptes, sur le serveur
//! Continuwuity JETABLE de `banc_local.rs` (même lancement, mêmes variables).
//! Sans LiveKit : appartenances, clés des médias échangées en to-device
//! chiffré, rotation au départ, mute visible depuis l'autre compte.
//!
//! ```sh
//! SION_BANC_SERVEUR=http://127.0.0.1:6167 SION_BANC_JETON=<jeton> \
//!   cargo test -p sion-matrix --test voix_locale -- --ignored --nocapture
//! ```
#![recursion_limit = "256"]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sion_matrix::{CleMedia, CoeurMatrix, CoffreMemoire};

const ATTENTE: Duration = Duration::from_secs(60);

fn variable(nom: &str) -> String {
    std::env::var(nom).unwrap_or_else(|_| panic!("{nom} requis"))
}

struct Compte {
    coeur: Arc<CoeurMatrix>,
    id: String,
    identite: String,
    cles: Arc<Mutex<Vec<CleMedia>>>,
    _dossier: tempfile::TempDir,
}

async fn inscrire(serveur: &str, jeton: &str, nom: &str) -> Compte {
    let dossier = tempfile::tempdir().unwrap();
    let coeur = Arc::new(CoeurMatrix::nouveau(PathBuf::from(dossier.path()), nom, Arc::new(CoffreMemoire::default())));
    let mdp = format!("mdp-de-test-{nom}");
    coeur.inscrire(serveur, nom, &mdp, Some(jeton), None).await.expect("inscription par jeton");
    let client = coeur.client().await.unwrap();
    let id = client.user_id().unwrap().to_string();
    let identite = format!("{id}:{}", client.device_id().unwrap());
    // Toutes les clés remises au « moteur média ».
    let cles = Arc::new(Mutex::new(Vec::new()));
    let mut flux = coeur.cles_voix();
    let tampon = cles.clone();
    tokio::spawn(async move {
        while let Ok(c) = flux.recv().await {
            tampon.lock().unwrap().push(c);
        }
    });
    Compte { coeur, id, identite, cles, _dossier: dossier }
}

async fn attendre<T>(quoi: &str, mut essai: impl FnMut() -> Option<T>) -> T {
    let debut = std::time::Instant::now();
    while debut.elapsed() < ATTENTE {
        if let Some(v) = essai() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("{quoi} : jamais arrivé");
}

fn cle(compte: &Compte, identite: &str, index: u8) -> Option<Vec<u8>> {
    compte.cles.lock().unwrap().iter().rev().find(|c| c.identite == identite && c.index == index).map(|c| c.cle.clone())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "serveur jetable : variables SION_BANC_* requises"]
async fn voix_entre_deux_comptes() {
    let serveur = variable("SION_BANC_SERVEUR");
    let jeton = variable("SION_BANC_JETON");
    let nonce = std::process::id();
    let alice = inscrire(&serveur, &jeton, &format!("alicevoix{nonce}")).await;
    let bob = inscrire(&serveur, &jeton, &format!("bobvoix{nonce}")).await;

    // Salon vocal chiffré ; Bob accepte l'invitation tout seul (synchro).
    let salon = alice.coeur.creer_salon("Banc voix", true, false, true).await.expect("salon vocal chiffré");
    alice.coeur.inviter(&salon, &bob.id).await.expect("invitation");
    attendre("Bob dans le salon", || bob.coeur.salons_actuels().into_iter().find(|s| s.id == salon)).await;
    println!("1. salon vocal chiffré, Alice et Bob membres");

    // ── Jonction : chacun reçoit la clé de l'autre, sous son identité.
    let service = "https://livekit.exemple";
    let a = alice.coeur.rejoindre_appel_seul(&salon, service).await.expect("Alice rejoint");
    assert!(a.chiffre, "salon chiffré : médias chiffrés");
    assert_eq!(a.identite, alice.identite);
    bob.coeur.rejoindre_appel_seul(&salon, service).await.expect("Bob rejoint");
    let de_alice = attendre("clé d'Alice chez Bob", || cle(&bob, &alice.identite, 0)).await;
    assert_eq!(Some(de_alice.clone()), cle(&alice, &alice.identite, 0), "Bob déchiffre Alice avec la clé qu'elle utilise");
    assert_eq!(de_alice.len(), 16);
    let de_bob = attendre("clé de Bob chez Alice", || {
        let propre = cle(&bob, &bob.identite, 0)?;
        (cle(&alice, &bob.identite, 0)? == propre).then_some(propre)
    })
    .await;
    assert_ne!(de_alice, de_bob);
    println!("2. clés échangées : {} ↔ {}", alice.identite, bob.identite);

    // Les deux apparaissent dans l'appel, vus de l'autre compte.
    attendre("deux participants vus par Bob", || {
        let s = bob.coeur.salons_actuels().into_iter().find(|s| s.id == salon)?;
        (s.voice_users.len() == 2).then_some(())
    })
    .await;

    // ── Mute annoncé dans l'appartenance, visible depuis l'autre compte.
    assert!(alice.coeur.etat_voix(true, false).await);
    attendre("Alice muette vue par Bob", || {
        let s = bob.coeur.salons_actuels().into_iter().find(|s| s.id == salon)?;
        s.voice_users.iter().find(|u| u.id == alice.id).filter(|u| u.muted && !u.deafened).map(|_| ())
    })
    .await;
    println!("3. mute d'Alice visible chez Bob");

    // ── Départ de Bob : Alice renouvelle sa clé (index 1), sans la lui envoyer.
    bob.coeur.quitter_voix().await;
    let nouvelle = attendre("clé renouvelée d'Alice", || cle(&alice, &alice.identite, 1)).await;
    assert_ne!(nouvelle, de_alice);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(cle(&bob, &alice.identite, 1), None, "la clé renouvelée ne va pas à celui qui est parti");
    attendre("Bob sorti de l'appel", || {
        let s = alice.coeur.salons_actuels().into_iter().find(|s| s.id == salon)?;
        (s.voice_users.len() == 1).then_some(())
    })
    .await;
    println!("4. départ de Bob : clé d'Alice renouvelée (index 1), gardée pour les suivants");

    // ── Retour de Bob : il reçoit la clé qu'Alice UTILISE — la même si elle
    // est récente, une neuve sinon (période de grâce de 10 s).
    bob.coeur.rejoindre_appel_seul(&salon, service).await.expect("Bob revient");
    let index = attendre("clé courante d'Alice chez Bob revenu", || {
        let courante = alice.cles.lock().unwrap().iter().rev().find(|c| c.identite == alice.identite).cloned()?;
        (cle(&bob, &alice.identite, courante.index)? == courante.cle).then_some(courante.index)
    })
    .await;
    println!("5. Bob revenu : il reçoit la clé qu'Alice utilise (index {index}{})", if index == 1 { ", celle d'avant son retour" } else { ", renouvelée" });

    alice.coeur.quitter_voix().await;
    bob.coeur.quitter_voix().await;
    attendre("appel vide", || {
        let s = alice.coeur.salons_actuels().into_iter().find(|s| s.id == salon)?;
        s.voice_users.is_empty().then_some(())
    })
    .await;
    println!("6. appel quitté des deux côtés");
    alice.coeur.deconnecter().await.ok();
    bob.coeur.deconnecter().await.ok();
}
