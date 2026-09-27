//! Gestion (tranche T4) sur un VRAI compte — ignoré par défaut, jamais en CI.
//!
//! Seulement ce qui ne dérange personne : lecture des membres et niveaux,
//! création d'un salon PRIVÉ de test (quitté aussitôt), renommage et sujet du
//! salon de test, MP existant retrouvé sans rien créer, appareils (un second
//! appareil du test est supprimé par le premier, mot de passe à l'appui),
//! mandataire d'administration, salon d'administration, inscription (étapes
//! seulement). Jamais : invitation, expulsion, bannissement (il faudrait une
//! vraie personne), nom ou avatar du compte (visibles dans tous les salons),
//! mot de passe, salon public (il serait ouvert à tout le serveur).
//!
//! ```sh
//! SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
//!   cargo test -p sion-matrix --test gestion_reelle -- --ignored --nocapture
//! ```
#![recursion_limit = "256"]
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::RoomId;
use serde_json::Value;
use sion_matrix::{CoeurMatrix, CoffreMemoire};

const NOM_BANC: &str = "Sion — banc d'essai des moteurs";
const NOM_CREATION: &str = "Sion — essai création (test)";

fn variable(nom: &str) -> Option<String> {
    std::env::var(nom).ok().filter(|v| !v.is_empty())
}

async fn attendre<T>(quoi: &str, mut essai: impl FnMut() -> Option<T>) -> T {
    for _ in 0..120 {
        if let Some(v) = essai() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("{quoi} : jamais arrivé");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : variables SION_TEST_* requises"]
async fn gestion_sur_un_compte_reel() {
    let (Some(serveur), Some(identifiant), Some(mot_de_passe)) =
        (variable("SION_TEST_SERVEUR"), variable("SION_TEST_IDENTIFIANT"), variable("SION_TEST_MOT_DE_PASSE"))
    else {
        panic!("SION_TEST_SERVEUR, SION_TEST_IDENTIFIANT et SION_TEST_MOT_DE_PASSE requis");
    };
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — gestion (test)", Arc::new(CoffreMemoire::default()));
    coeur.connecter(&serveur, &identifiant, &mot_de_passe).await.expect("connexion");
    let resultat = AssertUnwindSafe(deroule(&coeur, &serveur, &identifiant, &mot_de_passe)).catch_unwind().await;
    coeur.deconnecter().await.expect("déconnexion");
    if let Err(panique) = resultat {
        std::panic::resume_unwind(panique);
    }
}

async fn deroule(coeur: &CoeurMatrix, serveur: &str, identifiant: &str, mot_de_passe: &str) {
    let client = coeur.client().await.unwrap();
    let moi = client.user_id().unwrap().to_string();
    let salons = attendre("liste des salons", || Some(coeur.salons_actuels()).filter(|l| !l.is_empty())).await;
    // Restes d'un passage interrompu : quittés et oubliés.
    for reste in salons.iter().filter(|s| s.name == NOM_CREATION) {
        let _ = coeur.quitter(&reste.id).await;
        if let Some(s) = client.get_room(&RoomId::parse(&reste.id).unwrap()) {
            let _ = s.forget().await;
        }
        println!("0. reste d'un passage précédent quitté : {}", reste.id);
    }

    // 1. Membres et niveaux du salon de test : j'en suis le créateur.
    let banc = salons.iter().find(|s| s.name == NOM_BANC).expect("salon de test (lancer aller-retour.sh une fois)");
    let d = coeur.details_salon(&banc.id).await.expect("détails");
    assert!(d.membres.iter().any(|m| m.user_id == moi), "je suis membre du salon de test");
    assert!(d.moi >= 100 && d.peut_ecrire, "créateur : niveau {} ", d.moi);
    println!("1. salon de test : {} membre(s), mon niveau {}", d.membres.len(), if d.moi == i64::MAX { "∞".into() } else { d.moi.to_string() });

    // 2. Renommage et sujet, puis retour à l'état d'origine.
    let sujet = format!("sujet de test {}", std::process::id());
    coeur.changer_sujet(&banc.id, &sujet).await.expect("sujet");
    coeur.renommer_salon(&banc.id, &format!("{NOM_BANC} (renommé)")).await.expect("renommage");
    attendre("nom et sujet republiés", || {
        coeur.salons_actuels().into_iter().find(|s| s.id == banc.id).filter(|s| s.name.ends_with("(renommé)") && s.topic.as_deref() == Some(sujet.as_str()))
    })
    .await;
    coeur.renommer_salon(&banc.id, NOM_BANC).await.expect("renommage inverse");
    coeur.changer_sujet(&banc.id, "").await.expect("sujet vidé");
    println!("2. renommage et sujet aller-retour");

    // 3. Salon privé vocal : état initial identique au JS, puis quitté.
    let nouveau = coeur.creer_salon(NOM_CREATION, true, false, false).await.expect("création");
    let salon = client.get_room(&RoomId::parse(&nouveau).unwrap()).expect("salon créé connu");
    let etat = |t: &str| {
        let salon = salon.clone();
        let t = t.to_owned();
        async move {
            // L'état d'un salon tout juste créé arrive par la synchro suivante.
            let mut brut = None;
            for _ in 0..120 {
                brut = salon.get_state_event(StateEventType::from(t.as_str()), "").await.unwrap();
                if brut.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let brut = brut.unwrap_or_else(|| panic!("état {t} jamais reçu"));
            let json = match brut {
                matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(e) => e.json().get().to_owned(),
                matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Stripped(e) => e.json().get().to_owned(),
            };
            serde_json::from_str::<Value>(&json).unwrap()["content"].clone()
        }
    };
    assert_eq!(etat("m.room.type").await["type"], "m.voice_channel");
    assert_eq!(etat("m.room.topic").await["topic"], "voice");
    assert_eq!(etat("m.room.join_rules").await["join_rule"], "invite");
    assert_eq!(etat("m.room.history_visibility").await["history_visibility"], "shared");
    let niveaux = etat("m.room.power_levels").await;
    assert_eq!(niveaux["events"]["org.matrix.msc3401.call.member"], 0);
    assert_eq!(niveaux["events"]["com.sion.client_version"], 0);
    // Salon privé : pas d'ouverture à tout le serveur ; règle inchangée.
    coeur.changer_regle_acces(&nouveau, false).await.expect("règle d'accès");
    // Mon propre niveau : infini en salon v12 (créateur) — matrix-sdk refuse
    // à raison de l'inscrire dans la table (`CreatorInUsersMap`).
    let details = coeur.details_salon(&nouveau).await.expect("détails du salon créé");
    if details.moi != i64::MAX {
        coeur.changer_niveau(&nouveau, &moi, 100).await.expect("niveau");
    } else {
        assert!(coeur.changer_niveau(&nouveau, &moi, 100).await.is_err());
    }
    coeur.quitter(&nouveau).await.expect("départ");
    if let Some(s) = client.get_room(salon.room_id()) {
        let _ = s.forget().await;
    }
    println!("3. salon privé vocal créé conforme, quitté");

    // 4. MP existant retrouvé, sans rien créer.
    let mp = salons.iter().find(|s| s.is_dm && s.dm_user_id.is_some());
    if let Some(mp) = mp {
        let pair = mp.dm_user_id.clone().unwrap();
        let details = coeur.details_salon(&mp.id).await.expect("détails du MP");
        if details.membres.iter().any(|m| m.user_id == pair) {
            assert_eq!(coeur.mp_avec(&pair).await.expect("MP"), mp.id, "le MP existant est réutilisé");
            println!("4. MP avec {pair} retrouvé");
        }
    }

    // 5. Profils.
    let nom = coeur.nom_utilisateur(&moi).await.expect("nom");
    assert!(nom.is_some());
    assert!(!coeur.est_suspendu().await.expect("suspension"));
    println!("5. profil lu ({}), compte non suspendu", nom.unwrap());

    // 6. Appareils : un second appareil du test, supprimé par le premier.
    let dossier = tempfile::tempdir().unwrap();
    let second = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — gestion (second)", Arc::new(CoffreMemoire::default()));
    second.connecter(serveur, identifiant, mot_de_passe).await.expect("second appareil");
    let id_second = second.client().await.unwrap().device_id().unwrap().to_string();
    second.fermer().await;
    assert!(coeur.appareils().await.expect("appareils").iter().any(|a| a.device_id == id_second));
    coeur.supprimer_appareil(&id_second, mot_de_passe).await.expect("suppression d'appareil");
    assert!(!coeur.appareils().await.expect("appareils").iter().any(|a| a.device_id == id_second));
    println!("6. second appareil {id_second} supprimé par mot de passe (UIA)");

    // 7. Administration.
    let version = coeur.requete_admin("GET", "/_continuwuity/server_version", None, false).await.expect("version");
    assert_eq!(version.status, 200, "{:?}", version.corps);
    let liste = coeur.requete_admin("GET", "/_continuwuity/admin/rooms/list", None, true).await.expect("liste admin");
    assert!(coeur.requete_admin("GET", "/_matrix/client/v3/account/whoami", None, true).await.is_err(), "hors liste blanche");
    let admin = coeur.salon_admin().await.expect("salon admin");
    let admins = coeur.admins_serveur().await.expect("admins");
    println!(
        "7. serveur {} {} ; liste admin → {} ; salon admin {:?} ; {} admin(s) connu(s)",
        version.corps["name"], version.corps["version"], liste.status, admin, admins.len()
    );
    if admin.is_none() {
        let e = coeur.commande_admin("!admin users list-users").await.expect_err("sans salon admin");
        assert!(e.to_string().contains("Admin room not found"));
    }

    // 8. Inscription : étapes seulement.
    let etapes = CoeurMatrix::etapes_inscription(serveur).await;
    println!("8. inscription : fermée={} étapes={}", etapes.disabled, etapes.flows);
}
