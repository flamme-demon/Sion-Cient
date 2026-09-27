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
        let mut verification = coeur.verification();
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
        // Étapes de la vérification par emojis (T5).
        let app_verification = app.clone();
        tauri::async_runtime::spawn(async move {
            while verification.changed().await.is_ok() {
                let etat = verification.borrow_and_update().clone();
                let _ = app_verification.emit("matrix-verification", &etat);
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

    // ── Envoi (T3) : chaque commande rend l'identifiant serveur de l'événement.

    fn erreur(e: sion_matrix::Erreur) -> String {
        e.to_string()
    }

    #[tauri::command]
    pub async fn matrix_envoyer_texte(salon: String, corps: String) -> Result<String, String> {
        coeur()?.envoyer_texte(&salon, &corps).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_repondre(salon: String, cible: String, corps: String) -> Result<String, String> {
        coeur()?.repondre(&salon, &cible, &corps).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_editer(salon: String, cible: String, texte: String) -> Result<String, String> {
        coeur()?.editer(&salon, &cible, &texte).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_supprimer(salon: String, cible: String) -> Result<(), String> {
        coeur()?.supprimer(&salon, &cible).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_reagir(salon: String, cible: String, cle: String) -> Result<String, String> {
        coeur()?.reagir(&salon, &cible, &cle).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_poker(salon: String) -> Result<String, String> {
        coeur()?.poker(&salon).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_creer_sondage(
        salon: String,
        question: String,
        options: Vec<String>,
        secret: bool,
        max: u32,
        fin: Option<i64>,
    ) -> Result<String, String> {
        coeur()?.creer_sondage(&salon, &question, &options, secret, max, fin).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_voter(salon: String, sondage: String, reponses: Vec<String>) -> Result<String, String> {
        coeur()?.voter(&salon, &sondage, &reponses).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_clore_sondage(salon: String, sondage: String) -> Result<String, String> {
        coeur()?.clore_sondage(&salon, &sondage).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_epingler(salon: String, cible: String) -> Result<(), String> {
        coeur()?.epingler(&salon, &cible).await.map_err(erreur)
    }

    /// Fichier déposé par `stage_media` (voir `lire_depot`).
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_envoyer_fichier(
        salon: String,
        chemin: String,
        nom: String,
        mime: String,
        largeur: Option<u32>,
        hauteur: Option<u32>,
        duree_ms: Option<u64>,
    ) -> Result<String, String> {
        let octets = lire_depot(&chemin)?;
        let infos = sion_matrix::InfosMedia { largeur, hauteur, duree_ms };
        coeur()?.envoyer_fichier(&salon, octets, &nom, &mime, infos).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_envoyer_image_url(salon: String, url: String) -> Result<String, String> {
        coeur()?.envoyer_image_url(&salon, &url).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_taille_max_envoi() -> Result<u64, String> {
        coeur()?.taille_max_envoi().await.map_err(erreur)
    }
    // ── Membres, salons, compte, administration (T4) ─────────────────────────

    fn json<T: serde::Serialize>(r: Result<T, sion_matrix::Erreur>) -> Result<serde_json::Value, String> {
        serde_json::to_value(r.map_err(erreur)?).map_err(|e| e.to_string())
    }

    /// Octets d'un fichier déposé par `stage_media`, effacé une fois lu. Il
    /// doit être DANS le dossier média : sinon la commande lirait n'importe
    /// quel fichier du disque.
    fn lire_depot(chemin: &str) -> Result<Vec<u8>, String> {
        let dossier = crate::sion_media_dir().canonicalize().map_err(|e| format!("dossier média : {e}"))?;
        let fichier = std::path::PathBuf::from(chemin).canonicalize().map_err(|e| format!("fichier introuvable : {e}"))?;
        if !fichier.starts_with(&dossier) {
            return Err("chemin hors du dossier média".into());
        }
        let octets = std::fs::read(&fichier).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&fichier);
        Ok(octets)
    }

    #[tauri::command]
    pub async fn matrix_details_salon(salon: String) -> Result<serde_json::Value, String> {
        json(coeur()?.details_salon(&salon).await)
    }

    #[tauri::command]
    pub async fn matrix_admins_serveur() -> Result<Vec<String>, String> {
        coeur()?.admins_serveur().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_nom_utilisateur(utilisateur: String) -> Result<Option<String>, String> {
        coeur()?.nom_utilisateur(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_avatar_utilisateur(utilisateur: String) -> Result<Option<String>, String> {
        coeur()?.avatar_utilisateur(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_appareils() -> Result<serde_json::Value, String> {
        json(coeur()?.appareils().await)
    }

    #[tauri::command]
    pub async fn matrix_inviter(salon: String, utilisateur: String) -> Result<(), String> {
        coeur()?.inviter(&salon, &utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_expulser(salon: String, utilisateur: String, raison: Option<String>) -> Result<(), String> {
        coeur()?.expulser(&salon, &utilisateur, raison.as_deref()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_bannir(salon: String, utilisateur: String, raison: Option<String>) -> Result<(), String> {
        coeur()?.bannir(&salon, &utilisateur, raison.as_deref()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_niveau(salon: String, utilisateur: String, niveau: i64) -> Result<(), String> {
        coeur()?.changer_niveau(&salon, &utilisateur, niveau).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_rejoindre(salon: String) -> Result<(), String> {
        coeur()?.rejoindre(&salon).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_quitter(salon: String) -> Result<(), String> {
        coeur()?.quitter(&salon).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_renommer_salon(salon: String, nom: String) -> Result<(), String> {
        coeur()?.renommer_salon(&salon, &nom).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_sujet(salon: String, sujet: String) -> Result<(), String> {
        coeur()?.changer_sujet(&salon, &sujet).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_avatar_salon(salon: String, chemin: String, mime: String) -> Result<(), String> {
        coeur()?.changer_avatar_salon(&salon, lire_depot(&chemin)?, &mime).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_regle_acces(salon: String, publique: bool) -> Result<(), String> {
        coeur()?.changer_regle_acces(&salon, publique).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_creer_salon(nom: String, vocal: bool, publique: bool, chiffre: bool) -> Result<String, String> {
        coeur()?.creer_salon(&nom, vocal, publique, chiffre).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_mp_avec(utilisateur: String) -> Result<String, String> {
        coeur()?.mp_avec(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_nom(nom: String) -> Result<(), String> {
        coeur()?.changer_nom(&nom).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_avatar(chemin: String, mime: String) -> Result<Option<String>, String> {
        coeur()?.changer_avatar(lire_depot(&chemin)?, &mime).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_changer_mot_de_passe(ancien: String, nouveau: String) -> Result<(), String> {
        coeur()?.changer_mot_de_passe(&ancien, &nouveau).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_supprimer_appareil(appareil: String, mot_de_passe: String) -> Result<(), String> {
        coeur()?.supprimer_appareil(&appareil, &mot_de_passe).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_est_suspendu() -> Result<bool, String> {
        coeur()?.est_suspendu().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_etapes_inscription(serveur: String) -> Result<serde_json::Value, String> {
        serde_json::to_value(sion_matrix::CoeurMatrix::etapes_inscription(&serveur).await).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_inscrire(serveur: String, identifiant: String, mot_de_passe: String, jeton: Option<String>, captcha: Option<String>) -> Result<(), String> {
        coeur()?.inscrire(&serveur, &identifiant, &mot_de_passe, jeton.as_deref(), captcha.as_deref()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_requete_admin(methode: String, chemin: String, corps: Option<serde_json::Value>, authentifiee: bool) -> Result<serde_json::Value, String> {
        json(coeur()?.requete_admin(&methode, &chemin, corps, authentifiee).await)
    }

    #[tauri::command]
    pub async fn matrix_salon_admin() -> Result<Option<String>, String> {
        coeur()?.salon_admin().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_commande_admin(commande: String) -> Result<String, String> {
        coeur()?.commande_admin(&commande).await.map_err(erreur)
    }
    // ── Chiffrement et confiance (T5) ─────────────────────────────────────────

    #[tauri::command]
    pub fn matrix_verification() -> Result<serde_json::Value, String> {
        serde_json::to_value(coeur()?.verification_actuelle()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_demarrer_verification() -> Result<(), String> {
        coeur()?.demarrer_verification().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_confirmer_emojis() -> Result<(), String> {
        coeur()?.confirmer_emojis().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_refuser_emojis() -> Result<(), String> {
        coeur()?.refuser_emojis().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_annuler_verification() -> Result<(), String> {
        coeur()?.annuler_verification().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_appareil_verifie() -> Result<bool, String> {
        coeur()?.appareil_verifie().await.map_err(erreur)
    }

    #[tauri::command]
    pub fn matrix_messages_indechiffrables() -> Result<bool, String> {
        Ok(coeur()?.messages_indechiffrables())
    }

    #[tauri::command]
    pub async fn matrix_restaurer_par_cle(cle: String) -> Result<usize, String> {
        coeur()?.restaurer_par_cle(&cle).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_restaurer_automatiquement() -> Result<usize, String> {
        coeur()?.restaurer_automatiquement().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_a_besoin_amorcage() -> Result<bool, String> {
        coeur()?.a_besoin_amorcage().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_amorcer(mot_de_passe: Option<String>) -> Result<String, String> {
        coeur()?.amorcer(mot_de_passe.as_deref()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_nouvelle_cle_recuperation() -> Result<String, String> {
        coeur()?.nouvelle_cle_recuperation().await.map_err(erreur)
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

    #[tauri::command]
    pub async fn matrix_envoyer_texte(_salon: String, _corps: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_repondre(_salon: String, _cible: String, _corps: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_editer(_salon: String, _cible: String, _texte: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_supprimer(_salon: String, _cible: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_reagir(_salon: String, _cible: String, _cle: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_poker(_salon: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_creer_sondage(
        _salon: String,
        _question: String,
        _options: Vec<String>,
        _secret: bool,
        _max: u32,
        _fin: Option<i64>,
    ) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_voter(_salon: String, _sondage: String, _reponses: Vec<String>) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_clore_sondage(_salon: String, _sondage: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_epingler(_salon: String, _cible: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_envoyer_fichier(
        _salon: String,
        _chemin: String,
        _nom: String,
        _mime: String,
        _largeur: Option<u32>,
        _hauteur: Option<u32>,
        _duree_ms: Option<u64>,
    ) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_envoyer_image_url(_salon: String, _url: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_taille_max_envoi() -> Result<u64, String> {
        Err(INACTIF.into())
    }
    #[tauri::command]
    pub async fn matrix_details_salon(_salon: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_admins_serveur() -> Result<Vec<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_nom_utilisateur(_utilisateur: String) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_avatar_utilisateur(_utilisateur: String) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_appareils() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_inviter(_salon: String, _utilisateur: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_expulser(_salon: String, _utilisateur: String, _raison: Option<String>) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_bannir(_salon: String, _utilisateur: String, _raison: Option<String>) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_niveau(_salon: String, _utilisateur: String, _niveau: i64) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_rejoindre(_salon: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_quitter(_salon: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_renommer_salon(_salon: String, _nom: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_sujet(_salon: String, _sujet: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_avatar_salon(_salon: String, _chemin: String, _mime: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_regle_acces(_salon: String, _publique: bool) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_creer_salon(_nom: String, _vocal: bool, _publique: bool, _chiffre: bool) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_mp_avec(_utilisateur: String) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_nom(_nom: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_avatar(_chemin: String, _mime: String) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_mot_de_passe(_ancien: String, _nouveau: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_supprimer_appareil(_appareil: String, _mot_de_passe: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_est_suspendu() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_etapes_inscription(_serveur: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_inscrire(_serveur: String, _identifiant: String, _mot_de_passe: String, _jeton: Option<String>, _captcha: Option<String>) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_requete_admin(_methode: String, _chemin: String, _corps: Option<serde_json::Value>, _authentifiee: bool) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_salon_admin() -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_commande_admin(_commande: String) -> Result<String, String> {
        Err(INACTIF.into())
    }
    #[tauri::command]
    pub fn matrix_verification() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_demarrer_verification() -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_confirmer_emojis() -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_refuser_emojis() -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_annuler_verification() -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_appareil_verifie() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub fn matrix_messages_indechiffrables() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_restaurer_par_cle(_cle: String) -> Result<usize, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_restaurer_automatiquement() -> Result<usize, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_a_besoin_amorcage() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_amorcer(_mot_de_passe: Option<String>) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_nouvelle_cle_recuperation() -> Result<String, String> {
        Err(INACTIF.into())
    }
}

