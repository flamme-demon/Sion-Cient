//! Pont Tauri du cœur Matrix en Rust (`sion-matrix`).
//!
//! Compilé pour de vrai seulement avec la feature `moteur-matrix-rust`, et
//! actif seulement si Sion est lancé avec `SION_MATRIX_MOTEUR=rust` : le
//! moteur JS reste celui par défaut jusqu'à la parité (voir
//! `docs/plan-matrix-rust-sdk.md`). Sans la feature, les commandes existent
//! mais répondent « moteur JS », pour que l'interface n'ait qu'un seul code.

/// Moteur Matrix de ce lancement : « rust » ou « js ».
#[tauri::command]
pub fn matrix_moteur() -> &'static str {
    actif::moteur()
}

#[cfg(feature = "moteur-matrix-rust")]
mod actif {
    use std::sync::{Arc, OnceLock};

    use sion_matrix::{CoeurMatrix, Coffre};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    static COEUR: OnceLock<Arc<CoeurMatrix>> = OnceLock::new();

    pub fn moteur() -> &'static str {
        if std::env::var("SION_MATRIX_MOTEUR").as_deref() == Ok("rust") {
            "rust"
        } else {
            "js"
        }
    }

    /// Coffre du système, sur une entrée DISTINCTE de la session JS : les deux
    /// moteurs sont deux appareils différents et ne partagent rien.
    struct CoffreSysteme;

    #[cfg(not(target_os = "android"))]
    impl CoffreSysteme {
        fn entree() -> Option<keyring::Entry> {
            keyring::Entry::new("com.sion.client", "session-matrix-rust").ok()
        }
    }

    #[cfg(not(target_os = "android"))]
    impl Coffre for CoffreSysteme {
        fn lire(&self) -> Option<String> {
            Self::entree()?.get_password().ok()
        }

        /// Écrit puis relit : sans feature de trousseau, `keyring` compile un
        /// faux coffre qui « réussit » sans rien garder (voir
        /// `secure_session_set_verified`).
        fn ecrire(&self, secret: &str) -> bool {
            let Some(entree) = Self::entree() else { return false };
            entree.set_password(secret).is_ok() && self.lire().as_deref() == Some(secret)
        }

        fn effacer(&self) {
            if let Some(entree) = Self::entree() {
                let _ = entree.delete_credential();
            }
        }
    }

    /// Android : pas de coffre système, les secrets restent dans le fichier
    /// de session — comme la session JS.
    #[cfg(target_os = "android")]
    impl Coffre for CoffreSysteme {
        fn lire(&self) -> Option<String> {
            None
        }
        fn ecrire(&self, _secret: &str) -> bool {
            false
        }
        fn effacer(&self) {}
    }

    pub fn initialiser<R: Runtime>(app: &AppHandle<R>) {
        if moteur() != "rust" {
            return;
        }
        let dossier = match app.path().app_data_dir() {
            Ok(d) => d.join("matrix-rust"),
            Err(e) => {
                log::error!("[Sion][matrix] dossier de données introuvable : {e}");
                return;
            }
        };
        let coeur = Arc::new(CoeurMatrix::nouveau(dossier, "Sion (moteur Rust)", Arc::new(CoffreSysteme)));
        let mut etat = coeur.etat();
        let _ = COEUR.set(coeur);
        log::info!("[Sion][matrix] moteur Rust actif");

        // Relais de l'état de connexion vers la webview.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let courant = etat.borrow_and_update().clone();
                let _ = app.emit("matrix-etat", &courant);
                if etat.changed().await.is_err() {
                    break;
                }
            }
        });
    }

    pub fn coeur() -> Result<&'static Arc<CoeurMatrix>, String> {
        COEUR.get().ok_or_else(|| "moteur Matrix Rust inactif".to_string())
    }
}

#[cfg(not(feature = "moteur-matrix-rust"))]
mod actif {
    pub fn moteur() -> &'static str {
        "js"
    }

    pub fn initialiser<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {
        if std::env::var("SION_MATRIX_MOTEUR").as_deref() == Ok("rust") {
            log::warn!("[Sion][matrix] SION_MATRIX_MOTEUR=rust ignoré : Sion compilé sans la feature moteur-matrix-rust");
        }
    }
}

pub use actif::initialiser;

#[cfg(feature = "moteur-matrix-rust")]
pub mod commandes {
    use super::actif::coeur;

    #[tauri::command]
    pub fn matrix_etat() -> Result<serde_json::Value, String> {
        serde_json::to_value(coeur()?.etat_actuel()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_connecter(serveur: String, identifiant: String, mot_de_passe: String) -> Result<(), String> {
        coeur()?.connecter(&serveur, &identifiant, &mot_de_passe).await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_reprendre() -> Result<bool, String> {
        coeur()?.reprendre().await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_deconnecter() -> Result<(), String> {
        coeur()?.deconnecter().await.map_err(|e| e.to_string())
    }
}

#[cfg(not(feature = "moteur-matrix-rust"))]
pub mod commandes {
    const INACTIF: &str = "moteur Matrix Rust non compilé (feature moteur-matrix-rust)";

    #[tauri::command]
    pub fn matrix_etat() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_connecter(_serveur: String, _identifiant: String, _mot_de_passe: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_reprendre() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_deconnecter() -> Result<(), String> {
        Err(INACTIF.into())
    }
}

