//! Pont Tauri du cœur Matrix en Rust (`sion-matrix`).
//!
//! Compilé avec la feature `moteur-matrix-rust` (par défaut sur ordinateur) :
//! le cœur Rust est le moteur Matrix depuis la 2.0.0-beta.2, l'ancien moteur
//! JS ne revient qu'avec `SION_MATRIX_MOTEUR=js` (voir
//! `docs/plan-matrix-rust-sdk.md`). Sans la feature (Android), les commandes
//! existent mais répondent « moteur JS », pour que l'interface n'ait qu'un
//! seul code.

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

    /// Le cœur Rust par défaut (2.0.0-beta.2) ; `SION_MATRIX_MOTEUR=js`
    /// relance l'ancien moteur, en secours ; `=rust-apercu` l'écran de
    /// diagnostic du cœur.
    pub fn moteur() -> &'static str {
        match std::env::var("SION_MATRIX_MOTEUR").as_deref() {
            Ok("js") => "js",
            Ok("rust-apercu") => "rust-apercu",
            _ => "rust",
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

        /// Seule l'absence d'entrée (`NoEntry`) veut dire « pas de secret » ;
        /// tout le reste (portefeuille verrouillé, service absent ou lent)
        /// est une indisponibilité, qui ne doit pas coûter la session.
        fn lire_verifie(&self) -> Result<Option<String>, String> {
            let entree = keyring::Entry::new("com.sion.client", "session-matrix-rust").map_err(|e| e.to_string())?;
            match entree.get_password() {
                Ok(s) => Ok(Some(s)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
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
        if moteur() == "js" {
            return;
        }
        // `SION_MATRIX_DOSSIER` : un cœur isolé pour les essais (autre compte,
        // migration) sans toucher à la session de l'utilisateur — secrets
        // gardés dans le fichier de session (coffre qui refuse), pas dans le
        // trousseau partagé.
        let (dossier, coffre): (std::path::PathBuf, Arc<dyn Coffre>) = match std::env::var_os("SION_MATRIX_DOSSIER") {
            Some(d) => (d.into(), Arc::new(sion_matrix::CoffreMemoire::refusant())),
            None => match app.path().app_data_dir() {
                Ok(d) => (d.join("matrix-rust"), Arc::new(CoffreSysteme)),
                Err(e) => {
                    log::error!("[Sion][matrix] dossier de données introuvable : {e}");
                    return;
                }
            },
        };
        let coeur = Arc::new(CoeurMatrix::nouveau(dossier, "Sion (moteur Rust)", coffre).avec_prefixe_medias(PREFIXE_MEDIAS));
        let mut etat = coeur.etat();
        let mut salons = coeur.salons();
        let mut messages = coeur.messages();
        let mut verification = coeur.verification();
        let mut evenements_sion = coeur.evenements_sion();
        let mut cles_voix = coeur.cles_voix();
        let mut frappes = coeur.frappes();
        let mut lectures = coeur.lectures();
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
        // Événements `com.sion.*` (transcriptions, éjection vocale) (T6).
        let app_sion = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match evenements_sion.recv().await {
                    Ok(ev) => {
                        let _ = app_sion.emit("matrix-evenement-sion", &ev);
                    }
                    Err(RecvError::Lagged(n)) => log::warn!("[Sion][matrix] {n} événement(s) Sion perdu(s) en route"),
                    Err(RecvError::Closed) => break,
                }
            }
        });
        // Clés des médias de l'appel (étape 3) : du cœur au moteur vocal
        // natif, directement — elles ne passent plus par la webview.
        tauri::async_runtime::spawn(async move {
            loop {
                match cles_voix.recv().await {
                    Ok(c) => {
                        remettre_cles(vec![c]).await;
                    }
                    Err(RecvError::Lagged(_)) => {
                        if let Ok(coeur) = self::coeur() {
                            remettre_cles(coeur.cles_voix_connues().await).await;
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        });
        // « En train d'écrire » et « vu par » : perdre une frappe en route
        // est sans gravité (la suivante arrive dans les 3 s) ; en retard sur
        // les lectures, on les renvoie toutes.
        let app_frappes = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match frappes.recv().await {
                    Ok(f) => {
                        let _ = app_frappes.emit("matrix-frappe", &f);
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        });
        let app_lectures = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match lectures.recv().await {
                    Ok(l) => {
                        let _ = app_lectures.emit("matrix-lectures", &l);
                    }
                    Err(RecvError::Lagged(_)) => {
                        if let Ok(coeur) = self::coeur() {
                            for l in coeur.lectures_actuelles() {
                                let _ = app_lectures.emit("matrix-lectures", &l);
                            }
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
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
        // Original, vignette du fil (`?vignette=1`) ou avatar (`?avatar=1`).
        let format = sion_matrix::FormatMedia::depuis_requete(requete.uri().query());
        let original = format == sion_matrix::FormatMedia::Original;
        // Requête par plage (lecteur vidéo : avancer, reculer, aperçu, index
        // en fin de MP4). Servie depuis le fichier déchiffré une fois : sans
        // elle, chaque demande renvoyait la vidéo entière et le lecteur ne
        // savait pas se déplacer (29/09, téléphone).
        let plage = requete
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        // Android : le WebView applique LUI-MÊME la plage à la réponse
        // interceptée — il saute dans le flux jusqu'au début demandé, puis
        // lit jusqu'à la fin, en gardant notre statut. On lui donne donc le
        // fichier ENTIER avec un 206 « du début demandé à la fin » (un morceau
        // déjà découpé l'était deux fois ; un 200 faisait planter les sauts).
        #[cfg(target_os = "android")]
        let (plage, plage_android) = (None::<String>, plage.filter(|_| original));
        if let (true, Some(plage)) = (original, plage) {
            tauri::async_runtime::spawn_blocking(move || match servir_plage(&cle, &plage) {
                Ok(r) => repondeur.respond(r),
                Err(e) => log::error!("[Sion][matrix] réponse média invalide : {e}"),
            });
            return;
        }
        tauri::async_runtime::spawn(async move {
            let contenu = match coeur() {
                Ok(coeur) => coeur.media_format(&cle, format).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            let reponse = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            // L'original accepte les plages (voir plus haut).
            let reponse = if original { reponse.header(header::ACCEPT_RANGES, "bytes") } else { reponse };
            let reponse = match contenu {
                #[cfg(target_os = "android")]
                Ok(octets) if plage_android.is_some() => {
                    let total = octets.len() as u64;
                    let plage = plage_android.as_deref().unwrap_or_default();
                    match sion_matrix::plage_http(plage, total, u64::MAX) {
                        Some((debut, _)) => reponse
                            .status(206)
                            .header(header::CONTENT_TYPE, sion_matrix::type_mime(&octets))
                            .header(header::CONTENT_RANGE, format!("bytes {debut}-{}/{total}", total - 1))
                            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                            .body(octets),
                        None => reponse
                            .status(416)
                            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                            .body(Vec::new()),
                    }
                }
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

    /// Au plus par réponse à une plage : le lecteur redemande la suite.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    const MORCEAU_MAX: u64 = 4 * 1024 * 1024;

    /// Réponse 206 à une requête par plage, lue dans le fichier déchiffré
    /// (`deposer_media`) ; 416 si la plage est hors du fichier.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    fn servir_plage(cle: &str, plage: &str) -> Result<Response<Vec<u8>>, tauri::http::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let base = Response::builder()
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCEPT_RANGES, "bytes");
        let Some((nom, mime)) = deposer_media(cle) else {
            return base.status(404).body(Vec::new());
        };
        let chemin = crate::sion_media_dir().join(&nom);
        let lire = || -> std::io::Result<(u64, Option<(u64, u64, Vec<u8>)>)> {
            let mut fichier = std::fs::File::open(&chemin)?;
            let total = fichier.metadata()?.len();
            let Some((debut, fin)) = sion_matrix::plage_http(plage, total, MORCEAU_MAX) else {
                return Ok((total, None));
            };
            fichier.seek(SeekFrom::Start(debut))?;
            let mut octets = vec![0u8; (fin - debut + 1) as usize];
            fichier.read_exact(&mut octets)?;
            Ok((total, Some((debut, fin, octets))))
        };
        match lire() {
            Ok((total, Some((debut, fin, octets)))) => base
                .status(206)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_RANGE, format!("bytes {debut}-{fin}/{total}"))
                .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                .body(octets),
            Ok((total, None)) => base
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Vec::new()),
            Err(e) => {
                log::warn!("[Sion][matrix] média {cle} illisible : {e}");
                base.status(404).body(Vec::new())
            }
        }
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

    /// Fichier local d'un média du cœur, désigné par une URL `sion-media` ou
    /// un `mxc://` : ce que le lecteur vidéo natif et la memeboard donnent à
    /// ffmpeg (jamais une URL). `None` si la source n'est ni l'un ni l'autre.
    /// Le dépôt se fait sur un fil à part : l'appelant peut être n'importe où,
    /// y compris dans un runtime async (où `block_on` paniquerait).
    pub fn fichier_media_matrix(source: &str) -> Option<Result<String, String>> {
        let cle_de = |url: &str| url.rsplit('/').next().unwrap_or("").split('?').next().unwrap_or("").to_owned();
        let cle = if source.starts_with(sion_matrix::PREFIXE_PAR_DEFAUT) || source.starts_with("http://sion-media.localhost/") {
            cle_de(source)
        } else if source.starts_with("mxc://") {
            cle_de(&coeur().ok()?.url_media(source)?)
        } else {
            return None;
        };
        let depose = std::thread::spawn(move || deposer_media(&cle)).join().ok().flatten();
        Some(
            depose
                .map(|(nom, _)| crate::sion_media_dir().join(nom).to_string_lossy().into_owned())
                .ok_or_else(|| format!("média Matrix indisponible : {source}")),
        )
    }

    /// Fermeture de la fenêtre : départ de l'appel publié par le cœur, sans
    /// compter sur une webview qui s'en va.
    pub fn quitter_voix_a_la_fermeture() {
        if let Ok(coeur) = coeur() {
            let coeur = coeur.clone();
            tauri::async_runtime::spawn(async move { coeur.quitter_voix().await });
        }
    }

    /// Remet des clés au moteur vocal natif ; renvoie combien il en a
    /// acceptées (aucune hors appel). L'import attend un moteur prêté
    /// ailleurs : hors du runtime async.
    pub async fn remettre_cles(cles: Vec<sion_matrix::CleMedia>) -> usize {
        tauri::async_runtime::spawn_blocking(move || {
            cles.into_iter().filter(|c| crate::voice_native::importer_cle_e2ee(&c.identite, i32::from(c.index), c.cle.clone())).count()
        })
        .await
        .unwrap_or(0)
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

    pub fn fichier_media_matrix(_source: &str) -> Option<Result<String, String>> {
        None
    }

    pub fn initialiser<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {
        if std::env::var("SION_MATRIX_MOTEUR").is_ok_and(|m| m.starts_with("rust")) {
            log::warn!("[Sion][matrix] SION_MATRIX_MOTEUR=rust ignoré : Sion compilé sans la feature moteur-matrix-rust");
        }
    }

    pub fn quitter_voix_a_la_fermeture() {}
}

#[cfg_attr(target_os = "android", allow(unused_imports))]
pub use actif::{deposer_media, fichier_media_matrix, initialiser, quitter_voix_a_la_fermeture};

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

    /// Connexion qui reprend l'appareil de l'ancien moteur (étape 4) : son
    /// paquet de secrets et ses clés de salons, exportés par l'interface.
    #[tauri::command]
    pub async fn matrix_connecter_migration(
        serveur: String,
        identifiant: String,
        mot_de_passe: String,
        secrets: Option<serde_json::Value>,
        cles: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let import = sion_matrix::ImportMigration { secrets, cles_salons: cles };
        let rapport = coeur()?.connecter_et_migrer(&serveur, &identifiant, &mot_de_passe, &import).await.map_err(|e| e.to_string())?;
        serde_json::to_value(rapport).map_err(|e| e.to_string())
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
    /// Un message précis, même hors du fil chargé (aperçu d'un épinglé).
    #[tauri::command]
    pub async fn matrix_message(salon: String, evenement: String) -> Result<serde_json::Value, String> {
        let m = coeur()?.message(&salon, &evenement).await.map_err(|e| e.to_string())?;
        serde_json::to_value(m).map_err(|e| e.to_string())
    }

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

    // ── Entre membres : frappe, « vu par », signalement, ignorés, bannière ──

    #[tauri::command]
    pub async fn matrix_ecrire(salon: String, actif: bool) -> Result<(), String> {
        coeur()?.ecrire(&salon, actif).await.map_err(erreur)
    }

    #[tauri::command]
    pub fn matrix_lectures() -> Result<serde_json::Value, String> {
        serde_json::to_value(coeur()?.lectures_actuelles()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_signaler(salon: String, evenement: String, raison: Option<String>) -> Result<(), String> {
        coeur()?.signaler(&salon, &evenement, raison).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_ignorer(utilisateur: String) -> Result<(), String> {
        coeur()?.ignorer(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_ne_plus_ignorer(utilisateur: String) -> Result<(), String> {
        coeur()?.ne_plus_ignorer(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_ignores() -> Result<Vec<String>, String> {
        coeur()?.ignores().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_banniere(utilisateur: String) -> Result<Option<String>, String> {
        coeur()?.banniere(&utilisateur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_salons_en_commun(utilisateur: String) -> Result<Vec<String>, String> {
        coeur()?.salons_en_commun(&utilisateur).await.map_err(erreur)
    }

    /// Sans `chemin` : la bannière est retirée.
    #[tauri::command]
    pub async fn matrix_changer_banniere(chemin: Option<String>, mime: Option<String>) -> Result<Option<String>, String> {
        let image = match chemin {
            Some(c) => Some((lire_depot(&c)?, mime.unwrap_or_else(|| "image/png".into()))),
            None => None,
        };
        coeur()?.changer_banniere(image).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_supprimer_compte(mot_de_passe: String, effacer: bool) -> Result<(), String> {
        coeur()?.supprimer_compte(&mot_de_passe, effacer).await.map_err(erreur)
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
    // ── Fonctions propres à Sion (T6) ─────────────────────────────────────────

    /// Métadonnées d'une voix de référence à l'ajout d'un son.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VoixJs {
        ref_text: Option<String>,
        avatar: Option<String>,
    }

    /// Champs de voix à l'édition : absents = inchangés, `null` = effacés.
    #[derive(serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    pub struct ChangementsVoix {
        #[serde(default, deserialize_with = "present")]
        ref_text: Option<Option<String>>,
        #[serde(default, deserialize_with = "present")]
        avatar: Option<Option<String>>,
    }

    impl ChangementsVoix {
        fn ref_text(&self) -> sion_matrix::ChampVoix {
            self.ref_text.clone()
        }
        fn avatar(&self) -> sion_matrix::ChampVoix {
            self.avatar.clone()
        }
    }

    /// Une clé présente (même à `null`) donne `Some(..)`.
    fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(serde::Deserialize::deserialize(d)?))
    }

    /// Octets d'un fichier du dossier média, SANS l'effacer (un meme préparé
    /// reste testable après l'envoi).
    fn lire_fichier_media(chemin: &str) -> Result<Vec<u8>, String> {
        let dossier = crate::sion_media_dir().canonicalize().map_err(|e| format!("dossier média : {e}"))?;
        let fichier = std::path::PathBuf::from(chemin).canonicalize().map_err(|e| format!("fichier introuvable : {e}"))?;
        if !fichier.starts_with(&dossier) {
            return Err("chemin hors du dossier média".into());
        }
        std::fs::read(&fichier).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn matrix_salon_soundboard() -> Result<Option<String>, String> {
        coeur()?.salon_soundboard().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_creer_ou_synchroniser_soundboard() -> Result<serde_json::Value, String> {
        json(coeur()?.creer_ou_synchroniser_soundboard().await)
    }

    #[tauri::command]
    pub async fn matrix_sons() -> Result<serde_json::Value, String> {
        json(coeur()?.sons().await)
    }

    #[tauri::command]
    pub async fn matrix_memes() -> Result<serde_json::Value, String> {
        json(coeur()?.memes().await)
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_ajouter_son(chemin: String, nom_fichier: String, mime: String, duree: Option<i64>, label: String, categorie: String, emoji: Option<String>, gain: f64, voix: Option<VoixJs>, modele: Option<String>) -> Result<serde_json::Value, String> {
        let voix = voix.map(|v| sion_matrix::Voix { ref_text: v.ref_text, avatar: v.avatar });
        json(coeur()?.ajouter_son(lire_depot(&chemin)?, &nom_fichier, &mime, duree, &label, &categorie, emoji.as_deref(), gain, voix, modele.as_deref()).await)
    }

    #[tauri::command]
    pub async fn matrix_modifier_son(event_id: String, label: String, categorie: String, emoji: Option<String>, gain: f64, changements: ChangementsVoix) -> Result<(), String> {
        coeur()?.modifier_son(&event_id, &label, &categorie, emoji.as_deref(), gain, changements.ref_text(), changements.avatar()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_supprimer_du_soundboard(event_id: String) -> Result<(), String> {
        coeur()?.supprimer_du_soundboard(&event_id).await.map_err(erreur)
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_envoyer_meme(chemin: String, mime: String, largeur: i64, hauteur: i64, duree_ms: i64, apercu: Option<String>, apercu_mime: Option<String>, label: String, emoji: Option<String>) -> Result<String, String> {
        let video = lire_fichier_media(&chemin)?;
        let apercu = match (apercu, apercu_mime) {
            (Some(c), Some(m)) => Some((lire_fichier_media(&c)?, m)),
            _ => None,
        };
        coeur()?.envoyer_meme(video, &mime, largeur, hauteur, duree_ms, apercu, &label, emoji.as_deref()).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_envoyer_evenement(salon: String, type_evenement: String, contenu: serde_json::Value) -> Result<String, String> {
        coeur()?.envoyer_evenement(&salon, &type_evenement, contenu).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_envoyer_etat(salon: String, type_evenement: String, cle: String, contenu: serde_json::Value) -> Result<(), String> {
        coeur()?.envoyer_etat(&salon, &type_evenement, &cle, contenu).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_etats(salon: String, type_evenement: String) -> Result<serde_json::Value, String> {
        json(coeur()?.etats(&salon, &type_evenement).await)
    }

    #[tauri::command]
    pub async fn matrix_versions_salon(salon: String) -> Result<serde_json::Value, String> {
        json(coeur()?.versions_salon(&salon).await)
    }

    #[tauri::command]
    pub async fn matrix_publier_version(version: String, os: String, ts: i64) -> Result<usize, String> {
        coeur()?.publier_version(&version, &os, ts).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_ouvrir_droit_version() -> Result<usize, String> {
        coeur()?.ouvrir_droit_version().await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_rafraichir_nom_appareil(nom: String) -> Result<bool, String> {
        coeur()?.rafraichir_nom_appareil(&nom).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_historique_filtre(salon: String, types: Vec<String>) -> Result<serde_json::Value, String> {
        json(coeur()?.historique_filtre(&salon, &types).await)
    }

    #[tauri::command]
    pub fn matrix_url_media(mxc: String) -> Result<Option<String>, String> {
        Ok(coeur()?.url_media(&mxc))
    }

    #[tauri::command]
    pub async fn matrix_definir_pousseur(pousseur: serde_json::Value) -> Result<(), String> {
        coeur()?.definir_pousseur(pousseur).await.map_err(erreur)
    }

    #[tauri::command]
    pub async fn matrix_supprimer_regle_push(portee: String, genre: String, regle: String) -> Result<(), String> {
        coeur()?.supprimer_regle_push(&portee, &genre, &regle).await.map_err(erreur)
    }

    // ── Voix (étape 3) ───────────────────────────────────────────────────

    /// Rejoint l'appel d'un salon : adresse et jeton du serveur média, salon
    /// chiffré ou non, notre identité. Les clés suivent par le relais.
    #[tauri::command]
    pub async fn matrix_rejoindre_voix(salon: String) -> Result<serde_json::Value, String> {
        json(coeur()?.rejoindre_voix(&salon).await)
    }

    #[tauri::command]
    pub async fn matrix_quitter_voix() -> Result<(), String> {
        coeur()?.quitter_voix().await;
        Ok(())
    }

    #[tauri::command]
    pub async fn matrix_etat_voix(muet: bool, sourd: bool) -> Result<bool, String> {
        Ok(coeur()?.etat_voix(muet, sourd).await)
    }

    #[tauri::command]
    pub async fn matrix_republier_voix() -> Result<bool, String> {
        Ok(coeur()?.republier_voix().await)
    }

    /// Toutes les clés connues de l'appel, au moteur vocal qui vient de se
    /// connecter (celles arrivées avant lui ont été refusées).
    #[tauri::command]
    pub async fn matrix_rejouer_cles_voix() -> Result<usize, String> {
        let cles = coeur()?.cles_voix_connues().await;
        Ok(super::actif::remettre_cles(cles).await)
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
    pub async fn matrix_connecter_migration(
        _serveur: String,
        _identifiant: String,
        _mot_de_passe: String,
        _secrets: Option<serde_json::Value>,
        _cles: Option<String>,
    ) -> Result<serde_json::Value, String> {
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
    pub async fn matrix_message(_salon: String, _evenement: String) -> Result<serde_json::Value, String> {
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
    pub async fn matrix_ecrire(_salon: String, _actif: bool) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub fn matrix_lectures() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_signaler(_salon: String, _evenement: String, _raison: Option<String>) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_ignorer(_utilisateur: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_ne_plus_ignorer(_utilisateur: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_ignores() -> Result<Vec<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_banniere(_utilisateur: String) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_salons_en_commun(_utilisateur: String) -> Result<Vec<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_changer_banniere(_chemin: Option<String>, _mime: Option<String>) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_supprimer_compte(_mot_de_passe: String, _effacer: bool) -> Result<(), String> {
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
    #[derive(serde::Deserialize)]
    pub struct VoixJs {}

    #[derive(serde::Deserialize)]
    pub struct ChangementsVoix {}

    #[tauri::command]
    pub async fn matrix_salon_soundboard() -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_creer_ou_synchroniser_soundboard() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_sons() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_memes() -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_ajouter_son(_chemin: String, _nom_fichier: String, _mime: String, _duree: Option<i64>, _label: String, _categorie: String, _emoji: Option<String>, _gain: f64, _voix: Option<VoixJs>, _modele: Option<String>) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_modifier_son(_event_id: String, _label: String, _categorie: String, _emoji: Option<String>, _gain: f64, _changements: ChangementsVoix) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_supprimer_du_soundboard(_event_id: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn matrix_envoyer_meme(_chemin: String, _mime: String, _largeur: i64, _hauteur: i64, _duree_ms: i64, _apercu: Option<String>, _apercu_mime: Option<String>, _label: String, _emoji: Option<String>) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_envoyer_evenement(_salon: String, _type_evenement: String, _contenu: serde_json::Value) -> Result<String, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_envoyer_etat(_salon: String, _type_evenement: String, _cle: String, _contenu: serde_json::Value) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_etats(_salon: String, _type_evenement: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_versions_salon(_salon: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_publier_version(_version: String, _os: String, _ts: i64) -> Result<usize, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_ouvrir_droit_version() -> Result<usize, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_rafraichir_nom_appareil(_nom: String) -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_historique_filtre(_salon: String, _types: Vec<String>) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub fn matrix_url_media(_mxc: String) -> Result<Option<String>, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_definir_pousseur(_pousseur: serde_json::Value) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_supprimer_regle_push(_portee: String, _genre: String, _regle: String) -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_rejoindre_voix(_salon: String) -> Result<serde_json::Value, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_quitter_voix() -> Result<(), String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_etat_voix(_muet: bool, _sourd: bool) -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_republier_voix() -> Result<bool, String> {
        Err(INACTIF.into())
    }

    #[tauri::command]
    pub async fn matrix_rejouer_cles_voix() -> Result<usize, String> {
        Err(INACTIF.into())
    }
}

