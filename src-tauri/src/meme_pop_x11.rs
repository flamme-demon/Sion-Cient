//! Fenêtre d'un meme sous X11 — le repli quand le compositeur n'offre pas
//! layer-shell (session X11 pure, GNOME sous Wayland via XWayland).
//!
//! Une fenêtre ARGB en `override_redirect` : le gestionnaire de fenêtres ne
//! la gère pas, donc ne la décore pas, ne lui donne pas le focus et ne la
//! repousse pas sous une autre. La région d'entrée est vidée par l'extension
//! SHAPE : le clic traverse, comme pour l'overlay des curseurs.
//!
//! Limite connue : sous XWayland, une fenêtre X11 ne passe pas au-dessus d'un
//! jeu Wayland natif en plein écran. Seul l'hôte layer-shell le peut.

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::shape::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    ClipOrdering, ColormapAlloc, ConnectionExt as _, CreateGCAux, CreateWindowAux, ImageFormat,
    VisualClass, Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;

pub(super) struct FenetreX11 {
    conn: RustConnection,
    fenetre: Window,
    gc: u32,
    palette: u32,
    largeur: u16,
    hauteur: u16,
}

impl FenetreX11 {
    pub(super) fn ouvrir(
        largeur: u32,
        hauteur: u32,
        placer: &mut dyn FnMut(u32, u32) -> (i32, i32),
    ) -> Result<Self, String> {
        let erreur = |e: &dyn std::fmt::Display| format!("X11 : {e}");
        let (conn, ecran_n) = RustConnection::connect(None).map_err(|e| erreur(&e))?;
        let ecran = &conn.setup().roots[ecran_n];
        let racine = ecran.root;
        let (visuel, profondeur) = ecran
            .allowed_depths
            .iter()
            .filter(|d| d.depth == 32)
            .find_map(|d| {
                d.visuals
                    .iter()
                    .find(|v| v.class == VisualClass::TRUE_COLOR)
                    .map(|v| (v.visual_id, d.depth))
            })
            .ok_or("aucun visuel ARGB 32 bits")?;
        // L'écran principal, comme l'overlay des curseurs ; l'écran entier
        // si RANDR ne répond pas.
        let (mx, my, ml, mh) = crate::cursor_overlay::x11_host::primary_monitor(&conn, racine)
            .unwrap_or((0, 0, ecran.width_in_pixels, ecran.height_in_pixels));
        let (x, y) = placer(ml as u32, mh as u32);
        let (largeur, hauteur) = (largeur.min(u16::MAX as u32) as u16, hauteur.min(u16::MAX as u32) as u16);

        let fenetre = conn.generate_id().map_err(|e| erreur(&e))?;
        let gc = conn.generate_id().map_err(|e| erreur(&e))?;
        let palette = conn.generate_id().map_err(|e| erreur(&e))?;
        conn.create_colormap(ColormapAlloc::NONE, palette, racine, visuel)
            .map_err(|e| erreur(&e))?;
        conn.create_window(
            profondeur,
            fenetre,
            racine,
            (mx as i32 + x).clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            (my as i32 + y).clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            largeur,
            hauteur,
            0,
            WindowClass::INPUT_OUTPUT,
            visuel,
            &CreateWindowAux::new()
                .background_pixel(0)
                .border_pixel(0)
                .colormap(palette)
                .override_redirect(1),
        )
        .map_err(|e| erreur(&e))?;
        conn.create_gc(gc, fenetre, &CreateGCAux::new())
            .map_err(|e| erreur(&e))?;
        if conn
            .extension_information(shape::X11_EXTENSION_NAME)
            .ok()
            .flatten()
            .is_some()
        {
            conn.shape_rectangles(
                shape::SO::SET,
                shape::SK::INPUT,
                ClipOrdering::UNSORTED,
                fenetre,
                0,
                0,
                &[],
            )
            .map_err(|e| erreur(&e))?;
        }
        conn.map_window(fenetre).map_err(|e| erreur(&e))?;
        conn.flush().map_err(|e| erreur(&e))?;
        Ok(Self {
            conn,
            fenetre,
            gc,
            palette,
            largeur,
            hauteur,
        })
    }

    /// `bgra` : en petit-boutiste, c'est l'ARGB 32 bits du visuel.
    pub(super) fn presenter(&mut self, bgra: &[u8]) -> Result<(), String> {
        self.conn
            .put_image(
                ImageFormat::Z_PIXMAP,
                self.fenetre,
                self.gc,
                self.largeur,
                self.hauteur,
                0,
                0,
                0,
                32,
                bgra,
            )
            .map_err(|e| format!("X11 : {e}"))?;
        self.conn.flush().map_err(|e| format!("X11 : {e}"))
    }
}

impl Drop for FenetreX11 {
    fn drop(&mut self) {
        let _ = self.conn.free_gc(self.gc);
        let _ = self.conn.destroy_window(self.fenetre);
        let _ = self.conn.free_colormap(self.palette);
        let _ = self.conn.flush();
    }
}
