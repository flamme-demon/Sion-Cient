//! Surfaces vidéo intégrées à la fenêtre Tauri.
//!
//! Sous Linux, une `GtkDrawingArea` limitée à l'emprise des vidéos peint les
//! frames BGRA issues de libwebrtc au-dessus de la WebView. Sous Windows, un
//! HWND enfant borné par rectangle fait le même travail via GDI/WebView2. Les
//! régions natives laissent traverser les interactions : le DOM conserve les
//! contrôles et ne reçoit plus les pixels vidéo.

use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoSurfaceSpec {
    id: String,
    sender: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Rectangles de la page qui recouvrent la vidéo : menus, panneaux
    /// flottants, boîtes de dialogue. Mêmes coordonnées que la surface.
    #[serde(default)]
    holes: Vec<NativeVideoSurfaceHole>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct NativeVideoSurfaceHole {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Au-delà, le front envoie de toute façon l'enveloppe des trous.
#[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
const MAX_HOLES: usize = 16;

/// Les trous d'une surface dans son propre repère — origine en haut à gauche
/// de la surface —, rognés à elle.
///
/// La surface native est peinte AU-DESSUS de la page : aucun `z-index` ne
/// peut faire passer un menu devant. On la perce donc là où la page doit se
/// voir, plutôt que de l'effacer tout entière (23/09 : le partage recouvrait
/// la soundboard flottante, que l'ancien échantillonnage de cinq points ne
/// voyait pas).
#[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
fn holes_within(spec: &NativeVideoSurfaceSpec) -> Vec<(f64, f64, f64, f64)> {
    spec.holes
        .iter()
        .filter(|h| [h.x, h.y, h.width, h.height].iter().all(|v| v.is_finite()))
        .filter_map(|h| {
            let gauche = (h.x - spec.x).max(0.0);
            let haut = (h.y - spec.y).max(0.0);
            let droite = (h.x + h.width - spec.x).min(spec.width);
            let bas = (h.y + h.height - spec.y).min(spec.height);
            (droite > gauche && bas > haut).then_some((gauche, haut, droite - gauche, bas - haut))
        })
        .take(MAX_HOLES)
        .collect()
}

#[tauri::command]
pub fn native_video_surface_available() -> bool {
    imp::available()
}

#[tauri::command]
pub fn native_video_surfaces_set(surfaces: Vec<NativeVideoSurfaceSpec>) -> bool {
    imp::set_surfaces(surfaces)
}

/// La fenêtre principale possède un renderer intégré : le pont JPEG ne doit
/// plus être utilisé, même pendant les quelques millisecondes où le front n'a
/// pas encore publié son premier rectangle (la frame peut simplement tomber).
pub fn replaces_legacy_transport() -> bool {
    imp::available()
}

/// Résolution réellement utile au plus grand consommateur natif visible.
/// Le moteur peut ainsi réduire l'I420 avec libyuv avant la conversion BGRA,
/// au lieu de demander au thread GTK de redimensionner du 1080p pour une
/// vignette de quelques centaines de pixels.
pub fn preferred_frame_dimensions(
    sender: &str,
    source_width: u32,
    source_height: u32,
) -> Option<(u32, u32)> {
    let embedded = imp::preferred_frame_bounds(sender);
    #[cfg(not(target_os = "android"))]
    let pip = crate::pip_window::preferred_frame_bounds(sender);
    #[cfg(target_os = "android")]
    let pip = None;

    let bounds = match (embedded, pip) {
        (Some((aw, ah)), Some((bw, bh))) => Some((aw.max(bw), ah.max(bh))),
        (Some(bounds), None) | (None, Some(bounds)) => Some(bounds),
        (None, None) => None,
    }?;
    let cible = fit_frame_dimensions(source_width, source_height, bounds.0, bounds.1);

    // Cible STABILISÉE d'une image à l'autre.
    //
    // L'émetteur fait varier sa résolution source de quelques pixels — encodage
    // adaptatif — et notre cible suivait fidèlement : 496 puis 494, en boucle.
    // Amortir le rectangle d'affichage ne suffisait pas, car étirer une frame de
    // 494 puis de 496 dans le même rectangle ne donne pas le même facteur
    // d'échelle : le cadre restait figé mais le CONTENU se dilatait et se
    // contractait, et l'image « dansait » quand même (18/09).
    //
    // On garde donc la cible précédente tant que la nouvelle ne s'en écarte pas
    // de plus de huit pixels. Un vrai changement — l'émetteur qui passe en 720p,
    // une fenêtre redimensionnée — dépasse largement ce seuil.
    {
        static CIBLES: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<String, (u32, u32)>>,
        > = std::sync::OnceLock::new();
        let cibles =
            CIBLES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let mut cibles = cibles.lock().unwrap_or_else(|err| err.into_inner());
        match cibles.get(sender).copied() {
            Some((pw, ph))
                if pw.abs_diff(cible.0) <= 8 && ph.abs_diff(cible.1) <= 8 =>
            {
                return Some((pw, ph));
            }
            _ => {
                cibles.insert(sender.to_owned(), cible);
            }
        }
    }
    Some(cible)
}

fn fit_frame_dimensions(sw: u32, sh: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    if sw < 2 || sh < 2 || max_width < 2 || max_height < 2 {
        return (sw, sh);
    }
    // Les BORNES sont quantifiées sur 16 avant tout calcul.
    //
    // La borne publiée par la surface bouge de quelques pixels au gré de la
    // mise en page. Avec un simple arrondi au pair du résultat, l'image peinte
    // alternait entre 1648 et 1654 de large dans une zone cliente pourtant
    // stable : elle « dansait » à l'écran (18/09).
    //
    // Quantifier le RÉSULTAT ne suffit pas, et le test le prouve : un
    // frémissement de la borne fait basculer la dimension limitante, et le
    // facteur d'échelle change alors assez pour franchir un palier. Quantifier
    // la BORNE rend le facteur lui-même insensible à ce frémissement.
    let quantifie = |v: u32| (v.max(16)) & !15;
    let max_width = quantifie(max_width);
    let max_height = quantifie(max_height);
    let scale = (max_width as f64 / sw as f64)
        .min(max_height as f64 / sh as f64)
        .min(1.0);
    let even = |value: f64| ((value.floor() as u32).max(2)) & !1;
    (even(sw as f64 * scale), even(sh as f64 * scale))
}

/// Rectangle réellement occupé par une image rendue en `contain`. Les pixels
/// et les curseurs normalisés doivent partager strictement ce letterbox.
fn fit_content_rect(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    frame_width: u32,
    frame_height: u32,
) -> (f64, f64, f64, f64) {
    if width <= 0.0 || height <= 0.0 || frame_width == 0 || frame_height == 0 {
        return (x, y, width, height);
    }
    let scale = (width / frame_width as f64).min(height / frame_height as f64);
    let content_width = frame_width as f64 * scale;
    let content_height = frame_height as f64 * scale;
    (
        x + (width - content_width) * 0.5,
        y + (height - content_height) * 0.5,
        content_width,
        content_height,
    )
}

/// Rectangle où peindre une image que le moteur a déjà réduite à la taille
/// de sa surface.
///
/// Elle mesure presque toujours quelques pixels de moins que la zone : le
/// moteur arrondit sa cible au multiple de 16 inférieur, pour qu'elle cesse
/// de « danser » (18/09). L'étirer de ces quelques pixels au plus proche
/// voisin — le rendu GTK filtre en `GL_NEAREST` pour garder le texte net —
/// dédoublait une colonne tous les quatre-vingts pixels : le texte partagé
/// prenait des traits d'épaisseur irrégulière (23/09).
///
/// Tant que l'écart est celui de l'arrondi, l'image est donc posée au pixel
/// près, centrée sur des pixels entiers : une marge noire de quelques pixels
/// au plus, et un texte identique à celui de l'émetteur réduit. Au-delà —
/// une image qui n'a pas été réduite pour cette zone —, retour au `contain`.
///
/// Coordonnées logiques en entrée comme en sortie ; les dimensions de l'image
/// sont physiques, et `echelle` en donne le rapport.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn rect_affiche(
    x: f64,
    y: f64,
    largeur: f64,
    hauteur: f64,
    image_l: u32,
    image_h: u32,
    echelle: f64,
) -> (f64, f64, f64, f64) {
    let contenu = fit_content_rect(x, y, largeur, hauteur, image_l, image_h);
    let echelle = echelle.max(1.0);
    let (il, ih) = (image_l as f64, image_h as f64);
    let tient = il <= largeur * echelle + 0.5 && ih <= hauteur * echelle + 0.5;
    let proche = (contenu.2 * echelle - il).abs() <= 16.0 && (contenu.3 * echelle - ih).abs() <= 16.0;
    if !(tient && proche) {
        return contenu;
    }
    let (l, h) = (il / echelle, ih / echelle);
    (
        ((x + (largeur - l) / 2.0) * echelle).round() / echelle,
        ((y + (hauteur - h) / 2.0) * echelle).round() / echelle,
        l,
        h,
    )
}

#[cfg(test)]
mod dimension_tests {
    use super::{
        fit_content_rect, fit_frame_dimensions, holes_within, rect_affiche,
        NativeVideoSurfaceHole, NativeVideoSurfaceSpec, MAX_HOLES,
    };

    /// Le cas du 23/09 : un partage 1920x1080 réduit pour une zone de 1400
    /// pixels, arrondie à 1392. Étirée de 8 pixels au plus proche voisin,
    /// l'image dédoublait des colonnes ; posée telle quelle, elle est nette.
    #[test]
    fn une_image_reduite_pour_sa_zone_est_posee_au_pixel_pres() {
        let (lw, lh) = fit_frame_dimensions(1920, 1080, 1400, 900);
        let (x, y, w, h) = rect_affiche(10.0, 20.0, 1400.0, 900.0, lw, lh, 1.0);
        assert_eq!((w, h), (lw as f64, lh as f64), "aucun étirement");
        assert_eq!((x.fract(), y.fract()), (0.0, 0.0), "sur des pixels entiers");
        assert!(x >= 10.0 && x + w <= 1410.0);
        // En double densité, le même raisonnement en pixels physiques.
        let (x, _, w, _) = rect_affiche(10.0, 20.0, 700.0, 450.0, lw, lh, 2.0);
        assert_eq!(w * 2.0, lw as f64);
        assert_eq!((x * 2.0).fract(), 0.0);
    }

    #[test]
    fn une_image_qui_n_est_pas_faite_pour_la_zone_reste_en_contain() {
        // Pas encore réduite : on l'ajuste à la zone, comme avant.
        let affiche = rect_affiche(0.0, 0.0, 800.0, 450.0, 1920, 1080, 1.0);
        assert_eq!(affiche, fit_content_rect(0.0, 0.0, 800.0, 450.0, 1920, 1080));
    }

    #[test]
    fn adapte_la_frame_au_rectangle_sans_deformer() {
        // Réduction : le résultat est aligné sur 16. La borne publiée par la
        // surface bouge de quelques pixels au gré de la mise en page, et un
        // arrondi au pair laissait alterner l'image entre deux largeurs — elle
        // « dansait » dans un cadre pourtant stable (18/09).
        assert_eq!(fit_frame_dimensions(1920, 1080, 520, 300), (512, 288));
        // Une borne qui varie de quelques pixels doit donner la MÊME taille.
        assert_eq!(
            fit_frame_dimensions(1920, 1080, 1654, 930),
            fit_frame_dimensions(1920, 1080, 1648, 930)
        );
        assert_eq!(fit_frame_dimensions(1920, 1080, 2560, 1440), (1920, 1080));
        assert_eq!(fit_frame_dimensions(2560, 1440, 768, 432), (768, 432));
    }

    #[test]
    fn contenu_et_curseur_partagent_le_meme_letterbox() {
        assert_eq!(
            fit_content_rect(10.0, 20.0, 400.0, 300.0, 1920, 1080),
            (10.0, 57.5, 400.0, 225.0)
        );
        let (x, y, w, h) = fit_content_rect(10.0, 20.0, 400.0, 200.0, 1600, 1200);
        assert!((x - 76.666_666).abs() < 0.000_01);
        assert_eq!((y, h), (20.0, 200.0));
        assert!((w - 266.666_666).abs() < 0.000_01);
    }

    fn trou(x: f64, y: f64, width: f64, height: f64) -> NativeVideoSurfaceHole {
        NativeVideoSurfaceHole { x, y, width, height }
    }

    /// Les trous arrivent en coordonnées de la page ; le renderer les veut
    /// dans le repère de la surface, sans rien qui déborde.
    #[test]
    fn les_trous_sont_ramenes_a_la_surface_et_rognes() {
        let spec = NativeVideoSurfaceSpec {
            id: "s".into(),
            sender: "@a".into(),
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 450.0,
            holes: vec![
                // Un panneau flottant qui mord sur le coin bas droit.
                trou(700.0, 400.0, 400.0, 300.0),
                // Un menu entièrement dedans.
                trou(150.0, 80.0, 200.0, 120.0),
                // Hors de la vidéo : ignoré.
                trou(0.0, 0.0, 90.0, 40.0),
                // Valeur absurde : ignorée.
                trou(f64::NAN, 0.0, 10.0, 10.0),
            ],
        };
        assert_eq!(
            holes_within(&spec),
            vec![(600.0, 350.0, 200.0, 100.0), (50.0, 30.0, 200.0, 120.0)]
        );
        let plein = NativeVideoSurfaceSpec {
            holes: vec![trou(0.0, 0.0, 1.0, 1.0); MAX_HOLES + 4],
            x: 0.0,
            y: 0.0,
            ..spec
        };
        assert_eq!(holes_within(&plein).len(), MAX_HOLES);
    }
}

/// Source I420 transportée **sans copie** jusqu'au thread de rendu EGL.
///
/// Le renderer GPU convertit lui-même YUV→RGB : il n'y a plus aucune raison de
/// produire du BGRA sur le chemin chaud. Le trait évite au module de dépendre
/// des types `livekit`, qui n'existent que derrière la feature `native-voice`.
pub trait PlanarFrame: Send {
    /// Dimensions du plan de luminance.
    fn dimensions(&self) -> (u32, u32);
    /// Plans (Y, U, V).
    fn planes(&self) -> (&[u8], &[u8], &[u8]);
    /// Pas de ligne de chaque plan — libwebrtc aligne, ils ne valent pas la
    /// largeur.
    fn strides(&self) -> (u32, u32, u32);
}

/// Le consommateur natif accepte-t-il les plans I420 bruts ?
///
/// Vrai uniquement quand le renderer EGL tourne **et** que la fenêtre PIP ne
/// réclame pas ce partage : le PIP blitte du BGRA, il impose alors la
/// conversion CPU pour tout le monde.
pub fn prefers_planar(sender: &str) -> bool {
    #[cfg(not(target_os = "android"))]
    {
        imp::accepts_planar(sender) && !crate::pip_window::wants_frames(sender)
    }
    #[cfg(target_os = "android")]
    {
        let _ = sender;
        false
    }
}

/// Déclare la résolution **source** d'un partage (celle de l'écran distant).
///
/// Le front en tire le ratio d'affichage de la vidéo. Elle doit rester
/// indépendante de la géométrie du DOM : annoncer la taille réduite — qui
/// dérive justement de cette géométrie — refermait une boucle de rétroaction
/// et faisait osciller la taille de l'image à chaque frame.
pub fn announce_source_dimensions(sender: &str, width: u32, height: u32) {
    #[cfg(target_os = "linux")]
    imp::announce_source_size(sender, width, height);
    #[cfg(not(target_os = "linux"))]
    let _ = (sender, width, height);
}

/// Publie des plans I420 vers le renderer EGL. Aucune conversion, aucune copie.
pub fn on_planar_frame(sender: String, frame: Box<dyn PlanarFrame>) {
    imp::on_planar_frame(sender, frame);
}

/// Publie une frame BGRA et **rend le tampon qu'elle remplace**. La file est
/// latest-wins : l'image précédente allait être libérée, elle est recyclée par
/// la pompe pour la conversion suivante. Un partage 1080p évite ainsi 8,3 Mo
/// d'allocation + libération par image.
#[must_use = "le tampon rendu doit être recyclé par la pompe"]
pub fn on_frame(sender: String, width: u32, height: u32, bgra: Vec<u8>) -> Option<Vec<u8>> {
    #[cfg(not(target_os = "android"))]
    crate::pip_window::on_bgra_frame(&sender, width, height, &bgra);
    imp::on_frame(sender, width, height, bgra)
}

pub fn remove(sender: &str) {
    imp::remove(sender);
}

/// Senders des partages affichés par la surface intégrée (vue simple, tuiles
/// mosaïque, carte flottante). `None` = surface indisponible (fallback JPEG :
/// le DOM peint lui-même les curseurs). Sert au filtre Rust des paquets
/// `sion-cursor` : ne peindre que les curseurs pointant un partage affiché.
pub fn viewer_targets() -> Option<HashSet<String>> {
    #[cfg(not(target_os = "android"))]
    {
        imp::viewer_targets()
    }
    #[cfg(target_os = "android")]
    {
        None
    }
}

/// Ingestion viewer : un paquet `sion-cursor`/-click reçu sur la session
/// native pointe le partage `target`. La surface intégrée le peindra par
/// dessus la frame. Appelé depuis le thread du moteur vocal — tout est
/// latest-wins, aucune allocation n'y est conservée.
pub fn on_viewer_cursor_packet(
    target: &str,
    identity: &str,
    name: &str,
    click: bool,
    x: f32,
    y: f32,
    expire: bool,
) {
    #[cfg(not(target_os = "android"))]
    imp::on_viewer_cursor_packet(target, identity, name, click, x, y, expire);
    #[cfg(target_os = "android")]
    {
        let _ = (target, identity, name, click, x, y, expire);
    }
}

#[cfg(target_os = "linux")]
pub fn attach(
    app: &tauri::AppHandle<crate::TauriRuntime>,
    view: &webkit2gtk::WebView,
) -> Result<(), String> {
    imp::attach(app, view)
}

#[cfg(target_os = "windows")]
pub fn attach(
    app: &tauri::AppHandle<crate::TauriRuntime>,
    parent: isize,
    scale_factor: f64,
) -> Result<(), String> {
    imp::attach(app, parent, scale_factor)
}

#[cfg(target_os = "linux")]
mod imp {
    use super::NativeVideoSurfaceSpec;
    use gtk::cairo::{FontSlant, FontWeight};
    use gtk::gdk::prelude::DisplayExtManual as _;
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::f64::consts::PI;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::Emitter;

    const MAX_SURFACES: usize = 16;
    const MAX_FRAME_BYTES: usize = 4096 * 4096 * 4;
    const GL_TEXTURE_2D: u32 = 0x0DE1;
    const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
    const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
    const GL_LINEAR: i32 = 0x2601;
    const GL_UNPACK_ALIGNMENT: u32 = 0x0CF5;
    const GL_RGBA: i32 = 0x1908;
    const GL_BGRA: u32 = 0x80E1;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;
    const GL_COLOR_BUFFER_BIT: u32 = 0x0000_4000;
    const GL_TRIANGLES: u32 = 0x0004;
    const GL_VERTEX_SHADER: u32 = 0x8B31;
    const GL_FRAGMENT_SHADER: u32 = 0x8B30;
    const GL_COMPILE_STATUS: u32 = 0x8B81;
    const GL_LINK_STATUS: u32 = 0x8B82;
    const GL_INFO_LOG_LENGTH: u32 = 0x8B84;

    #[link(name = "GL")]
    unsafe extern "C" {
        fn glGenTextures(count: i32, textures: *mut u32);
        fn glDeleteTextures(count: i32, textures: *const u32);
        fn glBindTexture(target: u32, texture: u32);
        fn glTexParameteri(target: u32, parameter: u32, value: i32);
        fn glPixelStorei(parameter: u32, value: i32);
        fn glTexImage2D(
            target: u32,
            level: i32,
            internal_format: i32,
            width: i32,
            height: i32,
            border: i32,
            format: u32,
            pixel_type: u32,
            pixels: *const std::ffi::c_void,
        );
        fn glTexSubImage2D(
            target: u32,
            level: i32,
            xoffset: i32,
            yoffset: i32,
            width: i32,
            height: i32,
            format: u32,
            pixel_type: u32,
            pixels: *const std::ffi::c_void,
        );
        fn glActiveTexture(texture: u32);
        fn glViewport(x: i32, y: i32, width: i32, height: i32);
        fn glScissor(x: i32, y: i32, width: i32, height: i32);
        fn glEnable(capability: u32);
        fn glDisable(capability: u32);
        fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
        fn glClear(mask: u32);
        fn glCreateShader(shader_type: u32) -> u32;
        fn glShaderSource(shader: u32, count: i32, strings: *const *const i8, lengths: *const i32);
        fn glCompileShader(shader: u32);
        fn glGetShaderiv(shader: u32, pname: u32, params: *mut i32);
        fn glGetShaderInfoLog(shader: u32, max_length: i32, length: *mut i32, info_log: *mut i8);
        fn glDeleteShader(shader: u32);
        fn glCreateProgram() -> u32;
        fn glAttachShader(program: u32, shader: u32);
        fn glLinkProgram(program: u32);
        fn glGetProgramiv(program: u32, pname: u32, params: *mut i32);
        fn glGetProgramInfoLog(program: u32, max_length: i32, length: *mut i32, info_log: *mut i8);
        fn glDeleteProgram(program: u32);
        fn glUseProgram(program: u32);
        fn glGetUniformLocation(program: u32, name: *const i8) -> i32;
        fn glUniform4f(location: i32, v0: f32, v1: f32, v2: f32, v3: f32);
        fn glUniform1i(location: i32, value: i32);
        fn glGenVertexArrays(count: i32, arrays: *mut u32);
        fn glBindVertexArray(array: u32);
        fn glDrawArrays(mode: u32, first: i32, count: i32);
        fn glGetError() -> u32;
    }
    /// Ondes de clic simultanées plafonnées par partage : un flot anormal de
    /// paquets `sion-cursor-click` ne doit pas faire croître l'état de rendu.
    const MAX_VIEWER_CLICKS: usize = 32;

    static AVAILABLE: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<tauri::AppHandle<crate::TauriRuntime>> = OnceLock::new();
    static ACTIVE_SENDERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    static TARGET_SIZES: OnceLock<Mutex<HashMap<String, (u32, u32)>>> = OnceLock::new();
    /// Résolution **source** de chaque partage (celle de l'écran distant),
    /// pas la taille réduite envoyée au GPU. C'est une valeur stable : la
    /// taille réduite, elle, dérive de la géométrie du DOM, et la renvoyer au
    /// front créait une boucle (la boîte fixe le ratio qui fixe la boîte) —
    /// l'image « dansait » en se redimensionnant à chaque image.
    static FRAME_SIZES: OnceLock<Mutex<HashMap<String, (u32, u32)>>> = OnceLock::new();
    static PENDING_FRAMES: OnceLock<Mutex<HashMap<String, PendingFrame>>> = OnceLock::new();
    static PENDING_SURFACES: OnceLock<Mutex<Option<Vec<Surface>>>> = OnceLock::new();
    static PENDING_VIEWER_CURSORS: OnceLock<Mutex<HashMap<String, Vec<ViewerCursorCmd>>>> =
        OnceLock::new();
    static SURFACE_DISPATCH_QUEUED: AtomicBool = AtomicBool::new(false);
    static DRAIN_ARMED: AtomicBool = AtomicBool::new(false);
    /// Poignée partagée du thread de rendu EGL, posée une fois par `attach()`.
    /// La pompe vidéo y publie depuis n'importe quel thread : le chemin chaud
    /// ne touche plus du tout au thread GTK.
    static EGL_SHARED: OnceLock<std::sync::Arc<wayland_surface::Shared>> = OnceLock::new();
    static DRAW_COUNT: AtomicU64 = AtomicU64::new(0);
    static EMBEDDED_FRAME_COUNT: AtomicU64 = AtomicU64::new(0);
    static DRAWN_FRAME_SEQ: AtomicU64 = AtomicU64::new(0);
    /// Dernier écart journalisé entre l'allocation GTK et l'emprise voulue
    /// (largeur << 32 | hauteur de l'allocation, 0 = pas d'écart).
    static ECART_ALLOCATION: AtomicU64 = AtomicU64::new(0);
    /// Dernier nombre de trous journalisé, toutes surfaces confondues.
    static TROUS_JOURNALISES: AtomicU64 = AtomicU64::new(0);
    static OUTPUT_SCALE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

    thread_local! {
        static RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
    }

    #[derive(Debug)]
    struct PendingFrame {
        width: u32,
        height: u32,
        bgra: Vec<u8>,
    }

    struct NativeFrame {
        seq: u64,
        width: u32,
        height: u32,
        texture: Option<u32>,
        bgra: Option<Vec<u8>>,
    }

    struct GlRenderer {
        program: u32,
        vao: u32,
        rect_location: i32,
    }

    #[derive(Clone)]
    struct Surface {
        #[allow(dead_code)]
        id: String,
        sender: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        /// Zones rendues à la page, dans le repère de la surface.
        holes: Vec<(f64, f64, f64, f64)>,
    }

    /// Curseur distant d'un viewer pointant CE partage (état viewer).
    struct ViewerCursorEntry {
        name: String,
        x: f32,
        y: f32,
        expires_at: Instant,
    }

    /// Onde de clic d'un viewer : animée 600 ms puis balayée.
    struct ViewerClickEntry {
        identity: String,
        x: f32,
        y: f32,
        born_at: Instant,
        expires_at: Instant,
    }

    /// État viewer d'UN partage : les curseurs qui le pointent + ses ondes.
    #[derive(Default)]
    struct TargetViewerCursors {
        cursors: HashMap<String, ViewerCursorEntry>,
        clicks: Vec<ViewerClickEntry>,
    }

    /// Commande curseur en attente de fusion dans l'état de rendu (thread GTK).
    enum ViewerCursorCmd {
        Upsert {
            identity: String,
            name: String,
            x: f32,
            y: f32,
            expires_at: Instant,
        },
        Remove {
            identity: String,
        },
        Click {
            identity: String,
            x: f32,
            y: f32,
            born_at: Instant,
            expires_at: Instant,
        },
    }

    #[derive(Default)]
    struct RenderState {
        surfaces: Vec<Surface>,
        frames: HashMap<String, NativeFrame>,
        viewer_cursors: HashMap<String, TargetViewerCursors>,
        gl: Option<GlRenderer>,
        retired_textures: Vec<u32>,
        origin_x: f64,
        origin_y: f64,
    }

    struct Renderer {
        /// Conservé pour ré-affirmer `pass_through` à chaque affichage : la
        /// fenêtre enfant que `GtkOverlay` dédie au calque peut être recréée
        /// entre un `hide()` et un `show()`, et la propriété posée une fois au
        /// démarrage ne la suivrait pas.
        overlay: gtk::Overlay,
        area: gtk::GLArea,
        cursor_area: gtk::DrawingArea,
        state: std::rc::Rc<RefCell<RenderState>>,
        wayland: Option<wayland_surface::Renderer>,
    }

    fn active_senders() -> &'static Mutex<HashSet<String>> {
        ACTIVE_SENDERS.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn target_sizes() -> &'static Mutex<HashMap<String, (u32, u32)>> {
        TARGET_SIZES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn pending_frames() -> &'static Mutex<HashMap<String, PendingFrame>> {
        PENDING_FRAMES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn frame_sizes() -> &'static Mutex<HashMap<String, (u32, u32)>> {
        FRAME_SIZES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn pending_surfaces() -> &'static Mutex<Option<Vec<Surface>>> {
        PENDING_SURFACES.get_or_init(|| Mutex::new(None))
    }

    fn pending_viewer_cursors() -> &'static Mutex<HashMap<String, Vec<ViewerCursorCmd>>> {
        PENDING_VIEWER_CURSORS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn invalidate(area: &gtk::GLArea) {
        area.queue_render();
    }

    fn retire_frame(state: &mut RenderState, sender: &str) {
        if let Some(frame) = state.frames.remove(sender) {
            if let Some(texture) = frame.texture {
                state.retired_textures.push(texture);
            }
        }
    }

    /// Renderer EGL réellement opérationnel (thread démarré, contexte créé) ?
    fn egl() -> Option<&'static std::sync::Arc<wayland_surface::Shared>> {
        EGL_SHARED
            .get()
            .filter(|shared| shared.live.load(Ordering::Acquire))
    }

    /// Le chemin planaire ne vaut que pour le partage effectivement présenté
    /// par la sous-surface EGL, qui est unique. En mosaïque, répondre `true`
    /// faisait produire à la pompe des plans I420 que `on_planar_frame`
    /// rejetait ensuite faute de cible — les tuiles restaient noires, alors que
    /// le chemin GtkGLArea sait parfaitement en peindre plusieurs.
    pub fn accepts_planar(sender: &str) -> bool {
        egl().is_some() && wants_planar_sender(sender)
    }

    pub fn on_planar_frame(sender: String, frame: Box<dyn super::PlanarFrame>) {
        let Some(shared) = egl() else {
            // Sans renderer EGL, seul le chemin BGRA sait peindre : la pompe
            // aurait dû interroger `prefers_planar` avant d'arriver ici.
            //
            // Ce retour était muet. Un partage a tourné à 25 im/s « reçues,
            // converties, surface native » sans qu'une seule image ne soit
            // présentée (17/09) : de l'extérieur, rien ne distinguait un
            // renderer éteint d'un problème de rendu. On le dit — une fois
            // par salve, pour ne pas écrire 25 lignes par seconde.
            signaler_rejet("renderer EGL absent ou éteint");
            return;
        };
        if !wants_planar_sender(&sender) {
            signaler_rejet("expéditeur hors de la sous-surface unique");
            return;
        }
        // Compteur des soumissions, en regard des présentations.
        //
        // Un retour de PIP a laissé l'écran noir (17/09) : le fil de rendu
        // était vivant, aucune image n'était rejetée, et pourtant plus rien
        // n'était présenté. Impossible de dire si la pompe avait cessé
        // d'envoyer ou si le fil avait cessé de peindre — les deux donnent le
        // même silence. Ces deux compteurs se lisent l'un contre l'autre.
        static SOUMISES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SOUMISES.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 || n % 300 == 0 {
            log::info!("[Sion][partage-natif] image soumise au fil EGL #{n}");
        }
        let _ = shared.submit(wayland_surface::Payload::Planar(frame));
    }

    /// Ce partage est-il celui que la sous-surface unique présente ? La
    /// mosaïque reste sur le chemin GtkGLArea tant qu'il n'y a qu'une
    /// sous-surface.
    /// Signale un rejet d'image, au plus une fois toutes les cinq secondes.
    /// Le débit d'images rendrait un log par occurrence illisible, mais le
    /// silence total nous a coûté une soirée de diagnostic.
    fn signaler_rejet(raison: &str) {
        use std::sync::Mutex;
        use std::time::{Duration, Instant};
        static DERNIER: Mutex<Option<Instant>> = Mutex::new(None);
        let mut dernier = DERNIER.lock().unwrap_or_else(|err| err.into_inner());
        let maintenant = Instant::now();
        let a_crier = match *dernier {
            Some(t) => maintenant.duration_since(t) >= Duration::from_secs(5),
            None => true,
        };
        if a_crier {
            *dernier = Some(maintenant);
            log::warn!("[Sion][partage-natif] image ignorée : {raison}");
        }
    }

    fn wants_planar_sender(sender: &str) -> bool {
        let active = active_senders()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        active.len() == 1 && active.contains(sender)
    }

    /// Ré-annonce la résolution connue d'un partage, **sans dédoublonnage**.
    ///
    /// `FRAME_SIZES` survit aux rechargements de la WebView, alors que la map
    /// du front repart vide. Sans cette ré-annonce, `announce_source_size` ne
    /// voyait aucun changement et se taisait : le front ne connaissait plus la
    /// résolution, `getVideoContentRect` retombait sur les 300×150 par défaut
    /// d'un `<canvas>` et tout le letterbox — donc toutes les coordonnées de
    /// curseur — devenait faux.
    fn reannounce_known_size(sender: &str) {
        let known = frame_sizes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(sender)
            .copied();
        let Some((width, height)) = known else {
            return;
        };
        let Some(app) = APP.get() else {
            return;
        };
        let _ = app.emit(
            "voice-native-frame-size",
            serde_json::json!({ "sender": sender, "width": width, "height": height }),
        );
        log::info!("[Sion][partage-natif] résolution ré-annoncée {sender}: {width}x{height}");
    }

    /// Notifie le front d'un changement de résolution **source**. Le front en
    /// tire le ratio d'affichage ; il doit donc être indépendant de la taille
    /// de la boîte DOM, sous peine de boucle de rétroaction.
    pub fn announce_source_size(sender: &str, width: u32, height: u32) {
        let changed = frame_sizes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(sender.to_owned(), (width, height))
            != Some((width, height));
        if !changed {
            return;
        }
        if let Some(app) = APP.get() {
            let _ = app.emit(
                "voice-native-frame-size",
                serde_json::json!({ "sender": sender, "width": width, "height": height }),
            );
        }
        log::info!("[Sion][partage-natif] flux direct natif {sender}: {width}x{height}");
    }

    pub fn available() -> bool {
        AVAILABLE.load(Ordering::Acquire)
    }

    pub fn preferred_frame_bounds(sender: &str) -> Option<(u32, u32)> {
        target_sizes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(sender)
            .copied()
    }

    /// Copie des senders affichés (filtre curseur côté voice_native). Un
    /// ensemble vide (aucun rectangle publié : transition React) signifie
    /// « conserver les paquets » — la surface arrive quelques ms plus tard.
    pub fn viewer_targets() -> Option<HashSet<String>> {
        if !available() {
            return None;
        }
        Some(
            active_senders()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone(),
        )
    }

    fn valid_surface(spec: NativeVideoSurfaceSpec) -> Option<Surface> {
        let values = [spec.x, spec.y, spec.width, spec.height];
        if spec.id.is_empty()
            || spec.sender.is_empty()
            || values.iter().any(|v| !v.is_finite())
            || spec.width < 1.0
            || spec.height < 1.0
            || spec.width > 16384.0
            || spec.height > 16384.0
        {
            return None;
        }
        let holes = super::holes_within(&spec);
        Some(Surface {
            id: spec.id,
            sender: spec.sender,
            x: spec.x,
            y: spec.y,
            width: spec.width,
            height: spec.height,
            holes,
        })
    }

    pub fn set_surfaces(specs: Vec<NativeVideoSurfaceSpec>) -> bool {
        if !available() {
            return false;
        }
        let surfaces = specs
            .into_iter()
            .take(MAX_SURFACES)
            .filter_map(valid_surface)
            .collect::<Vec<_>>();
        let senders = surfaces
            .iter()
            .map(|surface| surface.sender.clone())
            .collect::<HashSet<_>>();
        let output_scale = OUTPUT_SCALE.load(Ordering::Relaxed).max(1) as f64;
        let mut sizes = HashMap::<String, (u32, u32)>::new();
        for surface in &surfaces {
            let width = (surface.width * output_scale).ceil().max(2.0) as u32;
            let height = (surface.height * output_scale).ceil().max(2.0) as u32;
            sizes
                .entry(surface.sender.clone())
                .and_modify(|current| {
                    current.0 = current.0.max(width);
                    current.1 = current.1.max(height);
                })
                .or_insert((width, height));
        }
        *target_sizes().lock().unwrap_or_else(|err| err.into_inner()) = sizes;
        let mut active = active_senders()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if *active != senders {
            let mut names = senders.iter().cloned().collect::<Vec<_>>();
            names.sort();
            log::info!(
                "[Sion][partage-natif] surfaces actives={} [{}]",
                surfaces.len(),
                names.join(", ")
            );

        }
        // Partages qui viennent d'apparaître : le front qui publie ces
        // rectangles peut être un front tout neuf (rechargement de page) qui
        // ignore leur résolution. On la lui redonne systématiquement.
        let fresh = senders
            .iter()
            .filter(|sender| !active.contains(*sender))
            .cloned()
            .collect::<Vec<_>>();
        *active = senders;
        drop(active);
        for sender in fresh {
            reannounce_known_size(&sender);
        }
        *pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(surfaces);
        if !SURFACE_DISPATCH_QUEUED.swap(true, Ordering::AcqRel) {
            gtk::glib::idle_add_once(drain_pending_surfaces);
        }
        true
    }

    /// Horloge de drain, armée uniquement pendant qu'un partage est affiché.
    ///
    /// Les réveils idle envoyés depuis le thread WebRTC peuvent être coalescés
    /// ou perdus par certaines boucles GTK/WebKit ; cette horloge draine la map
    /// latest-wins (au plus une frame par expéditeur, jamais de backlog) et
    /// fusionne les curseurs viewers.
    ///
    /// Elle est armée/désarmée au lieu de tourner en permanence : un `timeout`
    /// posé une fois pour toutes dans `attach()` réveillait le thread GTK 60
    /// fois par seconde pour toute la durée de l'application, partage ou non —
    /// le thread d'interface n'était alors jamais réellement au repos.
    fn arm_drain() {
        if DRAIN_ARMED.swap(true, Ordering::AcqRel) {
            return;
        }
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(16), || {
            drain_pending_frames();
            // Curseurs viewers : fusion latest-wins + sweep TTL. Le redraw
            // n'est réclamé que sur changement (une position à 60 Hz compte
            // comme changement ; l'écran immobile ne réveille pas GTK).
            let cursors_changed = RENDERER.with(|slot| {
                let mut changed = false;
                if let Some(renderer) = slot.borrow().as_ref() {
                    let mut state = renderer.state.borrow_mut();
                    changed = drain_viewer_cursors(&mut state);
                }
                changed
            });
            if cursors_changed {
                RENDERER.with(|slot| {
                    if let Some(renderer) = slot.borrow().as_ref() {
                        renderer.cursor_area.queue_draw();
                    }
                });
            }
            // Plus aucune surface affichée : l'horloge s'arrête d'elle-même et
            // sera réarmée par la prochaine publication de rectangles.
            if active_senders()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .is_empty()
            {
                DRAIN_ARMED.store(false, Ordering::Release);
                log::info!("[Sion][partage-natif] drain GTK désarmé (aucune surface)");
                return gtk::glib::ControlFlow::Break;
            }
            gtk::glib::ControlFlow::Continue
        });
        log::info!("[Sion][partage-natif] drain GTK armé (16 ms)");
    }

    fn drain_pending_surfaces() {
        let surfaces = pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        if let Some(surfaces) = surfaces {
            RENDERER.with(|slot| {
                if let Some(renderer) = slot.borrow_mut().as_mut() {
                    if surfaces.is_empty() {
                        let mut state = renderer.state.borrow_mut();
                        state.surfaces.clear();
                        state.origin_x = 0.0;
                        state.origin_y = 0.0;
                        drop(state);
                        if let Some(wayland) = renderer.wayland.as_mut() {
                            wayland.hide();
                        }
                        renderer.area.hide();
                        renderer.cursor_area.hide();
                        return;
                    }

                    // Des pixels vont arriver : l'horloge de drain reprend.
                    arm_drain();
                    // La sous-surface Wayland (opt-in) ne sait pas se percer :
                    // dès qu'un menu recouvre la vidéo, on repasse par le
                    // GtkGLArea, qui le sait.
                    let percee = surfaces.iter().any(|surface| !surface.holes.is_empty());
                    let trous = surfaces.iter().map(|surface| surface.holes.len() as u64).sum::<u64>();
                    if TROUS_JOURNALISES.swap(trous, Ordering::Relaxed) != trous {
                        log::info!("[Sion][partage-natif] trous dans la vidéo : {trous}");
                    }
                    let use_wayland_single_surface = surfaces.len() == 1 && !percee;
                    let first_surface = surfaces.first().cloned();
                    let min_x = surfaces
                        .iter()
                        .map(|surface| surface.x)
                        .fold(f64::INFINITY, f64::min)
                        .floor()
                        .max(0.0);
                    let min_y = surfaces
                        .iter()
                        .map(|surface| surface.y)
                        .fold(f64::INFINITY, f64::min)
                        .floor()
                        .max(0.0);
                    let max_x = surfaces
                        .iter()
                        .map(|surface| surface.x + surface.width)
                        .fold(0.0, f64::max)
                        .ceil();
                    let max_y = surfaces
                        .iter()
                        .map(|surface| surface.y + surface.height)
                        .fold(0.0, f64::max)
                        .ceil();
                    let width = (max_x - min_x).max(1.0).min(i32::MAX as f64) as i32;
                    let height = (max_y - min_y).max(1.0).min(i32::MAX as f64) as i32;
                    // Une surface unique remplit exactement le widget : un
                    // renderbuffer opaque permet à GTK de le blitter sans
                    // recomposition alpha à chaque frame WebKit. Les vues
                    // multiples gardent l'alpha pour leurs intervalles, et
                    // une surface percée pour ses trous.
                    renderer.area.set_has_alpha(surfaces.len() != 1 || percee);

                    let mut state = renderer.state.borrow_mut();
                    state.surfaces = surfaces;
                    state.origin_x = min_x;
                    state.origin_y = min_y;
                    let visible_senders = state
                        .surfaces
                        .iter()
                        .map(|surface| surface.sender.clone())
                        .collect::<HashSet<_>>();
                    let obsolete = state
                        .frames
                        .keys()
                        .filter(|sender| !visible_senders.contains(*sender))
                        .cloned()
                        .collect::<Vec<_>>();
                    for sender in obsolete {
                        retire_frame(&mut state, &sender);
                    }
                    state
                        .viewer_cursors
                        .retain(|target, _| visible_senders.contains(target));
                    drop(state);
                    let wayland_single = if let Some(wayland) = renderer.wayland.as_mut() {
                        if use_wayland_single_surface {
                            if let Some(surface) = first_surface.as_ref() {
                                wayland.set_geometry(
                                    surface,
                                    OUTPUT_SCALE.load(Ordering::Relaxed).max(1) as i32,
                                );
                            }
                            true
                        } else {
                            wayland.hide();
                            false
                        }
                    } else {
                        false
                    };
                    renderer.area.set_margin_start(min_x as i32);
                    renderer.area.set_margin_top(min_y as i32);
                    renderer.area.set_size_request(width, height);
                    renderer.cursor_area.set_margin_start(min_x as i32);
                    renderer.cursor_area.set_margin_top(min_y as i32);
                    renderer.cursor_area.set_size_request(width, height);
                    if wayland_single {
                        renderer.area.hide();
                        renderer.cursor_area.hide();
                    } else {
                        renderer.area.show();
                        renderer.cursor_area.show();
                        // Ré-affirmé APRÈS le `show` : c'est le mapping qui
                        // fixe la fenêtre enfant réellement visée par le
                        // pointeur.
                        renderer
                            .overlay
                            .set_overlay_pass_through(&renderer.area, true);
                        renderer
                            .overlay
                            .set_overlay_pass_through(&renderer.cursor_area, true);
                        make_input_transparent(renderer.area.upcast_ref());
                        make_input_transparent(renderer.cursor_area.upcast_ref());
                        invalidate(&renderer.area);
                        renderer.cursor_area.queue_draw();
                    }
                }
            });
        }
        SURFACE_DISPATCH_QUEUED.store(false, Ordering::Release);
        if pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
            && !SURFACE_DISPATCH_QUEUED.swap(true, Ordering::AcqRel)
        {
            gtk::glib::idle_add_once(drain_pending_surfaces);
        }
    }

    pub fn on_frame(
        sender: String,
        width: u32,
        height: u32,
        bgra: Vec<u8>,
    ) -> Option<Vec<u8>> {
        if !available()
            || width == 0
            || height == 0
            || bgra.len() != width as usize * height as usize * 4
            || bgra.len() > MAX_FRAME_BYTES
        {
            // Frame refusée : le tampon repart quand même à la pompe.
            return Some(bgra);
        }
        // Renderer EGL en place : les pixels vont directement au thread de
        // rendu, sans passer ni par la map drainée par GTK ni par le toplevel.
        if let Some(shared) = egl() {
            if wants_planar_sender(&sender) {
                return shared.submit(wayland_surface::Payload::Bgra {
                    width,
                    height,
                    data: bgra,
                });
            }
        }
        pending_frames()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
                sender,
                PendingFrame {
                    width,
                    height,
                    bgra,
                },
            )
            .map(|replaced| replaced.bgra)
    }

    fn drain_pending_frames() {
        let pending = std::mem::take(
            &mut *pending_frames()
                .lock()
                .unwrap_or_else(|err| err.into_inner()),
        );
        if pending.is_empty() {
            return;
        }
        RENDERER.with(|slot| {
            let mut borrowed = slot.borrow_mut();
            let Some(renderer) = borrowed.as_mut() else {
                return;
            };
            let mut state = renderer.state.borrow_mut();
            for (sender, frame) in pending {
                let seq = EMBEDDED_FRAME_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
                if state.frames.get(&sender).is_some_and(|current| {
                    current.width != frame.width || current.height != frame.height
                }) {
                    retire_frame(&mut state, &sender);
                }
                if let Some(current) = state.frames.get_mut(&sender) {
                    current.seq = seq;
                    current.bgra = Some(frame.bgra);
                } else {
                    state.frames.insert(
                        sender,
                        NativeFrame {
                            seq,
                            width: frame.width,
                            height: frame.height,
                            texture: None,
                            bgra: Some(frame.bgra),
                        },
                    );
                }
                if seq == 1 || seq % 120 == 0 {
                    log::info!("[Sion][partage-natif] frame intégrée native #{seq}");
                }
            }
            // Le chemin EGL ne passe plus par ici : `on_frame`/`on_planar_frame`
            // publient directement au thread de rendu. Ce drain ne sert donc
            // qu'au repli GtkGLArea (mosaïque, ou absence de sous-surface).
            invalidate(&renderer.area);
            drop(state);
        });
    }

    #[cfg(not(target_os = "linux"))]
    pub fn on_viewer_cursor_packet(
        _target: &str,
        _identity: &str,
        _name: &str,
        _click: bool,
        _x: f32,
        _y: f32,
        _expire: bool,
    ) {
    }

    pub fn remove(sender: &str) {
        // La surface appartient au DOM, pas à une instance de pompe LiveKit.
        // Une pompe peut être remplacée pour le même expéditeur ; son cleanup
        // ne doit jamais désabonner la nouvelle pompe. `set_surfaces` est
        // l'unique autorité qui ajoute/retire les surfaces et purge leurs
        // frames devenues invisibles.
        if active_senders()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .contains(sender)
        {
            return;
        }
        frame_sizes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(sender);
        pending_frames()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(sender);
        pending_viewer_cursors()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(sender);
        let sender = sender.to_owned();
        gtk::glib::idle_add_once(move || {
            RENDERER.with(|slot| {
                if let Some(renderer) = slot.borrow().as_ref() {
                    let mut state = renderer.state.borrow_mut();
                    retire_frame(&mut state, &sender);
                    drop(state);
                    invalidate(&renderer.area);
                }
            });
        });
    }

    /// Ingestion (thread moteur) : stocke la commande latest-wins par cible ;
    /// le drain du thread GTK la fusionnera dans l'état de rendu.
    pub fn on_viewer_cursor_packet(
        target: &str,
        identity: &str,
        name: &str,
        click: bool,
        x: f32,
        y: f32,
        expire: bool,
    ) {
        if !available() || target.is_empty() || identity.is_empty() {
            return;
        }
        let now = Instant::now();
        let cmd = if click {
            ViewerCursorCmd::Click {
                identity: identity.to_owned(),
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                born_at: now,
                expires_at: now + Duration::from_millis(800),
            }
        } else if expire {
            ViewerCursorCmd::Remove {
                identity: identity.to_owned(),
            }
        } else {
            // TTL 5 s, même règle que le calque DOM et l'overlay partageur :
            // un viewer immobile ou parti sans `leave` disparaît tout seul.
            ViewerCursorCmd::Upsert {
                identity: identity.to_owned(),
                name: name.to_owned(),
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                expires_at: now + Duration::from_millis(5000),
            }
        };
        let mut pending = pending_viewer_cursors()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        // Limite file par cible : à 60 Hz, le front (latest-wins) ne peut pas
        // dépasser une entrée par expéditeur entre deux drains ; un flot
        // anormal se borne au lieu de croître.
        let entry = pending.entry(target.to_owned()).or_default();
        if entry.len() >= 256 {
            entry.clear();
        }
        entry.push(cmd);
    }

    /// Fusionne les commandes en attente dans l'état de rendu + balaye les
    /// entrées expirées. Retourne vrai si l'état curseur a changé (redraw).
    fn drain_viewer_cursors(state: &mut RenderState) -> bool {
        let pending = std::mem::take(
            &mut *pending_viewer_cursors()
                .lock()
                .unwrap_or_else(|err| err.into_inner()),
        );
        let mut changed = !pending.is_empty();
        for (target, cmds) in pending {
            let entry = state.viewer_cursors.entry(target).or_default();
            for cmd in cmds {
                match cmd {
                    ViewerCursorCmd::Upsert {
                        identity,
                        name,
                        x,
                        y,
                        expires_at,
                    } => {
                        entry.cursors.insert(
                            identity,
                            ViewerCursorEntry {
                                name,
                                x,
                                y,
                                expires_at,
                            },
                        );
                    }
                    ViewerCursorCmd::Remove { identity } => {
                        entry.cursors.remove(&identity);
                    }
                    ViewerCursorCmd::Click {
                        identity,
                        x,
                        y,
                        born_at,
                        expires_at,
                    } => {
                        entry.clicks.push(ViewerClickEntry {
                            identity,
                            x,
                            y,
                            born_at,
                            expires_at,
                        });
                        if entry.clicks.len() > MAX_VIEWER_CLICKS {
                            entry.clicks.drain(..entry.clicks.len() - MAX_VIEWER_CLICKS);
                        }
                    }
                }
            }
        }
        // Sweep TTL : curseurs immobiles et ondes terminées. Le sweep tourne
        // à chaque drain (60 Hz max) — borne mémoire stricte par cible.
        let now = Instant::now();
        for target in state.viewer_cursors.values_mut() {
            let before = target.cursors.len() + target.clicks.len();
            target.cursors.retain(|_, c| c.expires_at > now);
            target.clicks.retain(|c| c.expires_at > now);
            if before != target.cursors.len() + target.clicks.len() {
                changed = true;
            }
        }
        state
            .viewer_cursors
            .retain(|_, t| !t.cursors.is_empty() || !t.clicks.is_empty());
        // Une onde de clic évolue durant 600 ms même sans nouveau paquet.
        changed |= state
            .viewer_cursors
            .values()
            .any(|target| !target.clicks.is_empty());
        changed
    }

    const GL_TEXTURE0: u32 = 0x84C0;
    const GL_SCISSOR_TEST: u32 = 0x0C11;
    const GL_TEXTURE_WRAP_S: u32 = 0x2802;
    const GL_TEXTURE_WRAP_T: u32 = 0x2803;
    const GL_CLAMP_TO_EDGE: i32 = 0x812F;

    fn compile_shader(kind: u32, source: &'static [u8]) -> Result<u32, String> {
        unsafe {
            let shader = glCreateShader(kind);
            let source_ptr = source.as_ptr().cast::<i8>();
            glShaderSource(shader, 1, &source_ptr, std::ptr::null());
            glCompileShader(shader);
            let mut ok = 0;
            glGetShaderiv(shader, GL_COMPILE_STATUS, &mut ok);
            if ok != 0 {
                return Ok(shader);
            }
            let mut length = 0;
            glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &mut length);
            let mut log = vec![0u8; length.max(1) as usize];
            glGetShaderInfoLog(
                shader,
                length,
                std::ptr::null_mut(),
                log.as_mut_ptr().cast(),
            );
            glDeleteShader(shader);
            Err(String::from_utf8_lossy(&log)
                .trim_end_matches('\0')
                .to_owned())
        }
    }

    fn create_gl_renderer() -> Result<GlRenderer, String> {
        const VERTEX: &[u8] = b"#version 150 core\n\
            uniform vec4 u_rect;\n\
            out vec2 v_uv;\n\
            const vec2 p[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1));\n\
            void main(){ vec2 q=p[gl_VertexID]; gl_Position=vec4(mix(u_rect.xy,u_rect.zw,q),0,1); v_uv=vec2(q.x,1.0-q.y); }\0";
        // Échantillonnage bicubique Catmull-Rom, en neuf lectures filtrées
        // linéairement.
        //
        // Le partage arrive souvent PLUS PETIT que la zone : le moteur ne
        // l'agrandit jamais sur le processeur. Un écran 1920x1080 affiché sur
        // 2560 pixels était alors étiré au plus proche voisin — un pixel sur
        // trois doublé, un texte crénelé aux traits irréguliers (23/09). Le
        // bicubique agrandit net, sans marches.
        //
        // Et quand l'image est posée au pixel près (`rect_affiche`), chaque
        // fragment tombe au centre d'un texel : les poids se réduisent à 1
        // pour ce texel et 0 ailleurs, le pixel sort tel quel, sans flou.
        const FRAGMENT: &[u8] = b"#version 150 core\n\
            uniform sampler2D u_texture;\n\
            in vec2 v_uv; out vec4 color;\n\
            void main(){\n\
              vec2 taille = vec2(textureSize(u_texture, 0));\n\
              vec2 pos = v_uv * taille;\n\
              vec2 t1 = floor(pos - 0.5) + 0.5;\n\
              vec2 f = pos - t1;\n\
              vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));\n\
              vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);\n\
              vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));\n\
              vec2 w3 = f * f * (-0.5 + 0.5 * f);\n\
              vec2 w12 = w1 + w2;\n\
              vec2 t0 = (t1 - 1.0) / taille;\n\
              vec2 t3 = (t1 + 2.0) / taille;\n\
              vec2 t12 = (t1 + w2 / w12) / taille;\n\
              vec4 c = texture(u_texture, vec2(t0.x, t0.y)) * w0.x * w0.y\n\
                     + texture(u_texture, vec2(t12.x, t0.y)) * w12.x * w0.y\n\
                     + texture(u_texture, vec2(t3.x, t0.y)) * w3.x * w0.y\n\
                     + texture(u_texture, vec2(t0.x, t12.y)) * w0.x * w12.y\n\
                     + texture(u_texture, vec2(t12.x, t12.y)) * w12.x * w12.y\n\
                     + texture(u_texture, vec2(t3.x, t12.y)) * w3.x * w12.y\n\
                     + texture(u_texture, vec2(t0.x, t3.y)) * w0.x * w3.y\n\
                     + texture(u_texture, vec2(t12.x, t3.y)) * w12.x * w3.y\n\
                     + texture(u_texture, vec2(t3.x, t3.y)) * w3.x * w3.y;\n\
              color = clamp(c, 0.0, 1.0);\n\
            }\0";
        unsafe {
            let vertex = compile_shader(GL_VERTEX_SHADER, VERTEX)?;
            let fragment = compile_shader(GL_FRAGMENT_SHADER, FRAGMENT)?;
            let program = glCreateProgram();
            glAttachShader(program, vertex);
            glAttachShader(program, fragment);
            glLinkProgram(program);
            glDeleteShader(vertex);
            glDeleteShader(fragment);
            let mut ok = 0;
            glGetProgramiv(program, GL_LINK_STATUS, &mut ok);
            if ok == 0 {
                let mut length = 0;
                glGetProgramiv(program, GL_INFO_LOG_LENGTH, &mut length);
                let mut log = vec![0u8; length.max(1) as usize];
                glGetProgramInfoLog(
                    program,
                    length,
                    std::ptr::null_mut(),
                    log.as_mut_ptr().cast(),
                );
                glDeleteProgram(program);
                return Err(String::from_utf8_lossy(&log)
                    .trim_end_matches('\0')
                    .to_owned());
            }
            let rect_location = glGetUniformLocation(program, b"u_rect\0".as_ptr().cast());
            let sampler = glGetUniformLocation(program, b"u_texture\0".as_ptr().cast());
            let mut vao = 0;
            glGenVertexArrays(1, &mut vao);
            glUseProgram(program);
            glUniform1i(sampler, 0);
            Ok(GlRenderer {
                program,
                vao,
                rect_location,
            })
        }
    }

    /// Taille, en pixels logiques, du rectangle qui englobe les surfaces —
    /// celle demandée au widget.
    fn emprise(state: &RenderState) -> Option<(i32, i32)> {
        if state.surfaces.is_empty() {
            return None;
        }
        let droite = state
            .surfaces
            .iter()
            .map(|surface| surface.x + surface.width)
            .fold(0.0, f64::max)
            .ceil();
        let bas = state
            .surfaces
            .iter()
            .map(|surface| surface.y + surface.height)
            .fold(0.0, f64::max)
            .ceil();
        Some((
            (droite - state.origin_x).max(1.0) as i32,
            (bas - state.origin_y).max(1.0) as i32,
        ))
    }

    fn render_gl(state: &mut RenderState, area: &gtk::GLArea) -> Result<(), String> {
        area.make_current();
        if let Some(err) = area.error() {
            return Err(err.to_string());
        }
        if state.gl.is_none() {
            state.gl = Some(create_gl_renderer()?);
            log::info!("[Sion][partage-natif] renderer GtkGLArea à la demande actif");
        }
        unsafe {
            for texture in state.retired_textures.drain(..) {
                glDeleteTextures(1, &texture);
            }
            for frame in state.frames.values_mut() {
                let Some(bgra) = frame.bgra.take() else {
                    continue;
                };
                let mut texture = frame.texture.unwrap_or(0);
                let fresh = texture == 0;
                if fresh {
                    glGenTextures(1, &mut texture);
                    frame.texture = Some(texture);
                }
                glBindTexture(GL_TEXTURE_2D, texture);
                // Filtrage LINÉAIRE : le shader bicubique s'en sert pour lire
                // quatre texels d'un coup. Il ne floute pas pour autant une
                // image posée au pixel près — voir le shader. Le `GL_NEAREST`
                // d'avant ne valait que pour ce cas-là, et crénelait tout
                // agrandissement (23/09).
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
                if fresh {
                    glTexImage2D(
                        GL_TEXTURE_2D,
                        0,
                        GL_RGBA,
                        frame.width as i32,
                        frame.height as i32,
                        0,
                        GL_BGRA,
                        GL_UNSIGNED_BYTE,
                        bgra.as_ptr().cast(),
                    );
                } else {
                    glTexSubImage2D(
                        GL_TEXTURE_2D,
                        0,
                        0,
                        0,
                        frame.width as i32,
                        frame.height as i32,
                        GL_BGRA,
                        GL_UNSIGNED_BYTE,
                        bgra.as_ptr().cast(),
                    );
                }
            }
            let allocation = area.allocation();
            // GTK doit allouer au widget exactement l'emprise des surfaces.
            // Plus grand, le reste serait peint en noir opaque par-dessus la
            // page (23/09 : image en haut à gauche d'un cadre noir qui
            // mordait sur la dock) — on veut le voir dans le journal.
            if let Some((voulu_l, voulu_h)) = emprise(state) {
                let ecart = (allocation.width() - voulu_l).abs() > 1
                    || (allocation.height() - voulu_h).abs() > 1;
                let cle = if ecart {
                    ((allocation.width() as u64) << 32) | allocation.height() as u64
                } else {
                    0
                };
                if ECART_ALLOCATION.swap(cle, Ordering::Relaxed) != cle && ecart {
                    log::warn!(
                        "[Sion][partage-natif] allocation GTK {}x{} ≠ emprise voulue {voulu_l}x{voulu_h}",
                        allocation.width(),
                        allocation.height()
                    );
                }
            }
            let scale_factor = area.scale_factor().max(1);
            let pixel_width = allocation.width().max(1) * scale_factor;
            let pixel_height = allocation.height().max(1) * scale_factor;
            glViewport(0, 0, pixel_width, pixel_height);
            glClearColor(0.0, 0.0, 0.0, 0.0);
            glClear(GL_COLOR_BUFFER_BIT);
            let gl = state.gl.as_ref().unwrap();
            glUseProgram(gl.program);
            glBindVertexArray(gl.vao);
            glActiveTexture(GL_TEXTURE0);
            for target in &state.surfaces {
                let tx = target.x - state.origin_x;
                let ty = target.y - state.origin_y;
                glEnable(GL_SCISSOR_TEST);
                glScissor(
                    (tx * scale_factor as f64) as i32,
                    pixel_height - ((ty + target.height) * scale_factor as f64) as i32,
                    (target.width * scale_factor as f64) as i32,
                    (target.height * scale_factor as f64) as i32,
                );
                glClearColor(0.0, 0.0, 0.0, 1.0);
                glClear(GL_COLOR_BUFFER_BIT);
                glDisable(GL_SCISSOR_TEST);
                'image: {
                    let Some(frame) = state.frames.get(&target.sender) else {
                        break 'image;
                    };
                    let Some(texture) = frame.texture else {
                        break 'image;
                    };
                    let (x, y, dw, dh) = super::rect_affiche(
                        tx,
                        ty,
                        target.width,
                        target.height,
                        frame.width,
                        frame.height,
                        scale_factor as f64,
                    );
                    let left = (2.0 * x / allocation.width() as f64 - 1.0) as f32;
                    let right = (2.0 * (x + dw) / allocation.width() as f64 - 1.0) as f32;
                    let top = (1.0 - 2.0 * y / allocation.height() as f64) as f32;
                    let bottom = (1.0 - 2.0 * (y + dh) / allocation.height() as f64) as f32;
                    glUniform4f(gl.rect_location, left, bottom, right, top);
                    glBindTexture(GL_TEXTURE_2D, texture);
                    glDrawArrays(GL_TRIANGLES, 0, 6);
                    let previous = DRAWN_FRAME_SEQ.swap(frame.seq, Ordering::Relaxed);
                    if frame.seq != previous && (frame.seq == 1 || frame.seq % 120 == 0) {
                        log::info!("[Sion][partage-natif] frame intégrée peinte #{}", frame.seq);
                    }
                }
                // Les trous en dernier, transparents : la page reparaît sous
                // le menu qui recouvre la vidéo. Arrondis vers l'extérieur,
                // pour qu'aucun filet de vidéo ne morde sur son bord.
                if !target.holes.is_empty() {
                    let s = scale_factor as f64;
                    glEnable(GL_SCISSOR_TEST);
                    glClearColor(0.0, 0.0, 0.0, 0.0);
                    for &(hx, hy, hw, hh) in &target.holes {
                        let gauche = ((tx + hx) * s).floor() as i32;
                        let haut = ((ty + hy) * s).floor() as i32;
                        let droite = ((tx + hx + hw) * s).ceil() as i32;
                        let bas = ((ty + hy + hh) * s).ceil() as i32;
                        glScissor(gauche, pixel_height - bas, droite - gauche, bas - haut);
                        glClear(GL_COLOR_BUFFER_BIT);
                    }
                    glDisable(GL_SCISSOR_TEST);
                }
            }
            glBindVertexArray(0);
            glBindTexture(GL_TEXTURE_2D, 0);
            let error = glGetError();
            if error != 0 {
                return Err(format!("OpenGL 0x{error:x}"));
            }
        }
        Ok(())
    }

    fn draw_cursors(state: &RenderState, context: &gtk::cairo::Context) {
        for target in &state.surfaces {
            if let Some(cursors) = state.viewer_cursors.get(&target.sender) {
                let (x, y, width, height) = state
                    .frames
                    .get(&target.sender)
                    .map(|frame| {
                        // Le même rectangle que l'image : les curseurs restent
                        // posés sur ce qu'ils désignent.
                        super::rect_affiche(
                            target.x - state.origin_x,
                            target.y - state.origin_y,
                            target.width,
                            target.height,
                            frame.width,
                            frame.height,
                            OUTPUT_SCALE.load(Ordering::Relaxed).max(1) as f64,
                        )
                    })
                    .unwrap_or((
                        target.x - state.origin_x,
                        target.y - state.origin_y,
                        target.width,
                        target.height,
                    ));
                if target.holes.is_empty() {
                    draw_viewer_cursors(context, x, y, width, height, cursors);
                    continue;
                }
                // Pas de curseur par-dessus un menu qui perce la vidéo : on
                // les peint à part, puis on efface les trous avant de poser.
                // Un rognage pair-impair rendrait l'intersection de deux
                // trous qui se chevauchent.
                let (tx, ty) = (target.x - state.origin_x, target.y - state.origin_y);
                context.push_group();
                draw_viewer_cursors(context, x, y, width, height, cursors);
                context.set_operator(gtk::cairo::Operator::Clear);
                for &(hx, hy, hw, hh) in &target.holes {
                    context.rectangle(tx + hx, ty + hy, hw, hh);
                }
                let _ = context.fill();
                if context.pop_group_to_source().is_ok() {
                    let _ = context.paint();
                }
            }
        }
    }

    /// Peint les curseurs/ondes des viewers sur UNE surface vidéo, dans le
    /// repère du rectangle DOM. Mêmes formes que le calque DOM remplacé :
    /// flèche colorée + pastille nom + onde de clic 600 ms.
    fn draw_viewer_cursors(
        context: &gtk::cairo::Context,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        cursors: &TargetViewerCursors,
    ) {
        let now = Instant::now();
        for click in &cursors.clicks {
            let cx = x + (click.x.clamp(0.0, 1.0) as f64) * w;
            let cy = y + (click.y.clamp(0.0, 1.0) as f64) * h;
            let (r, g, b) = crate::cursor_overlay::draw::identity_color_rgba8(&click.identity);
            // Trois anneaux décalés, 0.4→3.0 de rayon, opacité 0.85→0 en
            // 600 ms — miroir exact de l'animation CSS `sion-ripple-viewer`.
            let base_radius = 18.0_f64;
            let total_ms = 600.0_f64;
            for stagger_ms in [0.0, 120.0, 240.0] {
                let elapsed =
                    now.saturating_duration_since(click.born_at).as_millis() as f64 - stagger_ms;
                if elapsed <= 0.0 || elapsed >= total_ms {
                    continue;
                }
                let t = elapsed / total_ms;
                let alpha = 0.85 * (1.0 - t);
                let radius = base_radius * (0.4 + (3.0 - 0.4) * t);
                if radius < 1.0 {
                    continue;
                }
                context.set_source_rgba(
                    r as f64 / 255.0,
                    g as f64 / 255.0,
                    b as f64 / 255.0,
                    alpha,
                );
                context.set_line_width(2.5);
                context.arc(cx, cy, radius, 0.0, PI * 2.0);
                let _ = context.stroke();
            }
        }
        for (identity, cursor) in cursors.cursors.iter() {
            let px = x + (cursor.x.clamp(0.0, 1.0) as f64) * w;
            let py = y + (cursor.y.clamp(0.0, 1.0) as f64) * h;
            // Couleur dérivée de l'IDENTITÉ (pas du pseudo) : celle du calque
            // DOM remplacé et de l'overlay du partageur — cohérence totale.
            let (r, g, b) = crate::cursor_overlay::draw::identity_color_rgba8(identity);
            // Flèche ~14×17 (mêmes proportions que le SVG DOM et l'overlay
            // X11) : trait blanc de contour, remplissage coloré.
            let scale = 1.4_f64;
            let path = |context: &gtk::cairo::Context| {
                context.move_to(px, py);
                context.line_to(px, py + 14.0 * scale);
                context.line_to(px + 3.5 * scale, py + 11.0 * scale);
                context.line_to(px + 6.0 * scale, py + 16.0 * scale);
                context.line_to(px + 7.5 * scale, py + 15.0 * scale);
                context.line_to(px + 5.0 * scale, py + 10.0 * scale);
                context.line_to(px + 10.0 * scale, py + 10.0 * scale);
                context.close_path();
            };
            path(context);
            context.set_source_rgba(1.0, 1.0, 1.0, 1.0);
            context.set_line_width(2.0);
            context.set_line_join(gtk::cairo::LineJoin::Round);
            let _ = context.stroke_preserve();
            context.set_source_rgba(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0, 1.0);
            let _ = context.fill();

            // Pastille nom : fond coloré + texte blanc, clampée aux bords.
            if !cursor.name.is_empty() {
                const MAX_CHARS: usize = 28;
                let display: String = if cursor.name.chars().count() > MAX_CHARS {
                    cursor.name.chars().take(MAX_CHARS - 1).collect::<String>() + "…"
                } else {
                    cursor.name.clone()
                };
                context.select_font_face("sans-serif", FontSlant::Normal, FontWeight::Bold);
                context.set_font_size(13.0);
                let Ok(extents) = context.text_extents(&display) else {
                    continue;
                };
                let pad_x = 8.0;
                let pad_y = 4.0;
                let pill_w = extents.x_advance() + pad_x * 2.0;
                let pill_h = extents.height() + pad_y * 2.0;
                let pill_x = (px + 4.0).min(w + x - pill_w - 2.0).max(x + 2.0);
                let pill_y = (py + 16.0 * scale + 4.0)
                    .min(h + y - pill_h - 2.0)
                    .max(y + 2.0);
                // L'ombre portée des coins (drop-shadow du SVG DOM) : un
                // rectangle noir translucide décalé d'un pixel.
                context.set_source_rgba(0.0, 0.0, 0.0, 0.35);
                context.rectangle(pill_x + 1.0, pill_y + 1.0, pill_w, pill_h);
                let _ = context.fill();
                context.set_source_rgba(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0, 1.0);
                context.rectangle(pill_x, pill_y, pill_w, pill_h);
                let _ = context.fill();
                context.set_source_rgba(1.0, 1.0, 1.0, 1.0);
                let _ = context.move_to(pill_x + pad_x, pill_y + pad_y + extents.height());
                let _ = context.show_text(&display);
            }
        }
    }

    /// Prototype Wayland backend. It is intentionally opt-in until the
    /// one-surface path has been compared against GtkGLArea on the same
    /// machine; the latter remains the safe fallback for mosaics and cursors.
    /// Présentation GPU, hors du graphe de composition WebKit.
    ///
    /// La vidéo est une `wl_subsurface` fille du `wl_surface` de la fenêtre
    /// Sion, présentée par EGL depuis un thread dédié. Trois conséquences, qui
    /// sont tout l'intérêt de ce chemin par rapport au `GtkGLArea` frère :
    ///
    /// - le toplevel GTK n'est plus damagé à chaque image, donc
    ///   `WebKitWebProcess` ne recompose plus rien pour une vidéo qu'il ne
    ///   reçoit pas (c'était ~38 % d'un cœur mesuré le 16/09) ;
    /// - la conversion YUV→RGB et l'ajustement final sont faits par le GPU
    ///   (shader + échantillonneur) : plus de `libyuv::I420ToARGB` sur le
    ///   chemin chaud, et 1,5 o/px transférés au lieu de 4 ;
    /// - le rendu vit sur son propre thread : aucune image ne peut plus
    ///   retarder un clic ou une frappe, et `eglSwapBuffers` peut bloquer sur
    ///   le vsync du compositeur sans geler l'interface.
    ///
    /// Le prototype `wl_shm` qui précédait sortait bien WebKit de la boucle,
    /// mais payait un `memcpy` de 8,3 Mo par image **sur le thread principal**,
    /// relu ensuite par le compositeur pour l'upload GPU. Le squelette
    /// (sous-surface, région d'entrée vide, position, échelle) est conservé ;
    /// seul le transport des pixels change.
    pub(super) mod wayland_surface {
        use super::Surface;
        use crate::native_video_surface::{fit_content_rect, PlanarFrame};
        use super::{
            compile_shader, GL_CLAMP_TO_EDGE, GL_COLOR_BUFFER_BIT,
            GL_FRAGMENT_SHADER, GL_INFO_LOG_LENGTH, GL_LINK_STATUS, GL_TEXTURE0, GL_TEXTURE_2D,
            GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER, GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T,
            GL_TRIANGLES, GL_UNPACK_ALIGNMENT, GL_UNSIGNED_BYTE, GL_VERTEX_SHADER,
        };
        use gtk::glib::object::Cast;
        use gtk::glib::object::ObjectType;
        use gtk::prelude::WidgetExt;
        use khronos_egl as egl;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        use wayland_client::backend::{Backend, ObjectId};
        use wayland_client::globals::{registry_queue_init, GlobalListContents};
        use wayland_client::protocol::{
            wl_compositor, wl_region, wl_registry, wl_subcompositor, wl_subsurface, wl_surface,
        };
        use wayland_client::{delegate_noop, Connection, Dispatch, Proxy, QueueHandle};

        // Constantes GL absentes du tronc commun : plans mono-canal (I420) et
        // lignes à pas libre (les strides libwebrtc ne valent pas la largeur).
        const GL_R8: i32 = 0x8229;
        const GL_RED: u32 = 0x1903;
        const GL_UNPACK_ROW_LENGTH: u32 = 0x0CF2;
        const GL_LINEAR: i32 = 0x2601;

        struct State;

        impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
            fn event(
                _: &mut Self,
                _: &wl_registry::WlRegistry,
                _: wl_registry::Event,
                _: &GlobalListContents,
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
            }
        }

        delegate_noop!(State: ignore wl_compositor::WlCompositor);
        delegate_noop!(State: ignore wl_subcompositor::WlSubcompositor);
        delegate_noop!(State: ignore wl_subsurface::WlSubsurface);
        delegate_noop!(State: ignore wl_surface::WlSurface);
        delegate_noop!(State: ignore wl_region::WlRegion);

        /// Image à présenter. `Planar` est le chemin normal (aucune conversion
        /// CPU) ; `Bgra` sert quand la fenêtre PIP consomme les mêmes pixels et
        /// impose déjà une sortie BGRA.
        pub(in crate::native_video_surface) enum Payload {
            Planar(Box<dyn PlanarFrame>),
            Bgra {
                width: u32,
                height: u32,
                data: Vec<u8>,
            },
        }

        impl Payload {
            fn dimensions(&self) -> (u32, u32) {
                match self {
                    Payload::Planar(frame) => frame.dimensions(),
                    Payload::Bgra { width, height, .. } => (*width, *height),
                }
            }
        }

        #[derive(Default)]
        struct Inner {
            /// Latest-wins strict : au plus une image en attente.
            frame: Option<Payload>,
            /// Tampon BGRA rendu à la pompe pour recyclage.
            recycled: Option<Vec<u8>>,
            /// Nouvelle taille physique du `wl_egl_window`, si elle a changé.
            resize: Option<(i32, i32)>,
            hide: bool,
            quit: bool,
        }

        impl Inner {
            fn idle(&self) -> bool {
                self.frame.is_none() && self.resize.is_none() && !self.hide && !self.quit
            }
        }

        /// Rendez-vous entre la pompe vidéo (n'importe quel thread), le thread
        /// GTK (géométrie) et le thread de rendu.
        pub(in crate::native_video_surface) struct Shared {
            inner: Mutex<Inner>,
            wake: Condvar,
            /// Le thread de rendu a-t-il démarré sans erreur ? Tant que c'est
            /// faux, la pompe ne doit pas court-circuiter le chemin GTK.
            pub(in crate::native_video_surface) live: AtomicBool,
        }

        impl Shared {
            fn new() -> Self {
                Self {
                    inner: Mutex::new(Inner::default()),
                    wake: Condvar::new(),
                    live: AtomicBool::new(false),
                }
            }

            /// Publie une image et rend le tampon BGRA qu'elle remplace.
            pub(in crate::native_video_surface) fn submit(
                &self,
                payload: Payload,
            ) -> Option<Vec<u8>> {
                let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
                let replaced = match inner.frame.replace(payload) {
                    Some(Payload::Bgra { data, .. }) => Some(data),
                    _ => None,
                };
                let recycled = inner.recycled.take().or(replaced);
                self.wake.notify_one();
                recycled
            }

            fn request_resize(&self, width: i32, height: i32) {
                let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
                inner.resize = Some((width, height));
                inner.hide = false;
                self.wake.notify_one();
            }

            fn request_hide(&self) {
                let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
                inner.hide = true;
                inner.frame = None;
                self.wake.notify_one();
            }

            fn request_quit(&self) {
                let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
                inner.quit = true;
                self.wake.notify_one();
            }
        }

        /// Ce que le thread de rendu récolte à chaque réveil.
        struct Work {
            frame: Option<Payload>,
            resize: Option<(i32, i32)>,
            hide: bool,
            quit: bool,
        }

        /// Poignée conservée par le thread GTK. Elle ne touche jamais aux
        /// pixels : uniquement la géométrie de la sous-surface et le cycle de
        /// vie du thread de rendu.
        pub(super) struct Renderer {
            conn: Connection,
            qh: QueueHandle<State>,
            #[allow(dead_code)]
            parent: wl_surface::WlSurface,
            parent_window: gtk::gdk::Window,
            surface: wl_surface::WlSurface,
            subsurface: wl_subsurface::WlSubsurface,
            compositor: wl_compositor::WlCompositor,
            /// Notre file est distincte de celle que GDK dispatche : personne
            /// d'autre ne la vide. Les événements de nos objets (`wl_surface.
            /// enter/leave`…) s'y accumuleraient pour la durée de la session.
            queue: wayland_client::EventQueue<State>,
            /// La WebView et son toplevel : `wl_subsurface.set_position` est
            /// relatif au `wl_surface` PARENT, c'est-à-dire la fenêtre entière
            /// (barre de titre et marges d'ombre des décorations comprises),
            /// alors que les rectangles publiés par le front sont relatifs à la
            /// WebView. Sans cette traduction, la vidéo se dessinait une
            /// centaine de pixels trop haut, par-dessus l'en-tête du salon.
            view: gtk::Widget,
            toplevel: gtk::Window,
            shared: Arc<Shared>,
            thread: Option<std::thread::JoinHandle<()>>,
            size: (i32, i32),
            scale: i32,
        }

        impl Renderer {
            pub(super) fn new(view: &gtk::Widget) -> Result<Self, String> {
                let toplevel = view
                    .toplevel()
                    .ok_or_else(|| "WebView sans toplevel GTK".to_owned())?
                    .downcast::<gtk::Window>()
                    .map_err(|_| "toplevel GTK inattendu".to_owned())?;
                let gdk_window = toplevel
                    .window()
                    .ok_or_else(|| "fenêtre GDK non réalisée".to_owned())?;
                let display = gdk_window.display();
                let display_gdk_ptr: *mut gdk_wayland_sys::GdkWaylandDisplay =
                    display.as_ptr().cast();
                let display_ptr: *mut wayland_sys::client::wl_display =
                    unsafe { gdk_wayland_sys::gdk_wayland_display_get_wl_display(display_gdk_ptr) }
                        as *mut _;
                if display_ptr.is_null() {
                    return Err("GDK n'a pas exposé le wl_display".to_owned());
                }
                let window_gdk_ptr: *mut gdk_wayland_sys::GdkWaylandWindow =
                    gdk_window.as_ptr().cast();
                let parent_ptr: *mut wayland_sys::client::wl_proxy =
                    unsafe { gdk_wayland_sys::gdk_wayland_window_get_wl_surface(window_gdk_ptr) }
                        as *mut _;
                if parent_ptr.is_null() {
                    return Err("GDK n'a pas exposé le wl_surface parent".to_owned());
                }
                if !wayland_egl::is_available() {
                    return Err("libwayland-egl absente".to_owned());
                }

                // Connexion empruntée à GDK : un `wl_surface` parent ne peut pas
                // être référencé depuis une seconde connexion.
                let backend = unsafe { Backend::from_foreign_display(display_ptr) };
                let conn = Connection::from_backend(backend);
                let (globals, mut queue) = registry_queue_init::<State>(&conn)
                    .map_err(|err| format!("registry Wayland GDK: {err:?}"))?;
                let qh = queue.handle();
                let compositor = globals
                    .bind::<wl_compositor::WlCompositor, _, _>(&qh, 1..=4, ())
                    .map_err(|err| format!("wl_compositor absent: {err:?}"))?;
                let subcompositor = globals
                    .bind::<wl_subcompositor::WlSubcompositor, _, _>(&qh, 1..=1, ())
                    .map_err(|err| format!("wl_subcompositor absent: {err:?}"))?;
                let parent_id =
                    unsafe { ObjectId::from_ptr(wl_surface::WlSurface::interface(), parent_ptr) }
                        .map_err(|err| format!("wl_surface parent invalide: {err:?}"))?;
                let parent = wl_surface::WlSurface::from_id(&conn, parent_id)
                    .map_err(|err| format!("proxy wl_surface parent: {err:?}"))?;
                let surface = compositor.create_surface(&qh, ());
                let subsurface = subcompositor.get_subsurface(&surface, &parent, &qh, ());
                // Desync : la vidéo se présente à sa propre cadence, sans
                // attendre un commit du parent GTK.
                subsurface.set_desync();
                // Région d'entrée vide : tous les clics continuent vers WebKit.
                let input_region = compositor.create_region(&qh, ());
                surface.set_input_region(Some(&input_region));
                input_region.destroy();
                surface.commit();
                conn.flush()
                    .map_err(|err| format!("flush création subsurface: {err:?}"))?;
                queue
                    .dispatch_pending(&mut State)
                    .map_err(|err| format!("dispatch initial Wayland: {err:?}"))?;

                let shared = Arc::new(Shared::new());
                let thread_shared = shared.clone();
                let surface_id = surface.id();
                let display_addr = display_ptr as usize;
                let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
                let thread_conn = conn.clone();
                let thread_surface = surface.clone();
                let thread = std::thread::Builder::new()
                    .name("sion-video-egl".into())
                    .spawn(move || {
                        render_thread(
                            display_addr,
                            surface_id,
                            thread_conn,
                            thread_surface,
                            thread_shared,
                            ready_tx,
                        );
                    })
                    .map_err(|err| format!("thread de rendu: {err}"))?;

                match ready_rx.recv() {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => {
                        shared.request_quit();
                        let _ = thread.join();
                        subsurface.destroy();
                        surface.destroy();
                        let _ = conn.flush();
                        return Err(err);
                    }
                    Err(_) => {
                        subsurface.destroy();
                        surface.destroy();
                        let _ = conn.flush();
                        return Err("le thread de rendu EGL n'a pas répondu".to_owned());
                    }
                }

                log::info!(
                    "[Sion][partage-natif] sous-surface EGL prête (vidéo hors composition WebKit)"
                );
                Ok(Self {
                    conn,
                    qh,
                    parent,
                    parent_window: gdk_window,
                    view: view.clone(),
                    toplevel,
                    surface,
                    subsurface,
                    compositor,
                    queue,
                    shared,
                    thread: Some(thread),
                    size: (0, 0),
                    scale: 1,
                })
            }

            pub(super) fn shared(&self) -> Arc<Shared> {
                self.shared.clone()
            }

            pub(super) fn set_geometry(&mut self, target: &Surface, scale: i32) {
                // Une sous-surface n'est pas clippée par les ancêtres GTK/WebKit.
                // Le front a déjà intersecté les conteneurs à `overflow` ; ce
                // bornage au parent est le garde-fou final si un rectangle
                // périmé survit à un redimensionnement.
                let parent_width = self.parent_window.width().max(0) as f64;
                let parent_height = self.parent_window.height().max(0) as f64;
                let x = target.x.max(0.0).min(parent_width.max(1.0));
                let y = target.y.max(0.0).min(parent_height.max(1.0));
                let logical_width = target.width.min((parent_width - x).max(1.0)).max(1.0);
                let logical_height = target.height.min((parent_height - y).max(1.0)).max(1.0);
                let scale = scale.max(1);
                let width = ((logical_width * scale as f64).ceil() as i32).max(2);
                let height = ((logical_height * scale as f64).ceil() as i32).max(2);

                // Les rectangles du front sont relatifs à la WebView ; la
                // position d'une sous-surface est relative au `wl_surface`
                // parent, qui couvre toute la fenêtre décorations comprises.
                // `translate_coordinates` donne l'écart exact, quelle que soit
                // la hauteur de barre de titre ou la marge d'ombre du thème.
                let (offset_x, offset_y) = self
                    .view
                    .translate_coordinates(&self.toplevel, 0, 0)
                    .unwrap_or((0, 0));
                self.subsurface.set_position(
                    x.round() as i32 + offset_x,
                    y.round() as i32 + offset_y,
                );
                self.surface.set_buffer_scale(scale);
                // Surface opaque : le compositeur peut ignorer tout ce qui est
                // dessous, y compris la WebView.
                let opaque = self.compositor.create_region(&self.qh, ());
                opaque.add(0, 0, width, height);
                self.surface.set_opaque_region(Some(&opaque));
                opaque.destroy();
                let _ = self.conn.flush();

                // `wl_subsurface.set_position` n'est appliqué qu'au commit du
                // **parent**. Sans redraw, une fenêtre dont WebKit n'a rien à
                // repeindre ne commiterait pas, et la vidéo resterait à son
                // ancienne place après un scroll ou un redimensionnement. Ce
                // réveil n'a lieu qu'au changement de géométrie, jamais par
                // image.
                self.parent_window.invalidate_rect(None, false);
                // Personne d'autre ne vide notre file d'événements.
                let _ = self.queue.dispatch_pending(&mut State);
                if self.size != (width, height) || self.scale != scale {
                    self.size = (width, height);
                    self.scale = scale;
                    log::info!(
                        "[Sion][partage-natif] sous-surface EGL {width}x{height} position {},{} échelle {scale}",
                        x.round() as i32,
                        y.round() as i32
                    );
                }
                // Le resize du `wl_egl_window` appartient au thread qui détient
                // le contexte EGL.
                self.shared.request_resize(width, height);
            }

            pub(super) fn hide(&mut self) {
                self.shared.request_hide();
            }
        }

        impl Drop for Renderer {
            fn drop(&mut self) {
                self.shared.request_quit();
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
                self.subsurface.destroy();
                self.surface.destroy();
                let _ = self.conn.flush();
            }
        }

        /// Programme GPU : un quad plein cadre dont le rectangle est calculé en
        /// NDC (letterbox « contain »), et une conversion YUV faite à
        /// l'échantillonnage.
        struct Program {
            program: u32,
            vao: u32,
            rect_location: i32,
            planar_location: i32,
            textures: [u32; 3],
            /// Dimensions ET format interne déjà alloués par plan, pour
            /// choisir entre `glTexImage2D` et `glTexSubImage2D`.
            ///
            /// Le format fait partie de la clé : `prefers_planar()` bascule
            /// entre plans I420 (`GL_R8`) et BGRA (`GL_RGBA`) dès que la
            /// fenêtre PIP s'ouvre ou se ferme sur le partage présenté. À
            /// dimensions égales, ne comparer que la taille prenait le chemin
            /// `glTexSubImage2D` par-dessus une texture au mauvais format —
            /// des octets BGRA écrits dans une texture mono-canal, donc des
            /// couleurs aberrantes.
            allocated: [(u32, u32, i32); 3],
        }

        fn create_program() -> Result<Program, String> {
            const VERTEX: &[u8] = b"#version 150 core\n\
                uniform vec4 u_rect;\n\
                out vec2 v_uv;\n\
                const vec2 p[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1));\n\
                void main(){ vec2 q=p[gl_VertexID]; gl_Position=vec4(mix(u_rect.xy,u_rect.zw,q),0,1); v_uv=vec2(q.x,1.0-q.y); }\0";
            // BT.601 plage réduite — mêmes coefficients que `libyuv::I420ToARGB`,
            // qui sert le chemin GTK de repli et la fenêtre PIP. Un autre
            // espace (BT.709) décalerait visiblement les couleurs au moindre
            // basculement entre les deux backends.
            const FRAGMENT: &[u8] = b"#version 150 core\n\
                uniform sampler2D u_plane0;\n\
                uniform sampler2D u_plane1;\n\
                uniform sampler2D u_plane2;\n\
                uniform int u_planar;\n\
                in vec2 v_uv; out vec4 color;\n\
                void main(){\n\
                  if (u_planar == 1) {\n\
                    float y = (texture(u_plane0, v_uv).r - 0.0625) * 1.164383;\n\
                    float u = texture(u_plane1, v_uv).r - 0.5;\n\
                    float v = texture(u_plane2, v_uv).r - 0.5;\n\
                    color = vec4(y + 1.596027 * v,\n\
                                 y - 0.391762 * u - 0.812968 * v,\n\
                                 y + 2.017232 * u, 1.0);\n\
                  } else {\n\
                    color = vec4(texture(u_plane0, v_uv).bgr, 1.0);\n\
                  }\n\
                }\0";
            unsafe {
                let vertex = compile_shader(GL_VERTEX_SHADER, VERTEX)?;
                let fragment = compile_shader(GL_FRAGMENT_SHADER, FRAGMENT)?;
                let program = super::glCreateProgram();
                super::glAttachShader(program, vertex);
                super::glAttachShader(program, fragment);
                super::glLinkProgram(program);
                super::glDeleteShader(vertex);
                super::glDeleteShader(fragment);
                let mut ok = 0;
                super::glGetProgramiv(program, GL_LINK_STATUS, &mut ok);
                if ok == 0 {
                    let mut length = 0;
                    super::glGetProgramiv(program, GL_INFO_LOG_LENGTH, &mut length);
                    let mut log = vec![0u8; length.max(1) as usize];
                    super::glGetProgramInfoLog(
                        program,
                        length,
                        std::ptr::null_mut(),
                        log.as_mut_ptr().cast(),
                    );
                    super::glDeleteProgram(program);
                    return Err(String::from_utf8_lossy(&log)
                        .trim_end_matches('\0')
                        .to_owned());
                }
                let rect_location = super::glGetUniformLocation(program, b"u_rect\0".as_ptr().cast());
                let planar_location =
                    super::glGetUniformLocation(program, b"u_planar\0".as_ptr().cast());
                let mut vao = 0;
                super::glGenVertexArrays(1, &mut vao);
                super::glUseProgram(program);
                for (unit, name) in [
                    (0i32, b"u_plane0\0".as_ptr()),
                    (1, b"u_plane1\0".as_ptr()),
                    (2, b"u_plane2\0".as_ptr()),
                ] {
                    let location = super::glGetUniformLocation(program, name.cast());
                    super::glUniform1i(location, unit);
                }
                let mut textures = [0u32; 3];
                super::glGenTextures(3, textures.as_mut_ptr());
                for (index, texture) in textures.iter().enumerate() {
                    super::glActiveTexture(GL_TEXTURE0 + index as u32);
                    super::glBindTexture(GL_TEXTURE_2D, *texture);
                    // Filtrage linéaire : c'est le GPU qui met à l'échelle vers
                    // le rectangle visible, il n'y a plus de pré-réduction
                    // libyuv suivie d'un blit `GL_NEAREST` à recaler.
                    super::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                    super::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                    super::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                    super::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                }
                Ok(Program {
                    program,
                    vao,
                    rect_location,
                    planar_location,
                    textures,
                    allocated: [(0, 0, 0); 3],
                })
            }
        }

        impl Program {
            /// Téléverse un plan mono-canal en respectant son pas de ligne.
            unsafe fn upload_plane(
                &mut self,
                index: usize,
                width: u32,
                height: u32,
                stride: u32,
                pixels: &[u8],
                internal: i32,
                format: u32,
                bytes_per_pixel: u32,
            ) {
                if width == 0 || height == 0 {
                    return;
                }
                let needed = (stride * (height - 1) + width * bytes_per_pixel) as usize;
                if pixels.len() < needed {
                    // Abandon jusqu'ici SILENCIEUX : les trois plans étaient
                    // écartés sans un mot et la surface restait noire, alors
                    // que le PIP — qui consomme du BGRA et pas des plans —
                    // affichait la même vidéo sans problème. Une fois par
                    // seconde suffit à comprendre sans noyer le journal.
                    use std::sync::atomic::{AtomicU64, Ordering as O};
                    static DERNIER: AtomicU64 = AtomicU64::new(0);
                    let maintenant = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    if DERNIER.swap(maintenant, O::Relaxed) != maintenant {
                        log::warn!(
                            "[Sion][partage-natif] plan {} ignoré : {} octets reçus, {} attendus \
                             ({}x{}, pas {}, {} o/px)",
                            index,
                            pixels.len(),
                            needed,
                            width,
                            height,
                            stride,
                            bytes_per_pixel
                        );
                    }
                    return;
                }
                super::glActiveTexture(GL_TEXTURE0 + index as u32);
                super::glBindTexture(GL_TEXTURE_2D, self.textures[index]);
                super::glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                super::glPixelStorei(GL_UNPACK_ROW_LENGTH, (stride / bytes_per_pixel) as i32);
                if self.allocated[index] == (width, height, internal) {
                    super::glTexSubImage2D(
                        GL_TEXTURE_2D,
                        0,
                        0,
                        0,
                        width as i32,
                        height as i32,
                        format,
                        GL_UNSIGNED_BYTE,
                        pixels.as_ptr().cast(),
                    );
                } else {
                    super::glTexImage2D(
                        GL_TEXTURE_2D,
                        0,
                        internal,
                        width as i32,
                        height as i32,
                        0,
                        format,
                        GL_UNSIGNED_BYTE,
                        pixels.as_ptr().cast(),
                    );
                    self.allocated[index] = (width, height, internal);
                }
                super::glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
            }
        }

        impl Drop for Program {
            fn drop(&mut self) {
                unsafe {
                    super::glDeleteTextures(3, self.textures.as_ptr());
                    super::glDeleteProgram(self.program);
                }
            }
        }

        #[allow(clippy::too_many_arguments)]
        fn render_thread(
            display_addr: usize,
            surface_id: ObjectId,
            conn: Connection,
            surface: wl_surface::WlSurface,
            shared: Arc<Shared>,
            ready: std::sync::mpsc::Sender<Result<(), String>>,
        ) {
            let setup = (|| -> Result<
                (
                    egl::DynamicInstance<egl::EGL1_5>,
                    egl::Display,
                    egl::Surface,
                    egl::Context,
                    wayland_egl::WlEglSurface,
                    Program,
                ),
                String,
            > {
                let instance = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required() }
                    .map_err(|err| format!("libEGL introuvable: {err}"))?;
                let display = unsafe {
                    instance.get_display(display_addr as *mut std::ffi::c_void)
                }
                .ok_or_else(|| "eglGetDisplay a refusé le wl_display de GDK".to_owned())?;
                let (major, minor) = instance
                    .initialize(display)
                    .map_err(|err| format!("eglInitialize: {err}"))?;
                // GL de bureau, pas GLES : le tronc commun est déjà lié à libGL
                // et les shaders sont en `#version 150 core`.
                instance
                    .bind_api(egl::OPENGL_API)
                    .map_err(|err| format!("eglBindAPI(OpenGL): {err}"))?;
                let config = instance
                    .choose_first_config(
                        display,
                        &[
                            egl::SURFACE_TYPE,
                            egl::WINDOW_BIT,
                            egl::RENDERABLE_TYPE,
                            egl::OPENGL_BIT,
                            egl::RED_SIZE,
                            8,
                            egl::GREEN_SIZE,
                            8,
                            egl::BLUE_SIZE,
                            8,
                            egl::NONE,
                        ],
                    )
                    .map_err(|err| format!("eglChooseConfig: {err}"))?
                    .ok_or_else(|| "aucune config EGL RGB8 fenêtrée".to_owned())?;
                let context = instance
                    .create_context(
                        display,
                        config,
                        None,
                        &[
                            egl::CONTEXT_MAJOR_VERSION,
                            3,
                            egl::CONTEXT_MINOR_VERSION,
                            2,
                            egl::CONTEXT_OPENGL_PROFILE_MASK,
                            egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
                            egl::NONE,
                        ],
                    )
                    .map_err(|err| format!("eglCreateContext (GL 3.2 core): {err}"))?;
                // Taille d'amorçage : la première géométrie publiée la corrige
                // avant la première image.
                let egl_window = wayland_egl::WlEglSurface::new(surface_id, 2, 2)
                    .map_err(|err| format!("wl_egl_window: {err}"))?;
                let egl_surface = unsafe {
                    instance.create_window_surface(
                        display,
                        config,
                        egl_window.ptr() as egl::NativeWindowType,
                        None,
                    )
                }
                .map_err(|err| format!("eglCreateWindowSurface: {err}"))?;
                instance
                    .make_current(display, Some(egl_surface), Some(egl_surface), Some(context))
                    .map_err(|err| format!("eglMakeCurrent: {err}"))?;
                // Cadencement par le compositeur : `eglSwapBuffers` bloque sur
                // le vsync, ce qui est sans danger hors du thread d'interface.
                // Échange NON synchronisé sur le compositeur.
                //
                // Avec un intervalle de 1, `eglSwapBuffers` attend le « frame
                // callback » de la surface. Or notre sous-surface est démappée
                // dès que le partage disparaît de l'écran — passage en PIP,
                // arrêt du partage, onglet quitté : `attach(None)` puis commit.
                // Le compositeur n'a alors plus aucune raison d'envoyer ce
                // rappel, et le premier échange suivant BLOQUE le fil de rendu
                // définitivement. C'est l'écran noir au retour du PIP constaté
                // le 17/09 : images toujours soumises (#600), plus aucune
                // présentée (#300), fil vivant mais figé dans un `poll`.
                //
                // Rien ne justifiait cette synchronisation : la cadence est
                // déjà donnée par les images reçues du réseau, pas par la
                // boucle de rendu, et nous ne dessinons que sur image nouvelle.
                let _ = instance.swap_interval(display, 0);
                let program = create_program()?;
                log::info!("[Sion][partage-natif] contexte EGL {major}.{minor} / GL 3.2 core prêt");
                Ok((instance, display, egl_surface, context, egl_window, program))
            })();

            let (instance, display, egl_surface, context, egl_window, mut program) = match setup {
                Ok(parts) => {
                    let _ = ready.send(Ok(()));
                    parts
                }
                Err(err) => {
                    let _ = ready.send(Err(err));
                    return;
                }
            };
            shared.live.store(true, Ordering::Release);

            let mut viewport = (0i32, 0i32);
            let mut mapped = false;
            let mut presented: u64 = 0;
            loop {
                let work = {
                    let mut inner = shared.inner.lock().unwrap_or_else(|err| err.into_inner());
                    while inner.idle() {
                        inner = shared
                            .wake
                            .wait(inner)
                            .unwrap_or_else(|err| err.into_inner());
                    }
                    Work {
                        frame: inner.frame.take(),
                        resize: inner.resize.take(),
                        hide: std::mem::take(&mut inner.hide),
                        quit: inner.quit,
                    }
                };
                if work.quit {
                    break;
                }
                if let Some((width, height)) = work.resize {
                    if viewport != (width, height) {
                        egl_window.resize(width, height, 0, 0);
                        viewport = (width, height);
                    }
                }
                if work.hide {
                    if mapped {
                        surface.attach(None, 0, 0);
                        surface.commit();
                        let _ = conn.flush();
                        mapped = false;
                    }
                    continue;
                }
                let Some(payload) = work.frame else { continue };
                if viewport.0 < 2 || viewport.1 < 2 {
                    continue;
                }
                let (frame_width, frame_height) = payload.dimensions();
                if frame_width == 0 || frame_height == 0 {
                    continue;
                }
                unsafe {
                    let planar = match &payload {
                        Payload::Planar(frame) => {
                            let (y, u, v) = frame.planes();
                            let (sy, su, sv) = frame.strides();
                            let cw = frame_width.div_ceil(2);
                            let ch = frame_height.div_ceil(2);
                            program.upload_plane(
                                0,
                                frame_width,
                                frame_height,
                                sy,
                                y,
                                GL_R8,
                                GL_RED,
                                1,
                            );
                            program.upload_plane(1, cw, ch, su, u, GL_R8, GL_RED, 1);
                            program.upload_plane(2, cw, ch, sv, v, GL_R8, GL_RED, 1);
                            1
                        }
                        Payload::Bgra { data, .. } => {
                            program.upload_plane(
                                0,
                                frame_width,
                                frame_height,
                                frame_width * 4,
                                data,
                                super::GL_RGBA,
                                super::GL_RGBA as u32,
                                4,
                            );
                            0
                        }
                    };
                    super::glViewport(0, 0, viewport.0, viewport.1);
                    // Letterbox opaque : le noir appartient à la sous-surface,
                    // la WebView ne transparaît jamais au travers.
                    super::glClearColor(0.0, 0.0, 0.0, 1.0);
                    super::glClear(GL_COLOR_BUFFER_BIT);
                    super::glUseProgram(program.program);
                    super::glBindVertexArray(program.vao);
                    super::glUniform1i(program.planar_location, planar);
                    let (mut x, mut y, mut width, mut height) = fit_content_rect(
                        0.0,
                        0.0,
                        viewport.0 as f64,
                        viewport.1 as f64,
                        frame_width,
                        frame_height,
                    );
                    // `fit_frame_dimensions` arrondit la frame à des dimensions
                    // PAIRES (contrainte I420) alors que la sous-surface est
                    // arrondie au pixel supérieur. Un écart d'un ou deux pixels
                    // suffit à imposer un facteur d'échelle de 1,002 : le
                    // rééchantillonnage bilinéaire adoucit alors toute l'image,
                    // texte compris, pour un gain de taille invisible. On colle
                    // au 1:1 dans ce cas, centré sur des coordonnées entières —
                    // un texel par pixel, donc net.
                    if (width - frame_width as f64).abs() <= 2.0
                        && (height - frame_height as f64).abs() <= 2.0
                    {
                        width = frame_width as f64;
                        height = frame_height as f64;
                        x = ((viewport.0 as f64 - width) * 0.5).round();
                        y = ((viewport.1 as f64 - height) * 0.5).round();
                    }
                    let left = (2.0 * x / viewport.0 as f64 - 1.0) as f32;
                    let right = (2.0 * (x + width) / viewport.0 as f64 - 1.0) as f32;
                    let top = (1.0 - 2.0 * y / viewport.1 as f64) as f32;
                    let bottom = (1.0 - 2.0 * (y + height) / viewport.1 as f64) as f32;
                    super::glUniform4f(program.rect_location, left, bottom, right, top);
                    super::glDrawArrays(GL_TRIANGLES, 0, 6);
                    super::glBindVertexArray(0);
                }
                // Le tampon BGRA consommé repart à la pompe pour recyclage.
                if let Payload::Bgra { data, .. } = payload {
                    let mut inner = shared.inner.lock().unwrap_or_else(|err| err.into_inner());
                    inner.recycled = Some(data);
                }
                if instance.swap_buffers(display, egl_surface).is_err() {
                    log::warn!("[Sion][partage-natif] eglSwapBuffers refusé");
                    continue;
                }
                mapped = true;
                presented += 1;
                if presented == 1 || presented % 300 == 0 {
                    log::info!("[Sion][partage-natif] image EGL présentée #{presented}");
                }
            }

            // Sortie du fil : jusqu'ici muette. Or `live=false` fait rejeter
            // toutes les images suivantes en amont — le partage devient noir
            // sans qu'aucune ligne n'explique pourquoi.
            log::warn!(
                "[Sion][partage-natif] fil de rendu EGL terminé après {presented} image(s) —                  les images suivantes seront ignorées"
            );
            shared.live.store(false, Ordering::Release);
            // Les objets GL appartiennent au contexte : les libérer après
            // `eglMakeCurrent(NULL)` reviendrait à appeler `glDelete*` sans
            // contexte courant.
            drop(program);
            let _ = instance.make_current(display, None, None, None);
            let _ = instance.destroy_surface(display, egl_surface);
            let _ = instance.destroy_context(display, context);
            drop(egl_window);
            log::info!("[Sion][partage-natif] thread de rendu EGL arrêté");
        }
    }

    /// Rend la fenêtre GDK d'un widget d'overlay totalement traversante.
    ///
    /// Une région d'entrée vide dit au compositeur que cette fenêtre ne veut
    /// aucun événement de pointeur : ils atteignent alors la WebView en
    /// dessous. Sans ça, la surface vidéo avalait tout le `mousemove` sur son
    /// emprise et le DOM ne voyait plus que les franchissements de bordure.
    ///
    /// `GtkOverlay` crée une `GdkWindow` DÉDIÉE par enfant superposé, et c'est
    /// elle qui reçoit le pointeur — y compris pour un enfant sans fenêtre
    /// propre, qui s'y dessine quand même. Tester `has_window()` sautait donc
    /// exactement la fenêtre à neutraliser : mesuré le 16/09, le survol de
    /// l'intérieur de la vidéo ne produisait plus aucun `mousemove` (seuls les
    /// franchissements de bordure passaient), alors que la même manipulation
    /// avec `SION_DISABLE_NATIVE_VIDEO_SURFACE=1` suivait le pointeur sans
    /// faute.
    ///
    /// Garde-fou : si la fenêtre rendue est celle du parent, on ne touche à
    /// rien — la vider couperait l'entrée de toute l'application.
    fn make_input_transparent(widget: &gtk::Widget) {
        use gtk::prelude::WidgetExt as _;
        let Some(window) = widget.window() else {
            return;
        };
        if widget.parent().and_then(|parent| parent.window()).as_ref() == Some(&window) {
            log::warn!(
                "[Sion][partage-natif] calque sans fenêtre dédiée, entrée laissée intacte"
            );
            return;
        }
        let empty = gtk::cairo::Region::create();
        window.input_shape_combine_region(&empty, 0, 0);
        log::info!("[Sion][partage-natif] overlay rendu traversant (région d'entrée vide)");
    }

    /// Relève la WebView quand son processus web meurt.
    ///
    /// Un WebM tordu a fait échouer une assertion de `matroskademux` (17/09) ;
    /// le `SIGABRT` a emporté le processus web, et donc TOUTE l'interface :
    /// fenêtre figée, session perdue, alors que le moteur Rust continuait de
    /// tourner et de journaliser. Le défaut appartient à GStreamer et nous ne
    /// pouvons pas l'empêcher — mais rien ne nous oblige à en mourir avec lui.
    ///
    /// Le rechargement ramène l'incident au rang de clignotement. Il est borné :
    /// une page qui planterait à chaque chargement boucherait sinon la machine
    /// en rechargements perpétuels, ce qui serait pire que la fenêtre figée.
    fn surveiller_processus_web(view: &webkit2gtk::WebView) {
        use webkit2gtk::WebViewExt as _;
        const MAX_RELEVES: u32 = 3;
        const FENETRE: Duration = Duration::from_secs(60);
        let historique: std::rc::Rc<RefCell<Vec<Instant>>> =
            std::rc::Rc::new(RefCell::new(Vec::new()));
        view.connect_web_process_terminated(move |vue, raison| {
            let maintenant = Instant::now();
            let mut essais = historique.borrow_mut();
            essais.retain(|t| maintenant.duration_since(*t) < FENETRE);
            if essais.len() as u32 >= MAX_RELEVES {
                log::error!(
                    "[Sion][webkit] processus web mort ({raison:?}) — {MAX_RELEVES} relèves en \
                     moins d'une minute, on renonce : l'interface restera figée"
                );
                return;
            }
            essais.push(maintenant);
            let rang = essais.len();
            drop(essais);
            log::error!(
                "[Sion][webkit] processus web mort ({raison:?}) — rechargement {rang}/{MAX_RELEVES}"
            );
            vue.reload();
        });
    }

    pub fn attach(
        app: &tauri::AppHandle<crate::TauriRuntime>,
        view: &webkit2gtk::WebView,
    ) -> Result<(), String> {
        if available() {
            return Ok(());
        }
        let overlay = view
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
            .ok_or_else(|| "la WebView n'a pas été créée dans le GtkOverlay natif".to_owned())?;

        surveiller_processus_web(view);

        let display = view.display();
        log::info!(
            "[Sion][partage-natif] backend GDK={:?} type={} échelle={}",
            display.backend(),
            display.type_().name(),
            view.scale_factor().max(1)
        );

        let area = gtk::GLArea::new();
        area.set_auto_render(false);
        area.set_has_alpha(false);
        area.set_required_version(3, 2);
        area.set_use_es(false);
        // L'overlay parent est déjà visible lorsque Tauri nous le remet.
        // Sans `no_show_all`, un `show_all()` du parent remappe cette zone
        // pourtant vide et WebKit/GTK la repeint à 60 Hz avant tout partage.
        area.set_no_show_all(true);
        area.set_halign(gtk::Align::Start);
        area.set_valign(gtk::Align::Start);
        area.set_can_focus(false);
        let state = std::rc::Rc::new(RefCell::new(RenderState::default()));
        let render_state = state.clone();
        area.connect_render(move |area, _context| {
            if let Err(err) = render_gl(&mut render_state.borrow_mut(), area) {
                log::error!("[Sion][partage-natif] rendu GtkGLArea refusé: {err}");
            }
            let count = DRAW_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
            if count == 1 || count % 120 == 0 {
                log::info!("[Sion][partage-natif] rendu GL à la demande #{count}");
            }
            gtk::glib::Propagation::Stop
        });
        // `set_overlay_pass_through` ne suffit pas : mesuré le 16/09, seuls les
        // franchissements de bordure du canvas produisaient un `mousemove` —
        // l'intérieur de la vidéo ne recevait plus rien, donc le curseur du
        // viewer n'était jamais émis ailleurs que sur les bords. Une
        // `GtkDrawingArea` possède sa propre `GdkWindow` et une `GtkGLArea`
        // une fenêtre d'événements interne : toutes deux captent le pointeur.
        // La région d'entrée vide est le mécanisme GDK qui rend réellement une
        // fenêtre traversante.
        area.connect_realize(move |area| {
            area.make_current();
            if let Some(context) = area.context() {
                let version = context.version();
                log::info!(
                    "[Sion][partage-natif] GtkGLArea OpenGL {}.{} prêt",
                    version.0,
                    version.1
                );
            }
            make_input_transparent(area.upcast_ref());
        });
        let cursor_area = gtk::DrawingArea::new();
        // Une `GtkDrawingArea` crée SA PROPRE `GdkWindow`, et cette fenêtre
        // capte le pointeur sur toute son emprise — mesuré le 16/09 : seuls
        // les franchissements de bordure du canvas produisaient encore un
        // `mousemove`, l'intérieur de la vidéo était mort, et le curseur du
        // viewer ne partait donc jamais qu'avec des coordonnées de bord.
        // Ni `set_overlay_pass_through` ni une région d'entrée vide n'y ont
        // suffi. Sans fenêtre, le widget dessine sur celle du parent — comme
        // la `GtkGLArea` juste au-dessus — et n'a plus rien à intercepter.
        // À poser AVANT `add_overlay`, qui réalise aussitôt le widget.
        cursor_area.set_has_window(false);
        cursor_area.set_no_show_all(true);
        cursor_area.set_halign(gtk::Align::Start);
        cursor_area.set_valign(gtk::Align::Start);
        cursor_area.set_can_focus(false);
        let cursor_state = state.clone();
        cursor_area.connect_draw(move |_area, context| {
            draw_cursors(&cursor_state.borrow(), context);
            gtk::glib::Propagation::Proceed
        });
        cursor_area.connect_realize(|area| {
            make_input_transparent(area.upcast_ref());
        });
        overlay.add_overlay(&area);
        overlay.set_overlay_pass_through(&area, true);
        overlay.add_overlay(&cursor_area);
        overlay.set_overlay_pass_through(&cursor_area, true);
        OUTPUT_SCALE.store(area.scale_factor().max(1) as u32, Ordering::Relaxed);
        // Sous-surface EGL : c'est le chemin qui sort réellement la vidéo du
        // graphe de composition WebKit. Il reste explicitement opt-in tant que
        // le clipping exact du layout (coins arrondis, redimensionnements) et
        // les curseurs distants composés dans la surface ne sont pas validés
        // visuellement — le repli GtkGLArea reste le défaut.
        let wayland = if std::env::var_os("SION_WAYLAND_SUBSURFACE").is_some()
            && display.backend().is_wayland()
        {
            match wayland_surface::Renderer::new(view.upcast_ref()) {
                Ok(renderer) => {
                    let _ = EGL_SHARED.set(renderer.shared());
                    Some(renderer)
                }
                Err(err) => {
                    log::warn!(
                        "[Sion][partage-natif] sous-surface EGL indisponible, repli GtkGLArea: {err}"
                    );
                    None
                }
            }
        } else {
            None
        };
        area.hide();
        cursor_area.hide();
        RENDERER.with(|slot| {
            *slot.borrow_mut() = Some(Renderer {
                overlay,
                area,
                cursor_area,
                state,
                wayland,
            });
        });
        let _ = APP.set(app.clone());
        AVAILABLE.store(true, Ordering::Release);
        log::info!("[Sion][partage-natif] surface GtkGLArea bornée prête (entrée vide)");
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// La fusion des commandes viewer est latest-wins par (cible,
        /// expéditeur) et le sweep TTL retire tout ce qui a expiré. Ces deux
        /// propriétés bornent l'état de rendu sans fuite mémoire.
        #[test]
        fn fusion_curseurs_viewer_latest_wins_puis_sweep_ttl() {
            let mut state = RenderState::default();
            let echeance = Instant::now() + Duration::from_millis(5000);
            // Deux positions successives du même viewer sur le même partage :
            // une seule entrée, la dernière position.
            for (x, y) in [(0.25, 0.5), (0.75, 0.125)] {
                pending_viewer_cursors()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .entry("@picsou:sion".into())
                    .or_default()
                    .push(ViewerCursorCmd::Upsert {
                        identity: "@viewer:sion".into(),
                        name: "Viewer".into(),
                        x,
                        y,
                        expires_at: echeance,
                    });
            }
            // Un clic : une onde née maintenant, expirée dans 800 ms.
            let now = Instant::now();
            pending_viewer_cursors()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .entry("@picsou:sion".into())
                .or_default()
                .push(ViewerCursorCmd::Click {
                    identity: "@viewer:sion".into(),
                    x: 0.5,
                    y: 0.5,
                    born_at: now,
                    expires_at: now + Duration::from_millis(800),
                });
            assert!(drain_viewer_cursors(&mut state));
            let target = state.viewer_cursors.get("@picsou:sion").unwrap();
            assert_eq!(target.cursors.len(), 1, "latest-wins par expéditeur");
            assert_eq!(target.clicks.len(), 1);
            let cursor = target.cursors.get("@viewer:sion").unwrap();
            assert_eq!(
                (cursor.x, cursor.y),
                (0.75, 0.125),
                "dernière position gardée"
            );

            // Expire explicite : le curseur disparaît, l'onde survit jusqu'à
            // son échéance propre.
            pending_viewer_cursors()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .entry("@picsou:sion".into())
                .or_default()
                .push(ViewerCursorCmd::Remove {
                    identity: "@viewer:sion".into(),
                });
            assert!(drain_viewer_cursors(&mut state));
            let target = state.viewer_cursors.get("@picsou:sion").unwrap();
            assert!(target.cursors.is_empty(), "expire explicite appliqué");
            assert_eq!(target.clicks.len(), 1, "l'onde garde sa durée propre");
        }

        /// Le plafond d'ondes simultanées tient même sous un flot anormal de
        /// clics : l'état ne croît pas au-delà de MAX_VIEWER_CLICKS.
        #[test]
        fn plafond_ondes_de_clic() {
            let mut state = RenderState::default();
            let now = Instant::now();
            {
                let mut pending = pending_viewer_cursors()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner());
                let cmds = pending.entry("@picsou:sion".into()).or_default();
                for i in 0..(MAX_VIEWER_CLICKS as u32 * 3) {
                    cmds.push(ViewerCursorCmd::Click {
                        identity: format!("@v{i}:sion"),
                        x: 0.1,
                        y: 0.2,
                        born_at: now,
                        expires_at: now + Duration::from_millis(800),
                    });
                }
            }
            let _ = drain_viewer_cursors(&mut state);
            let target = state.viewer_cursors.get("@picsou:sion").unwrap();
            assert_eq!(target.clicks.len(), MAX_VIEWER_CLICKS);
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::NativeVideoSurfaceSpec;
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::Emitter;
    use windows::Win32::Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, EndPaint, InvalidateRect, PatBlt, SetStretchBltMode, StretchDIBits, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, BLACKNESS, COLORONCOLOR, DIB_RGB_COLORS, PAINTSTRUCT, SRCCOPY,
    };
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CombineRgn, CreateCompatibleBitmap, CreateCompatibleDC, CreateRectRgn, DeleteDC,
        DeleteObject, SelectObject, SetWindowRgn, HRGN, RGN_DIFF,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
        RegisterClassExW, SetWindowLongPtrW, SetWindowPos, CREATESTRUCTW, GWLP_USERDATA,
        HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
        SWP_SHOWWINDOW, WINDOW_EX_STYLE, WM_ERASEBKGND, WM_NCCREATE, WM_NCDESTROY,
        WM_LBUTTONDOWN, WM_PAINT, WNDCLASSEXW, WNDCLASS_STYLES, WS_CHILD, WS_CLIPSIBLINGS,
        WS_VISIBLE,
    };
    use windows_core::w;

    /// Le chemin planaire est propre au renderer EGL de Wayland. Ici la
    /// présentation passe par `StretchDIBits`, qui ne sait peindre que du
    /// BGRA : la pompe doit continuer à convertir côté CPU.
    pub fn accepts_planar(_sender: &str) -> bool {
        false
    }

    /// Inaccessible en pratique — `prefers_planar()` répond `false` au-dessus.
    /// Le plan est relâché sans être peint plutôt que d'être converti ici, ce
    /// qui masquerait une régression du côté appelant.
    pub fn on_planar_frame(_sender: String, _frame: Box<dyn super::PlanarFrame>) {}

    const MAX_SURFACES: usize = 16;
    const MAX_FRAME_BYTES: usize = 4096 * 4096 * 4;

    static AVAILABLE: AtomicBool = AtomicBool::new(false);
    static PARENT: AtomicIsize = AtomicIsize::new(0);
    static SCALE_BITS: AtomicU64 = AtomicU64::new(1.0f64.to_bits());
    static APP: OnceLock<tauri::AppHandle<crate::TauriRuntime>> = OnceLock::new();
    static ACTIVE_SENDERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    static TARGET_SIZES: OnceLock<Mutex<HashMap<String, (u32, u32)>>> = OnceLock::new();
    static FRAMES: OnceLock<Mutex<HashMap<String, Arc<Frame>>>> = OnceLock::new();
    static WINDOWS: OnceLock<Mutex<HashMap<String, NativeWindow>>> = OnceLock::new();
    static PENDING_SURFACES: OnceLock<Mutex<Option<Vec<Surface>>>> = OnceLock::new();
    static SURFACE_DISPATCH_QUEUED: AtomicBool = AtomicBool::new(false);

    #[derive(Clone)]
    struct Surface {
        id: String,
        sender: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        /// Zones rendues à la page, dans le repère de la surface (CSS).
        holes: Vec<(f64, f64, f64, f64)>,
    }

    struct Frame {
        width: u32,
        height: u32,
        bgra: Vec<u8>,
    }

    struct WindowContext {
        sender: String,
    }

    struct NativeWindow {
        hwnd: isize,
        sender: String,
        /// Trous posés par la dernière région, en pixels physiques : une
        /// région inchangée n'est pas réappliquée.
        trous: Vec<(i32, i32, i32, i32)>,
        // Adresse stable lue par WndProc via GWLP_USERDATA. La Box reste
        // vivante jusqu'au retour de DestroyWindow.
        _context: Box<WindowContext>,
    }

    fn active_senders() -> &'static Mutex<HashSet<String>> {
        ACTIVE_SENDERS.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn target_sizes() -> &'static Mutex<HashMap<String, (u32, u32)>> {
        TARGET_SIZES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn frames() -> &'static Mutex<HashMap<String, Arc<Frame>>> {
        FRAMES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn windows() -> &'static Mutex<HashMap<String, NativeWindow>> {
        WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn pending_surfaces() -> &'static Mutex<Option<Vec<Surface>>> {
        PENDING_SURFACES.get_or_init(|| Mutex::new(None))
    }

    fn output_scale() -> f64 {
        f64::from_bits(SCALE_BITS.load(Ordering::Relaxed)).clamp(0.5, 8.0)
    }

    pub fn available() -> bool {
        AVAILABLE.load(Ordering::Acquire)
    }

    pub fn preferred_frame_bounds(sender: &str) -> Option<(u32, u32)> {
        target_sizes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(sender)
            .copied()
    }

    pub fn viewer_targets() -> Option<HashSet<String>> {
        // Les curseurs sont désormais peints par le calque GDI, dans la même
        // passe que la vidéo. Le DOM ne peut plus s'en charger : notre fenêtre
        // enfant recouvre la zone, et ses curseurs se retrouvaient DERRIÈRE la
        // vidéo — invisibles dès que la surface native est devenue visible
        // (17/09). Déclarer nos cibles coupe leur émission côté JS.
        if !available() {
            return None;
        }
        Some(
            windows()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .values()
                .map(|window| window.sender.clone())
                .collect(),
        )
    }

    /// Curseur d'un viewer tel qu'il sera peint.
    struct CurseurViewer {
        nom: String,
        x: f32,
        y: f32,
        expire_a: std::time::Instant,
    }

    /// Curseurs par partage, puis par identité.
    fn curseurs() -> &'static Mutex<HashMap<String, HashMap<String, CurseurViewer>>> {
        static CURSEURS: OnceLock<Mutex<HashMap<String, HashMap<String, CurseurViewer>>>> =
            OnceLock::new();
        CURSEURS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Durée de vie d'une position sans nouvelle. Le partageur cesse parfois
    /// d'émettre sans envoyer de masquage (fenêtre quittée, réseau coupé) : la
    /// flèche resterait figée à l'écran.
    const CURSEUR_TTL: std::time::Duration = std::time::Duration::from_secs(5);

    pub fn on_viewer_cursor_packet(
        target: &str,
        identity: &str,
        name: &str,
        _click: bool,
        x: f32,
        y: f32,
        expire: bool,
    ) {
        {
            let mut tout = curseurs().lock().unwrap_or_else(|err| err.into_inner());
            let par_cible = tout.entry(target.to_owned()).or_default();
            if expire {
                par_cible.remove(identity);
            } else {
                par_cible.insert(
                    identity.to_owned(),
                    CurseurViewer {
                        nom: name.to_owned(),
                        x,
                        y,
                        expire_a: std::time::Instant::now() + CURSEUR_TTL,
                    },
                );
            }
        }
        // Repeindre la ou les fenêtres de ce partage.
        let hwnds = windows()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .filter(|window| window.sender == target)
            .map(|window| window.hwnd)
            .collect::<Vec<_>>();
        // Les paquets arrivaient (près de 6/s) sans qu'aucun curseur
        // n'apparaisse (17/09) : reste à savoir si la cible du paquet
        // correspond à une fenêtre affichée. Zéro fenêtre ici = le curseur est
        // rangé pour un partage que nous ne montrons pas, et il ne sera jamais
        // peint.
        {
            static RECUS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = RECUS.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n % 60 == 0 {
                log::info!(
                    "[Sion][partage-natif/windows] curseur #{n} de {identity} visant {target} — \
                     {} fenêtre(s) concernée(s)",
                    hwnds.len()
                );
            }
        }
        // Repeindre au plus 30 fois par seconde pour les curseurs.
        //
        // Chaque position reçue déclenchait une peinture PLEIN CADRE. Avec 48
        // positions par seconde émises et autant reçues, on atteignait 80
        // peintures par seconde pour une vidéo qui n'en produit que 27 — soit
        // environ 240 Mo/s de recopie sur le fil d'interface, qui ajoutaient
        // précisément la latence qu'on cherchait à supprimer (18/09).
        //
        // La vidéo repeint de toute façon la surface à sa propre cadence ; ce
        // rafraîchissement supplémentaire ne sert qu'aux moments où l'image est
        // fixe et où seul le curseur bouge.
        {
            static DERNIERE_PEINTURE: Mutex<Option<std::time::Instant>> = Mutex::new(None);
            const PERIODE: std::time::Duration = std::time::Duration::from_millis(33);
            let mut derniere = DERNIERE_PEINTURE
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            let maintenant = std::time::Instant::now();
            match *derniere {
                Some(t) if maintenant.duration_since(t) < PERIODE => return,
                _ => *derniere = Some(maintenant),
            }
        }
        for hwnd in hwnds {
            unsafe {
                let _ = InvalidateRect(HWND(hwnd as _), None, BOOL(0));
            }
        }
    }

    /// Peint les curseurs des viewers par-dessus l'image, dans le tampon hors
    /// écran : ils sont donc déposés en même temps qu'elle, sans scintillement.
    /// `dest_*` est le rectangle réellement occupé par la vidéo (letterbox
    /// compris) — les coordonnées reçues sont normalisées par rapport à lui.
    unsafe fn peindre_curseurs(
        hdc: windows::Win32::Graphics::Gdi::HDC,
        sender: &str,
        dest_x: i32,
        dest_y: i32,
        dest_width: i32,
        dest_height: i32,
    ) {
        use windows::Win32::Foundation::{COLORREF, POINT};
        use windows::Win32::Graphics::Gdi::{
            CreatePen, CreateSolidBrush, FillRect, Polygon, SetBkMode, SetTextColor, TextOutW,
            PS_SOLID, TRANSPARENT,
        };

        let maintenant = std::time::Instant::now();
        let a_peindre: Vec<(String, String, f32, f32)> = {
            let mut tout = curseurs().lock().unwrap_or_else(|err| err.into_inner());
            let Some(par_cible) = tout.get_mut(sender) else {
                return;
            };
            par_cible.retain(|_, c| c.expire_a > maintenant);
            par_cible
                .iter()
                .map(|(identite, c)| (identite.clone(), c.nom.clone(), c.x, c.y))
                .collect()
        };
        {
            static PASSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = PASSES.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n % 120 == 0 {
                log::info!(
                    "[Sion][partage-natif/windows] passe curseurs #{n} pour {sender} : {} à peindre",
                    a_peindre.len()
                );
            }
        }
        if a_peindre.is_empty() {
            return;
        }

        SetBkMode(hdc, TRANSPARENT);
        for (identite, nom, nx, ny) in a_peindre {
            let (r, g, b) = crate::cursor_overlay::draw::identity_color_rgba8(&identite);
            let couleur = COLORREF(r as u32 | ((g as u32) << 8) | ((b as u32) << 16));
            let blanc = COLORREF(0x00FF_FFFF);
            let px = dest_x + (nx.clamp(0.0, 1.0) * dest_width as f32) as i32;
            let py = dest_y + (ny.clamp(0.0, 1.0) * dest_height as f32) as i32;

            // Même silhouette que le calque Cairo de Linux et que l'overlay du
            // partageur : une seule flèche reconnaissable partout.
            let points = [
                POINT { x: px, y: py },
                POINT { x: px, y: py + 14 },
                POINT { x: px + 4, y: py + 11 },
                POINT { x: px + 6, y: py + 16 },
                POINT { x: px + 8, y: py + 15 },
                POINT { x: px + 5, y: py + 10 },
                POINT { x: px + 10, y: py + 10 },
            ];
            let stylo = CreatePen(PS_SOLID, 1, blanc);
            let brosse = CreateSolidBrush(couleur);
            let ancien_stylo = SelectObject(hdc, stylo);
            let ancienne_brosse = SelectObject(hdc, brosse);
            let _ = Polygon(hdc, &points);
            SelectObject(hdc, ancien_stylo);
            SelectObject(hdc, ancienne_brosse);
            let _ = DeleteObject(stylo);
            let _ = DeleteObject(brosse);

            if !nom.is_empty() {
                let texte: Vec<u16> = nom.encode_utf16().collect();
                // Largeur estimée : une police système ~7 px par caractère. Le
                // fond n'a pas besoin d'être au pixel près, seulement lisible.
                let largeur = (texte.len() as i32 * 7) + 8;
                let fond = windows::Win32::Foundation::RECT {
                    left: px + 12,
                    top: py + 12,
                    right: px + 12 + largeur,
                    bottom: py + 30,
                };
                let brosse_fond = CreateSolidBrush(couleur);
                FillRect(hdc, &fond, brosse_fond);
                let _ = DeleteObject(brosse_fond);
                SetTextColor(hdc, blanc);
                let _ = TextOutW(hdc, px + 16, py + 14, &texte);
            }
        }
    }

    fn valid_surface(spec: NativeVideoSurfaceSpec) -> Option<Surface> {
        let values = [spec.x, spec.y, spec.width, spec.height];
        if spec.id.is_empty()
            || spec.sender.is_empty()
            || values.iter().any(|value| !value.is_finite())
            || spec.width < 1.0
            || spec.height < 1.0
            || spec.width > 16384.0
            || spec.height > 16384.0
        {
            return None;
        }
        let holes = super::holes_within(&spec);
        Some(Surface {
            id: spec.id,
            sender: spec.sender,
            x: spec.x,
            y: spec.y,
            width: spec.width,
            height: spec.height,
            holes,
        })
    }

    pub fn set_surfaces(specs: Vec<NativeVideoSurfaceSpec>) -> bool {
        if !available() {
            return false;
        }
        let surfaces = specs
            .into_iter()
            .take(MAX_SURFACES)
            .filter_map(valid_surface)
            .collect::<Vec<_>>();
        let scale = output_scale();
        let senders = surfaces
            .iter()
            .map(|surface| surface.sender.clone())
            .collect::<HashSet<_>>();
        let mut sizes = HashMap::new();
        for surface in &surfaces {
            let width = (surface.width * scale).ceil().max(2.0) as u32;
            let height = (surface.height * scale).ceil().max(2.0) as u32;
            sizes
                .entry(surface.sender.clone())
                .and_modify(|current: &mut (u32, u32)| {
                    current.0 = current.0.max(width);
                    current.1 = current.1.max(height);
                })
                .or_insert((width, height));
        }
        *target_sizes().lock().unwrap_or_else(|err| err.into_inner()) = sizes;
        *active_senders()
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = senders;
        *pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(surfaces);

        if !SURFACE_DISPATCH_QUEUED.swap(true, Ordering::AcqRel) {
            if let Some(app) = APP.get() {
                if let Err(err) = app.run_on_main_thread(apply_pending_surfaces) {
                    SURFACE_DISPATCH_QUEUED.store(false, Ordering::Release);
                    log::warn!("[Sion][partage-natif/windows] dispatch UI impossible: {err}");
                }
            }
        }
        true
    }

    /// Dernier rectangle appliqué à chaque surface, pour ne journaliser que
    /// les changements réels.
    #[allow(clippy::type_complexity)]
    fn derniers_rects(
    ) -> &'static Mutex<HashMap<isize, ((i32, i32, i32, i32), Option<(i32, i32, i32, i32)>)>> {
        #[allow(clippy::type_complexity)]
        static RECTS: OnceLock<
            Mutex<HashMap<isize, ((i32, i32, i32, i32), Option<(i32, i32, i32, i32)>)>>,
        > = OnceLock::new();
        RECTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn register_window_class() -> Result<(), String> {
        static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
        REGISTERED
            .get_or_init(|| {
                let module = unsafe { GetModuleHandleW(None) }.map_err(|err| err.to_string())?;
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: WNDCLASS_STYLES::default(),
                    lpfnWndProc: Some(surface_window_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: HINSTANCE(module.0),
                    lpszClassName: w!("SION_NATIVE_VIDEO_SURFACE"),
                    ..Default::default()
                };
                let atom = unsafe { RegisterClassExW(&class) };
                if atom == 0 {
                    Err(windows_core::Error::from_win32().to_string())
                } else {
                    Ok(())
                }
            })
            .clone()
    }

    fn create_surface_window(parent: HWND, surface: &Surface) -> Result<NativeWindow, String> {
        register_window_class()?;
        let context = Box::new(WindowContext {
            sender: surface.sender.clone(),
        });
        let context_ptr = (&*context as *const WindowContext).cast();
        let module = unsafe { GetModuleHandleW(None) }.map_err(|err| err.to_string())?;
        let hwnd = unsafe {
            CreateWindowExW(
                // `WS_EX_TRANSPARENT` a été essayé ici puis retiré (18/09) :
                // il change l'ordre de peinture des fenêtres enfants et rendait
                // la surface entièrement noire, sans pour autant rétablir la
                // souris. On garde donc une fenêtre ordinaire, qui REÇOIT les
                // messages souris et les relaie au front — voir `WM_MOUSEMOVE`.
                WINDOW_EX_STYLE::default(),
                w!("SION_NATIVE_VIDEO_SURFACE"),
                w!("Sion native video"),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent,
                None,
                HINSTANCE(module.0),
                Some(context_ptr),
            )
        }
        .map_err(|err| err.to_string())?;
        Ok(NativeWindow {
            hwnd: hwnd.0 as isize,
            sender: surface.sender.clone(),
            trous: Vec::new(),
            _context: context,
        })
    }

    /// Perce la fenêtre enfant là où un menu, un panneau flottant ou une
    /// boîte de dialogue de la page la recouvre. Aucun `z-index` ne passe
    /// devant une fenêtre native : sa région est le seul moyen de rendre la
    /// page visible à cet endroit.
    ///
    /// `decalage` : écart, en pixels physiques, entre le rectangle demandé et
    /// la position réelle de la fenêtre, quand l'amortisseur l'a laissée en
    /// place.
    fn appliquer_trous(
        window: &mut NativeWindow,
        holes: &[(f64, f64, f64, f64)],
        scale: f64,
        decalage: (i32, i32),
    ) {
        // Arrondis vers l'extérieur : aucun filet de vidéo sur le bord du menu.
        let (dx, dy) = decalage;
        let trous = holes
            .iter()
            .map(|&(x, y, w, h)| {
                (
                    (x * scale).floor() as i32 + dx,
                    (y * scale).floor() as i32 + dy,
                    ((x + w) * scale).ceil() as i32 + dx,
                    ((y + h) * scale).ceil() as i32 + dy,
                )
            })
            .collect::<Vec<_>>();
        if trous == window.trous {
            return;
        }
        let hwnd = HWND(window.hwnd as _);
        unsafe {
            if trous.is_empty() {
                // Plus de région : la fenêtre redevient un rectangle plein.
                let _ = SetWindowRgn(hwnd, HRGN::default(), BOOL(1));
            } else {
                // Une région plus grande que toute fenêtre : c'est la
                // fenêtre elle-même qui la borne.
                let region = CreateRectRgn(0, 0, 16384, 16384);
                for &(gauche, haut, droite, bas) in &trous {
                    let trou = CreateRectRgn(gauche, haut, droite, bas);
                    let _ = CombineRgn(region, region, trou, RGN_DIFF);
                    let _ = DeleteObject(trou);
                }
                // Posée, la région appartient au système ; refusée, elle
                // reste à nous.
                if SetWindowRgn(hwnd, region, BOOL(1)) == 0 {
                    let _ = DeleteObject(region);
                }
            }
        }
        window.trous = trous;
    }

    fn destroy_surface_window(window: NativeWindow) {
        let hwnd = HWND(window.hwnd as _);
        let _ = unsafe { DestroyWindow(hwnd) };
        drop(window);
    }

    fn apply_pending_surfaces() {
        let surfaces = pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
            .unwrap_or_default();
        let parent = HWND(PARENT.load(Ordering::Acquire) as _);
        let scale = output_scale();
        let mut current = windows().lock().unwrap_or_else(|err| err.into_inner());
        let wanted = surfaces
            .iter()
            .map(|surface| surface.id.clone())
            .collect::<HashSet<_>>();
        let removed = current
            .keys()
            .filter(|id| !wanted.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        for id in removed {
            if let Some(window) = current.remove(&id) {
                destroy_surface_window(window);
            }
        }

        for surface in &surfaces {
            let recreate = current
                .get(&surface.id)
                .is_some_and(|window| window.sender != surface.sender);
            if recreate {
                if let Some(window) = current.remove(&surface.id) {
                    destroy_surface_window(window);
                }
            }
            if !current.contains_key(&surface.id) {
                match create_surface_window(parent, surface) {
                    Ok(window) => {
                        // Journalisé : sans cette ligne, un partage noir ne
                        // permettait pas de distinguer « la fenêtre enfant n'a
                        // pas été créée » de « elle existe mais reste derrière
                        // la composition de WebView2 » — deux causes qui
                        // n'appellent pas le même correctif.
                        log::info!(
                            "[Sion][partage-natif/windows] surface {} créée pour {} à {:.0},{:.0} \
                             ({:.0}x{:.0} CSS, échelle {:.2})",
                            surface.id,
                            surface.sender,
                            surface.x,
                            surface.y,
                            surface.width,
                            surface.height,
                            scale
                        );
                        current.insert(surface.id.clone(), window);
                    }
                    Err(err) => {
                        log::warn!("[Sion][partage-natif/windows] création surface: {err}");
                        continue;
                    }
                }
            }
            let Some(window) = current.get_mut(&surface.id) else {
                continue;
            };
            let x = (surface.x * scale).round() as i32;
            let y = (surface.y * scale).round() as i32;
            let width = (surface.width * scale).round().max(1.0) as i32;
            let height = (surface.height * scale).round().max(1.0) as i32;
            // Amortisseur contre la boucle de rétroaction de mise en page.
            //
            // Le rectangle publié par le front dérive de la taille rendue, qui
            // dérive de la fenêtre, qui dérive du rectangle. Deux pixels
            // d'écart suffisent à entretenir le cycle : la surface oscillait
            // entre 464 et 466 pixels de haut, 1851 déplacements en quelques
            // secondes — l'image « dansait » à l'écran (17/09).
            //
            // On ignore donc les variations d'au plus deux pixels. Elles sont
            // invisibles, et le cycle n'a plus de quoi se relancer ; un vrai
            // redimensionnement, lui, dépasse toujours ce seuil. Le remède
            // appartient idéalement au calcul du rectangle côté front, mais un
            // consommateur qui amortit reste une protection légitime.
            // Un seuil seul ne suffisait pas : l'oscillation résiduelle
            // atteignait 3 px en hauteur et 5 px en largeur (18/09), donc elle
            // le franchissait. L'élargir aurait fini par ignorer de vrais
            // redimensionnements.
            //
            // On reconnaît donc le cycle lui-même : un rectangle qui revient
            // EXACTEMENT à l'avant-dernier est un aller-retour, pas un
            // mouvement. Le plafond garde la porte ouverte aux vraies
            // variations — un redimensionnement de fenêtre dépasse toujours
            // largement quelques pixels.
            //
            // Le remède de fond appartient au calcul du rectangle côté front,
            // qui dérive d'une taille rendue dépendant elle-même de ce
            // rectangle ; amortir au point de consommation reste une
            // protection légitime en attendant.
            const SEUIL: i32 = 2;
            const AMPLITUDE_CYCLE: i32 = 16;
            let candidat = (x, y, width, height);
            let ecart = |a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)| {
                (a.0 - b.0)
                    .abs()
                    .max((a.1 - b.1).abs())
                    .max((a.2 - b.2).abs())
                    .max((a.3 - b.3).abs())
            };
            {
                let mut derniers = derniers_rects()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner());
                if let Some((dernier, precedent)) = derniers.get(&window.hwnd).copied() {
                    let immobile = ecart(dernier, candidat) <= SEUIL;
                    let cycle = precedent == Some(candidat)
                        && ecart(dernier, candidat) <= AMPLITUDE_CYCLE;
                    if immobile || cycle {
                        // La fenêtre reste où elle est : les trous se posent
                        // par rapport à elle, pas au rectangle demandé, sinon
                        // ils mordraient à côté du menu de l'écart amorti.
                        drop(derniers);
                        appliquer_trous(
                            window,
                            &surface.holes,
                            scale,
                            (x - dernier.0, y - dernier.1),
                        );
                        continue;
                    }
                    log::info!(
                        "[Sion][partage-natif/windows] surface déplacée en {x},{y} {width}x{height} (avant {dernier:?})"
                    );
                    derniers.insert(window.hwnd, (candidat, Some(dernier)));
                } else {
                    log::info!(
                        "[Sion][partage-natif/windows] surface placée en {x},{y} {width}x{height}"
                    );
                    derniers.insert(window.hwnd, (candidat, None));
                }
            }
            appliquer_trous(window, &surface.holes, scale, (0, 0));
            let _ = unsafe {
                SetWindowPos(
                    HWND(window.hwnd as _),
                    HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
                )
            };
        }
        drop(current);
        SURFACE_DISPATCH_QUEUED.store(false, Ordering::Release);
        if pending_surfaces()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
            && !SURFACE_DISPATCH_QUEUED.swap(true, Ordering::AcqRel)
        {
            if let Some(app) = APP.get() {
                let _ = app.run_on_main_thread(apply_pending_surfaces);
            }
        }
    }

    unsafe extern "system" fn surface_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCCREATE => {
                let create = &*(lparam.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                return LRESULT(1);
            }
            // Clic : publié comme onde chez le partageur. Le calque DOM s'en
            // chargeait ; notre fenêtre recouvre le canvas et capte désormais
            // ces clics, donc c'est à nous de les transmettre (18/09).
            WM_LBUTTONDOWN => {
                publier_clic(hwnd, lparam);
                return LRESULT(0);
            }
            // `HTTRANSPARENT` était renvoyé ici pour laisser la souris
            // atteindre la WebView2. Cela n'a jamais fonctionné — le DOM ne
            // recevait aucun `mousemove` et flammemob n'émettait plus sa
            // position (`curseurs tx 0/s`, 18/09) — et cela nous privait des
            // messages souris. On les accepte donc, et on relaie la position.
            // `WM_MOUSEMOVE` était traité ici. Windows FUSIONNE ces messages :
            // il n'en poste un nouveau que lorsque l'application vide sa file.
            // Ce fil peignant 27 images par seconde, la souris se retrouvait
            // cadencée par la peinture — 13 positions par seconde au lieu de 60
            // (18/09). Elle est désormais échantillonnée par un fil dédié.
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                paint(hwnd);
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                liberer_tampon(hwnd);
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    /// Tampon hors écran conservé par fenêtre : (DC, bitmap, largeur, hauteur).
    /// Les poignées GDI ne traversent pas les fils ; elles ne sont utilisées
    /// que depuis le fil d'interface, seul à peindre. On les range en `isize`
    /// pour pouvoir les garder dans un statique.
    fn tampons() -> &'static Mutex<HashMap<isize, (isize, isize, i32, i32)>> {
        static TAMPONS: OnceLock<Mutex<HashMap<isize, (isize, isize, i32, i32)>>> = OnceLock::new();
        TAMPONS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Rend le tampon de cette fenêtre, en le recréant si la taille a changé.
    /// `None` en second membre = création impossible : l'appelant peint alors
    /// directement à l'écran, quitte à scintiller, plutôt que de ne rien
    /// afficher.
    unsafe fn tampon_de(
        hdc_ecran: windows::Win32::Graphics::Gdi::HDC,
        hwnd: HWND,
        width: i32,
        height: i32,
    ) -> (
        windows::Win32::Graphics::Gdi::HDC,
        Option<windows::Win32::Graphics::Gdi::HBITMAP>,
    ) {
        use windows::Win32::Graphics::Gdi::{HBITMAP, HDC};
        let mut tampons = tampons().lock().unwrap_or_else(|err| err.into_inner());
        let cle = hwnd.0 as isize;
        if let Some(&(dc, bmp, w, h)) = tampons.get(&cle) {
            if w == width && h == height {
                return (HDC(dc as *mut _), Some(HBITMAP(bmp as *mut _)));
            }
            // Taille changée : on jette l'ancien avant d'en refaire un.
            let _ = DeleteDC(HDC(dc as *mut _));
            let _ = DeleteObject(HBITMAP(bmp as *mut _));
            tampons.remove(&cle);
        }
        let memoire = CreateCompatibleDC(hdc_ecran);
        if memoire.is_invalid() {
            return (hdc_ecran, None);
        }
        let bitmap = CreateCompatibleBitmap(hdc_ecran, width, height);
        if bitmap.is_invalid() {
            let _ = DeleteDC(memoire);
            return (hdc_ecran, None);
        }
        // Le bitmap reste sélectionné dans le DC pour toute sa vie : c'est ce
        // qui permet de ne plus rien allouer aux peintures suivantes.
        SelectObject(memoire, bitmap);
        tampons.insert(
            cle,
            (memoire.0 as isize, bitmap.0 as isize, width, height),
        );
        (memoire, Some(bitmap))
    }

    /// Libère le tampon d'une fenêtre détruite. Sans cela, chaque partage
    /// affiché puis refermé laisserait derrière lui un DC et un bitmap.
    unsafe fn liberer_tampon(hwnd: HWND) {
        use windows::Win32::Graphics::Gdi::{HBITMAP, HDC};
        if let Some((dc, bmp, _, _)) = tampons()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&(hwnd.0 as isize))
        {
            let _ = DeleteDC(HDC(dc as *mut _));
            let _ = DeleteObject(HBITMAP(bmp as *mut _));
        }
        rects_video()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&(hwnd.0 as isize));
        // L'amortisseur de rectangle d'affichage est lui aussi indexé par
        // fenêtre. Sans cette purge, il gardait une entrée par partage fermé —
        // et surtout, Windows recyclant les poignées, une fenêtre neuve
        // pouvait hériter du rectangle d'une défunte.
        derniers_dest()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&(hwnd.0 as isize));
    }

    /// Dernier rectangle d'affichage et zone cliente associée, par fenêtre.
    /// Sert à amortir le battement de résolution de l'émetteur sans figer les
    /// vrais redimensionnements.
    #[allow(clippy::type_complexity)]
    fn derniers_dest() -> &'static Mutex<HashMap<isize, (i32, i32, i32, i32, i32, i32)>> {
        static DESTS: OnceLock<Mutex<HashMap<isize, (i32, i32, i32, i32, i32, i32)>>> =
            OnceLock::new();
        DESTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Rectangle vidéo par fenêtre, renseigné à la peinture.
    fn rects_video() -> &'static Mutex<HashMap<isize, (i32, i32, i32, i32)>> {
        static RECTS: OnceLock<Mutex<HashMap<isize, (i32, i32, i32, i32)>>> = OnceLock::new();
        RECTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Relaie la position du pointeur au front.
    ///
    /// La surface native recouvre la WebView2, et c'est le DOM qui capte la
    /// souris pour diffuser le curseur aux autres participants. Tant que la
    /// fenêtre interceptait ces messages sans rien en faire, flammemob
    /// n'émettait plus rien (`curseurs tx 0/s`, 18/09) et sa flèche colorée
    /// n'apparaissait chez personne. Les tentatives pour rendre la fenêtre
    /// traversante ont échoué : `HTTRANSPARENT` ne délivrait rien au DOM, et
    /// `WS_EX_TRANSPARENT` noircissait la surface. On prend donc le chemin
    /// inverse — la fenêtre reçoit la souris et transmet la position, que le
    /// front diffuse comme il le faisait depuis le canvas.
    ///
    /// Les coordonnées sont normalisées sur l'image, pas sur la fenêtre : les
    /// bandes noires du letterbox n'en font pas partie.
    /// Transmet un clic, normalisé sur l'image comme les positions.
    unsafe fn publier_clic(hwnd: HWND, lparam: LPARAM) {
        let brut = lparam.0 as u32;
        let px = (brut & 0xFFFF) as i16 as i32;
        let py = ((brut >> 16) & 0xFFFF) as i16 as i32;
        let Some((dx, dy, dw, dh)) = rects_video()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(&(hwnd.0 as isize))
            .copied()
        else {
            return;
        };
        if dw <= 0 || dh <= 0 {
            return;
        }
        let x = (px - dx) as f32 / dw as f32;
        let y = (py - dy) as f32 / dh as f32;
        if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
            return;
        }
        let context = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowContext;
        if context.is_null() {
            return;
        }
        let sender = (*context).sender.clone();
        if let Some(app) = APP.get() {
            #[cfg(feature = "native-voice")]
            crate::voice_native::publier_clic_local(app, &sender, x, y);
            #[cfg(not(feature = "native-voice"))]
            let _ = (app, &sender);
        }
    }

    fn demarrer_echantillonnage_pointeur() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::ScreenToClient;
        use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, WindowFromPoint};

        static DEMARRE: AtomicBool = AtomicBool::new(false);
        if DEMARRE.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("sion-surface-pointeur".into())
            .spawn(|| loop {
                // Au repos — aucun partage affiché — on se contente d'un
                // réveil paresseux : ce fil ne doit rien coûter hors partage.
                let fenetres: Vec<(isize, String)> = windows()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .values()
                    .map(|f| (f.hwnd, f.sender.clone()))
                    .collect();
                if fenetres.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
                std::thread::sleep(std::time::Duration::from_millis(16));

                let mut point = POINT::default();
                if unsafe { GetCursorPos(&mut point) }.is_err() {
                    continue;
                }
                // La fenêtre RÉELLEMENT sous le pointeur.
                //
                // On interroge la position globale de la souris : sans cette
                // vérification, un partageur dont Sion est masqué par une autre
                // fenêtre voyait quand même son curseur diffusé dès qu'il
                // survolait la zone où Sion se trouve EN DESSOUS (18/09).
                // L'ancien chemin par le DOM ne pouvait pas avoir ce défaut,
                // puisqu'il n'était notifié que d'un survol réel.
                let dessus = unsafe { WindowFromPoint(point) };
                for (brut, sender) in fenetres {
                    let hwnd = HWND(brut as *mut _);
                    if dessus != hwnd {
                        continue;
                    }
                    let mut local = point;
                    if !unsafe { ScreenToClient(hwnd, &mut local) }.as_bool() {
                        continue;
                    }
                    let Some((dx, dy, dw, dh)) = rects_video()
                        .lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .get(&brut)
                        .copied()
                    else {
                        continue;
                    };
                    if dw <= 0 || dh <= 0 {
                        continue;
                    }
                    let x = (local.x - dx) as f32 / dw as f32;
                    let y = (local.y - dy) as f32 / dh as f32;
                    // Hors de l'image : rien à publier. La flèche s'efface
                    // d'elle-même par expiration chez les autres.
                    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                        continue;
                    }
                    if let Some(app) = APP.get() {
                        #[cfg(feature = "native-voice")]
                        crate::voice_native::publier_curseur_local(app, &sender, x, y);
                        #[cfg(not(feature = "native-voice"))]
                        let _ = (app, &sender);
                    }
                    break;
                }
            });
    }

    /// Compteur de peintures, pour n'en tracer qu'une sur 120.
    static PEINTURES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    unsafe fn paint(hwnd: HWND) {
        let mut paint = PAINTSTRUCT::default();
        let hdc_ecran = BeginPaint(hwnd, &mut paint);
        let mut client = windows::Win32::Foundation::RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        let width = (client.right - client.left).max(1);
        let height = (client.bottom - client.top).max(1);

        // Double tampon.
        //
        // La peinture se faisait directement sur le DC de l'écran : remplissage
        // noir de toute la zone, PUIS dessin de l'image par-dessus. Entre les
        // deux, l'écran affichait du noir — d'où le scintillement constaté dès
        // que la surface native a enfin été visible (17/09). On compose donc
        // hors écran et on dépose le résultat en un seul `BitBlt` : l'écran ne
        // voit jamais l'état intermédiaire.
        //
        // Si la création du tampon échoue (ressources GDI épuisées), on peint
        // directement comme avant : scintillant, mais visible.
        // Le tampon est CONSERVÉ entre deux peintures, et refait seulement
        // quand la taille change.
        //
        // Il était alloué puis détruit à chaque image : un bitmap de trois
        // méga-octets, vingt-cinq fois par seconde, sur le fil qui traite
        // aussi les messages souris. Ce fil n'en délivrait plus que quatre par
        // seconde et le curseur des viewers traînait très visiblement (18/09).
        let (memoire, bitmap) = tampon_de(hdc_ecran, hwnd, width, height);
        let hdc = if bitmap.is_some() { memoire } else { hdc_ecran };
        let _ = PatBlt(hdc, 0, 0, width, height, BLACKNESS);

        let context = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowContext;
        // Compte-rendu de peinture, une fois sur 120 (~5 s à 25 im/s).
        //
        // La surface native de Windows reste optionnelle à cause d'un écran
        // noir jamais expliqué. `paint` noircit puis dessine l'image SI elle
        // existe : de l'extérieur, « aucune image pour cet expéditeur » et
        // « image dessinée mais fenêtre invisible » donnent le même écran noir.
        // Cette trace les sépare — sans elle, on en est réduit aux hypothèses.
        PEINTURES.fetch_add(1, Ordering::Relaxed);
        let tracer = PEINTURES.load(Ordering::Relaxed) % 120 == 1;
        if context.is_null() {
            if tracer {
                log::warn!("[Sion][partage-natif] peinture sans contexte (fenêtre orpheline)");
            }
        }
        if !context.is_null() {
            let frame = frames()
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .get(&(*context).sender)
                .cloned();
            if tracer {
                match &frame {
                    Some(f) => log::info!(
                        "[Sion][partage-natif] peinture {}x{} dans une zone cliente {width}x{height} (expéditeur {})",
                        f.width,
                        f.height,
                        (*context).sender
                    ),
                    None => log::warn!(
                        "[Sion][partage-natif] peinture SANS image pour {} — écran noir",
                        (*context).sender
                    ),
                }
            }
            if let Some(frame) = frame {
                let client_width = width;
                let client_height = height;
                let scale = (client_width as f64 / frame.width as f64)
                    .min(client_height as f64 / frame.height as f64);
                let dest_width = (frame.width as f64 * scale).round().max(1.0) as i32;
                let dest_height = (frame.height as f64 * scale).round().max(1.0) as i32;
                let mut dest_width = dest_width;
                let mut dest_height = dest_height;
                // Amortissement du rectangle d'affichage.
                //
                // L'émetteur fait varier sa résolution source de quelques
                // pixels — encodage adaptatif — et notre mise à l'échelle suit
                // fidèlement : l'image peinte alternait entre 880x496 et
                // 880x494 dans une zone cliente pourtant figée, et « vibrait »
                // (18/09, partage de narkow). La fenêtre n'y était pour rien,
                // elle n'avait pas bougé depuis deux minutes.
                //
                // On garde donc le rectangle précédent tant que le nouveau ne
                // s'en écarte pas de plus de deux pixels. Un vrai changement de
                // résolution dépasse toujours ce seuil.
                // Seuil de 8 px, et seulement à zone cliente INCHANGÉE.
                //
                // Un seuil de 2 ne mordait pas : la frame alternant entre 494 et
                // 496 de haut, le rectangle d'affichage bougeait de 3 px — juste
                // au-dessus. Le conditionner à une zone cliente identique permet
                // d'élargir le seuil sans rendre les redimensionnements
                // approximatifs : dès que la fenêtre change de taille, le
                // rectangle est recalculé exactement.
                if let Some((_, _, pw, ph, pcw, pch)) = derniers_dest()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .get(&(hwnd.0 as isize))
                    .copied()
                {
                    if pcw == client_width
                        && pch == client_height
                        && (pw - dest_width).abs() <= 8
                        && (ph - dest_height).abs() <= 8
                    {
                        dest_width = pw;
                        dest_height = ph;
                    }
                }
                derniers_dest()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .insert(
                        hwnd.0 as isize,
                        (0, 0, dest_width, dest_height, client_width, client_height),
                    );
                if tracer {
                    log::info!(
                        "[Sion][partage-natif] rendu {dest_width}x{dest_height} (amorti) pour une frame {}x{}",
                        frame.width,
                        frame.height
                    );
                }
                let dest_x = (client_width - dest_width) / 2;
                let dest_y = (client_height - dest_height) / 2;
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: frame.width as i32,
                        // Hauteur négative : la frame BGRA est top-down.
                        biHeight: -(frame.height as i32),
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        biSizeImage: frame.bgra.len() as u32,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                // Rectangle réellement occupé par l'image, letterbox comprise.
                // Le relais de la souris en a besoin pour normaliser la
                // position : sans lui, le curseur transmis serait décalé de
                // toute la bande noire.
                rects_video()
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .insert(hwnd.0 as isize, (dest_x, dest_y, dest_width, dest_height));
                // `HALFTONE` rééchantillonne en haute qualité sur le
                // processeur, et c'est le mode le plus lent. Il ne sert à rien
                // ici : la pompe a déjà mis l'image à la taille visée avec
                // libyuv, donc `StretchDIBits` ne fait pratiquement plus de
                // mise à l'échelle. Ce coût était payé vingt-cinq fois par
                // seconde sur le fil qui délivre aussi la souris.
                let _ = SetStretchBltMode(hdc, COLORONCOLOR);
                StretchDIBits(
                    hdc,
                    dest_x,
                    dest_y,
                    dest_width,
                    dest_height,
                    0,
                    0,
                    frame.width as i32,
                    frame.height as i32,
                    Some(frame.bgra.as_ptr().cast()),
                    &info,
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
                // Les curseurs se posent SUR l'image, dans le même tampon :
                // une seule composition, donc aucun scintillement entre la
                // vidéo et les flèches.
                peindre_curseurs(hdc, &(*context).sender, dest_x, dest_y, dest_width, dest_height);
            }
        }
        if bitmap.is_some() {
            let _ = BitBlt(hdc_ecran, 0, 0, width, height, hdc, 0, 0, SRCCOPY);
        }
        EndPaint(hwnd, &paint);
    }

    pub fn on_frame(
        sender: String,
        width: u32,
        height: u32,
        bgra: Vec<u8>,
    ) -> Option<Vec<u8>> {
        if !available()
            || width == 0
            || height == 0
            || bgra.len() != width as usize * height as usize * 4
            || bgra.len() > MAX_FRAME_BYTES
        {
            return Some(bgra);
        }
        let previous = frames()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
                sender.clone(),
                Arc::new(Frame {
                    width,
                    height,
                    bgra,
                }),
            );
        // Le GDI peut encore tenir une référence sur l'image remplacée (peinture
        // en cours) ; elle n'est recyclable que si nous en sommes le dernier
        // porteur.
        let (size_changed, recycled) = match previous {
            Some(previous) => {
                let changed = previous.width != width || previous.height != height;
                (changed, Arc::into_inner(previous).map(|frame| frame.bgra))
            }
            None => (true, None),
        };
        if size_changed {
            if let Some(app) = APP.get() {
                let _ = app.emit(
                    "voice-native-frame-size",
                    serde_json::json!({ "sender": &sender, "width": width, "height": height }),
                );
            }
        }
        let hwnds = windows()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .filter(|window| window.sender == sender)
            .map(|window| window.hwnd)
            .collect::<Vec<_>>();
        for hwnd in hwnds {
            unsafe {
                let _ = InvalidateRect(HWND(hwnd as _), None, BOOL(0));
            }
        }
        recycled
    }

    pub fn remove(sender: &str) {
        frames()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(sender);
    }

    pub fn attach(
        app: &tauri::AppHandle<crate::TauriRuntime>,
        parent: isize,
        scale_factor: f64,
    ) -> Result<(), String> {
        if parent == 0 {
            return Err("HWND principal nul".into());
        }
        register_window_class()?;
        let _ = APP.set(app.clone());
        PARENT.store(parent, Ordering::Release);
        SCALE_BITS.store(scale_factor.max(0.5).to_bits(), Ordering::Release);
        AVAILABLE.store(true, Ordering::Release);
        clipper_les_soeurs(HWND(parent as _));
        demarrer_echantillonnage_pointeur();
        log::info!(
            "[Sion][partage-natif/windows] surfaces HWND prêtes (échelle {:.2})",
            scale_factor
        );
        Ok(())
    }

    /// Fait respecter notre fenêtre par ses sœurs.
    ///
    /// La surface vidéo native peignait bien — trace « peinture 1648x464 dans
    /// une zone cliente 1654x466 » à l'appui — et restait pourtant invisible
    /// (17/09) : la fenêtre de la WebView2 est une SŒUR de la nôtre, et sans le
    /// style `WS_CLIPSIBLINGS` elle repeint toute sa surface, la nôtre
    /// comprise, quel que soit notre rang dans la pile. `HWND_TOP` ne protège
    /// de rien tant que la sœur ne s'interdit pas d'empiéter.
    ///
    /// On ajoute donc le style à chaque enfant du toplevel. Il est sans effet
    /// pour celles qui ne chevauchent personne, et la classe de la fenêtre est
    /// journalisée : si la WebView2 n'y figurait pas, l'hypothèse tomberait et
    /// il faudrait chercher du côté de la composition DirectComposition.
    fn clipper_les_soeurs(parent: HWND) {
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumChildWindows, GetClassNameW, GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        };

        unsafe extern "system" fn visiter(hwnd: HWND, _param: LPARAM) -> BOOL {
            let mut classe = [0u16; 128];
            let n = GetClassNameW(hwnd, &mut classe);
            let nom = String::from_utf16_lossy(&classe[..n.max(0) as usize]);
            // Ne pas se clipper soi-même : nos propres surfaces l'ont déjà.
            if nom == "SION_NATIVE_VIDEO_SURFACE" {
                return BOOL(1);
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let deja = style & WS_CLIPSIBLINGS.0 as isize != 0;
            if !deja {
                SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_CLIPSIBLINGS.0 as isize);
                let _ = SetWindowPos(
                    hwnd,
                    HWND(std::ptr::null_mut()),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
            log::info!(
                "[Sion][partage-natif/windows] sœur « {nom} » : WS_CLIPSIBLINGS {}",
                if deja { "déjà posé" } else { "ajouté" }
            );
            BOOL(1)
        }

        unsafe {
            let _ = EnumChildWindows(parent, Some(visiter), LPARAM(0));
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod imp {
    use super::NativeVideoSurfaceSpec;

    /// Le chemin planaire est propre au renderer EGL de Wayland. Ici la
    /// présentation passe par le repli BGRA : la pompe doit continuer à convertir côté CPU.
    pub fn accepts_planar(_sender: &str) -> bool {
        false
    }

    /// Inaccessible en pratique — `prefers_planar()` répond `false` au-dessus.
    /// Le plan est relâché sans être peint plutôt que d'être converti ici, ce
    /// qui masquerait une régression du côté appelant.
    pub fn on_planar_frame(_sender: String, _frame: Box<dyn super::PlanarFrame>) {}

    pub fn available() -> bool {
        false
    }

    pub fn set_surfaces(_surfaces: Vec<NativeVideoSurfaceSpec>) -> bool {
        false
    }

    pub fn preferred_frame_bounds(_sender: &str) -> Option<(u32, u32)> {
        None
    }

    pub fn on_frame(
        _sender: String,
        _width: u32,
        _height: u32,
        bgra: Vec<u8>,
    ) -> Option<Vec<u8>> {
        Some(bgra)
    }

    pub fn remove(_sender: &str) {}

    pub fn viewer_targets() -> Option<std::collections::HashSet<String>> {
        None
    }

    pub fn on_viewer_cursor_packet(
        _target: &str,
        _identity: &str,
        _name: &str,
        _click: bool,
        _x: f32,
        _y: f32,
        _expire: bool,
    ) {
    }
}
