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
    use tauri::http::{header, Request, Response};
    use tauri::{AppHandle, Emitter, Manager, Runtime, UriSchemeResponder};
    use tokio::sync::broadcast::error::RecvError;

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
        let coeur = Arc::new(
            CoeurMatrix::nouveau(dossier, "Sion (moteur Rust)", Arc::new(CoffreSysteme)).avec_prefixe_medias(PREFIXE_MEDIAS),
        );
        let mut etat = coeur.etat();
        let mut salons = coeur.salons();
        let mut messages = coeur.messages();
        let _ = COEUR.set(coeur);
        log::info!("[Sion][matrix] moteur Rust actif");

        // Relais de l'état de connexion et de la liste des salons vers la
        // webview. Le cœur ne republie la liste que si elle a changé.
        let app_etat = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let courant = etat.borrow_and_update().clone();
                let _ = app_etat.emit("matrix-etat", &courant);
                if etat.changed().await.is_err() {
                    break;
                }
            }
        });
        let app_salons = app.clone();
        tauri::async_runtime::spawn(async move {
            while salons.changed().await.is_ok() {
                let liste = salons.borrow_and_update().clone();
                let _ = app_salons.emit("matrix-salons", &liste);
            }
        });
        // Fil d'un salon, à chaque changement. En retard sur le cœur : on
        // renvoie tous les fils plutôt que d'en perdre un.
        let app_messages = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match messages.recv().await {
                    Ok(fil) => {
                        let _ = app_messages.emit("matrix-messages", &fil);
                    }
                    Err(RecvError::Lagged(_)) => {
                        if let Ok(coeur) = self::coeur() {
                            for fil in coeur.fils_actuels() {
                                let _ = app_messages.emit("matrix-messages", &fil);
                            }
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }

    /// Préfixe sous lequel la webview voit le protocole `sion-media` : Tauri
    /// le sert en `http://<protocole>.localhost/` sous Windows et Android.
    #[cfg(any(windows, target_os = "android"))]
    const PREFIXE_MEDIAS: &str = "http://sion-media.localhost/";
    #[cfg(not(any(windows, target_os = "android")))]
    const PREFIXE_MEDIAS: &str = sion_matrix::PREFIXE_PAR_DEFAUT;

    /// `sion-media://localhost/<clé>[?vignette=1]` : un média de message,
    /// téléchargé — et déchiffré — par le cœur. La clé désigne une source
    /// fixe : la réponse ne change jamais, le navigateur peut la garder.
    pub fn servir_media(requete: Request<Vec<u8>>, repondeur: UriSchemeResponder) {
        let cle = requete.uri().path().trim_start_matches('/').to_owned();
        let vignette = requete.uri().query().is_some_and(|q| q.split('&').any(|p| p == "vignette=1"));
        tauri::async_runtime::spawn(async move {
            let contenu = match coeur() {
                Ok(coeur) => coeur.media(&cle, vignette).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            let reponse = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            let reponse = match contenu {
                Ok(octets) => reponse
                    .header(header::CONTENT_TYPE, sion_matrix::type_mime(&octets))
                    .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                    .body(octets),
                Err(e) => {
                    log::warn!("[Sion][matrix] média {cle} indisponible : {e}");
                    reponse.status(404).body(Vec::new())
                }
            };
            match reponse {
                Ok(r) => repondeur.respond(r),
                Err(e) => log::error!("[Sion][matrix] réponse média invalide : {e}"),
            }
        });
    }

    /// Dépose un média du cœur dans le dossier du serveur média local
    /// (`/matrix/<clé>`), une fois : nom du fichier et type MIME. Appelé depuis
    /// un fil du serveur, hors de tout runtime async.
    pub fn deposer_media(cle: &str) -> Option<(String, &'static str)> {
        // Clé opaque produite par le cœur : 16 chiffres hexadécimaux, rien d'autre.
        if cle.len() != 16 || !cle.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let nom = format!("sion_mx_{cle}");
        let chemin = crate::sion_media_dir().join(&nom);
        if let Ok(mut fichier) = std::fs::File::open(&chemin) {
            use std::io::Read;
            let mut debut = [0u8; 16];
            let lus = fichier.read(&mut debut).ok()?;
            return Some((nom, sion_matrix::type_mime(&debut[..lus])));
        }
        let octets = tauri::async_runtime::block_on(coeur().ok()?.media(cle, false))
            .map_err(|e| log::warn!("[Sion][matrix] média {cle} indisponible : {e}"))
            .ok()?;
        // Déchiffré : lisible par ce seul utilisateur. Écrit à côté puis
        // renommé, pour qu'une requête concurrente ne lise jamais un fichier
        // à moitié écrit.
        let provisoire = crate::sion_media_dir().join(format!(".{nom}.{}", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let ecrit = options.open(&provisoire).and_then(|mut f| std::io::Write::write_all(&mut f, &octets));
        if let Err(e) = ecrit.and_then(|_| std::fs::rename(&provisoire, &chemin)) {
            log::warn!("[Sion][matrix] média {cle} non déposé : {e}");
            let _ = std::fs::remove_file(&provisoire);
            return None;
        }
        Some((nom, sion_matrix::type_mime(&octets)))
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

    pub fn deposer_media(_cle: &str) -> Option<(String, &'static str)> {
        None
    }

    pub fn initialiser<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {
        if std::env::var("SION_MATRIX_MOTEUR").as_deref() == Ok("rust") {
            log::warn!("[Sion][matrix] SION_MATRIX_MOTEUR=rust ignoré : Sion compilé sans la feature moteur-matrix-rust");
        }
    }
}

pub use actif::{deposer_media, initialiser};

/// Protocole `sion-media` (médias des messages du moteur Rust). Sans la
/// feature, il n'existe pas : le moteur JS n'en produit aucune URL.
pub fn enregistrer_protocole<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(feature = "moteur-matrix-rust")]
    let builder = builder.register_asynchronous_uri_scheme_protocol("sion-media", |_ctx, requete, repondeur| {
        actif::servir_media(requete, repondeur)
    });
    builder
}

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

    #[tauri::command]
    pub fn matrix_salons() -> Result<serde_json::Value, String> {
        serde_json::to_value(coeur()?.salons_actuels()).map_err(|e| e.to_string())
    }

    /// Écart de l'horloge locale avec le serveur, en minutes (0 sous 5 min).
    #[tauri::command]
    pub fn matrix_ecart_horloge() -> Result<i64, String> {
        Ok(coeur()?.ecart_horloge_minutes())
    }

    /// Dernière version de tous les fils (chargement initial de l'écran).
    #[tauri::command]
    pub fn matrix_fils() -> Result<serde_json::Value, String> {
        serde_json::to_value(coeur()?.fils_actuels()).map_err(|e| e.to_string())
    }

    /// Remonte l'historique d'un salon ; renvoie « il en reste ».
    #[tauri::command]
    pub async fn matrix_charger_historique(salon: String) -> Result<bool, String> {
        coeur()?.charger_historique(&salon).await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_marquer_lu(salon: String) -> Result<(), String> {
        coeur()?.marquer_lu(&salon).await.map_err(|e| e.to_string())
    }

    /// Résumés des épinglés d'un salon (`getPinnedSummaries`).
    #[tauri::command]
    pub async fn matrix_epingles(salon: String) -> Result<serde_json::Value, String> {
        let resumes = coeur()?.epingles(&salon).await.map_err(|e| e.to_string())?;
        serde_json::to_value(resumes).map_err(|e| e.to_string())
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

    #[tauri::command]
    pub fn matrix_salons() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub fn matrix_ecart_horloge() -> Result<i64, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub fn matrix_fils() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_charger_historique(_salon: String) -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_marquer_lu(_salon: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_epingles(_salon: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }
}

