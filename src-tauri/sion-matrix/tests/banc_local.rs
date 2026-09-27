//! Banc sur un serveur Continuwuity JETABLE (tranches T4 et T5) — ignoré par
//! défaut, jamais en CI. Ce que le compte de test réel ne permet pas : un
//! compte neuf (inscription par jeton), son amorçage, la vérification entre
//! appareils, et l'administration par un vrai compte administrateur.
//!
//! ```sh
//! docker run -d --name sion-banc-matrix -p 127.0.0.1:6167:8008 \
//!   -e CONTINUWUITY_SERVER_NAME=sion.test -e CONTINUWUITY_DATABASE_PATH=/var/lib/continuwuity \
//!   -e CONTINUWUITY_ADDRESS=0.0.0.0 -e CONTINUWUITY_ALLOW_REGISTRATION=true \
//!   -e CONTINUWUITY_REGISTRATION_TOKEN=<jeton> -e CONTINUWUITY_ALLOW_FEDERATION=false \
//!   forgejo.ellis.link/continuwuation/continuwuity:latest /sbin/conduwuit --execute "users create-user admin"
//! SION_BANC_SERVEUR=http://127.0.0.1:6167 SION_BANC_JETON=<jeton> SION_BANC_ADMIN_MDP=<mot de passe admin> \
//!   cargo test -p sion-matrix --test banc_local -- --ignored --nocapture
//! ```
#![recursion_limit = "256"]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sion_matrix::{CoeurMatrix, CoffreMemoire, EtatVerification, FilSalon};

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

fn fil(coeur: &CoeurMatrix, salon: &str) -> Option<FilSalon> {
    coeur.fils_actuels().into_iter().find(|f| f.salon == salon)
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
async fn banc_local_t4_t5() {
    let serveur = variable("SION_BANC_SERVEUR");
    let jeton = variable("SION_BANC_JETON");
    let mdp_admin = variable("SION_BANC_ADMIN_MDP");
    let nonce = std::process::id();
    let alice = format!("alice{nonce}");
    let mdp = format!("mdp-de-test-{nonce}");

    // ── Inscription (T4) : compte neuf par jeton, connecté comme appareil 1.
    let a1 = appareil("Sion — Alice 1");
    a1.coeur.inscrire(&serveur, &alice, &mdp, Some(&jeton), None).await.expect("inscription par jeton");
    let id_alice = a1.coeur.client().await.unwrap().user_id().unwrap().to_string();
    println!("1. {id_alice} inscrite et connectée");

    // ── Amorçage (T5).
    assert!(a1.coeur.a_besoin_amorcage().await.unwrap(), "compte neuf : amorçage requis");
    let cle = a1.coeur.amorcer(Some(&mdp)).await.expect("amorçage");
    assert!(!a1.coeur.a_besoin_amorcage().await.unwrap());
    assert!(a1.coeur.appareil_verifie().await.unwrap(), "appareil amorceur vérifié");
    assert!(a1.coeur.amorcer(Some(&mdp)).await.is_err(), "second amorçage REFUSÉ");
    println!("2. compte amorcé ; second amorçage refusé");

    // Un salon chiffré et un message, sauvegardé.
    let salon = a1.coeur.creer_salon("Banc chiffré", false, false, true).await.expect("salon chiffré");
    let texte = format!("secret {nonce}");
    let _ = attendre("salon chiffré connu", || a1.coeur.salons_actuels().into_iter().find(|s| s.id == salon)).await;
    a1.coeur.envoyer_texte(&salon, &texte).await.expect("message chiffré");
    let client1 = a1.coeur.client().await.unwrap();
    client1.encryption().backups().wait_for_steady_state().await.expect("sauvegarde envoyée");

    // ── Appareil 2 : indéchiffrable, puis récupération par la clé.
    let a2 = appareil("Sion — Alice 2");
    a2.coeur.connecter(&serveur, &alice, &mdp).await.expect("appareil 2");
    assert!(!a2.coeur.appareil_verifie().await.unwrap(), "appareil 2 pas encore vérifié");
    a2.coeur.charger_historique(&salon).await.ok();
    attendre("message indéchiffrable sur l'appareil 2", || {
        fil(&a2.coeur, &salon).filter(|f| f.messages.iter().any(|m| m.msgtype.as_deref() == Some("m.encrypted")))
    })
    .await;
    assert!(a2.coeur.messages_indechiffrables());
    let id_utd = fil(&a2.coeur, &salon)
        .and_then(|f| f.messages.iter().find(|m| m.msgtype.as_deref() == Some("m.encrypted")).map(|m| m.id.clone()))
        .unwrap();
    let restaures = a2.coeur.restaurer_par_cle(&cle).await.expect("récupération par clé");
    assert!(restaures >= 1);
    {
        // Diagnostic : la clé est-elle importée (déchiffrement direct) ?
        let client2 = a2.coeur.client().await.unwrap();
        let room = client2.get_room(&matrix_sdk::ruma::RoomId::parse(&salon).unwrap()).unwrap();
        let ev = room.event(&matrix_sdk::ruma::EventId::parse(&id_utd).unwrap(), None).await.unwrap();
        println!(
            "   diagnostic : sauvegardes actives={} état={:?} déchiffrement direct={}",
            client2.encryption().backups().are_enabled().await,
            client2.encryption().backups().state(),
            !matches!(ev.kind, matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt { .. })
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (cache, _) = room.event_cache().await.unwrap();
        let evs = cache.events().await.unwrap();
        let utd: Vec<_> = evs
            .iter()
            .filter(|e| e.event_id().is_some_and(|i| i.as_str() == id_utd))
            .map(|e| matches!(e.kind, matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt { .. }))
            .collect();
        println!("   diagnostic : dans le cache, l'événement est encore indéchiffrable = {utd:?} ({} événements)", evs.len());
    }
    assert!(a2.coeur.appareil_verifie().await.unwrap(), "vérifié par la clé de récupération");
    attendre("message re-déchiffré sur l'appareil 2", || {
        fil(&a2.coeur, &salon).filter(|f| f.messages.iter().any(|m| m.text == texte))
    })
    .await;
    println!("3. appareil 2 : indéchiffrable → clé de récupération → vérifié, message lu");
    // Une demande de vérification part vers TOUS les appareils du compte, et
    // chacun l'accepte ; celui qui n'est pas retenu est annulé. Pour une
    // vérification entre l'appareil 1 et l'appareil 3 seulement :
    a2.coeur.deconnecter().await.expect("déconnexion de l'appareil 2");

    // ── Appareil 3 : vérification par emojis avec l'appareil 1.
    let a3 = appareil("Sion — Alice 3");
    a3.coeur.connecter(&serveur, &alice, &mdp).await.expect("appareil 3");
    // L'appareil 1 doit connaître l'appareil 3 pour accepter sa demande.
    tokio::time::sleep(Duration::from_secs(2)).await;
    a3.coeur.demarrer_verification().await.expect("demande de vérification");
    let e3 = etape_de_verification(&a3.coeur, "comparing").await;
    let e1 = etape_de_verification(&a1.coeur, "comparing").await;
    assert_eq!(e1.emojis, e3.emojis, "mêmes emojis des deux côtés");
    assert_eq!(e1.emojis.len(), 7);
    a1.coeur.confirmer_emojis().await.expect("confirmation 1");
    a3.coeur.confirmer_emojis().await.expect("confirmation 3");
    etape_de_verification(&a3.coeur, "done").await;
    etape_de_verification(&a1.coeur, "done").await;
    let emojis: Vec<_> = e3.emojis.iter().map(|e| e.emoji.as_str()).collect();
    println!("4. appareil 3 vérifié par emojis {}", emojis.join(" "));
    assert!(a3.coeur.appareil_verifie().await.unwrap(), "appareil 3 vérifié par l'appareil 1");
    // Les secrets reçus de l'appareil 1 permettent de lire l'historique.
    a3.coeur.charger_historique(&salon).await.ok();
    let mut lu = false;
    for _ in 0..40 {
        let _ = a3.coeur.restaurer_automatiquement().await;
        if fil(&a3.coeur, &salon).is_some_and(|f| f.messages.iter().any(|m| m.text == texte)) {
            lu = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    println!("   historique lisible sur l'appareil 3 après vérification : {lu}");
    assert!(lu, "l'appareil vérifié doit recevoir la clé de sauvegarde et lire l'historique");

    // ── Nouvelle clé de récupération : l'ancienne ne vaut plus, la nouvelle oui.
    let nouvelle = a1.coeur.nouvelle_cle_recuperation().await.expect("nouvelle clé");
    assert_ne!(nouvelle, cle);
    let a4 = appareil("Sion — Alice 4");
    a4.coeur.connecter(&serveur, &alice, &mdp).await.expect("appareil 4");
    assert!(a4.coeur.restaurer_par_cle(&cle).await.is_err(), "ancienne clé refusée");
    a4.coeur.restaurer_par_cle(&nouvelle).await.expect("nouvelle clé acceptée");
    assert!(a4.coeur.appareil_verifie().await.unwrap());
    println!("5. nouvelle clé de récupération : ancienne refusée, nouvelle acceptée");

    // ── Administration (T4) par le compte administrateur du banc.
    let admin = appareil("Sion — admin du banc");
    admin.coeur.connecter(&serveur, "admin", &mdp_admin).await.expect("connexion admin");
    let salon_admin = attendre("salon d'administration rejoint", || {
        admin.coeur.salons_actuels().into_iter().find(|s| s.name.to_lowercase().contains("admin")).map(|s| s.id)
    })
    .await;
    // Les membres du salon doivent être connus pour reconnaître le robot.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(admin.coeur.salon_admin().await.unwrap().as_deref(), Some(salon_admin.as_str()));
    let liste = admin.coeur.commande_admin("!admin users list-users").await.expect("commande au robot");
    assert!(liste.contains(&id_alice), "list-users cite Alice : {liste}");
    let salons_admin = admin.coeur.requete_admin("GET", "/_continuwuity/admin/rooms/list", None, true).await.unwrap();
    let suspension = admin
        .coeur
        .requete_admin("GET", &format!("/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/{}", id_alice.replace('@', "%40").replace(':', "%3A")), None, true)
        .await
        .unwrap();
    println!("6. robot : list-users OK ; API admin salons → {} ; suspension d'Alice → {} {}", salons_admin.status, suspension.status, suspension.corps);

    // Salon public : Alice y est ajoutée d'office par le robot.
    let public = admin.coeur.creer_salon("Banc public", false, true, false).await.expect("salon public");
    attendre("Alice ajoutée au salon public", || a1.coeur.salons_actuels().into_iter().find(|s| s.id == public)).await;
    // L'état du salon tout neuf doit être arrivé chez l'administrateur (sinon
    // matrix-sdk ne connaît pas encore ses niveaux : `InsufficientData`).
    attendre("salon public synchronisé chez l'admin", || admin.coeur.salons_actuels().into_iter().find(|s| s.id == public)).await;
    admin.coeur.changer_niveau(&public, &id_alice, 50).await.expect("niveau");
    // Le nouvel état des niveaux revient par la synchro.
    let mut niveau = None;
    for _ in 0..120 {
        let d = admin.coeur.details_salon(&public).await.unwrap();
        niveau = d.membres.iter().find(|m| m.user_id == id_alice).map(|m| m.power_level);
        if niveau == Some(50) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(niveau, Some(50));
    admin.coeur.expulser(&public, &id_alice, Some("banc")).await.expect("expulsion");
    attendre("Alice expulsée", || {
        (!a1.coeur.salons_actuels().iter().any(|s| s.id == public)).then_some(())
    })
    .await;
    admin.coeur.inviter(&public, &id_alice).await.expect("invitation");
    // L'invitation est acceptée d'office par la synchro d'Alice.
    attendre("Alice revenue par invitation", || a1.coeur.salons_actuels().into_iter().find(|s| s.id == public)).await;
    admin.coeur.bannir(&public, &id_alice, Some("banc")).await.expect("bannissement");
    println!("7. salon public : ajout d'office, niveau 50, expulsion, invitation acceptée, bannissement");

    // ── Compte d'Alice : nom, avatar, mot de passe.
    a1.coeur.changer_nom("Alice du banc").await.expect("nom");
    assert_eq!(admin.coeur.nom_utilisateur(&id_alice).await.unwrap().as_deref(), Some("Alice du banc"));
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49,
        0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    assert!(a1.coeur.changer_avatar(PNG.to_vec(), "image/png").await.expect("avatar").is_some());
    assert!(admin.coeur.avatar_utilisateur(&id_alice).await.unwrap().is_some());
    let nouveau_mdp = format!("{mdp}-2");
    a1.coeur.changer_mot_de_passe(&mdp, &nouveau_mdp).await.expect("mot de passe");
    let a5 = appareil("Sion — Alice 5");
    a5.coeur.connecter(&serveur, &alice, &nouveau_mdp).await.expect("connexion avec le nouveau mot de passe");
    assert!(!a5.coeur.est_suspendu().await.unwrap());
    println!("8. compte : nom, avatar, mot de passe changés ; non suspendu");

    for a in [&a5, &a4, &a3, &admin] {
        let _ = a.coeur.deconnecter().await;
    }
    let _ = a1.coeur.deconnecter().await;
}
