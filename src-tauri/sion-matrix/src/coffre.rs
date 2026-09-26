//! Où ranger les secrets (jetons d'accès, phrase de passe des magasins).
//!
//! Fourni par l'application : sous Linux, Windows et macOS, le coffre du
//! système (`keyring`) ; sous Android, aucun — la session garde alors ses
//! secrets dans son fichier, comme la session JS historique.
use std::sync::Mutex;

pub trait Coffre: Send + Sync {
    /// Le secret rangé, s'il y en a un.
    fn lire(&self) -> Option<String>;
    /// Range le secret et renvoie `true` **seulement si une relecture le
    /// confirme** : un faux coffre qui « réussit » sans rien garder ferait
    /// perdre la session au redémarrage suivant (vécu avec `keyring`, voir
    /// `secure_session_set_verified` dans `lib.rs`).
    fn ecrire(&self, secret: &str) -> bool;
    fn effacer(&self);
}

/// Coffre en mémoire : tests, et plateformes sans coffre si on accepte de
/// perdre la session à chaque lancement.
#[derive(Default)]
pub struct CoffreMemoire {
    secret: Mutex<Option<String>>,
    /// Simule un coffre qui refuse d'écrire (Android, keyring absent).
    pub refuse: bool,
}

impl CoffreMemoire {
    /// Un coffre qui refuse toute écriture (Android, keyring absent).
    pub fn refusant() -> Self {
        Self { refuse: true, ..Default::default() }
    }
}

impl Coffre for CoffreMemoire {
    fn lire(&self) -> Option<String> {
        self.secret.lock().unwrap().clone()
    }

    fn ecrire(&self, secret: &str) -> bool {
        if self.refuse {
            return false;
        }
        *self.secret.lock().unwrap() = Some(secret.to_owned());
        true
    }

    fn effacer(&self) {
        *self.secret.lock().unwrap() = None;
    }
}
