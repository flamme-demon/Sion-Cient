//! Hôte Wayland natif de l'overlay curseurs — `zwlr_layer_shell_v1` + `wl_shm`.
//!
//! **Pourquoi un troisième hôte.** L'hôte X11 pose `_NET_WM_STATE_ABOVE`,
//! `_NET_WM_STATE_STICKY` et `_NET_WM_DESKTOP = 0xFFFFFFFF`. Sous KDE/Wayland
//! ces hints sont corrects et sans effet : KWin gère ses bureaux virtuels
//! nativement et ne les expose pas à XWayland, où `_NET_NUMBER_OF_DESKTOPS`
//! vaut 1 — mesuré le 17/09. On demande donc « tous les bureaux » à une couche
//! qui n'en connaît qu'un, et l'overlay reste sur le bureau où il est né.
//!
//! Une surface `layer_shell` n'est pas une fenêtre de bureau : elle vit dans
//! une couche du compositeur, au-dessus des fenêtres et indépendamment des
//! bureaux virtuels. C'est le mécanisme prévu pour les barres, notifications et
//! overlays.
//!
//! **Ce que ça supprime au passage.** Plus de bagarre autour de
//! `_NET_WM_STATE_ABOVE`, que KWin réécrivait à la prise en gestion et qu'il
//! fallait réaffirmer à chaque `MapNotify` et `ConfigureNotify` ; plus de
//! maximisation imposée par le gestionnaire de fenêtres ; et la traversée des
//! clics passe par `wl_surface.set_input_region`, natif, au lieu de l'extension
//! SHAPE de X11.
//!
//! **Ce que ça ne change pas.** Toute la peinture vient du module parent
//! (`super::draw`), exactement comme les deux autres hôtes : celui-ci ne fait
//! que la surface et le blit.
//!
//! L'hôte X11 reste le repli — sessions X11 pures, ou compositeur sans
//! `zwlr_layer_shell_v1`.

use std::io::{Seek, SeekFrom, Write};
use std::os::fd::AsFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tiny_skia::Pixmap;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{
    wl_buffer::WlBuffer,
    wl_compositor::WlCompositor,
    wl_output::{self, WlOutput},
    wl_registry::WlRegistry,
    wl_shm::{Format, WlShm},
    wl_shm_pool::WlShmPool,
    wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, QueueHandle, WEnum};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1::{Layer, ZwlrLayerShellV1},
    zwlr_layer_surface_v1::{Anchor, Event as LayerEvent, ZwlrLayerSurfaceV1},
};

use super::{GeometrieEcran, OverlayState, UserEvent};

/// Cadence d'animation des ondes de clic, identique aux autres hôtes.
const ANIMATE_STEP: Duration = Duration::from_millis(33);
/// Plafond d'attente : on doit aussi relever les évènements Wayland.
const POLL_CAP: Duration = Duration::from_millis(100);

/// Démarre le fil Wayland. `None` si le compositeur n'annonce pas
/// `zwlr_layer_shell_v1` — l'appelant retombe alors sur l'hôte X11.
pub(super) fn start(
    state: Arc<Mutex<OverlayState>>,
    thread_alive: Arc<AtomicBool>,
) -> Option<Sender<UserEvent>> {
    let (tx, rx) = std::sync::mpsc::channel::<UserEvent>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();

    thread::Builder::new()
        .name("sion-cursor-overlay-wl".into())
        .spawn(move || {
            let mut host = match Host::connect() {
                Ok(h) => h,
                Err(err) => {
                    log::info!("[Sion][CursorOverlay] layer-shell indisponible ({err}) — repli X11");
                    let _ = ready_tx.send(false);
                    thread_alive.store(false, Ordering::Release);
                    return;
                }
            };
            let _ = ready_tx.send(true);
            host.run(&state, rx);
            thread_alive.store(false, Ordering::Release);
            log::info!("[Sion][CursorOverlay] fil Wayland arrêté");
        })
        .ok()?;

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(true) => Some(tx),
        _ => None,
    }
}

/// Ce que le compositeur annonce d'un écran (`wl_output`).
#[derive(Clone, Debug, Default, PartialEq)]
struct InfoEcran {
    /// Position dans l'espace du compositeur.
    x: i32,
    y: i32,
    /// Mode courant, en pixels physiques, avant rotation.
    largeur: i32,
    hauteur: i32,
    /// Écran tourné d'un quart de tour : largeur et hauteur s'échangent.
    pivote: bool,
    /// Connecteur (« DP-3 »), pour les journaux.
    nom: Option<String>,
}

impl InfoEcran {
    fn taille(&self) -> (i32, i32) {
        if self.pivote {
            (self.hauteur, self.largeur)
        } else {
            (self.largeur, self.hauteur)
        }
    }
}

/// L'écran dont la taille (et, si la capture en donne une, la position)
/// correspond à l'image capturée. `None` si aucun, ou si plusieurs écrans
/// identiques restent indiscernables : mieux vaut alors laisser le
/// compositeur choisir que viser au hasard.
///
/// La position d'une image du portail vaut en général (0, 0) — le flux ne
/// sait pas où est son écran — : elle ne départage donc que si elle n'est pas
/// nulle.
fn choisir_ecran(ecrans: &[InfoEcran], g: GeometrieEcran) -> Option<usize> {
    let proche = |a: i32, b: i32| (a - b).abs() <= 2;
    let candidats: Vec<usize> = ecrans
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            let (w, h) = e.taille();
            w > 0 && proche(w, g.largeur) && proche(h, g.hauteur)
        })
        .map(|(i, _)| i)
        .collect();
    match candidats.as_slice() {
        [] => None,
        [seul] => Some(*seul),
        plusieurs => {
            if g.x == 0 && g.y == 0 {
                return None;
            }
            let par_position: Vec<usize> =
                plusieurs.iter().copied().filter(|&i| ecrans[i].x == g.x && ecrans[i].y == g.y).collect();
            match par_position.as_slice() {
                [seul] => Some(*seul),
                _ => None,
            }
        }
    }
}

/// État partagé avec la file d'évènements Wayland.
#[derive(Default)]
struct Etat {
    /// Écrans du compositeur, dans l'ordre de `Host::sorties`.
    ecrans: Vec<InfoEcran>,
    /// Taille accordée par le compositeur, en pixels logiques.
    largeur: u32,
    hauteur: u32,
    /// Vrai dès le premier `configure` : avant, rien ne peut être présenté.
    configure: bool,
    /// Le compositeur a fermé la surface (changement d'écran, par exemple).
    ferme: bool,
    /// Tampon rendu au compositeur et pas encore relâché.
    occupe: bool,
}

struct Surfaces {
    surface: WlSurface,
    couche: ZwlrLayerSurfaceV1,
}

struct Host {
    conn: Connection,
    queue: EventQueue<Etat>,
    qh: QueueHandle<Etat>,
    compositor: WlCompositor,
    shm: WlShm,
    layer_shell: ZwlrLayerShellV1,
    /// Écrans (`wl_output`), pour poser l'overlay sur celui qui est partagé.
    sorties: Vec<WlOutput>,
    /// Géométrie partagée connue à la création de la surface : si elle
    /// change, la surface est recréée sur le bon écran.
    cible: Option<GeometrieEcran>,
    etat: Etat,
    surfaces: Option<Surfaces>,
    /// Mémoire partagée courante et sa taille, réallouée quand la surface
    /// grandit. Conservée entre les frames : recréer un pool par image
    /// coûterait un `mmap` à chaque fois.
    pool: Option<(WlShmPool, std::fs::File, usize)>,
    buffer: Option<WlBuffer>,
    pixmap: Option<Pixmap>,
    /// Tampon de conversion RGBA→BGRA, conservé entre les images. Il était
    /// alloué à chaque redessin : quinze méga-octets par image pour une
    /// surface plein écran.
    octets: Vec<u8>,
    need_redraw: bool,
    redraw_at: Option<Instant>,
    /// Instant du dernier redessin, pour en limiter la cadence.
    dernier_rendu: Option<Instant>,
    /// Bande de lignes peinte au tour précédent, à effacer au suivant.
    bande_precedente: Option<(u32, u32)>,
}

impl Host {
    fn connect() -> Result<Self, String> {
        let conn = Connection::connect_to_env().map_err(|e| format!("connexion Wayland: {e}"))?;
        let (globals, mut queue) =
            registry_queue_init::<Etat>(&conn).map_err(|e| format!("registre: {e}"))?;
        let qh = queue.handle();
        let compositor: WlCompositor = globals
            .bind(&qh, 1..=6, ())
            .map_err(|e| format!("wl_compositor: {e}"))?;
        let shm: WlShm = globals.bind(&qh, 1..=1, ()).map_err(|e| format!("wl_shm: {e}"))?;
        let layer_shell: ZwlrLayerShellV1 = globals
            .bind(&qh, 1..=5, ())
            .map_err(|e| format!("zwlr_layer_shell_v1 absent: {e}"))?;
        // Tous les écrans, pour viser celui qui est partagé. Version 4 au
        // plus : elle ajoute le nom du connecteur.
        let mut sorties = Vec::new();
        for g in globals.contents().clone_list() {
            if g.interface == "wl_output" {
                let index = sorties.len() as u32;
                sorties.push(globals.registry().bind::<WlOutput, u32, Etat>(g.name, g.version.min(4), &qh, index));
            }
        }
        let mut etat = Etat::default();
        // Un aller-retour : les écrans décrivent leur géométrie et leur mode.
        let _ = queue.roundtrip(&mut etat);
        log::info!(
            "[Sion][CursorOverlay] hôte Wayland layer-shell prêt ({} écran(s) : {})",
            etat.ecrans.len(),
            etat.ecrans
                .iter()
                .map(|e| format!("{} {}x{} à {},{}", e.nom.as_deref().unwrap_or("?"), e.taille().0, e.taille().1, e.x, e.y))
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok(Self {
            conn,
            queue,
            qh,
            compositor,
            shm,
            layer_shell,
            sorties,
            cible: None,
            etat,
            surfaces: None,
            pool: None,
            buffer: None,
            pixmap: None,
            octets: Vec::new(),
            need_redraw: false,
            redraw_at: None,
            dernier_rendu: None,
            bande_precedente: None,
        })
    }

    /// Crée la surface d'overlay. Couche `Overlay` : au-dessus de tout, y
    /// compris des fenêtres en plein écran, ce que la couche `Top` ne garantit
    /// pas.
    fn show(&mut self) {
        if self.surfaces.is_some() {
            return;
        }
        let surface = self.compositor.create_surface(&self.qh, ());
        // L'écran PARTAGÉ, reconnu à la taille de l'image capturée. Faute de
        // le connaître (capture pas encore commencée, écrans identiques), le
        // compositeur choisit — en général l'écran actif.
        self.cible = super::cursor_overlay_shared_geometry();
        let choix = self.cible.and_then(|g| {
            let choix = choisir_ecran(&self.etat.ecrans, g);
            match choix {
                Some(i) => log::info!(
                    "[Sion][CursorOverlay] overlay posé sur l'écran partagé {} ({}x{})",
                    self.etat.ecrans[i].nom.as_deref().unwrap_or("?"),
                    g.largeur,
                    g.hauteur
                ),
                None => log::warn!(
                    "[Sion][CursorOverlay] écran partagé {}x{} à {},{} non reconnu parmi {:?} : le compositeur choisit",
                    g.largeur,
                    g.hauteur,
                    g.x,
                    g.y,
                    self.etat.ecrans
                ),
            }
            choix
        });
        let sortie = choix.and_then(|i| self.sorties.get(i));
        let couche = self.layer_shell.get_layer_surface(
            &surface,
            sortie,
            Layer::Overlay,
            "sion-cursor-overlay".to_string(),
            &self.qh,
            (),
        );
        // Ancré aux quatre bords = plein écran. `set_size(0, 0)` laisse alors
        // le compositeur imposer la taille de l'écran.
        couche.set_anchor(Anchor::Top | Anchor::Bottom | Anchor::Left | Anchor::Right);
        couche.set_size(0, 0);
        // -1 : ne réserve aucune place et ne pousse aucune fenêtre. Sans ça,
        // une surface plein écran rétrécirait la zone de travail.
        couche.set_exclusive_zone(-1);
        // Aucune entrée : l'overlay est traversant, le clic va à ce qu'il y a
        // dessous. Équivalent natif de la région SHAPE vide de l'hôte X11.
        let region = self.compositor.create_region(&self.qh, ());
        surface.set_input_region(Some(&region));
        region.destroy();
        surface.commit();
        self.etat.configure = false;
        self.etat.ferme = false;
        self.surfaces = Some(Surfaces { surface, couche });
        self.need_redraw = true;
        log::info!("[Sion][CursorOverlay] surface layer-shell créée (couche overlay)");
    }

    fn hide(&mut self) {
        if let Some(Surfaces { surface, couche }) = self.surfaces.take() {
            couche.destroy();
            surface.destroy();
        }
        self.buffer = None;
        self.pool = None;
        self.pixmap = None;
        self.etat.configure = false;
        self.etat.occupe = false;
        log::info!("[Sion][CursorOverlay] surface layer-shell détruite");
    }

    /// Mémoire partagée pour `wl_shm`. Un fichier de `/dev/shm` délié aussitôt
    /// créé : il ne survit pas au processus et n'a pas de nom exploitable.
    fn pool_pour(&mut self, taille: usize) -> Result<(), String> {
        if let Some((_, _, actuelle)) = &self.pool {
            if *actuelle >= taille {
                return Ok(());
            }
        }
        let chemin = format!(
            "/dev/shm/sion-overlay-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        );
        let fichier = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&chemin)
            .map_err(|e| format!("mémoire partagée: {e}"))?;
        let _ = std::fs::remove_file(&chemin);
        fichier
            .set_len(taille as u64)
            .map_err(|e| format!("taille mémoire partagée: {e}"))?;
        let pool = self
            .shm
            .create_pool(fichier.as_fd(), taille as i32, &self.qh, ());
        self.buffer = None;
        self.pool = Some((pool, fichier, taille));
        Ok(())
    }

    fn redraw(&mut self, state: &Arc<Mutex<OverlayState>>) {
        if !self.etat.configure || self.etat.ferme {
            return;
        }
        let (w, h) = (self.etat.largeur.max(1), self.etat.hauteur.max(1));
        let taille = w as usize * h as usize * 4;
        if self.pixmap.as_ref().map(|p| (p.width(), p.height())) != Some((w, h)) {
            self.pixmap = Pixmap::new(w, h);
            self.buffer = None;
        }
        let Some(pixmap) = self.pixmap.as_mut() else {
            return;
        };
        let now = Instant::now();
        let (anime, prochain, zone) = {
            let mut s = match state.lock() {
                Ok(s) => s,
                Err(poisoned) => poisoned.into_inner(),
            };
            s.cursors.retain(|_, c| c.expires_at > now);
            s.clicks.retain(|c| c.expires_at > now);
            // Bande utile : les lignes où se trouve réellement quelque chose.
            //
            // Tout l'écran était effacé, converti puis réécrit à chaque image —
            // quinze méga-octets pour une flèche de vingt pixels. On ne touche
            // plus qu'aux lignes concernées, réunies avec celles du tour
            // précédent pour effacer la trace laissée par un curseur qui a
            // bougé. La marge couvre le pseudo et l'onde de clic.
            const MARGE: f32 = 180.0;
            let mut haut = f32::INFINITY;
            let mut bas = f32::NEG_INFINITY;
            for c in s.cursors.values() {
                let cy = c.y.clamp(0.0, 1.0) * h as f32;
                haut = haut.min(cy - MARGE);
                bas = bas.max(cy + MARGE);
            }
            for c in &s.clicks {
                let cy = c.y.clamp(0.0, 1.0) * h as f32;
                haut = haut.min(cy - MARGE);
                bas = bas.max(cy + MARGE);
            }
            let bande = if haut.is_finite() {
                Some((
                    haut.max(0.0) as u32,
                    (bas.max(0.0) as u32 + 1).min(h),
                ))
            } else {
                None
            };
            // Réunion avec la bande précédente : sans elle, la flèche resterait
            // peinte à son ancienne place.
            let a_nettoyer = match (bande, self.bande_precedente) {
                (Some((a, b)), Some((c, d))) => Some((a.min(c), b.max(d))),
                (Some(v), None) | (None, Some(v)) => Some(v),
                (None, None) => None,
            };
            if let Some((y0, y1)) = a_nettoyer {
                let ligne = w as usize * 4;
                let debut = y0 as usize * ligne;
                let fin = (y1 as usize * ligne).min(pixmap.data().len());
                if debut < fin {
                    pixmap.data_mut()[debut..fin].fill(0);
                }
            }
            self.bande_precedente = bande;
            super::draw::draw(pixmap, w as f32, h as f32, &s, now);
            let zone = a_nettoyer;
            let mut prochain: Option<Instant> = None;
            for c in s.cursors.values() {
                prochain = Some(prochain.map_or(c.expires_at, |t: Instant| t.min(c.expires_at)));
            }
            for c in &s.clicks {
                prochain = Some(prochain.map_or(c.expires_at, |t: Instant| t.min(c.expires_at)));
            }
            (!s.clicks.is_empty(), prochain, zone)
        };

        if let Err(err) = self.pool_pour(taille) {
            log::warn!("[Sion][CursorOverlay] {err}");
            return;
        }
        // `wl_shm` ARGB8888 est du BGRA prémultiplié en little-endian, tandis
        // que tiny-skia rend du RGBA prémultiplié : seuls les canaux R et B
        // sont à échanger, l'alpha est déjà correct.
        let Some((pool, fichier, _)) = self.pool.as_mut() else {
            return;
        };
        // Conversion RGBA→BGRA dans un tampon RÉUTILISÉ.
        //
        // Il était alloué à chaque image — quinze méga-octets pour un écran
        // 2560x1440 — et rempli par un `extend_from_slice` de quatre octets par
        // pixel, soit 3,7 millions d'appels. Tant que les curseurs distants
        // n'arrivaient qu'à 4 par seconde, ce coût passait inaperçu ; à 41 par
        // seconde il écroulait l'overlay et le curseur traînait visiblement
        // (18/09). On écrit désormais en place, dans un tampon gardé d'une
        // image à l'autre.
        if self.octets.len() != taille {
            self.octets.resize(taille, 0);
        }
        // Conversion et écriture limitées à la bande utile. Rien à peindre =
        // rien à écrire : l'écran reste tel quel.
        let ligne = w as usize * 4;
        let (y0, y1) = match zone {
            Some(v) => v,
            None => {
                self.need_redraw = false;
                self.redraw_at = prochain;
                return;
            }
        };
        let debut = y0 as usize * ligne;
        let fin = (y1 as usize * ligne).min(taille);
        if debut >= fin {
            self.need_redraw = false;
            self.redraw_at = prochain;
            return;
        }
        let source = self.pixmap.as_ref().unwrap().data();
        for (dst, px) in self.octets[debut..fin]
            .chunks_exact_mut(4)
            .zip(source[debut..fin].chunks_exact(4))
        {
            dst[0] = px[2];
            dst[1] = px[1];
            dst[2] = px[0];
            dst[3] = px[3];
        }
        if fichier.seek(SeekFrom::Start(debut as u64)).is_err()
            || fichier.write_all(&self.octets[debut..fin]).is_err()
        {
            log::warn!("[Sion][CursorOverlay] écriture du tampon partagé impossible");
            return;
        }
        if self.buffer.is_none() {
            self.buffer = Some(pool.create_buffer(
                0,
                w as i32,
                h as i32,
                (w * 4) as i32,
                Format::Argb8888,
                &self.qh,
                (),
            ));
        }
        let Some(Surfaces { surface, .. }) = self.surfaces.as_ref() else {
            return;
        };
        if let Some(buffer) = self.buffer.as_ref() {
            surface.attach(Some(buffer), 0, 0);
            surface.damage_buffer(0, y0 as i32, w as i32, (y1 - y0) as i32);
            surface.commit();
            self.etat.occupe = true;
        }

        self.need_redraw = false;
        self.redraw_at = if anime {
            Some(now + ANIMATE_STEP)
        } else {
            prochain
        };
    }

    fn run(&mut self, state: &Arc<Mutex<OverlayState>>, rx: Receiver<UserEvent>) {
        loop {
            // 1) Vider la file Wayland sans bloquer : configure, release,
            //    fermeture.
            if self.queue.roundtrip(&mut self.etat).is_err() {
                log::warn!("[Sion][CursorOverlay] connexion Wayland perdue");
                return;
            }
            if self.etat.ferme {
                // Le compositeur a retiré la surface : on la recrée au prochain
                // `Show` plutôt que d'insister.
                self.hide();
                self.etat.ferme = false;
            }
            // L'écran partagé vient d'être connu (première image), ou a
            // changé : la surface est recréée dessus.
            if self.surfaces.is_some() && super::cursor_overlay_shared_geometry() != self.cible {
                self.hide();
                self.show();
                self.need_redraw = true;
            }

            // 2) Peindre si nécessaire.
            // Un redessin au plus toutes les 33 ms.
            //
            // Chaque position reçue en demandait un, et une surface plein écran
            // coûte plusieurs méga-octets à rastériser puis à recopier. À 41
            // positions par seconde, l'overlay n'arrivait plus à suivre et le
            // curseur traînait (18/09). Trente images par seconde suffisent
            // amplement à un pointeur, et les positions intermédiaires ne sont
            // pas perdues : elles sont déjà dans l'état partagé, le prochain
            // redessin les peindra.
            const PERIODE_MIN: Duration = Duration::from_millis(33);
            let maintenant = Instant::now();
            let du = self.need_redraw || self.redraw_at.is_some_and(|t| maintenant >= t);
            if du && self.surfaces.is_some() {
                let assez_tot = self
                    .dernier_rendu
                    .is_none_or(|t| maintenant.duration_since(t) >= PERIODE_MIN);
                if assez_tot {
                    self.dernier_rendu = Some(maintenant);
                    self.redraw(state);
                } else if self.redraw_at.is_none() {
                    // Trop tôt : on se recale sur la prochaine échéance plutôt
                    // que de perdre la demande.
                    self.redraw_at = self.dernier_rendu.map(|t| t + PERIODE_MIN);
                }
            }

            // 3) Attendre une commande, ou l'échéance du prochain rendu.
            let attente = self
                .redraw_at
                .map(|t| t.saturating_duration_since(Instant::now()).min(POLL_CAP))
                .unwrap_or(POLL_CAP);
            match rx.recv_timeout(attente) {
                Ok(UserEvent::Show) => {
                    self.show();
                    self.need_redraw = true;
                }
                Ok(UserEvent::Hide) => self.hide(),
                Ok(UserEvent::Shutdown) => {
                    self.hide();
                    let _ = self.conn.flush();
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.hide();
                    return;
                }
            }
        }
    }
}

impl Dispatch<ZwlrLayerSurfaceV1, ()> for Etat {
    fn event(
        etat: &mut Self,
        couche: &ZwlrLayerSurfaceV1,
        event: LayerEvent,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            LayerEvent::Configure {
                serial,
                width,
                height,
            } => {
                // L'acquittement est obligatoire : sans lui le compositeur ne
                // présentera jamais la surface.
                couche.ack_configure(serial);
                etat.largeur = width.max(1);
                etat.hauteur = height.max(1);
                etat.configure = true;
            }
            LayerEvent::Closed => etat.ferme = true,
            _ => {}
        }
    }
}

impl Dispatch<WlBuffer, ()> for Etat {
    fn event(
        etat: &mut Self,
        _: &WlBuffer,
        event: wayland_client::protocol::wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if matches!(event, wayland_client::protocol::wl_buffer::Event::Release) {
            etat.occupe = false;
        }
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for Etat {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Les globales sont figées à l'initialisation : rien à suivre ensuite.
    }
}

impl Dispatch<WlOutput, u32> for Etat {
    fn event(
        etat: &mut Self,
        _: &WlOutput,
        event: wl_output::Event,
        index: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let i = *index as usize;
        if etat.ecrans.len() <= i {
            etat.ecrans.resize_with(i + 1, InfoEcran::default);
        }
        let ecran = &mut etat.ecrans[i];
        match event {
            wl_output::Event::Geometry { x, y, transform, .. } => {
                ecran.x = x;
                ecran.y = y;
                ecran.pivote = matches!(
                    transform,
                    WEnum::Value(
                        wl_output::Transform::_90
                            | wl_output::Transform::_270
                            | wl_output::Transform::Flipped90
                            | wl_output::Transform::Flipped270
                    )
                );
            }
            wl_output::Event::Mode { flags, width, height, .. } => {
                if matches!(flags, WEnum::Value(f) if f.contains(wl_output::Mode::Current)) {
                    ecran.largeur = width;
                    ecran.hauteur = height;
                }
            }
            wl_output::Event::Name { name } => ecran.nom = Some(name),
            _ => {}
        }
    }
}

delegate_noop!(Etat: ignore WlCompositor);
delegate_noop!(Etat: ignore WlSurface);
delegate_noop!(Etat: ignore WlShm);
delegate_noop!(Etat: ignore WlShmPool);
delegate_noop!(Etat: ignore ZwlrLayerShellV1);
delegate_noop!(Etat: ignore wayland_client::protocol::wl_region::WlRegion);

#[cfg(test)]
mod tests {
    use super::*;

    fn ecran(nom: &str, x: i32, y: i32, largeur: i32, hauteur: i32) -> InfoEcran {
        InfoEcran { x, y, largeur, hauteur, pivote: false, nom: Some(nom.into()) }
    }

    fn capture(x: i32, y: i32, largeur: i32, hauteur: i32) -> GeometrieEcran {
        GeometrieEcran { x, y, largeur, hauteur }
    }

    #[test]
    fn un_seul_ecran_de_cette_taille_est_choisi() {
        let ecrans = [ecran("DP-1", 0, 0, 2560, 1440), ecran("DP-2", 2560, 0, 1920, 1080), ecran("HDMI-1", 4480, 0, 3840, 2160)];
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 1920, 1080)), Some(1));
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 3840, 2160)), Some(2));
    }

    #[test]
    fn un_ecran_pivote_se_reconnait_a_sa_taille_tournee() {
        let mut vertical = ecran("DP-2", 2560, 0, 1920, 1080);
        vertical.pivote = true;
        let ecrans = [ecran("DP-1", 0, 0, 1920, 1080), vertical];
        // 1080x1920 : seul l'écran vertical correspond.
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 1080, 1920)), Some(1));
    }

    #[test]
    fn des_ecrans_identiques_sans_position_restent_indecis() {
        let ecrans = [ecran("DP-1", 0, 0, 1920, 1080), ecran("DP-2", 1920, 0, 1920, 1080)];
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 1920, 1080)), None);
    }

    #[test]
    fn une_position_reelle_departage_des_ecrans_identiques() {
        let ecrans = [ecran("DP-1", 0, 0, 1920, 1080), ecran("DP-2", 1920, 0, 1920, 1080)];
        assert_eq!(choisir_ecran(&ecrans, capture(1920, 0, 1920, 1080)), Some(1));
    }

    #[test]
    fn aucune_taille_correspondante_ne_choisit_rien() {
        let ecrans = [ecran("DP-1", 0, 0, 2560, 1440)];
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 1280, 720)), None);
        assert_eq!(choisir_ecran(&[], capture(0, 0, 1280, 720)), None);
    }

    #[test]
    fn deux_pixels_d_ecart_sont_toleres() {
        // Certains flux arrondissent à un nombre pair de pixels.
        let ecrans = [ecran("DP-1", 0, 0, 1366, 768), ecran("DP-2", 1366, 0, 2560, 1440)];
        assert_eq!(choisir_ecran(&ecrans, capture(0, 0, 1364, 768)), Some(0));
    }
}
