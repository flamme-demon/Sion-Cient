//! Lecture vidéo hors du moteur web.
//!
//! Le `<video>` du webview délègue son décodage à GStreamer sous Linux et à
//! WebView2 sous Windows : ce qui s'affiche dépend alors de la distribution,
//! des greffons installés et du pilote graphique de chaque utilisateur. Sept
//! mécanismes de contournement ont été empilés sans y suffire — jusqu'à un
//! utilisateur dont le journal annonce une vidéo décodée, sans erreur, et qui
//! ne voit qu'un rectangle vert.
//!
//! On décode donc nous-mêmes et on pousse les plans I420 dans la surface
//! native — celle qui affiche déjà le partage d'écran, et qui fonctionne y
//! compris chez cet utilisateur-là.
//!
//! ## Pourquoi un PROCESSUS et pas la bibliothèque
//!
//! La première version liait `ffmpeg-next`. Elle décodait parfaitement en
//! prototype isolé — 600 images par seconde — et échouait dans Sion sur
//! « Protocol not found ». La raison, mesurée le 21/09 : `libwebrtc.a`, que
//! Sion lie pour la voix et le partage, **embarque sa propre copie de
//! ffmpeg**, 1 684 symboles `av_*`. Ils l'emportent sur ceux du système à
//! l'édition de liens, et cette copie est amputée :
//!
//! ```text
//! [Sion][lecteur] libavformat 62.17.100 — 0 protocole(s) en entrée :
//! ```
//!
//! Zéro protocole : ni `https`, ni même `file`. Aucun ordre de liaison ne
//! corrige cela proprement — un symbole défini dans une archive statique
//! gagne, et cette archive vient d'une build pré-compilée de LiveKit.
//!
//! On lance donc ffmpeg comme processus séparé, qui a son propre espace de
//! symboles. `-re` le fait débiter à la vitesse réelle du média : c'est lui
//! qui cadence, nous n'avons plus d'horloge à tenir ni de dérive possible. Le
//! prix est un déplacement coûteux dans le film — relancer le processus avec
//! `-ss` — ce qui reste acceptable pour regarder un clip.
//!
//! Voir `docs/lecteur-video-natif.md`.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Identifiant de flux réservé au lecteur dans la surface native.
///
/// La surface distingue ses sources par ce nom : le front déclare un rectangle
/// pour ce même identifiant, et les plans publiés ici y atterrissent. Un nom
/// qui ne peut appartenir à personne — les partages portent une identité
/// Matrix.
pub const SENDER_LECTEUR: &str = "sion:lecteur";

/// Plans I420 d'une image, transportés jusqu'au rendu.
///
/// ffmpeg écrit du `rawvideo yuv420p` sans alignement : les pas de ligne
/// valent exactement la largeur, contrairement aux images de libwebrtc.
struct ImageI420 {
    largeur: u32,
    hauteur: u32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

impl crate::native_video_surface::PlanarFrame for ImageI420 {
    fn dimensions(&self) -> (u32, u32) {
        (self.largeur, self.hauteur)
    }
    fn planes(&self) -> (&[u8], &[u8], &[u8]) {
        (&self.y, &self.u, &self.v)
    }
    fn strides(&self) -> (u32, u32, u32) {
        (self.largeur, self.largeur / 2, self.largeur / 2)
    }
}

/// Lecture en cours. Une seule à la fois : la surface native est unique et
/// partagée avec le partage d'écran.
struct Lecture {
    arret: Arc<AtomicBool>,
    enfant: Arc<Mutex<Option<std::process::Child>>>,
    position_ms: Arc<AtomicU64>,
    duree_ms: u64,
    /// Absente si le média est muet ou si aucune sortie n'est disponible.
    audio: Option<crate::lecteur_audio::Audio>,
    /// En pause, le fil vidéo cesse de consommer le tube : ffmpeg se bloque
    /// de lui-même, et rien ne s'accumule en mémoire.
    pause: Arc<AtomicBool>,
    /// De quoi relancer ailleurs dans le film : se déplacer revient à tuer
    /// les deux processus et à les relancer avec `-ss`.
    source: String,
    ffmpeg: String,
    largeur: u32,
    hauteur: u32,
    /// Décalage du départ courant, à ajouter à l'horloge audio — celle-ci
    /// repart de zéro à chaque relance.
    depart_ms: u64,
    /// Ce que le bandeau incrusté doit montrer. Lu par le fil de lecture à
    /// chaque image, écrit par les commandes du front.
    incrustation: Arc<Mutex<crate::incrustation_lecteur::EtatIncrustation>>,
}

fn lecture() -> &'static Mutex<Option<Lecture>> {
    static L: OnceLock<Mutex<Option<Lecture>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// Pixels d'écran par pixel de média, en millièmes.
///
/// Hors de `Lecture`, et c'est essentiel : se déplacer dans la vidéo relance
/// ffmpeg et crée une nouvelle lecture. Rangée là-dedans, l'échelle repartait
/// à sa valeur par défaut à chaque saut, et le bandeau — dimensionné pour
/// rester lisible après réduction — passait d'énorme à minuscule (21/09).
/// Elle décrit l'affichage, qui ne change pas parce qu'on saute dans le film.
fn echelle_millimes() -> &'static AtomicU64 {
    static E: AtomicU64 = AtomicU64::new(1000);
    &E
}

/// Décrit ce qui est en train d'être lu, pour le front.
#[derive(serde::Serialize, Clone)]
pub struct EtatLecteur {
    pub actif: bool,
    pub largeur: u32,
    pub hauteur: u32,
    pub duree_ms: u64,
    pub position_ms: u64,
    pub en_pause: bool,
    pub a_du_son: bool,
}

/// Largeur de la toile de rendu — celle de la vidéo, arrondie au pair.
///
/// **Une tentative d'élargissement a été retirée le 21/09.** L'idée était
/// d'ajouter des bandes noires pour donner au bandeau la largeur qui manque
/// sur une vidéo verticale. Mais la toile s'affiche dans la largeur
/// disponible de la bulle : l'élargir y rapetissait la VIDÉO, et forcer une
/// largeur minimale de lecteur pour compenser le faisait déborder hors du
/// message. Le bandeau sait se simplifier quand la place manque — il
/// abandonne le compteur, puis la jauge de volume — et cela suffit.
///
/// L'arrondi reste nécessaire : l'I420 sous-échantillonne la chrominance par
/// deux et n'accepte pas de largeur impaire.
fn largeur_toile(largeur: u32, _hauteur: u32) -> u32 {
    largeur + (largeur % 2)
}

/// Taille d'une image I420, en octets : un plan de luminance pleine
/// résolution, deux plans de chrominance à un quart chacun.
fn taille_image(largeur: u32, hauteur: u32) -> usize {
    (largeur as usize * hauteur as usize) * 3 / 2
}

/// Découpe un tampon brut en ses trois plans.
///
/// ffmpeg écrit les plans bout à bout, sans remplissage : Y, puis U, puis V.
fn decouper_plans(tampon: &[u8], largeur: u32, hauteur: u32) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let luma = largeur as usize * hauteur as usize;
    let chroma = luma / 4;
    if tampon.len() < luma + 2 * chroma {
        return None;
    }
    Some((
        tampon[..luma].to_vec(),
        tampon[luma..luma + chroma].to_vec(),
        tampon[luma + chroma..luma + 2 * chroma].to_vec(),
    ))
}

/// Remet une image à la surface, par le chemin qu'elle accepte.
///
/// Le rendu planaire EGL n'est pris QUE lorsqu'une seule surface est active :
/// `wants_planar_sender` l'exige explicitement. Dès qu'un partage d'écran
/// s'affiche en même temps que le lecteur, les plans sont rejetés — « image
/// ignorée : expéditeur hors de la sous-surface unique » — et il faut passer
/// par le chemin BGRA, celui des vues multiples. Constaté le 21/09 : le son
/// jouait, l'image restait noire.
///
/// `i420_to_argb` de libyuv écrit des octets B, G, R, A en mémoire — c'est la
/// même convention que `argb_to_i420` employée à l'autre bout pour le partage.
fn presenter(
    largeur: u32,
    hauteur: u32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
    recyclage: &mut Option<Vec<u8>>,
) {
    if crate::native_video_surface::prefers_planar(SENDER_LECTEUR) {
        crate::native_video_surface::on_planar_frame(
            SENDER_LECTEUR.to_string(),
            Box::new(ImageI420 {
                largeur,
                hauteur,
                y,
                u,
                v,
            }),
        );
        return;
    }

    #[cfg(feature = "native-voice")]
    {
        let taille = largeur as usize * hauteur as usize * 4;
        let mut bgra = recyclage.take().unwrap_or_default();
        bgra.clear();
        bgra.resize(taille, 0);
        let demi = largeur.div_ceil(2);
        livekit::webrtc::native::yuv_helper::i420_to_argb(
            &y,
            largeur,
            &u,
            demi,
            &v,
            demi,
            &mut bgra,
            largeur * 4,
            largeur as i32,
            hauteur as i32,
        );
        *recyclage = crate::native_video_surface::on_frame(
            SENDER_LECTEUR.to_string(),
            largeur,
            hauteur,
            bgra,
        );
    }
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (largeur, hauteur, y, u, v, recyclage);
    }
}

/// Ouvre une source et lance sa lecture dans la surface native.
///
/// `chemin` est un fichier local ou une URL : ffmpeg lit les deux. Rend la
/// main dès que les dimensions sont connues ; la lecture se poursuit sur un
/// fil dédié. Une lecture déjà en cours est arrêtée d'abord.
#[tauri::command]
pub fn lecteur_video_ouvrir(
    app: tauri::AppHandle<crate::TauriRuntime>,
    chemin: String,
    ffmpeg_path: Option<String>,
) -> Result<EtatLecteur, String> {
    let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());
    demarrer(&ffmpeg, &chemin, 0)
}

/// Démarre — ou redémarre — la lecture à une position donnée.
fn demarrer(ffmpeg: &str, chemin: &str, depart_ms: u64) -> Result<EtatLecteur, String> {
    lecteur_video_fermer();
    let ffmpeg = ffmpeg.to_string();
    let chemin = chemin.to_string();

    // Dimensions et durée : ffmpeg les écrit sur sa sortie d'erreur quand on
    // l'invoque sans destination. `ffprobe` serait plus propre, mais le
    // bouton d'installation intégré ne pose que `ffmpeg`.
    let (largeur, hauteur, duree) = crate::probe_video(&ffmpeg, std::path::Path::new(&chemin))
        .ok_or_else(|| format!("format illisible, ou ffmpeg absent : {chemin}"))?;
    if largeur == 0 || hauteur == 0 || largeur % 2 != 0 || hauteur % 2 != 0 {
        return Err(format!("dimensions inexploitables : {largeur}x{hauteur}"));
    }
    let duree_ms = (duree * 1000.0) as u64;

    // Toile élargie si la vidéo est trop étroite pour porter les commandes.
    let toile_l = largeur_toile(largeur, hauteur);
    let toile_h = hauteur;

    log::info!(
        "[Sion][lecteur] {chemin} — vidéo {largeur}x{hauteur}, toile {toile_l}x{toile_h}, {} s",
        duree_ms / 1000
    );
    crate::native_video_surface::announce_source_dimensions(SENDER_LECTEUR, toile_l, toile_h);

    let mut commande = crate::hidden_command(&ffmpeg);
    commande.args(["-hide_banner", "-loglevel", "error", "-re"]);
    // `-ss` AVANT `-i` : ffmpeg saute à l'image clé la plus proche au lieu de
    // décoder depuis le début pour tout jeter.
    if depart_ms > 0 {
        commande.args(["-ss", &format!("{:.3}", depart_ms as f64 / 1000.0)]);
    }
    commande.arg("-i").arg(&chemin);
    if toile_l != largeur {
        // La vidéo reste intacte, centrée : on ajoute seulement du noir de
        // part et d'autre pour que le bandeau ait où s'écrire.
        commande.args([
            "-vf",
            &format!("pad={toile_l}:{toile_h}:({toile_l}-iw)/2:0:color=black"),
        ]);
    }
    commande
        .args([
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            // Sans cela ffmpeg duplique ou supprime des images pour tenir une
            // cadence constante : on veut exactement celles du fichier.
            "-fps_mode",
            "passthrough",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut enfant = commande
        .spawn()
        .map_err(|e| format!("lancement de ffmpeg : {e}"))?;
    let mut sortie = enfant
        .stdout
        .take()
        .ok_or_else(|| "sortie de ffmpeg indisponible".to_string())?;
    let erreurs = enfant.stderr.take();

    let arret = Arc::new(AtomicBool::new(false));
    let position_ms = Arc::new(AtomicU64::new(0));
    let enfant = Arc::new(Mutex::new(Some(enfant)));
    let pause = Arc::new(AtomicBool::new(false));

    // La piste sonore a son propre processus ffmpeg. Un média muet, ou une
    // machine sans sortie audio, rend simplement `None` : mieux vaut une
    // vidéo silencieuse qu'une vidéo qui refuse de partir.
    let audio = crate::lecteur_audio::demarrer(&ffmpeg, &chemin, depart_ms);
    let a_du_son = audio.is_some();

    let incrustation = Arc::new(Mutex::new(crate::incrustation_lecteur::EtatIncrustation {
        position_ms: depart_ms,
        duree_ms,
        en_pause: false,
        volume: 1.0,
        apercu_ms: None,
    }));

    // Les plaintes de ffmpeg dans notre journal : sans cela, un échec de
    // lecture serait totalement muet.
    if let Some(mut flux) = erreurs {
        std::thread::Builder::new()
            .name("sion-lecteur-erreurs".into())
            .spawn(move || {
                let mut texte = String::new();
                if flux.read_to_string(&mut texte).is_ok() && !texte.trim().is_empty() {
                    log::warn!("[Sion][lecteur] ffmpeg : {}", texte.trim());
                }
            })
            .ok();
    }

    let arret_fil = Arc::clone(&arret);
    let position_fil = Arc::clone(&position_ms);
    let enfant_fil = Arc::clone(&enfant);
    let pause_fil = Arc::clone(&pause);
    let incrustation_fil = Arc::clone(&incrustation);
    let octets = taille_image(toile_l, toile_h);

    std::thread::Builder::new()
        .name("sion-lecteur-video".into())
        .spawn(move || {
            let depart = std::time::Instant::now();
            let mut tampon = vec![0u8; octets];
            let mut images = 0u64;
            // Tampon BGRA réutilisé d'une image à l'autre : le chemin non
            // planaire alloue sinon quatre octets par pixel à chaque frame.
            let mut recyclage: Option<Vec<u8>> = None;
            let mut calque: Option<tiny_skia::Pixmap> = None;
            // L'échelle fait partie de la clé : changer la taille du lecteur
            // doit redessiner le bandeau, pas seulement le remettre tel quel.
            let mut calque_etat: Option<(crate::incrustation_lecteur::EtatIncrustation, u32)> =
                None;

            // Derniers plans décodés, AVANT incrustation. À l'arrêt, plus
            // aucune image n'arrive : sans cette copie, le bandeau resterait
            // figé sur l'icône d'avant la pause, et le bouton paraissait
            // déconnecté de la vidéo (21/09).
            let mut derniere: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = None;

            while !arret_fil.load(Ordering::Relaxed) {
                // En pause, on cesse de lire : le tube se remplit, ffmpeg
                // s'arrête tout seul, et rien ne s'accumule chez nous. On
                // continue en revanche de repeindre la dernière image quand
                // le bandeau change — mise en pause, volume, position.
                while pause_fil.load(Ordering::Relaxed) && !arret_fil.load(Ordering::Relaxed) {
                    let voulu = *incrustation_fil.lock().unwrap_or_else(|e| e.into_inner());
                    let echelle = echelle_millimes().load(Ordering::Relaxed) as f32 / 1000.0;
                    if calque_etat != Some((voulu, echelle.to_bits())) {
                        calque =
                            crate::incrustation_lecteur::dessiner(toile_l, toile_h, echelle, &voulu);
                        calque_etat = Some((voulu, echelle.to_bits()));
                        if let (Some(c), Some((y0, u0, v0))) = (calque.as_ref(), derniere.as_ref()) {
                            let (mut y, mut u, mut v) = (y0.clone(), u0.clone(), v0.clone());
                            crate::incrustation_lecteur::composer_sur_i420(
                                c, &mut y, &mut u, &mut v, toile_l, toile_h,
                            );
                            presenter(toile_l, toile_h, y, u, v, &mut recyclage);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
                if arret_fil.load(Ordering::Relaxed) {
                    break;
                }
                // Une lecture incomplète signe la fin du flux : ffmpeg a
                // terminé, ou il a été arrêté.
                if sortie.read_exact(&mut tampon).is_err() {
                    break;
                }
                let Some((mut y, mut u, mut v)) = decouper_plans(&tampon, toile_l, toile_h) else {
                    break;
                };
                // Copie conservée pour pouvoir repeindre à l'arrêt.
                derniere = Some((y.clone(), u.clone(), v.clone()));

                // Les contrôles sont peints DANS l'image : rien du DOM ne peut
                // s'afficher devant la surface native. Le calque n'est
                // redessiné que lorsque son contenu change — sinon on le
                // recompose tel quel, ce qui évite une rastérisation par
                // image.
                let voulu = *incrustation_fil.lock().unwrap_or_else(|e| e.into_inner());
                let echelle = echelle_millimes().load(Ordering::Relaxed) as f32 / 1000.0;
                if calque_etat != Some((voulu, echelle.to_bits())) {
                    calque =
                        crate::incrustation_lecteur::dessiner(toile_l, toile_h, echelle, &voulu);
                    calque_etat = Some((voulu, echelle.to_bits()));
                }
                if let Some(c) = calque.as_ref() {
                    crate::incrustation_lecteur::composer_sur_i420(
                        c, &mut y, &mut u, &mut v, toile_l, toile_h,
                    );
                }

                presenter(toile_l, toile_h, y, u, v, &mut recyclage);
                images += 1;
                // La position vient de l'horloge : `-re` garantit que le débit
                // suit le temps réel, il n'y a pas de PTS à lire ici.
                let ecoule = depart.elapsed().as_millis() as u64;
                position_fil.store(ecoule, Ordering::Relaxed);
                {
                    let mut etat = incrustation_fil.lock().unwrap_or_else(|e| e.into_inner());
                    etat.position_ms = depart_ms + ecoule;
                }
            }

            log::info!(
                "[Sion][lecteur] fin de lecture — {images} images en {:.1} s",
                depart.elapsed().as_secs_f64()
            );
            if let Some(mut proc) = enfant_fil.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = proc.kill();
                let _ = proc.wait();
            }
            crate::native_video_surface::remove(SENDER_LECTEUR);
            *lecture().lock().unwrap_or_else(|e| e.into_inner()) = None;
        })
        .map_err(|e| format!("fil de lecture : {e}"))?;

    *lecture().lock().unwrap_or_else(|e| e.into_inner()) = Some(Lecture {
        arret,
        enfant,
        position_ms,
        duree_ms,
        audio,
        pause,
        source: chemin.clone(),
        ffmpeg: ffmpeg.clone(),
        largeur: toile_l,
        hauteur: toile_h,
        depart_ms,
        incrustation,
    });

    Ok(EtatLecteur {
        actif: true,
        // Dimensions de la TOILE : c'est elle que la surface affiche, et
        // c'est sur elle que le front calcule ses zones de clic.
        largeur: toile_l,
        hauteur: toile_h,
        duree_ms,
        position_ms: depart_ms,
        en_pause: false,
        a_du_son,
    })
}

/// Arrête la lecture et libère la surface. Sans effet s'il n'y a rien à
/// arrêter : le front peut l'appeler à chaque fermeture sans condition.
#[tauri::command]
pub fn lecteur_video_fermer() {
    let precedente = lecture().lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(l) = precedente {
        l.arret.store(true, Ordering::Relaxed);
        if let Some(audio) = l.audio.as_ref() {
            audio.arreter();
        }
        // Tuer le processus débloque le fil, qui attend sur le tube : sans
        // cela il resterait figé jusqu'à la fin du média.
        if let Some(mut proc) = l.enfant.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = proc.kill();
            let _ = proc.wait();
        }
        crate::native_video_surface::remove(SENDER_LECTEUR);
    }
}

/// État courant, pour la barre de progression du front.
#[tauri::command]
pub fn lecteur_video_etat() -> EtatLecteur {
    let garde = lecture().lock().unwrap_or_else(|e| e.into_inner());
    match garde.as_ref() {
        Some(l) => EtatLecteur {
            actif: true,
            largeur: l.largeur,
            hauteur: l.hauteur,
            duree_ms: l.duree_ms,
            // La carte son est la meilleure horloge : elle compte ce qui a
            // réellement été joué. L'horloge système ne sert que pour un
            // média muet.
            position_ms: l.depart_ms
                + l.audio
                    .as_ref()
                    .map_or_else(|| l.position_ms.load(Ordering::Relaxed), |a| a.position_ms()),
            en_pause: l.pause.load(Ordering::Relaxed),
            a_du_son: l.audio.is_some(),
        },
        None => EtatLecteur {
            actif: false,
            largeur: 0,
            hauteur: 0,
            duree_ms: 0,
            position_ms: 0,
            en_pause: false,
            a_du_son: false,
        },
    }
}

/// Image d'affiche d'une vidéo, en JPEG encodé en base64.
///
/// Le serveur ne sait pas en produire : interrogé sur la route des vignettes,
/// Continuwuity répond 200 et renvoie **la vidéo entière** — 5,5 Mo pour un
/// clip (21/09). On extrait donc une image nous-mêmes, une fois, et on la
/// garde sur disque : une carte de fil ne doit pas relancer ffmpeg à chaque
/// défilement.
///
/// L'image est prise à une seconde du début, un premier plan étant souvent
/// noir. Sur une vidéo plus courte, ffmpeg rend la dernière image disponible.
#[tauri::command]
pub fn lecteur_video_affiche(
    app: tauri::AppHandle<crate::TauriRuntime>,
    chemin: String,
    ffmpeg_path: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    use std::hash::{Hash, Hasher};

    let mut h = std::collections::hash_map::DefaultHasher::new();
    chemin.hash(&mut h);
    let cache = crate::sion_media_dir().join(format!("sion_affiche_{:x}.jpg", h.finish()));

    if let Ok(octets) = std::fs::read(&cache) {
        if !octets.is_empty() {
            return Ok(base64::engine::general_purpose::STANDARD.encode(octets));
        }
    }

    let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());

    let sortie = crate::hidden_command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-ss", "1"])
        .arg("-i")
        .arg(&chemin)
        .args([
            "-frames:v",
            "1",
            // 480 pixels de large suffisent à une carte de fil, et l'image
            // reste nette sur un écran dense.
            "-vf",
            "scale='min(480,iw)':-2",
            "-q:v",
            "6",
            "-f",
            "mjpeg",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg introuvable : {e}"))?;

    if !sortie.status.success() || sortie.stdout.is_empty() {
        return Err("aucune image extraite".to_string());
    }
    let _ = std::fs::write(&cache, &sortie.stdout);
    Ok(base64::engine::general_purpose::STANDARD.encode(&sortie.stdout))
}

/// Où se trouvent les contrôles dans l'image, en pixels du média.
///
/// Rust les dessine, la page les écoute : la surface laisse passer les clics,
/// le front n'a qu'à poser des zones transparentes aux mêmes endroits.
#[tauri::command]
pub fn lecteur_video_zones(
    largeur: u32,
    hauteur: u32,
    echelle: f32,
) -> crate::incrustation_lecteur::Zones {
    // L'échelle sert aussi au dessin : la mémoriser ici évite au front un
    // second aller-retour, et garantit que le bandeau peint correspond aux
    // zones de clic qu'on vient de lui rendre.
    echelle_millimes().store((echelle.max(0.0) * 1000.0) as u64, Ordering::Relaxed);
    crate::incrustation_lecteur::zones(largeur, hauteur, echelle)
}

/// Met la lecture en pause, ou la reprend.
#[tauri::command]
pub fn lecteur_video_pause(en_pause: bool) {
    let garde = lecture().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = garde.as_ref() {
        l.pause.store(en_pause, Ordering::Relaxed);
        if let Some(audio) = l.audio.as_ref() {
            audio.pause(en_pause);
        }
        l.incrustation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .en_pause = en_pause;
    }
}

/// Se déplace dans le film.
///
/// ffmpeg écrit dans un tube : il n'y a rien à rembobiner, on tue les deux
/// processus et on les relance avec `-ss`. C'est le prix du processus séparé,
/// et il se paie en quelques dixièmes de seconde — `-ss` placé avant `-i`
/// saute directement à l'image clé au lieu de tout décoder.
#[tauri::command]
pub fn lecteur_video_seek(position_ms: u64) -> Result<EtatLecteur, String> {
    let (source, ffmpeg, duree) = {
        let garde = lecture().lock().unwrap_or_else(|e| e.into_inner());
        let l = garde.as_ref().ok_or_else(|| "aucune lecture".to_string())?;
        (l.source.clone(), l.ffmpeg.clone(), l.duree_ms)
    };
    // Se placer pile à la fin ne rendrait qu'un flux vide : on garde une
    // marge, et une position au-delà de la durée revient à la fin utile.
    let cible = position_ms.min(duree.saturating_sub(500));
    demarrer(&ffmpeg, &source, cible)
}

/// Position visée pendant un glissement sur la barre, ou `None` à la fin du
/// geste. Seule la pastille bouge : le déplacement réel attend le
/// relâchement, relancer ffmpeg à chaque pixel serait intenable.
#[tauri::command]
pub fn lecteur_video_apercu(position_ms: Option<u64>) {
    let garde = lecture().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = garde.as_ref() {
        l.incrustation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .apercu_ms = position_ms;
    }
}

/// Règle le volume, de 0 à 1,5 — au-delà de 1 le son est amplifié.
#[tauri::command]
pub fn lecteur_video_volume(valeur: f32) {
    let garde = lecture().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = garde.as_ref() {
        if let Some(audio) = l.audio.as_ref() {
            audio.regler_volume(valeur);
        }
        l.incrustation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .volume = valeur;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_toile_epouse_la_video_par_defaut() {
        // Élargir rapetissait la vidéo dans une bulle étroite : on n'ajoute
        // plus de bandes, le bandeau s'adapte à la place disponible.
        assert_eq!(largeur_toile(576, 1022), 576);
        assert_eq!(largeur_toile(1920, 1080), 1920);
        assert_eq!(largeur_toile(577, 1022) % 2, 0, "l'I420 exige une largeur paire");
    }


    #[test]
    fn une_image_i420_pese_une_fois_et_demie_sa_luminance() {
        assert_eq!(taille_image(4, 2), 12); // 8 de Y, 2 de U, 2 de V
        assert_eq!(taille_image(1920, 1080), 1920 * 1080 * 3 / 2);
    }

    #[test]
    fn les_plans_sont_decoupes_bout_a_bout_sans_remplissage() {
        let brut: Vec<u8> = (0u8..12).collect();
        let (y, u, v) = decouper_plans(&brut, 4, 2).expect("découpe");
        assert_eq!(y, (0u8..8).collect::<Vec<_>>());
        assert_eq!(u, vec![8, 9]);
        assert_eq!(v, vec![10, 11]);
    }

    #[test]
    fn une_image_tronquee_est_refusee_plutot_que_rendue_a_moitie() {
        // Le tube peut se fermer au milieu d'une image : mieux vaut arrêter
        // que peindre un plan incomplet, qui s'afficherait en vert.
        let brut = vec![0u8; 10];
        assert!(decouper_plans(&brut, 4, 2).is_none());
    }
}
