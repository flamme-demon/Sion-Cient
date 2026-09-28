//! Banc sur le serveur Continuwuity JETABLE (voir `banc_local.rs` pour le
//! lancer) : « en train d'écrire », « vu par », salons en commun,
//! signalement, bannière, utilisateurs ignorés et suppression de compte,
//! entre comptes neufs. Ignoré par défaut, jamais en CI.
//!
//! ```sh
//! SION_BANC_SERVEUR=http://127.0.0.1:6167 SION_BANC_JETON=<jeton> \
//!   cargo test -p sion-matrix --test entre_membres -- --ignored --nocapture
//! ```
#![recursion_limit = "256"]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sion_matrix::{CoeurMatrix, CoffreMemoire, EtatConnexion, FilSalon};

const ATTENTE: Duration = Duration::from_secs(60);

/// PNG 1×1 transparent.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01,
    0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

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

fn textes(coeur: &CoeurMatrix, salon: &str) -> Vec<String> {
    fil(coeur, salon).map(|f| f.messages.iter().map(|m| m.text.clone()).collect()).unwrap_or_default()
}

async fn inscrire(serveur: &str, jeton: &str, nom: &str, mdp: &str) -> (Appareil, String) {
    let a = appareil(&format!("Sion — {nom}"));
    a.coeur.inscrire(serveur, nom, mdp, Some(jeton), None).await.unwrap_or_else(|e| panic!("inscription de {nom} : {e}"));
    let id = a.coeur.client().await.unwrap().user_id().unwrap().to_string();
    (a, id)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "serveur jetable : variables SION_BANC_* requises"]
async fn entre_membres() {
    let serveur = variable("SION_BANC_SERVEUR");
    let jeton = variable("SION_BANC_JETON");
    let nonce = std::process::id();
    let mdp = format!("mdp-de-test-{nonce}");

    let (alice, id_alice) = inscrire(&serveur, &jeton, &format!("alice{nonce}"), &mdp).await;
    let (bob, id_bob) = inscrire(&serveur, &jeton, &format!("bob{nonce}"), &mdp).await;

    // Un salon privé d'Alice où Bob est invité (il accepte d'office).
    let salon = alice.coeur.creer_salon("Banc entre membres", false, false, false).await.expect("salon");
    alice.coeur.inviter(&salon, &id_bob).await.expect("invitation");
    attendre("Bob dans le salon", || bob.coeur.salons_actuels().into_iter().find(|s| s.id == salon)).await;
    alice.coeur.envoyer_texte(&salon, "bonjour Bob").await.expect("message");
    attendre("message chez Bob", || textes(&bob.coeur, &salon).contains(&"bonjour Bob".to_string()).then_some(())).await;
    println!("1. {id_alice} et {id_bob} dans le même salon");

    // ── « En train d'écrire »
    let mut frappes = bob.coeur.frappes();
    alice.coeur.ecrire(&salon, true).await.expect("j'écris");
    let frappe = tokio::time::timeout(ATTENTE, async {
        loop {
            let f = frappes.recv().await.unwrap();
            if f.salon == salon && !f.personnes.is_empty() {
                return f;
            }
        }
    })
    .await
    .expect("frappe d'Alice jamais reçue");
    assert_eq!(frappe.personnes[0].id, id_alice);
    assert!(!frappe.personnes[0].nom.is_empty());
    alice.coeur.ecrire(&salon, false).await.expect("j'ai fini");
    tokio::time::timeout(ATTENTE, async {
        loop {
            let f = frappes.recv().await.unwrap();
            if f.salon == salon && f.personnes.is_empty() {
                return;
            }
        }
    })
    .await
    .expect("fin de frappe jamais reçue");
    println!("2. frappe d'Alice vue par Bob ({}), puis terminée", frappe.personnes[0].nom);

    // ── « Vu par » : Bob lit, Alice le voit sur son message.
    let message = fil(&alice.coeur, &salon).unwrap().messages.iter().find(|m| m.text == "bonjour Bob").unwrap().event_id.clone();
    bob.coeur.marquer_lu(&salon).await.expect("accusé de Bob");
    attendre("Bob dans « vu par » chez Alice", || {
        alice
            .coeur
            .lectures_actuelles()
            .into_iter()
            .find(|l| l.salon == salon)
            .and_then(|l| l.lectures.get(&message).cloned())
            .filter(|lecteurs| lecteurs.iter().any(|p| p.id == id_bob))
    })
    .await;
    println!("3. « vu par » : Bob sur « bonjour Bob »");

    // ── Salons en commun
    let communs = alice.coeur.salons_en_commun(&id_bob).await.expect("salons en commun");
    assert!(communs.contains(&salon), "le salon partagé manque : {communs:?}");
    println!("4. salons en commun : {}", communs.len());

    // ── Signalement
    bob.coeur.signaler(&salon, &message, Some("essai du banc".into())).await.expect("signalement");
    println!("5. message signalé");

    // ── Bannière
    let url = alice.coeur.changer_banniere(Some((PNG.to_vec(), "image/png".into()))).await.expect("bannière posée");
    assert!(url.is_some());
    assert!(bob.coeur.banniere(&id_alice).await.expect("bannière lue").is_some(), "Bob ne voit pas la bannière");
    alice.coeur.changer_banniere(None).await.expect("bannière retirée");
    assert!(bob.coeur.banniere(&id_alice).await.expect("bannière relue").is_none(), "bannière toujours là");
    println!("6. bannière posée, vue, retirée");

    // ── Ignorer : les messages d'Alice disparaissent chez Bob, sans vider
    // le fil ; ne plus ignorer les fait revenir.
    bob.coeur.envoyer_texte(&salon, "réponse de Bob").await.expect("message de Bob");
    attendre("réponse chez Bob", || textes(&bob.coeur, &salon).contains(&"réponse de Bob".to_string()).then_some(())).await;
    bob.coeur.ignorer(&id_alice).await.expect("ignorer");
    assert_eq!(bob.coeur.ignores().await.unwrap(), vec![id_alice.clone()]);
    attendre("messages d'Alice masqués chez Bob", || {
        let t = textes(&bob.coeur, &salon);
        (!t.contains(&"bonjour Bob".to_string()) && t.contains(&"réponse de Bob".to_string())).then_some(())
    })
    .await;
    alice.coeur.envoyer_texte(&salon, "tu m'ignores ?").await.expect("message ignoré");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!textes(&bob.coeur, &salon).contains(&"tu m'ignores ?".to_string()), "message d'une ignorée affiché");
    bob.coeur.ne_plus_ignorer(&id_alice).await.expect("ne plus ignorer");
    assert!(bob.coeur.ignores().await.unwrap().is_empty());
    attendre("messages d'Alice revenus chez Bob", || textes(&bob.coeur, &salon).contains(&"bonjour Bob".to_string()).then_some(())).await;
    println!("7. ignorée : messages masqués, fil conservé ; plus ignorée : messages revenus");

    // ── Suppression de compte
    let nom_carol = format!("carol{nonce}");
    let (carol, _) = inscrire(&serveur, &jeton, &nom_carol, &mdp).await;
    assert!(carol.coeur.supprimer_compte("mauvais", false).await.is_err(), "mot de passe faux accepté");
    assert!(matches!(carol.coeur.etat_actuel(), EtatConnexion::Connecte { .. }), "un refus ne doit rien défaire");
    carol.coeur.supprimer_compte(&mdp, true).await.expect("suppression");
    assert_eq!(carol.coeur.etat_actuel(), EtatConnexion::Deconnecte);
    let autre = appareil("Sion — Carol, après");
    assert!(autre.coeur.connecter(&serveur, &nom_carol, &mdp).await.is_err(), "compte supprimé encore utilisable");
    println!("8. compte supprimé : mauvais mot de passe refusé, puis désactivé");

    for a in [&alice, &bob] {
        a.coeur.deconnecter().await.ok();
    }
}
