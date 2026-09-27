//! Aller-retour ENTRE LES DEUX MOTEURS sur un vrai compte (critère de T3) —
//! ignoré par défaut, jamais en CI. Lancé par `build-scripts/aller-retour.sh`,
//! en même temps que `src/services/allerRetour.test.ts` (moteur JS) : les deux
//! appareils sont en ligne ensemble, dans un salon de test privé et CHIFFRÉ, et
//! se coordonnent par fichiers dans `SION_TEST_ECHANGE`.
//!
//! 1. Rust et JS se connectent (nouveaux appareils) et s'annoncent.
//! 2. Rust trouve (ou crée) le salon de test, attend de connaître l'appareil
//!    JS, puis envoie de tout : texte avec mention, réponse, édition,
//!    réaction, poke, sondage + vote + clôture, fichier, message supprimé,
//!    épinglage.
//! 3. JS vérifie ce qu'il lit, envoie la même série par les VRAIES fonctions
//!    de `matrixService.ts`, et désépingle le message de Rust.
//! 4. Rust vérifie ce qu'il lit. Chacun supprime son appareil.
#![recursion_limit = "256"]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::ruma::api::client::room::create_room::v3::{Request as CreerSalon, RoomPreset};
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::InitialStateEvent;
use futures_util::FutureExt;
use matrix_sdk::Client;
use std::panic::AssertUnwindSafe;
use serde_json::{json, Value};
use sion_matrix::{CoeurMatrix, CoffreMemoire, FilSalon, InfosMedia, Message};

/// Salon réutilisé d'un passage à l'autre (pas d'accumulation sur le serveur).
const NOM_SALON: &str = "Sion — banc d'essai des moteurs";
const ATTENTE: Duration = Duration::from_secs(180);

/// PNG 1×1 transparent : le fichier envoyé de part et d'autre.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn variable(nom: &str) -> Option<String> {
    std::env::var(nom).ok().filter(|v| !v.is_empty())
}

fn ecrire(chemin: &Path, valeur: Value) {
    let provisoire = chemin.with_extension("tmp");
    std::fs::write(&provisoire, serde_json::to_vec_pretty(&valeur).unwrap()).unwrap();
    std::fs::rename(provisoire, chemin).unwrap();
}

async fn attendre_fichier(chemin: &Path) -> Value {
    tokio::time::timeout(ATTENTE, async {
        loop {
            if let Ok(octets) = std::fs::read(chemin) {
                if let Ok(v) = serde_json::from_slice::<Value>(&octets) {
                    return v;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} jamais écrit", chemin.display()))
}

/// Attend qu'une condition sur le fil du salon soit remplie ; renvoie le
/// dernier constat en cas d'échec, pour le diagnostic.
async fn attendre_fil(coeur: &CoeurMatrix, salon: &str, condition: impl Fn(&FilSalon) -> Result<(), String>) {
    let debut = std::time::Instant::now();
    let mut constat = "fil absent".to_owned();
    while debut.elapsed() < ATTENTE {
        if let Some(fil) = coeur.fils_actuels().into_iter().find(|f| f.salon == salon) {
            match condition(&fil) {
                Ok(()) => return,
                Err(e) => constat = e,
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("fil jamais conforme : {constat}");
}

async fn trouver_ou_creer_salon(client: &Client) -> String {
    let mut existants: Vec<_> = client
        .joined_rooms()
        .into_iter()
        .filter(|s| s.cached_display_name().is_some_and(|n| n.to_string() == NOM_SALON) || s.name().as_deref() == Some(NOM_SALON))
        .collect();
    existants.sort_by_key(|s| s.room_id().to_owned());
    if let Some(salon) = existants.first() {
        return salon.room_id().to_string();
    }
    let mut requete = CreerSalon::new();
    requete.name = Some(NOM_SALON.to_owned());
    requete.preset = Some(RoomPreset::PrivateChat);
    requete.initial_state =
        vec![InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::with_recommended_defaults()).to_raw_any()];
    client.create_room(requete).await.expect("création du salon de test").room_id().to_string()
}

fn message<'a>(fil: &'a FilSalon, texte: &str) -> Result<&'a Message, String> {
    fil.messages.iter().find(|m| m.text == texte).ok_or_else(|| format!("« {texte} » absent"))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : lancé par build-scripts/aller-retour.sh"]
async fn aller_retour_avec_le_moteur_js() {
    let (Some(serveur), Some(identifiant), Some(mot_de_passe), Some(echange)) = (
        variable("SION_TEST_SERVEUR"),
        variable("SION_TEST_IDENTIFIANT"),
        variable("SION_TEST_MOT_DE_PASSE"),
        variable("SION_TEST_ECHANGE"),
    ) else {
        panic!("SION_TEST_SERVEUR, SION_TEST_IDENTIFIANT, SION_TEST_MOT_DE_PASSE et SION_TEST_ECHANGE requis");
    };
    let echange = PathBuf::from(echange);
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — aller-retour (Rust)", Arc::new(CoffreMemoire::default()));
    coeur.connecter(&serveur, &identifiant, &mot_de_passe).await.expect("connexion");
    // Quoi qu'il arrive, l'appareil est supprimé et le moteur JS prévenu.
    let resultat = AssertUnwindSafe(deroule(&coeur, &echange)).catch_unwind().await;
    if resultat.is_err() && !echange.join("rust-verifie.json").exists() {
        ecrire(&echange.join("rust-verifie.json"), json!({ "erreur": "échec côté Rust (voir sa sortie)" }));
    }
    coeur.deconnecter().await.expect("déconnexion");
    if let Err(panique) = resultat {
        std::panic::resume_unwind(panique);
    }
}

async fn deroule(coeur: &CoeurMatrix, echange: &Path) {
    let client = coeur.client().await.unwrap();
    let moi = client.user_id().unwrap().to_owned();
    let nom = client.account().get_display_name().await.ok().flatten().unwrap_or_else(|| moi.to_string());
    ecrire(&echange.join("rust-pret.json"), json!({ "appareil": client.device_id().unwrap().as_str() }));
    println!("1. Rust connecté, en attente du moteur JS");

    let js = attendre_fichier(&echange.join("js-pret.json")).await;
    let appareil_js = js["appareil"].as_str().expect("appareil JS").to_owned();
    let salon = trouver_ou_creer_salon(&client).await;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
    ecrire(&echange.join("salon.json"), json!({ "salon": salon, "nonce": nonce, "nom": nom }));
    println!("2. salon de test {salon}, passage {nonce}");

    // Sans connaître l'appareil JS, la clé de session ne lui serait pas
    // partagée : il lirait des messages indéchiffrables.
    tokio::time::timeout(ATTENTE, async {
        loop {
            let appareils = client.encryption().get_user_devices(&moi).await.expect("appareils");
            if appareils.devices().any(|d| d.device_id().as_str() == appareil_js) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("appareil JS jamais connu du moteur Rust");

    // 2. Rust envoie.
    let r0 = coeur.envoyer_texte(&salon, &format!("R0 {nonce} coucou @{nom}")).await.expect("texte");
    let r1 = coeur.envoyer_texte(&salon, &format!("R1 {nonce} bonjour")).await.expect("texte");
    let reponse = coeur.repondre(&salon, &r1, &format!("R2 {nonce} réponse")).await.expect("réponse");
    coeur.editer(&salon, &r1, &format!("R1 {nonce} bonjour (corrigé)")).await.expect("édition");
    coeur.reagir(&salon, &r1, "👍").await.expect("réaction");
    let poke = coeur.poker(&salon).await.expect("poke");
    let sondage = coeur
        .creer_sondage(&salon, &format!("R-sondage {nonce} ?"), &["A".into(), "B".into()], false, 1, None)
        .await
        .expect("sondage");
    coeur.voter(&salon, &sondage, &["0".into()]).await.expect("vote");
    coeur.clore_sondage(&salon, &sondage).await.expect("clôture");
    let infos = InfosMedia { largeur: Some(1), hauteur: Some(1), duree_ms: None };
    let fichier = coeur.envoyer_fichier(&salon, PNG.to_vec(), "rust.png", "image/png", infos).await.expect("fichier");
    let supprime = coeur.envoyer_texte(&salon, &format!("R-à-supprimer {nonce}")).await.expect("texte");
    coeur.supprimer(&salon, &supprime).await.expect("suppression");
    coeur.epingler(&salon, &r1).await.expect("épinglage");
    ecrire(
        &echange.join("rust-envois.json"),
        json!({ "r0": r0, "r1": r1, "reponse": reponse, "poke": poke, "sondage": sondage, "fichier": fichier, "supprime": supprime }),
    );
    println!("3. Rust a tout envoyé");

    // Rust relit ses propres envois (y compris le fichier chiffré).
    attendre_fil(coeur, &salon, |fil| {
        let m = fil.messages.iter().find(|m| m.id == fichier).ok_or("fichier Rust absent")?;
        let url = &m.attachments.as_ref().and_then(|a| a.first()).ok_or("pièce jointe absente")?.url;
        if url.is_empty() {
            return Err("URL du fichier vide".into());
        }
        Ok(())
    })
    .await;
    let fil = coeur.fils_actuels().into_iter().find(|f| f.salon == salon).unwrap();
    let url = fil.messages.iter().find(|m| m.id == fichier).unwrap().attachments.as_ref().unwrap()[0].url.clone();
    let cle = url.strip_prefix(sion_matrix::PREFIXE_PAR_DEFAUT).unwrap().split('?').next().unwrap().to_owned();
    assert_eq!(coeur.media(&cle, false).await.expect("fichier Rust relu"), PNG, "fichier chiffré relu à l'identique");

    // 4. Rust vérifie les envois du moteur JS.
    let js = attendre_fichier(&echange.join("js-envois.json")).await;
    if let Some(erreur) = js.get("erreur").and_then(Value::as_str) {
        panic!("le moteur JS a échoué : {erreur}");
    }
    let moi_s = moi.to_string();
    attendre_fil(coeur, &salon, |fil| {
        let j0 = message(fil, &format!("J0 {nonce} coucou @{nom}"))?;
        if !j0.formatted_body.as_deref().unwrap_or("").contains("https://matrix.to/#/") {
            return Err(format!("mention JS sans lien : {:?}", j0.formatted_body));
        }
        let j1 = message(fil, &format!("J1 {nonce} salut (corrigé)"))?;
        if j1.edited != Some(true) {
            return Err("édition JS non marquée".into());
        }
        let j2 = message(fil, &format!("J2 {nonce} réponse"))?;
        if j2.reply_to.as_ref().map(|r| r.event_id.as_str()) != Some(r1.as_str()) {
            return Err(format!("réponse JS mal rattachée : {:?}", j2.reply_to));
        }
        let origine = fil.messages.iter().find(|m| m.id == r1).ok_or("R1 absent")?;
        let reactions: Vec<&str> = origine.reactions.iter().flatten().map(|r| r.emoji.as_str()).collect();
        if !reactions.contains(&"🎉") || !reactions.contains(&"👍") {
            return Err(format!("réactions sur R1 : {reactions:?}"));
        }
        let poke_js = js["poke"].as_str().unwrap_or("");
        if fil.messages.iter().find(|m| m.id == poke_js).and_then(|m| m.msgtype.as_deref()) != Some("m.poke") {
            return Err("poke JS absent".into());
        }
        let sondage_js = fil
            .messages
            .iter()
            .find(|m| m.text == format!("J-sondage {nonce} ?"))
            .and_then(|m| m.poll.as_ref())
            .ok_or("sondage JS absent")?;
        if !sondage_js.ended || sondage_js.votes.get(&moi_s) != Some(&vec![json!("1")]) {
            return Err(format!("sondage JS : clos={} votes={:?}", sondage_js.ended, sondage_js.votes));
        }
        if !fil.messages.iter().any(|m| m.attachments.iter().flatten().any(|a| a.name == "js.png" && a.mime_type == "image/png")) {
            return Err("fichier JS absent".into());
        }
        if fil.messages.iter().any(|m| m.text == format!("J-à-supprimer {nonce}")) {
            return Err("message supprimé par JS encore affiché".into());
        }
        if fil.epingles.contains(&r1) {
            return Err("R1 toujours épinglé (le JS l'a désépinglé)".into());
        }
        Ok(())
    })
    .await;
    // Le fichier du JS se télécharge par le cœur, à l'identique.
    let fil = coeur.fils_actuels().into_iter().find(|f| f.salon == salon).unwrap();
    let piece = fil
        .messages
        .iter()
        .flat_map(|m| m.attachments.iter().flatten())
        .find(|a| a.name == "js.png")
        .unwrap()
        .clone();
    let cle = piece.url.strip_prefix(sion_matrix::PREFIXE_PAR_DEFAUT).unwrap().split('?').next().unwrap().to_owned();
    assert_eq!(coeur.media(&cle, false).await.expect("fichier JS"), PNG);
    ecrire(&echange.join("rust-verifie.json"), json!({ "ok": true }));
    println!("4. envois du moteur JS lus et vérifiés");
}
