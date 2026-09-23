//! Memes : de courtes vidéos qui surgissent par-dessus l'écran — jeux
//! compris — chez tous les participants du salon vocal.
//!
//! ## Une fenêtre par meme, pas l'overlay des curseurs
//!
//! L'overlay des curseurs couvre tout l'écran, et sous X11 comme sous Windows
//! il reconvertit l'écran entier à chaque image. Supportable pour quelques
//! ondes de clic ; pas pour une vidéo à trente images par seconde pendant dix
//! secondes, en plein jeu. Il est aussi lié au partage d'écran, qui l'ouvre et
//! le ferme. Chaque meme a donc sa propre petite fenêtre, à sa taille, faite
//! des mêmes briques : layer-shell sous Wayland — la seule couche qui passe
//! au-dessus d'un jeu en plein écran —, fenêtre ARGB sous X11, fenêtre
//! « layered » sous Windows.
//!
//! ## Image et son
//!
//! L'image est décodée par ffmpeg au fil de la lecture (`-re`), comme pour le
//! lecteur vidéo : rien n'est gardé en mémoire au-delà de l'image courante.
//! Le son emprunte le chemin de la soundboard : mixé dans le rendu WebRTC,
//! donc vu par l'annulation d'écho, et jeté en sourdine.
//!
//! ## Sourdine
//!
//! En sourdine, un meme ne fait RIEN — ni image ni son. Un meme sans son n'est
//! qu'à moitié un meme, et la sourdine sert souvent à dire « je ne suis pas
//! là ». Un meme en cours se retire si la sourdine tombe pendant sa lecture.

use std::io::Read;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ab_glyph::{Font, PxScale, ScaleFont};
use tiny_skia::{
    Color, FillRule, FilterQuality, IntSize, Paint, Path, PathBuilder, Pattern, Pixmap,
    SpreadMode, Stroke, Transform,
};

#[cfg(target_os = "linux")]
#[path = "meme_pop_wayland.rs"]
mod wayland;
#[cfg(target_os = "linux")]
#[path = "meme_pop_x11.rs"]
mod x11;
#[cfg(target_os = "windows")]
#[path = "meme_pop_win32.rs"]
mod win32;

/// Boîte où tient la vidéo, en pixels d'écran. Assez grande pour se voir en
/// pleine partie, assez petite pour ne masquer qu'un coin de l'action.
const BOITE_LARGEUR: u32 = 420;
const BOITE_HAUTEUR: u32 = 320;
/// Une vidéo minuscule n'est pas agrandie au-delà : on verrait ses pixels.
const AGRANDISSEMENT_MAX: f32 = 2.0;
/// Place autour de la vidéo pour son ombre.
const MARGE: u32 = 16;
/// Distance minimale entre le meme et les bords de l'écran.
const MARGE_ECRAN: i32 = 24;
const RAYON: f32 = 14.0;
/// Au-delà, le meme est coupé : c'est une réaction, pas un film.
pub const DUREE_MAX_S: f64 = 10.0;
const IMAGES_PAR_SECONDE: u32 = 30;
/// Au-delà, les memes suivants sont ignorés : trois vidéos à la fois, c'est
/// déjà beaucoup par-dessus une partie.
const SIMULTANES_MAX: usize = 3;
const FONDU_ENTREE: Duration = Duration::from_millis(180);
const FONDU_SORTIE: Duration = Duration::from_millis(260);

static EN_COURS: AtomicUsize = AtomicUsize::new(0);
/// Incrémenté par `memeboard_arreter` : chaque meme retient la valeur de son
/// départ et se retire dès qu'elle change.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Une place parmi les `SIMULTANES_MAX`, rendue à la fin du meme — y compris
/// sur erreur ou panique.
struct Place;

impl Place {
    fn prendre() -> Option<Place> {
        let avant = EN_COURS.fetch_add(1, Ordering::AcqRel);
        if avant >= SIMULTANES_MAX {
            EN_COURS.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Place)
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        EN_COURS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Fait surgir un meme.
///
/// `source` est un fichier local ou une URL — ramenée en cache, jamais passée
/// à ffmpeg (voir `lecteur_video::ramener_en_local`). `emetteur` est le nom
/// affiché sur le meme. Rend la main aussitôt : la lecture se fait sur un fil.
#[tauri::command]
pub fn memeboard_jouer(
    app: tauri::AppHandle<crate::TauriRuntime>,
    source: String,
    gain: f32,
    emetteur: Option<String>,
    ffmpeg_path: Option<String>,
) -> Result<(), String> {
    if crate::voice_native::en_sourdine() {
        return Ok(());
    }
    let Some(place) = Place::prendre() else {
        log::info!("[Sion][meme] déjà {SIMULTANES_MAX} memes à l'écran — ignoré");
        return Ok(());
    };
    let gain = if gain.is_finite() { gain.clamp(0.0, 3.0) } else { 1.0 };
    std::thread::Builder::new()
        .name("sion-meme".into())
        .spawn(move || {
            let _place = place;
            if let Err(e) = jouer(&app, &source, gain, emetteur.as_deref(), ffmpeg_path.as_deref())
            {
                log::warn!("[Sion][meme] {e}");
            }
        })
        .map_err(|e| format!("fil du meme : {e}"))?;
    Ok(())
}

/// Retire tous les memes à l'écran — la memeboard vient d'être coupée.
#[tauri::command]
pub fn memeboard_arreter() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
}

fn jouer(
    app: &tauri::AppHandle<crate::TauriRuntime>,
    source: &str,
    gain: f32,
    emetteur: Option<&str>,
    ffmpeg_path: Option<&str>,
) -> Result<(), String> {
    let gere = crate::managed_ffmpeg_path(app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path, gere.as_deref());
    let chemin = crate::lecteur_video::ramener_en_local(app, source)?;
    lire(&ffmpeg, &chemin, emetteur, |samples| {
        crate::voice_native::jouer_clip_de_pair(app, samples, gain)
    })
}

/// La lecture elle-même, sans rien de l'application : `jouer_son` reçoit la
/// bande-son au moment où la première image paraît.
fn lire(
    ffmpeg: &str,
    chemin: &str,
    emetteur: Option<&str>,
    jouer_son: impl FnOnce(Vec<i16>),
) -> Result<(), String> {
    let generation = GENERATION.load(Ordering::Acquire);
    let (vl, vh, _) = crate::probe_video(ffmpeg, std::path::Path::new(chemin))
        .ok_or_else(|| format!("meme illisible : {chemin}"))?;
    let (l, h) = taille_affichee(vl, vh);
    let son = decoder_son(ffmpeg, chemin);

    // Dimensions IMPOSÉES à ffmpeg, jamais supposées — voir `lecteur_video`.
    let mut enfant = crate::hidden_command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-re", "-i"])
        .arg(chemin)
        .args([
            "-t",
            &DUREE_MAX_S.to_string(),
            "-vf",
            &format!("scale={l}:{h}:flags=bicubic,setsar=1,fps={IMAGES_PAR_SECONDE}"),
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("lancement de ffmpeg : {e}"))?;
    let mut sortie = enfant.stdout.take().ok_or("sortie de ffmpeg indisponible")?;

    let resultat = (|| {
        let cadre = Cadre::new(l, h, emetteur);
        let (fl, fh) = (cadre.largeur(), cadre.hauteur());
        let mut fenetre = Fenetre::ouvrir(fl, fh, |el, eh| position_aleatoire(el, eh, fl, fh))?;
        let mut tampon = vec![0u8; l as usize * h as usize * 4];
        let mut toile = Pixmap::new(fl, fh).ok_or("toile du meme")?;
        let mut bgra = vec![0u8; fl as usize * fh as usize * 4];
        let mut image: Option<Pixmap> = None;
        let mut debut: Option<Instant> = None;
        let mut son = Some((son, jouer_son));

        let retire = || {
            GENERATION.load(Ordering::Acquire) != generation
                || crate::voice_native::en_sourdine()
        };
        while !retire() {
            if sortie.read_exact(&mut tampon).is_err() {
                break;
            }
            image = image_depuis_rgba(&tampon, l, h);
            let depart = *debut.get_or_insert_with(Instant::now);
            // Le son part avec la première image : ffmpeg met quelques
            // dizaines de millisecondes à livrer l'image, et un son lancé
            // avant se serait décalé d'autant.
            if let Some((samples, jouer_son)) = son.take() {
                jouer_son(samples);
            }
            let opacite = (depart.elapsed().as_secs_f32() / FONDU_ENTREE.as_secs_f32()).min(1.0);
            if let Some(i) = image.as_ref() {
                cadre.peindre(&mut toile, i, opacite);
                vers_bgra(&toile, &mut bgra);
                fenetre.presenter(&bgra)?;
            }
        }

        // Fondu de sortie sur la dernière image : un meme qui disparaît d'un
        // coup donne l'impression d'avoir planté.
        if let Some(i) = image.as_ref() {
            let fin = Instant::now();
            loop {
                let t = fin.elapsed().as_secs_f32() / FONDU_SORTIE.as_secs_f32();
                if t >= 1.0 {
                    break;
                }
                cadre.peindre(&mut toile, i, 1.0 - t);
                vers_bgra(&toile, &mut bgra);
                fenetre.presenter(&bgra)?;
                std::thread::sleep(Duration::from_millis(1000 / IMAGES_PAR_SECONDE as u64));
            }
        }
        Ok(())
    })();

    let _ = enfant.kill();
    let _ = enfant.wait();
    resultat
}

/// Côté maximal d'un meme envoyé : la boîte d'affichage, arrondie. Au-delà,
/// on paierait en poids ce que personne ne verra.
const COTE_MAX_ENVOI: u32 = 480;
/// Poids maximal d'un meme envoyé. Tout le salon le télécharge au premier
/// déclenchement : un meme lourd arriverait après la blague.
const POIDS_MAX: u64 = 3 * 1024 * 1024;

/// Un meme prêt à envoyer : fichiers dans le dossier média temporaire, que le
/// front relit par `read_media`.
#[derive(serde::Serialize)]
pub struct MemePrepare {
    pub video: String,
    pub mime: String,
    pub apercu: Option<String>,
    pub apercu_mime: Option<String>,
    pub largeur: u32,
    pub hauteur: u32,
    pub duree_ms: u64,
    pub taille: u64,
}

/// Découpe et réencode un meme avant l'envoi.
///
/// `debut_ms` et `duree_ms` choisissent l'extrait ; la durée est bornée à
/// `DUREE_MAX_S`. Une vidéo devient du MP4 H.264 compact ; un GIF reste un
/// GIF, pour garder sa transparence — ffmpeg la rend telle quelle au moment
/// de l'afficher. S'y ajoute un aperçu WebP animé pour la grille du panneau,
/// que la vue web sait animer sans GStreamer.
#[tauri::command]
pub async fn memeboard_preparer(
    app: tauri::AppHandle<crate::TauriRuntime>,
    source: String,
    debut_ms: u64,
    duree_ms: u64,
    ffmpeg_path: Option<String>,
) -> Result<MemePrepare, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
        let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());
        let chemin = crate::lecteur_video::ramener_en_local(&app, &source)?;
        preparer(&ffmpeg, &chemin, debut_ms, duree_ms)
    })
    .await
    .map_err(|e| format!("préparation interrompue : {e}"))?
}

fn preparer(ffmpeg: &str, chemin: &str, debut_ms: u64, duree_ms: u64) -> Result<MemePrepare, String> {
    let (_, _, duree_source) = crate::probe_video(ffmpeg, std::path::Path::new(chemin))
        .ok_or_else(|| "vidéo illisible, ou ffmpeg absent".to_string())?;
    let total_ms = (duree_source * 1000.0) as u64;
    // Une image fixe ou une durée inconnue : on garde ce que l'utilisateur a
    // demandé, ffmpeg s'arrêtera de lui-même au bout du fichier.
    let debut_ms = if total_ms > 0 { debut_ms.min(total_ms.saturating_sub(100)) } else { debut_ms };
    let mut duree_ms = duree_ms.clamp(300, (DUREE_MAX_S * 1000.0) as u64);
    if total_ms > 0 {
        duree_ms = duree_ms.min(total_ms - debut_ms).max(100);
    }
    let (debut, duree) = (
        format!("{:.3}", debut_ms as f64 / 1000.0),
        format!("{:.3}", duree_ms as f64 / 1000.0),
    );
    let tampon = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dossier = crate::sion_media_dir();
    let lancer = |args: &[&str], sortie: &std::path::Path| -> bool {
        crate::hidden_command(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &debut, "-t", &duree, "-i"])
            .arg(chemin)
            .args(args)
            .arg(sortie)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
            && sortie.metadata().map(|m| m.len() > 0).unwrap_or(false)
    };
    let poids = |p: &std::path::Path| p.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
    let echelle = |cote: u32| {
        format!(
            "scale=w='min({cote},iw)':h='min({cote},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
        )
    };

    let mut sortie: Option<(std::path::PathBuf, &str)> = None;
    if chemin.to_ascii_lowercase().ends_with(".gif") {
        let gif = dossier.join(format!("meme_{tampon:x}.gif"));
        let filtre = format!(
            "fps=20,{},split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:alpha_threshold=128",
            echelle(360)
        );
        if lancer(&["-vf", &filtre, "-loop", "0"], &gif) && poids(&gif) <= POIDS_MAX {
            sortie = Some((gif, "image/gif"));
        }
    }
    if sortie.is_none() {
        let mp4 = dossier.join(format!("meme_{tampon:x}.mp4"));
        // Du plus fin au plus compact : on garde la première passe qui tient
        // dans le poids.
        //
        // x264 est sous GPL : le ffmpeg livré avec l'installeur Windows — la
        // variante LGPL de BtbN — ne l'a pas. Il a en revanche OpenH264
        // (BSD) : le meme reste du H.264. `mpeg4` n'est plus que le dernier
        // recours d'un ffmpeg qui n'aurait ni l'un ni l'autre.
        let passes: [(u32, &[&str]); 6] = [
            (COTE_MAX_ENVOI, &["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]),
            (360, &["-c:v", "libx264", "-preset", "veryfast", "-crf", "32"]),
            (COTE_MAX_ENVOI, &["-c:v", "libopenh264", "-b:v", "1800k"]),
            (360, &["-c:v", "libopenh264", "-b:v", "900k"]),
            (COTE_MAX_ENVOI, &["-c:v", "mpeg4", "-q:v", "6"]),
            (360, &["-c:v", "mpeg4", "-q:v", "12"]),
        ];
        for (cote, video) in passes {
            let filtre = format!("{},fps=30", echelle(cote));
            let mut args: Vec<&str> = vec!["-vf", &filtre];
            args.extend_from_slice(video);
            args.extend_from_slice(&[
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "96k",
                "-ac", "2", "-ar", "48000",
            ]);
            if lancer(&args, &mp4) && poids(&mp4) <= POIDS_MAX {
                sortie = Some((mp4, "video/mp4"));
                break;
            }
        }
    }
    let (video, mime) = sortie.ok_or_else(|| {
        format!("impossible de ramener le meme sous {} Mo", POIDS_MAX / 1024 / 1024)
    })?;
    let (largeur, hauteur, duree_sortie) = crate::probe_video(ffmpeg, &video)
        .ok_or_else(|| "le meme préparé est illisible".to_string())?;

    // Aperçu animé des trois premières secondes, repli sur une image fixe.
    let webp = dossier.join(format!("meme_{tampon:x}_apercu.webp"));
    let jpg = dossier.join(format!("meme_{tampon:x}_apercu.jpg"));
    let apercu = if lancer(
        &[
            "-t", "3", "-vf", "fps=12,scale=w='min(220,iw)':h=-2:flags=lanczos", "-an", "-loop",
            "0", "-c:v", "libwebp", "-quality", "55",
        ],
        &webp,
    ) {
        Some((webp, "image/webp"))
    } else if lancer(&["-frames:v", "1", "-vf", "scale=w='min(220,iw)':h=-2", "-q:v", "4"], &jpg) {
        Some((jpg, "image/jpeg"))
    } else {
        None
    };

    Ok(MemePrepare {
        taille: poids(&video),
        video: video.to_string_lossy().into_owned(),
        mime: mime.to_string(),
        apercu_mime: apercu.as_ref().map(|(_, m)| m.to_string()),
        apercu: apercu.map(|(p, _)| p.to_string_lossy().into_owned()),
        largeur,
        hauteur,
        duree_ms: (duree_sortie * 1000.0) as u64,
    })
}

/// Ce que le découpeur doit savoir d'une source.
#[derive(serde::Serialize)]
pub struct MemeAnalyse {
    pub duree_ms: u64,
}

/// Nom de fichier unique dans le dossier média, même entre fils parallèles.
fn fichier_temporaire(suffixe: &str) -> std::path::PathBuf {
    static COMPTEUR: AtomicU64 = AtomicU64::new(0);
    let n = COMPTEUR.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    crate::sion_media_dir().join(format!("meme_{t:x}_{n}_{suffixe}"))
}

/// Les fichiers de préparation de la veille : personne ne les relira.
fn purger_anciens() {
    let Ok(entrees) = std::fs::read_dir(crate::sion_media_dir()) else { return };
    let limite = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
    for e in entrees.flatten() {
        let nom = e.file_name();
        if !nom.to_string_lossy().starts_with("meme_") {
            continue;
        }
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < limite) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn ffmpeg_ok(ffmpeg: &str, args: &[&str], sortie: &std::path::Path) -> bool {
    crate::hidden_command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .arg(sortie)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        && sortie.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// Durée d'une source, pour borner les curseurs du découpeur.
#[tauri::command]
pub async fn memeboard_analyser(
    app: tauri::AppHandle<crate::TauriRuntime>,
    source: String,
    ffmpeg_path: Option<String>,
) -> Result<MemeAnalyse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
        let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());
        let chemin = crate::lecteur_video::ramener_en_local(&app, &source)?;
        purger_anciens();
        let (_, _, duree) = crate::probe_video(&ffmpeg, std::path::Path::new(&chemin))
            .ok_or_else(|| "vidéo illisible, ou ffmpeg absent".to_string())?;
        Ok(MemeAnalyse {
            duree_ms: (duree.max(0.0) * 1000.0) as u64,
        })
    })
    .await
    .map_err(|e| format!("analyse interrompue : {e}"))?
}

/// L'image d'une source à un instant — celle que montre le découpeur sous le
/// curseur qu'on déplace. La vue web ne sait pas lire la vidéo elle-même.
#[tauri::command]
pub async fn memeboard_image(
    app: tauri::AppHandle<crate::TauriRuntime>,
    source: String,
    t_ms: u64,
    ffmpeg_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gere = crate::managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
        let ffmpeg = crate::resolve_ffmpeg(ffmpeg_path.as_deref(), gere.as_deref());
        let chemin = crate::lecteur_video::ramener_en_local(&app, &source)?;
        image_a(&ffmpeg, &chemin, t_ms)
    })
    .await
    .map_err(|e| format!("extraction interrompue : {e}"))?
}

fn image_a(ffmpeg: &str, chemin: &str, t_ms: u64) -> Result<String, String> {
    let sortie = fichier_temporaire("image.jpg");
    let t = format!("{:.3}", t_ms as f64 / 1000.0);
    // `-ss` avant `-i` : saut direct à l'image clé la plus proche, sans
    // décoder ce qui précède — l'image suit le curseur sans attendre.
    if ffmpeg_ok(
        ffmpeg,
        &["-ss", &t, "-i", chemin, "-frames:v", "1", "-vf", "scale=w='min(480,iw)':h=-2", "-q:v", "4"],
        &sortie,
    ) {
        Ok(sortie.to_string_lossy().into_owned())
    } else {
        Err(format!("pas d'image à {t} s"))
    }
}

/// Taille de la vidéo à l'écran : dans la boîte, proportions gardées,
/// dimensions paires pour ffmpeg.
fn taille_affichee(l: u32, h: u32) -> (u32, u32) {
    let (l, h) = (l.max(1) as f32, h.max(1) as f32);
    let echelle = (BOITE_LARGEUR as f32 / l)
        .min(BOITE_HAUTEUR as f32 / h)
        .min(AGRANDISSEMENT_MAX);
    let pair = |v: f32| (((v / 2.0).round() as u32) * 2).max(2);
    (pair(l * echelle), pair(h * echelle))
}

/// Une place au hasard sur l'écran, loin des bords.
fn position_aleatoire(ecran_l: u32, ecran_h: u32, l: u32, h: u32) -> (i32, i32) {
    let mut graine = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15)
        | 1;
    // xorshift : un tirage par meme n'appelle pas une dépendance de plus.
    let mut tirer = |borne: i32| -> i32 {
        graine ^= graine << 13;
        graine ^= graine >> 7;
        graine ^= graine << 17;
        if borne <= 0 {
            0
        } else {
            (graine % borne as u64) as i32
        }
    };
    let libre_x = ecran_l as i32 - l as i32 - 2 * MARGE_ECRAN;
    let libre_y = ecran_h as i32 - h as i32 - 2 * MARGE_ECRAN;
    (
        MARGE_ECRAN.min((ecran_l as i32 - l as i32).max(0) / 2) + tirer(libre_x + 1),
        MARGE_ECRAN.min((ecran_h as i32 - h as i32).max(0) / 2) + tirer(libre_y + 1),
    )
}

/// Bande-son entière, mono 48 kHz : le format du mixeur de la soundboard.
/// Vide si le meme est muet — un GIF, typiquement.
fn decoder_son(ffmpeg: &str, chemin: &str) -> Vec<i16> {
    let sortie = crate::hidden_command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(chemin)
        .args([
            "-t",
            &DUREE_MAX_S.to_string(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "-",
        ])
        .stderr(std::process::Stdio::null())
        .output();
    match sortie {
        Ok(s) if s.status.success() => s
            .stdout
            .chunks_exact(2)
            .map(|p| i16::from_le_bytes([p[0], p[1]]))
            .collect(),
        _ => Vec::new(),
    }
}

/// Image RGBA de ffmpeg vers un pixmap. tiny-skia veut de l'alpha
/// pré-multiplié : un GIF à fond transparent garde ainsi ses bords propres.
fn image_depuis_rgba(rgba: &[u8], l: u32, h: u32) -> Option<Pixmap> {
    let mut donnees = rgba.to_vec();
    for px in donnees.chunks_exact_mut(4) {
        let a = px[3] as u16;
        if a != 255 {
            for c in &mut px[..3] {
                *c = ((*c as u16 * a + 127) / 255) as u8;
            }
        }
    }
    Pixmap::from_vec(donnees, IntSize::from_wh(l, h)?)
}

/// RGBA pré-multiplié de tiny-skia vers le BGRA pré-multiplié qu'attendent
/// les trois plateformes : seuls le rouge et le bleu s'échangent.
fn vers_bgra(toile: &Pixmap, bgra: &mut [u8]) {
    for (d, s) in bgra.chunks_exact_mut(4).zip(toile.data().chunks_exact(4)) {
        d[0] = s[2];
        d[1] = s[1];
        d[2] = s[0];
        d[3] = s[3];
    }
}

fn rectangle_arrondi(x: f32, y: f32, l: f32, h: f32, r: f32) -> Option<Path> {
    let r = r.min(l / 2.0).min(h / 2.0).max(0.0);
    let c = 0.552_284_8 * r;
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + l - r, y);
    pb.cubic_to(x + l - r + c, y, x + l, y + r - c, x + l, y + r);
    pb.line_to(x + l, y + h - r);
    pb.cubic_to(x + l, y + h - r + c, x + l - r + c, y + h, x + l - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - c, y + h, x, y + h - r + c, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - c, x + r - c, y, x + r, y);
    pb.close();
    pb.finish()
}

/// Ce qui entoure la vidéo : ombre, coins arrondis, liseré, et le nom de qui
/// l'a envoyée.
struct Cadre {
    l: u32,
    h: u32,
    ombre: Pixmap,
    pastille: Option<Pixmap>,
}

impl Cadre {
    fn new(l: u32, h: u32, emetteur: Option<&str>) -> Self {
        let (fl, fh) = (l + 2 * MARGE, h + 2 * MARGE);
        // L'ombre ne change pas d'une image à l'autre : peinte une fois. Des
        // anneaux concentriques peu opaques font un flou convenable, tiny-skia
        // n'en ayant pas.
        let mut ombre = Pixmap::new(fl, fh).expect("dimensions non nulles");
        let m = MARGE as f32;
        for i in (1..=6).rev() {
            let e = i as f32 * (m / 6.0);
            let mut peinture = Paint::default();
            peinture.set_color(Color::from_rgba(0.0, 0.0, 0.0, 0.07).unwrap_or(Color::BLACK));
            peinture.anti_alias = true;
            if let Some(chemin) = rectangle_arrondi(
                m - e,
                m - e + 3.0,
                l as f32 + 2.0 * e,
                h as f32 + 2.0 * e,
                RAYON + e,
            ) {
                ombre.fill_path(&chemin, &peinture, FillRule::Winding, Transform::identity(), None);
            }
        }
        Cadre {
            l,
            h,
            ombre,
            pastille: emetteur.filter(|n| !n.trim().is_empty()).and_then(pastille),
        }
    }

    fn largeur(&self) -> u32 {
        self.l + 2 * MARGE
    }

    fn hauteur(&self) -> u32 {
        self.h + 2 * MARGE
    }

    fn peindre(&self, toile: &mut Pixmap, image: &Pixmap, opacite: f32) {
        toile.fill(Color::TRANSPARENT);
        let opacite = opacite.clamp(0.0, 1.0);
        let fondu = tiny_skia::PixmapPaint {
            opacity: opacite,
            ..Default::default()
        };
        toile.draw_pixmap(0, 0, self.ombre.as_ref(), &fondu, Transform::identity(), None);

        let m = MARGE as f32;
        let Some(cadre) = rectangle_arrondi(m, m, self.l as f32, self.h as f32, RAYON) else {
            return;
        };
        let mut peinture = Paint::default();
        peinture.anti_alias = true;
        peinture.shader = Pattern::new(
            image.as_ref(),
            SpreadMode::Pad,
            FilterQuality::Nearest,
            opacite,
            Transform::from_translate(m, m),
        );
        toile.fill_path(&cadre, &peinture, FillRule::Winding, Transform::identity(), None);

        // Liseré clair : détache le meme d'un jeu sombre.
        let mut trait_ = Paint::default();
        trait_.anti_alias = true;
        trait_.set_color(Color::from_rgba(1.0, 1.0, 1.0, 0.14 * opacite).unwrap_or(Color::WHITE));
        toile.stroke_path(
            &cadre,
            &trait_,
            &Stroke {
                width: 1.0,
                ..Default::default()
            },
            Transform::identity(),
            None,
        );

        if let Some(p) = self.pastille.as_ref() {
            toile.draw_pixmap(
                MARGE as i32 + 10,
                MARGE as i32 + 10,
                p.as_ref(),
                &fondu,
                Transform::identity(),
                None,
            );
        }
    }
}

/// Le nom de l'expéditeur, dans une pastille sombre. Peinte une fois.
fn pastille(nom: &str) -> Option<Pixmap> {
    const CORPS: f32 = 14.0;
    const MAX_CARACTERES: usize = 24;
    let font = crate::cursor_overlay::font()?;
    let nom: String = if nom.chars().count() > MAX_CARACTERES {
        nom.chars().take(MAX_CARACTERES - 1).collect::<String>() + "…"
    } else {
        nom.to_string()
    };
    let echelle = PxScale::from(CORPS);
    let f = font.as_scaled(echelle);
    let texte_l: f32 = nom.chars().map(|c| f.h_advance(f.glyph_id(c))).sum();
    let (pad_x, pad_y) = (9.0, 4.0);
    let l = (texte_l + 2.0 * pad_x).ceil() as u32;
    let h = (f.ascent() - f.descent() + 2.0 * pad_y).ceil() as u32;
    let mut p = Pixmap::new(l.max(1), h.max(1))?;
    let mut fond = Paint::default();
    fond.anti_alias = true;
    fond.set_color(Color::from_rgba(0.0, 0.0, 0.0, 0.6)?);
    let chemin = rectangle_arrondi(0.0, 0.0, l as f32, h as f32, h as f32 / 2.0)?;
    p.fill_path(&chemin, &fond, FillRule::Winding, Transform::identity(), None);

    let (pl, ph) = (p.width() as i32, p.height() as i32);
    let donnees = p.data_mut();
    let base = pad_y + f.ascent();
    let mut stylo = pad_x;
    for c in nom.chars() {
        let id = f.glyph_id(c);
        let glyphe = id.with_scale_and_position(echelle, ab_glyph::point(stylo, base));
        if let Some(contour) = font.outline_glyph(glyphe) {
            let boite = contour.px_bounds();
            contour.draw(|gx, gy, couverture| {
                let x = boite.min.x as i32 + gx as i32;
                let y = boite.min.y as i32 + gy as i32;
                if x < 0 || y < 0 || x >= pl || y >= ph {
                    return;
                }
                let i = (y * pl + x) as usize * 4;
                let a = couverture.clamp(0.0, 1.0);
                for canal in 0..4 {
                    let d = &mut donnees[i + canal];
                    *d = (255.0 * a + *d as f32 * (1.0 - a)).round() as u8;
                }
            });
        }
        stylo += f.h_advance(id);
    }
    Some(p)
}

/// La fenêtre de la plateforme. Sous Linux, Wayland d'abord — seul
/// layer-shell passe au-dessus d'un jeu en plein écran — puis X11.
enum Fenetre {
    #[cfg(target_os = "linux")]
    Wayland(wayland::FenetreWayland),
    #[cfg(target_os = "linux")]
    X11(x11::FenetreX11),
    #[cfg(target_os = "windows")]
    Win32(win32::FenetreWin32),
}

impl Fenetre {
    /// Ouvre une fenêtre de `l`×`h` pixels. `placer` reçoit la taille de
    /// l'écran et rend le coin haut gauche voulu.
    #[allow(unused_variables, unused_mut)]
    fn ouvrir(
        l: u32,
        h: u32,
        mut placer: impl FnMut(u32, u32) -> (i32, i32),
    ) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                match wayland::FenetreWayland::ouvrir(l, h, &mut placer) {
                    Ok(f) => return Ok(Fenetre::Wayland(f)),
                    Err(e) => log::info!("[Sion][meme] layer-shell indisponible ({e}) — repli X11"),
                }
            }
            x11::FenetreX11::ouvrir(l, h, &mut placer).map(Fenetre::X11)
        }
        #[cfg(target_os = "windows")]
        {
            win32::FenetreWin32::ouvrir(l, h, &mut placer).map(Fenetre::Win32)
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Err("memes non pris en charge sur cette plateforme".into())
        }
    }

    /// `bgra` : `l`×`h` pixels BGRA pré-multipliés.
    #[allow(unused_variables)]
    fn presenter(&mut self, bgra: &[u8]) -> Result<(), String> {
        match self {
            #[cfg(target_os = "linux")]
            Fenetre::Wayland(f) => f.presenter(bgra),
            #[cfg(target_os = "linux")]
            Fenetre::X11(f) => f.presenter(bgra),
            #[cfg(target_os = "windows")]
            Fenetre::Win32(f) => f.presenter(bgra),
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_meme_tient_dans_sa_boite_sans_etre_deforme() {
        let (l, h) = taille_affichee(1920, 1080);
        assert!(l <= BOITE_LARGEUR && h <= BOITE_HAUTEUR);
        assert!((l as f32 / h as f32 - 16.0 / 9.0).abs() < 0.02);
        let (l, h) = taille_affichee(720, 1280);
        assert!(l <= BOITE_LARGEUR && h <= BOITE_HAUTEUR);
        assert_eq!((l % 2, h % 2), (0, 0));
    }

    #[test]
    fn un_petit_gif_est_agrandi_mais_pas_trop() {
        let (l, _) = taille_affichee(100, 100);
        assert_eq!(l, (100.0 * AGRANDISSEMENT_MAX) as u32);
    }

    #[test]
    fn le_meme_tombe_toujours_dans_l_ecran() {
        for _ in 0..200 {
            let (x, y) = position_aleatoire(1920, 1080, 452, 352);
            assert!(x >= MARGE_ECRAN && x + 452 <= 1920 - MARGE_ECRAN, "x = {x}");
            assert!(y >= MARGE_ECRAN && y + 352 <= 1080 - MARGE_ECRAN, "y = {y}");
        }
        // Écran plus petit que le meme : collé en haut à gauche, sans panique.
        assert_eq!(position_aleatoire(200, 100, 452, 352), (0, 0));
    }

    #[test]
    fn trois_memes_a_la_fois_et_pas_un_de_plus() {
        let places: Vec<_> = (0..SIMULTANES_MAX).filter_map(|_| Place::prendre()).collect();
        assert_eq!(places.len(), SIMULTANES_MAX);
        assert!(Place::prendre().is_none());
        drop(places);
        assert!(Place::prendre().is_some());
    }

    /// Fait surgir un vrai meme à l'écran — pas un test, un outil de réglage.
    ///
    /// `SION_MEME_APERCU=video.mp4 cargo test -j4 --lib meme_pop::tests::apercu
    /// -- --ignored --nocapture`, sans le son.
    #[test]
    #[ignore]
    fn apercu() {
        let Ok(chemin) = std::env::var("SION_MEME_APERCU") else { return };
        lire("ffmpeg", &chemin, Some("Picsou"), |_| {}).expect("lecture du meme");
    }

    /// Source générée par ffmpeg : le test se passe de fichier, et s'efface
    /// là où ffmpeg manque.
    fn source_de_test(nom: &str, args: &[&str]) -> Option<String> {
        let chemin = std::env::temp_dir().join(nom);
        let ok = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(args)
            .arg(&chemin)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        ok.then(|| chemin.to_string_lossy().into_owned())
    }

    #[test]
    fn un_meme_est_coupe_a_dix_secondes_et_reste_leger() {
        let Some(source) = source_de_test(
            "sion-meme-source.mp4",
            &["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
              "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
              "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"],
        ) else {
            eprintln!("ffmpeg absent : test ignoré");
            return;
        };
        let p = preparer("ffmpeg", &source, 1_000, 60_000).expect("préparation");
        assert_eq!(p.mime, "video/mp4");
        assert!(p.duree_ms <= 10_100, "durée {}", p.duree_ms);
        assert!(p.duree_ms >= 9_500, "durée {}", p.duree_ms);
        assert!(p.largeur <= COTE_MAX_ENVOI && p.hauteur <= COTE_MAX_ENVOI);
        assert!(p.taille <= POIDS_MAX);
        assert!(p.apercu.is_some(), "aperçu manquant");
        for f in [Some(&p.video), p.apercu.as_ref()].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn le_decoupeur_obtient_l_image_sous_le_curseur() {
        let Some(source) = source_de_test(
            "sion-meme-image.mp4",
            &["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
              "-c:v", "libx264", "-preset", "ultrafast"],
        ) else {
            eprintln!("ffmpeg absent : test ignoré");
            return;
        };
        let image = image_a("ffmpeg", &source, 2_500).expect("image à 2,5 s");
        assert!(std::fs::metadata(&image).map(|m| m.len() > 0).unwrap_or(false));
        let _ = std::fs::remove_file(image);
        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn un_gif_reste_un_gif_pour_garder_sa_transparence() {
        let Some(source) = source_de_test(
            "sion-meme-source.gif",
            &["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=2"],
        ) else {
            eprintln!("ffmpeg absent : test ignoré");
            return;
        };
        let p = preparer("ffmpeg", &source, 0, 5_000).expect("préparation");
        assert_eq!(p.mime, "image/gif");
        for f in [Some(&p.video), p.apercu.as_ref()].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn la_transparence_d_un_gif_est_premultipliee() {
        let image = image_depuis_rgba(&[200, 100, 50, 128], 1, 1).expect("image");
        let p = image.pixels()[0];
        assert_eq!(p.alpha(), 128);
        assert_eq!(p.red(), 100);
    }
}
