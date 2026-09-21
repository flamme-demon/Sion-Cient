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
}

fn lecture() -> &'static Mutex<Option<Lecture>> {
    static L: OnceLock<Mutex<Option<Lecture>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// Décrit ce qui est en train d'être lu, pour le front.
#[derive(serde::Serialize, Clone)]
pub struct EtatLecteur {
    pub actif: bool,
    pub largeur: u32,
    pub hauteur: u32,
    pub duree_ms: u64,
    pub position_ms: u64,
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
    lecteur_video_fermer();

    let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());

    // Dimensions et durée : ffmpeg les écrit sur sa sortie d'erreur quand on
    // l'invoque sans destination. `ffprobe` serait plus propre, mais le
    // bouton d'installation intégré ne pose que `ffmpeg`.
    let (largeur, hauteur, duree) = crate::probe_video(&ffmpeg, std::path::Path::new(&chemin))
        .ok_or_else(|| format!("format illisible, ou ffmpeg absent : {chemin}"))?;
    if largeur == 0 || hauteur == 0 || largeur % 2 != 0 || hauteur % 2 != 0 {
        return Err(format!("dimensions inexploitables : {largeur}x{hauteur}"));
    }
    let duree_ms = (duree * 1000.0) as u64;

    log::info!(
        "[Sion][lecteur] {chemin} — {largeur}x{hauteur}, {} s",
        duree_ms / 1000
    );
    crate::native_video_surface::announce_source_dimensions(SENDER_LECTEUR, largeur, hauteur);

    let mut commande = crate::hidden_command(&ffmpeg);
    commande
        .args(["-hide_banner", "-loglevel", "error", "-re", "-i"])
        .arg(&chemin)
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
    let octets = taille_image(largeur, hauteur);

    std::thread::Builder::new()
        .name("sion-lecteur-video".into())
        .spawn(move || {
            let depart = std::time::Instant::now();
            let mut tampon = vec![0u8; octets];
            let mut images = 0u64;

            while !arret_fil.load(Ordering::Relaxed) {
                // Une lecture incomplète signe la fin du flux : ffmpeg a
                // terminé, ou il a été arrêté.
                if sortie.read_exact(&mut tampon).is_err() {
                    break;
                }
                let Some((y, u, v)) = decouper_plans(&tampon, largeur, hauteur) else {
                    break;
                };
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
                images += 1;
                // La position vient de l'horloge : `-re` garantit que le débit
                // suit le temps réel, il n'y a pas de PTS à lire ici.
                position_fil.store(depart.elapsed().as_millis() as u64, Ordering::Relaxed);
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
    });

    Ok(EtatLecteur {
        actif: true,
        largeur,
        hauteur,
        duree_ms,
        position_ms: 0,
    })
}

/// Arrête la lecture et libère la surface. Sans effet s'il n'y a rien à
/// arrêter : le front peut l'appeler à chaque fermeture sans condition.
#[tauri::command]
pub fn lecteur_video_fermer() {
    let precedente = lecture().lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(l) = precedente {
        l.arret.store(true, Ordering::Relaxed);
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
            largeur: 0,
            hauteur: 0,
            duree_ms: l.duree_ms,
            position_ms: l.position_ms.load(Ordering::Relaxed),
        },
        None => EtatLecteur {
            actif: false,
            largeur: 0,
            hauteur: 0,
            duree_ms: 0,
            position_ms: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
