//! La voix ENTRE LES DEUX MOTEURS, sur un vrai compte — côté Rust. Ignoré par
//! défaut ; lancé par `build-scripts/voix-croisee.sh` avec
//! `src/services/voixCroisee.test.ts`.
//!
//! Un appareil JS (le vrai `MatrixRTCSession` de matrix-js-sdk, réglé comme
//! Sion) et un appareil Rust rejoignent l'appel du salon de test : chacun
//! doit voir l'appartenance de l'autre et recevoir SA clé, sous l'identité
//! que le serveur média lui donne. Le jeton LiveKit est demandé pour de vrai
//! et son identité vérifiée ; aucun média n'est ouvert.
#![recursion_limit = "256"]
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use sion_matrix::{CleMedia, CoeurMatrix, CoffreMemoire};

const ATTENTE: Duration = Duration::from_secs(120);
const NOM_SALON: &str = "Sion — banc d'essai des moteurs";

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

async fn attendre<T>(quoi: &str, mut essai: impl FnMut() -> Option<T>) -> T {
    let debut = std::time::Instant::now();
    while debut.elapsed() < ATTENTE {
        if let Some(v) = essai() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("{quoi} : jamais arrivé");
}

fn b64(o: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(o)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : lancé par build-scripts/voix-croisee.sh"]
async fn voix_avec_le_moteur_js() {
    let v = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("{n} requis"));
    let echange = PathBuf::from(v("SION_TEST_ECHANGE"));
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — voix croisée (Rust)", Arc::new(CoffreMemoire::default()));
    coeur.connecter(&v("SION_TEST_SERVEUR"), &v("SION_TEST_IDENTIFIANT"), &v("SION_TEST_MOT_DE_PASSE")).await.expect("connexion");
    let resultat = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(deroule(&coeur, &echange))).await;
    if resultat.is_err() && !echange.join("rust-fini.json").exists() {
        ecrire(&echange.join("rust-fini.json"), json!({ "erreur": "échec côté Rust" }));
    }
    coeur.quitter_voix().await;
    coeur.deconnecter().await.expect("déconnexion");
    if let Err(p) = resultat {
        std::panic::resume_unwind(p);
    }
}

async fn deroule(coeur: &CoeurMatrix, echange: &Path) {
    let client = coeur.client().await.unwrap();
    let appareil = client.device_id().unwrap().to_string();
    let salon = attendre("salon de test", || coeur.salons_actuels().into_iter().find(|s| s.name == NOM_SALON)).await.id;
    let cles = Arc::new(Mutex::new(Vec::<CleMedia>::new()));
    let mut flux = coeur.cles_voix();
    let tampon = cles.clone();
    tokio::spawn(async move {
        while let Ok(c) = flux.recv().await {
            tampon.lock().unwrap().push(c);
        }
    });
    attendre_fichier(&echange.join("js-pret.json")).await;
    ecrire(&echange.join("salon.json"), json!({ "salon": salon, "appareil": appareil }));
    let js = attendre_fichier(&echange.join("js-joint.json")).await;
    let identite_js = js["identite"].as_str().unwrap().to_owned();

    // ── Jonction complète : service trouvé, jeton du serveur média.
    let connexion = coeur.rejoindre_voix(&salon).await.expect("rejoindre la voix");
    assert!(connexion.chiffre, "salon de test chiffré");
    assert_eq!(connexion.url, "wss://livekit.sionchat.fr");
    let charge = connexion.jeton.split('.').nth(1).expect("jeton JWT");
    let charge: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(charge).unwrap()).unwrap();
    println!("jeton LiveKit : sub={} salle={}", charge["sub"], charge["video"]["room"]);
    assert_eq!(charge["sub"], json!(connexion.identite), "identité du serveur média = identité des clés");
    // Le service hache le nom de la salle : le moteur JS, qui envoie le même
    // nom, aboutit à la même salle.
    assert!(charge["video"]["room"].as_str().is_some_and(|s| !s.is_empty()));

    // ── Clés : la nôtre, et celle de l'appareil JS sous son identité.
    let (propre, recue) = attendre("clé de l'appareil JS", || {
        let l = cles.lock().unwrap();
        let propre = l.iter().rev().find(|c| c.identite == connexion.identite)?.clone();
        let recue = l.iter().rev().find(|c| c.identite == identite_js)?.clone();
        Some((propre, recue))
    })
    .await;
    println!("clé propre {} ; clé {} reçue de {identite_js}", propre.index, recue.index);
    ecrire(
        &echange.join("rust-cles.json"),
        json!({ "identite": connexion.identite, "propre": { "index": propre.index, "cle": b64(&propre.cle) } }),
    );
    let js = attendre_fichier(&echange.join("js-cles.json")).await;
    if let Some(e) = js.get("erreur") {
        panic!("le moteur JS a échoué : {e}");
    }
    // La clé que le JS utilise pour chiffrer est celle que le Rust a reçue.
    let courante_js = attendre("clé courante du JS reçue", || {
        let l = cles.lock().unwrap();
        let index = js["propre"]["index"].as_u64()? as u8;
        let c = l.iter().rev().find(|c| c.identite == identite_js && c.index == index)?;
        (b64(&c.cle) == js["propre"]["cle"].as_str()?).then_some(index)
    })
    .await;
    println!("clé courante du JS (index {courante_js}) reçue à l'identique");
    ecrire(&echange.join("rust-fini.json"), json!({ "ok": true }));
    attendre_fichier(&echange.join("js-fini.json")).await;
}
