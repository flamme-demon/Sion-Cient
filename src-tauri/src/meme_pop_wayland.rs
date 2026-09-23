//! Fenêtre d'un meme sous Wayland : une surface `zwlr_layer_shell_v1`.
//!
//! La couche `Overlay` est la seule à passer au-dessus d'une fenêtre en plein
//! écran — un jeu, typiquement. Mêmes briques que l'hôte Wayland de l'overlay
//! des curseurs, mais une surface à la taille du meme plutôt qu'à celle de
//! l'écran : il n'y a que ses pixels à envoyer.
//!
//! **Ouverture en deux temps.** Pour tirer une place au hasard, il faut la
//! taille de l'écran, que Wayland ne donne qu'au premier `configure`. La
//! surface naît donc ancrée aux quatre bords, sans contenu — le compositeur y
//! répond avec la taille de l'écran —, puis elle est réancrée en haut à gauche,
//! à sa taille, décalée par ses marges.
//!
//! Chaque meme a sa propre connexion : les memes vivent sur leurs propres fils
//! et se ferment indépendamment, sans hôte partagé à orchestrer.

use std::io::{Seek, SeekFrom, Write};
use std::os::fd::AsFd;
use std::time::{Duration, Instant};

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{
    wl_buffer::WlBuffer, wl_compositor::WlCompositor, wl_region::WlRegion,
    wl_registry::WlRegistry, wl_shm::Format, wl_shm::WlShm, wl_shm_pool::WlShmPool,
    wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1::{Layer, ZwlrLayerShellV1},
    zwlr_layer_surface_v1::{Anchor, Event as LayerEvent, ZwlrLayerSurfaceV1},
};

/// Attente maximale d'un `configure`.
const DELAI_CONFIGURE: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Etat {
    /// Dernière taille accordée par le compositeur, pas encore consommée.
    configure: Option<(u32, u32)>,
    ferme: bool,
    /// Tampons rendus au compositeur et pas encore relâchés.
    occupes: [bool; 2],
}

pub(super) struct FenetreWayland {
    conn: Connection,
    queue: EventQueue<Etat>,
    etat: Etat,
    surface: WlSurface,
    couche: ZwlrLayerSurfaceV1,
    pool: WlShmPool,
    fichier: std::fs::File,
    /// Deux tampons en alternance : on écrit dans l'un pendant que le
    /// compositeur lit l'autre.
    tampons: [WlBuffer; 2],
    suivant: usize,
    largeur: u32,
    hauteur: u32,
}

impl FenetreWayland {
    pub(super) fn ouvrir(
        largeur: u32,
        hauteur: u32,
        placer: &mut dyn FnMut(u32, u32) -> (i32, i32),
    ) -> Result<Self, String> {
        let conn = Connection::connect_to_env().map_err(|e| format!("connexion Wayland : {e}"))?;
        let (globales, mut queue) =
            registry_queue_init::<Etat>(&conn).map_err(|e| format!("registre : {e}"))?;
        let qh = queue.handle();
        let compositeur: WlCompositor = globales
            .bind(&qh, 1..=6, ())
            .map_err(|e| format!("wl_compositor : {e}"))?;
        let shm: WlShm = globales.bind(&qh, 1..=1, ()).map_err(|e| format!("wl_shm : {e}"))?;
        let layer_shell: ZwlrLayerShellV1 = globales
            .bind(&qh, 1..=4, ())
            .map_err(|e| format!("zwlr_layer_shell_v1 absent : {e}"))?;

        let surface = compositeur.create_surface(&qh, ());
        let couche = layer_shell.get_layer_surface(
            &surface,
            // Le compositeur choisit l'écran : celui où l'on se trouve, là
            // où se joue la partie.
            None,
            Layer::Overlay,
            "sion-meme".to_string(),
            &qh,
            (),
        );
        // Aucune entrée : le clic traverse le meme et va au jeu dessous.
        let region = compositeur.create_region(&qh, ());
        surface.set_input_region(Some(&region));
        region.destroy();
        couche.set_exclusive_zone(-1);

        // 1) Plein écran, sans contenu : le `configure` donne la taille.
        couche.set_anchor(Anchor::Top | Anchor::Bottom | Anchor::Left | Anchor::Right);
        couche.set_size(0, 0);
        surface.commit();
        let mut etat = Etat::default();
        let (ecran_l, ecran_h) = attendre_configure(&mut queue, &mut etat)?;

        // 2) À sa taille, à sa place.
        let (x, y) = placer(ecran_l, ecran_h);
        couche.set_anchor(Anchor::Top | Anchor::Left);
        couche.set_size(largeur, hauteur);
        couche.set_margin(y.max(0), 0, 0, x.max(0));
        surface.commit();
        attendre_configure(&mut queue, &mut etat)?;

        let taille_tampon = largeur as usize * hauteur as usize * 4;
        let fichier = memoire_partagee(2 * taille_tampon)?;
        let pool = shm.create_pool(fichier.as_fd(), (2 * taille_tampon) as i32, &qh, ());
        let tampon = |i: usize| {
            pool.create_buffer(
                (i * taille_tampon) as i32,
                largeur as i32,
                hauteur as i32,
                (largeur * 4) as i32,
                Format::Argb8888,
                &qh,
                i,
            )
        };
        let tampons = [tampon(0), tampon(1)];
        Ok(Self {
            conn,
            queue,
            etat,
            surface,
            couche,
            pool,
            fichier,
            tampons,
            suivant: 0,
            largeur,
            hauteur,
        })
    }

    /// `bgra` est exactement l'`ARGB8888` de `wl_shm` en petit-boutiste.
    pub(super) fn presenter(&mut self, bgra: &[u8]) -> Result<(), String> {
        self.queue
            .roundtrip(&mut self.etat)
            .map_err(|e| format!("connexion Wayland perdue : {e}"))?;
        if self.etat.ferme {
            return Err("surface retirée par le compositeur".into());
        }
        // Un nouveau `configure` (changement d'écran…) est acquitté par le
        // gestionnaire ; la taille demandée, elle, ne change pas.
        self.etat.configure = None;
        // Les deux tampons encore lus : on saute cette image plutôt que
        // d'écrire sous les yeux du compositeur.
        let Some(i) = [self.suivant, 1 - self.suivant]
            .into_iter()
            .find(|&i| !self.etat.occupes[i])
        else {
            return Ok(());
        };
        let taille = self.largeur as usize * self.hauteur as usize * 4;
        if bgra.len() != taille {
            return Err("image de taille inattendue".into());
        }
        self.fichier
            .seek(SeekFrom::Start((i * taille) as u64))
            .and_then(|_| self.fichier.write_all(bgra))
            .map_err(|e| format!("écriture du tampon : {e}"))?;
        self.surface.attach(Some(&self.tampons[i]), 0, 0);
        self.surface
            .damage_buffer(0, 0, self.largeur as i32, self.hauteur as i32);
        self.surface.commit();
        self.etat.occupes[i] = true;
        self.suivant = 1 - i;
        self.conn.flush().map_err(|e| format!("envoi Wayland : {e}"))
    }
}

impl Drop for FenetreWayland {
    fn drop(&mut self) {
        self.couche.destroy();
        self.surface.destroy();
        for t in &self.tampons {
            t.destroy();
        }
        self.pool.destroy();
        let _ = self.conn.flush();
    }
}

fn attendre_configure(queue: &mut EventQueue<Etat>, etat: &mut Etat) -> Result<(u32, u32), String> {
    let limite = Instant::now() + DELAI_CONFIGURE;
    loop {
        queue
            .roundtrip(etat)
            .map_err(|e| format!("connexion Wayland : {e}"))?;
        if etat.ferme {
            return Err("surface refusée par le compositeur".into());
        }
        if let Some(taille) = etat.configure.take() {
            return Ok(taille);
        }
        if Instant::now() > limite {
            return Err("le compositeur n'a pas configuré la surface".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Un fichier de `/dev/shm` délié aussitôt créé : il ne survit pas au
/// processus et n'a pas de nom exploitable.
fn memoire_partagee(taille: usize) -> Result<std::fs::File, String> {
    let chemin = format!(
        "/dev/shm/sion-meme-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    )
    .replace(['(', ')'], "");
    let fichier = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&chemin)
        .map_err(|e| format!("mémoire partagée : {e}"))?;
    let _ = std::fs::remove_file(&chemin);
    fichier
        .set_len(taille as u64)
        .map_err(|e| format!("taille de la mémoire partagée : {e}"))?;
    Ok(fichier)
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
                // Sans acquittement, le compositeur ne présente jamais rien.
                couche.ack_configure(serial);
                etat.configure = Some((width.max(1), height.max(1)));
            }
            LayerEvent::Closed => etat.ferme = true,
            _ => {}
        }
    }
}

impl Dispatch<WlBuffer, usize> for Etat {
    fn event(
        etat: &mut Self,
        _: &WlBuffer,
        event: wayland_client::protocol::wl_buffer::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if matches!(event, wayland_client::protocol::wl_buffer::Event::Release) {
            if let Some(o) = etat.occupes.get_mut(*index) {
                *o = false;
            }
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
    }
}

delegate_noop!(Etat: ignore WlCompositor);
delegate_noop!(Etat: ignore WlSurface);
delegate_noop!(Etat: ignore WlShm);
delegate_noop!(Etat: ignore WlShmPool);
delegate_noop!(Etat: ignore WlRegion);
delegate_noop!(Etat: ignore ZwlrLayerShellV1);
