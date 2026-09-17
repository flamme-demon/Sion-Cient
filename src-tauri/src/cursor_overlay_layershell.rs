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
    wl_registry::WlRegistry,
    wl_shm::{Format, WlShm},
    wl_shm_pool::WlShmPool,
    wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1::{Layer, ZwlrLayerShellV1},
    zwlr_layer_surface_v1::{Anchor, Event as LayerEvent, ZwlrLayerSurfaceV1},
};

use super::{OverlayState, UserEvent};

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

/// État partagé avec la file d'évènements Wayland.
#[derive(Default)]
struct Etat {
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
    etat: Etat,
    surfaces: Option<Surfaces>,
    /// Mémoire partagée courante et sa taille, réallouée quand la surface
    /// grandit. Conservée entre les frames : recréer un pool par image
    /// coûterait un `mmap` à chaque fois.
    pool: Option<(WlShmPool, std::fs::File, usize)>,
    buffer: Option<WlBuffer>,
    pixmap: Option<Pixmap>,
    need_redraw: bool,
    redraw_at: Option<Instant>,
}

impl Host {
    fn connect() -> Result<Self, String> {
        let conn = Connection::connect_to_env().map_err(|e| format!("connexion Wayland: {e}"))?;
        let (globals, queue) =
            registry_queue_init::<Etat>(&conn).map_err(|e| format!("registre: {e}"))?;
        let qh = queue.handle();
        let compositor: WlCompositor = globals
            .bind(&qh, 1..=6, ())
            .map_err(|e| format!("wl_compositor: {e}"))?;
        let shm: WlShm = globals.bind(&qh, 1..=1, ()).map_err(|e| format!("wl_shm: {e}"))?;
        let layer_shell: ZwlrLayerShellV1 = globals
            .bind(&qh, 1..=5, ())
            .map_err(|e| format!("zwlr_layer_shell_v1 absent: {e}"))?;
        log::info!("[Sion][CursorOverlay] hôte Wayland layer-shell prêt");
        Ok(Self {
            conn,
            queue,
            qh,
            compositor,
            shm,
            layer_shell,
            etat: Etat::default(),
            surfaces: None,
            pool: None,
            buffer: None,
            pixmap: None,
            need_redraw: false,
            redraw_at: None,
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
        let couche = self.layer_shell.get_layer_surface(
            &surface,
            // `None` : le compositeur choisit l'écran, comme l'hôte X11 visait
            // l'écran principal.
            None,
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
        pixmap.fill(tiny_skia::Color::TRANSPARENT);

        let now = Instant::now();
        let (anime, prochain) = {
            let mut s = match state.lock() {
                Ok(s) => s,
                Err(poisoned) => poisoned.into_inner(),
            };
            s.cursors.retain(|_, c| c.expires_at > now);
            s.clicks.retain(|c| c.expires_at > now);
            super::draw::draw(pixmap, w as f32, h as f32, &s, now);
            let mut prochain: Option<Instant> = None;
            for c in s.cursors.values() {
                prochain = Some(prochain.map_or(c.expires_at, |t: Instant| t.min(c.expires_at)));
            }
            for c in &s.clicks {
                prochain = Some(prochain.map_or(c.expires_at, |t: Instant| t.min(c.expires_at)));
            }
            (!s.clicks.is_empty(), prochain)
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
        let mut octets = Vec::with_capacity(taille);
        for px in self.pixmap.as_ref().unwrap().data().chunks_exact(4) {
            octets.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
        if fichier.seek(SeekFrom::Start(0)).is_err() || fichier.write_all(&octets).is_err() {
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
            surface.damage_buffer(0, 0, w as i32, h as i32);
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

            // 2) Peindre si nécessaire.
            let du = self.need_redraw || self.redraw_at.is_some_and(|t| Instant::now() >= t);
            if du && self.surfaces.is_some() {
                self.redraw(state);
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

delegate_noop!(Etat: ignore WlCompositor);
delegate_noop!(Etat: ignore WlSurface);
delegate_noop!(Etat: ignore WlShm);
delegate_noop!(Etat: ignore WlShmPool);
delegate_noop!(Etat: ignore ZwlrLayerShellV1);
delegate_noop!(Etat: ignore wayland_client::protocol::wl_region::WlRegion);
