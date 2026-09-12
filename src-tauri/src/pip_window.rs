//! Fenêtre PIP native du partage d'écran — au-dessus de toutes les applis.
//!
//! Complète le PIP *interne* (carte flottante dans la webview) : ici la
//! fenêtre est une vraie fenêtre OS, `AlwaysOnTop`, sans décoration, pilotée
//! par winit + softbuffer — même pile que l'overlay de curseurs, et pour la
//! même raison : les images du partage sont **déjà côté Rust** quand elles
//! arrivent du réseau (`native_video_transport::broadcast`), on les décode une
//! seconde fois ici et on les blitte, sans repasser par la webview.
//!
//! Architecture (calquée sur `cursor_overlay.rs`) :
//!   - un thread hôte porte l'event loop winit (X11 forcé sous Linux, sinon
//!     Wayland ignore `WindowLevel::AlwaysOnTop`) ;
//!   - `on_frame()` (appelé depuis le moteur vocal) dépose la dernière image
//!     JPEG dans un état partagé puis réveille la boucle par un `UserEvent` ;
//!   - la boucle décode à ~20 fps maximum (une vignette n'a pas besoin des
//!     30 fps de la source) et blitte l'image ajustée (letterbox noir) ;
//!   - glisser au clic gauche déplace la fenêtre, clic droit ou Échap la
//!     ferme — pas de décoration, donc pas de bouton système.
//!
//! La position est mémorisée en mémoire (par session) ; le partage terminé
//! ferme la fenêtre automatiquement.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use winit::application::ApplicationHandler;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId, WindowLevel};

const DEFAULT_W: u32 = 480;
const DEFAULT_H: u32 = 270;
const LARGE_W: u32 = 768;
const LARGE_H: u32 = 432;
const MARGIN: i32 = 24;
/// Décodage borné à ~20 fps : la source émet ~30, décoder chaque frame
/// coûterait un cœur pour un gain invisible sur une vignette.
const MIN_DECODE_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct PipFrame {
    width: u32,
    height: u32,
    jpeg: Vec<u8>,
    /// Incrémentée à chaque image reçue ; la boucle compare pour savoir si
    /// elle a déjà peint celle-ci.
    generation: u64,
}

#[derive(Default)]
struct PipState {
    /// Partage affiché (identité de l'expéditeur). `None` = fenêtre fermée.
    sender: Option<String>,
    /// Dernière image reçue pour ce partage (gardée : une source en pause
    /// laisse l'écran rempli au lieu de noircir).
    frame: Option<PipFrame>,
    /// Dernière génération peinte par la boucle d'événements.
    painted: u64,
    /// Position mémorisée de la fenêtre (retrouvée à la réouverture).
    last_pos: Option<(i32, i32)>,
    /// Grande taille (double-clic) — mémorisée aussi.
    large: bool,
}

#[derive(Debug)]
enum UserEvent {
    Show,
    Hide,
    /// Une nouvelle image est disponible (réveille la boucle).
    Frame,
}

struct PipHandle {
    state: Arc<Mutex<PipState>>,
    proxy: EventLoopProxy<UserEvent>,
    thread_alive: Arc<AtomicBool>,
}

static HANDLE: OnceLock<PipHandle> = OnceLock::new();
static OPEN: AtomicBool = AtomicBool::new(false);
/// Handle Tauri de l'application, posé au démarrage (`set_app_handle`) : il
/// sert aux actions des boutons du PIP — revenir sur Sion, couper le son du
/// partage — sans repasser par le front.
static APP: OnceLock<tauri::AppHandle<crate::TauriRuntime>> = OnceLock::new();

/// Posé par `lib.rs` (setup). Sans lui les boutons restent inertes (la
/// fenêtre, elle, s'affiche quand même).
pub fn set_app_handle(app: tauri::AppHandle<crate::TauriRuntime>) {
    let _ = APP.set(app);
}

/// Boutons dessinés dans le coin haut-droit (24 px, 4 px d'écart, marge 8).
const BTN: u32 = 24;
const BTN_GAP: u32 = 4;
const BTN_MARGIN: u32 = 8;

/// Coins haut-gauche des deux boutons (retour, son) pour une surface donnée.
fn button_rects(w: u32, _h: u32) -> ((u32, u32), (u32, u32)) {
    let mute_x = w.saturating_sub(BTN_MARGIN + BTN);
    let back_x = mute_x.saturating_sub(BTN_GAP + BTN);
    ((back_x, BTN_MARGIN), (mute_x, BTN_MARGIN))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PipButton {
    BackToApp,
    ToggleShareAudio,
}

/// Bouton sous le curseur (position en pixels physiques, comme la fenêtre).
fn hit_button(pos: (f64, f64), w: u32, h: u32) -> Option<PipButton> {
    let (back, mute) = button_rects(w, h);
    let inside = |(x, y): (u32, u32)| {
        pos.0 >= x as f64
            && pos.0 < (x + BTN) as f64
            && pos.1 >= y as f64
            && pos.1 < (y + BTN) as f64
    };
    if inside(back) {
        Some(PipButton::BackToApp)
    } else if inside(mute) {
        Some(PipButton::ToggleShareAudio)
    } else {
        None
    }
}

/// La fenêtre PIP native est-elle ouverte ? (lue par le front pour l'état
/// des boutons — l'ouverture est pilotée par `pip_native_open`.)
pub fn is_open() -> bool {
    // Un thread mort = plus de fenêtre : l'état ne doit pas mentir après un
    // échec de la boucle winit.
    OPEN.load(Ordering::Acquire)
        && HANDLE
            .get()
            .map(|h| h.thread_alive.load(Ordering::Acquire))
            .unwrap_or(false)
}

/// Démarre le thread de l'event loop au premier usage (idempotent).
fn get_or_start_handle() -> Option<&'static PipHandle> {
    if let Some(h) = HANDLE.get() {
        return Some(h);
    }

    let state = Arc::new(Mutex::new(PipState::default()));
    let thread_alive = Arc::new(AtomicBool::new(true));
    let (proxy_tx, proxy_rx) = std::sync::mpsc::channel::<Option<EventLoopProxy<UserEvent>>>();

    let state_clone = state.clone();
    let alive_clone = thread_alive.clone();
    thread::Builder::new()
        .name("sion-native-pip".into())
        .spawn(move || {
            // `with_any_thread(true)` : l'event loop doit pouvoir vivre hors
            // du thread principal (l'app Tauri l'occupe déjà).
            #[cfg(target_os = "linux")]
            use winit::platform::wayland::EventLoopBuilderExtWayland;
            #[cfg(target_os = "linux")]
            use winit::platform::x11::EventLoopBuilderExtX11;
            #[cfg(target_os = "windows")]
            use winit::platform::windows::EventLoopBuilderExtWindows;

            let mut builder = EventLoop::<UserEvent>::with_user_event();
            #[cfg(target_os = "linux")]
            {
                EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
                EventLoopBuilderExtX11::with_any_thread(&mut builder, true);
                // X11 (XWayland) forcé : le backend Wayland natif de winit
                // n'honore pas `WindowLevel::AlwaysOnTop` (pas de couche
                // « au-dessus » pour un toplevel ordinaire). Sous XWayland,
                // KWin/Mutter mappent ça sur `_NET_WM_STATE_ABOVE`.
                EventLoopBuilderExtX11::with_x11(&mut builder);
            }
            #[cfg(target_os = "windows")]
            {
                EventLoopBuilderExtWindows::with_any_thread(&mut builder, true);
            }

            let event_loop = match builder.build() {
                Ok(el) => el,
                Err(err) => {
                    log::warn!("[Sion][PIP] winit EventLoop build failed: {err:?}");
                    let _ = proxy_tx.send(None);
                    alive_clone.store(false, Ordering::Release);
                    return;
                }
            };
            let _ = proxy_tx.send(Some(event_loop.create_proxy()));

            let mut app = PipApp::new(state_clone);
            if let Err(err) = event_loop.run_app(&mut app) {
                log::warn!("[Sion][PIP] event loop exited with error: {err:?}");
            }
            alive_clone.store(false, Ordering::Release);
            OPEN.store(false, Ordering::Release);
            log::info!("[Sion][PIP] event loop thread stopped");
        })
        .ok()?;

    let proxy = match proxy_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("[Sion][PIP] event loop thread failed to initialise");
            return None;
        }
        Err(err) => {
            log::warn!("[Sion][PIP] timed out waiting for event-loop proxy: {err:?}");
            return None;
        }
    };

    let _ = HANDLE.set(PipHandle { state, proxy, thread_alive });
    HANDLE.get()
}

/// Ouvre (ou bascule vers) la fenêtre PIP pour le partage `sender`.
pub fn open(sender: &str) -> bool {
    let Some(handle) = get_or_start_handle() else {
        return false;
    };
    {
        let mut state = handle.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sender.as_deref() != Some(sender) {
            // Nouveau partage : on repart d'un écran noir, l'ancienne image
            // ne doit pas rester une seconde en évidence.
            state.frame = None;
            state.painted = 0;
            state.sender = Some(sender.to_owned());
        }
    }
    OPEN.store(true, Ordering::Release);
    let _ = handle.proxy.send_event(UserEvent::Show);
    emit_pip_state(true);
    log::info!("[Sion][PIP] fenêtre native ouverte pour {sender}");
    true
}

/// État du PIP vers le front : la fenêtre peut se fermer elle-même (bouton
/// maison, clic droit, Échap) — le bouton de la vue doit suivre.
fn emit_pip_state(open: bool) {
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit("voice-native-pip", serde_json::json!({ "open": open }));
    }
}

/// Ferme la fenêtre (le thread reste vivant pour une réouverture rapide).
pub fn close() {
    let Some(handle) = HANDLE.get() else {
        return;
    };
    {
        let mut state = handle.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender = None;
        state.frame = None;
        state.painted = 0;
    }
    OPEN.store(false, Ordering::Release);
    let _ = handle.proxy.send_event(UserEvent::Hide);
    emit_pip_state(false);
}

/// Une image de partage vient d'arriver (appelée par le transport binaire).
pub fn on_frame(sender: &str, width: u32, height: u32, jpeg: &[u8]) {
    let Some(handle) = HANDLE.get() else {
        return;
    };
    if !OPEN.load(Ordering::Acquire) {
        return;
    }
    {
        let mut state = handle.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sender.as_deref() != Some(sender) {
            return;
        }
        let generation = state.frame.as_ref().map(|f| f.generation).unwrap_or(0) + 1;
        state.frame = Some(PipFrame {
            width,
            height,
            jpeg: jpeg.to_vec(),
            generation,
        });
    }
    let _ = handle.proxy.send_event(UserEvent::Frame);
}

/// Le partage `sender` est terminé : ferme la fenêtre si c'est celui-ci.
pub fn on_share_removed(sender: &str) {
    let Some(handle) = HANDLE.get() else {
        return;
    };
    let is_current = {
        let state = handle.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender.as_deref() == Some(sender)
    };
    if is_current {
        close();
    }
}

// ── Commandes Tauri ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn pip_native_open(sender: String) -> Result<(), String> {
    if sender.is_empty() {
        return Err("identité du partage manquante".into());
    }
    if open(&sender) {
        Ok(())
    } else {
        Err("impossible d'ouvrir la fenêtre PIP native".into())
    }
}

#[tauri::command]
pub fn pip_native_close() -> Result<(), String> {
    close();
    Ok(())
}

#[tauri::command]
pub fn pip_native_status() -> bool {
    is_open()
}

// ── Rendu ───────────────────────────────────────────────────────────────────

/// Ajuste l'image dans la surface (letterbox noir), écrit en 0x00RRGGBB
/// (XRGB8888, ce qu'attend softbuffer — même convention que le repack de
/// l'overlay de curseurs).
fn blit_fit(dst: &mut [u32], ww: u32, wh: u32, img: &image::RgbImage) {
    let (iw, ih) = img.dimensions();
    if iw == 0 || ih == 0 || ww == 0 || wh == 0 {
        return;
    }
    let scale = f64::min(ww as f64 / iw as f64, wh as f64 / ih as f64);
    let dw = ((iw as f64 * scale).round() as u32).clamp(1, ww);
    let dh = ((ih as f64 * scale).round() as u32).clamp(1, wh);
    let x0 = (ww - dw) / 2;
    let y0 = (wh - dh) / 2;

    dst.fill(0);
    for dy in 0..dh {
        let sy = ((dy as u64 * ih as u64) / dh as u64) as u32;
        let row = (y0 + dy) as usize * ww as usize;
        for dx in 0..dw {
            let sx = ((dx as u64 * iw as u64) / dw as u64) as u32;
            let p = img.get_pixel(sx, sy);
            dst[row + (x0 + dx) as usize] =
                ((p[0] as u32) << 16) | ((p[1] as u32) << 8) | p[2] as u32;
        }
    }
}

struct PipApp {
    state: Arc<Mutex<PipState>>,
    window: Option<Arc<Window>>,
    surface: Option<softbuffer::Surface<Arc<Window>, Arc<Window>>>,
    /// Dernier décodage effectif (throttle).
    last_paint: Instant,
    /// Une image est en attente mais le throttle interdit encore de peindre.
    pending_redraw_at: Option<Instant>,
    /// Nombre de frames peintes (diagnostic).
    painted_count: u64,
    /// Dernière position du curseur (pixels physiques) — cible du clic.
    cursor: (f64, f64),
    /// Son du partage coupé ? (état local, initialisé depuis le moteur à
    /// l'ouverture, basculé par le bouton 🔊/🔇).
    muted: bool,
}

impl PipApp {
    fn new(state: Arc<Mutex<PipState>>) -> Self {
        Self {
            state,
            window: None,
            surface: None,
            last_paint: Instant::now() - MIN_DECODE_INTERVAL,
            pending_redraw_at: None,
            painted_count: 0,
            cursor: (0.0, 0.0),
            muted: false,
        }
    }

    /// Revient sur la fenêtre principale (dé-minimise, montre, focus).
    fn focus_main_window(&self) {
        let Some(app) = APP.get() else {
            return;
        };
        use tauri::Manager;
        match app.get_webview_window("main") {
            Some(win) => {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                log::info!("[Sion][PIP] retour sur la fenêtre principale");
            }
            None => log::warn!("[Sion][PIP] fenêtre principale introuvable"),
        }
    }

    /// Bascule le son du partage affiché (même chemin que le bouton 🔊 de la
    /// vue : le moteur reste l'unique propriétaire de l'état).
    fn toggle_share_audio(&mut self) {
        let Some(app) = APP.get() else {
            return;
        };
        let sender = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.sender.clone()
        };
        let Some(sender) = sender else { return };
        let wanted = !self.muted;
        match crate::voice_native::voice_native_set_screenshare_audio_muted(
            app.clone(),
            sender,
            wanted,
        ) {
            Ok(_) => {
                self.muted = wanted;
                log::info!(
                    "[Sion][PIP] son du partage {}",
                    if wanted { "coupé" } else { "rétabli" }
                );
            }
            Err(err) => log::warn!("[Sion][PIP] bascule du son refusée: {err}"),
        }
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }

    fn build_window(&self, event_loop: &ActiveEventLoop) -> Option<Arc<Window>> {
        let (mut w, mut h, pos_default) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.large {
                (LARGE_W, LARGE_H, state.last_pos)
            } else {
                (DEFAULT_W, DEFAULT_H, state.last_pos)
            }
        };
        let _ = &mut w;
        let _ = &mut h;

        // Position : dernière position mémorisée, sinon bas-droite du moniteur
        // principal (convention des lecteurs PIP du système).
        let pos = pos_default.unwrap_or_else(|| {
            let mon = event_loop
                .primary_monitor()
                .or_else(|| event_loop.available_monitors().next());
            match mon {
                Some(m) => {
                    let ms = m.size();
                    let mp = m.position();
                    (
                        mp.x + ms.width as i32 - w as i32 - MARGIN,
                        mp.y + ms.height as i32 - h as i32 - MARGIN,
                    )
                }
                None => (100, 100),
            }
        });

        let attrs = WindowAttributes::default()
            .with_title("Sion — PIP partage")
            .with_decorations(false)
            .with_resizable(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_inner_size(PhysicalSize::new(w, h))
            .with_position(PhysicalPosition::new(pos.0, pos.1));

        let window = match event_loop.create_window(attrs) {
            Ok(win) => Arc::new(win),
            Err(err) => {
                log::warn!("[Sion][PIP] create_window failed: {err:?}");
                return None;
            }
        };
        Some(window)
    }

    /// Décode la dernière image non peinte et blitte. Silencieux si rien de
    /// neuf (le throttle comme la source en pause arrivent ici).
    fn paint(&mut self) {
        let (Some(window), Some(surface)) = (self.window.as_ref(), self.surface.as_mut()) else {
            return;
        };
        self.last_paint = Instant::now();
        self.pending_redraw_at = None;

        let frame = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match &state.frame {
                Some(f) if f.generation > state.painted => f.clone(),
                _ => return,
            }
        };

        let img = match image::load_from_memory(&frame.jpeg) {
            Ok(img) => img.to_rgb8(),
            Err(err) => {
                log::warn!("[Sion][PIP] décodage JPEG {}x{} échoué: {err}", frame.width, frame.height);
                return;
            }
        };

        let size = window.inner_size();
        let Ok(mut buffer) = surface.buffer_mut() else {
            return;
        };
        blit_fit(&mut buffer, size.width, size.height, &img);
        // Boutons par-dessus l'image : maison = revenir sur Sion,
        // haut-parleur = son du partage.
        draw_controls(&mut buffer, size.width, size.height, self.muted);
        let _ = buffer.present();

        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.painted = frame.generation;
        drop(state);

        self.painted_count = self.painted_count.wrapping_add(1);
        if self.painted_count % 120 == 1 {
            log::info!(
                "[Sion][PIP] frame #{} ({}x{}) → {}x{}",
                self.painted_count,
                frame.width,
                frame.height,
                size.width,
                size.height,
            );
        }
    }

    fn hide(&mut self) {
        if let Some(window) = self.window.as_ref() {
            if let Ok(pos) = window.outer_position() {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.last_pos = Some((pos.x, pos.y));
            }
            window.set_visible(false);
        }
    }
}

impl ApplicationHandler<UserEvent> for PipApp {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Show => {
                if self.window.is_none() {
                    let Some(window) = self.build_window(event_loop) else {
                        return;
                    };
                    let context = match softbuffer::Context::new(window.clone()) {
                        Ok(c) => c,
                        Err(err) => {
                            log::warn!("[Sion][PIP] softbuffer context failed: {err:?}");
                            return;
                        }
                    };
                    let mut surface = match softbuffer::Surface::new(&context, window.clone()) {
                        Ok(s) => s,
                        Err(err) => {
                            log::warn!("[Sion][PIP] softbuffer surface failed: {err:?}");
                            return;
                        }
                    };
                    let size = window.inner_size();
                    if let (Ok(w), Ok(h)) = (
                        std::num::NonZeroU32::try_from(size.width),
                        std::num::NonZeroU32::try_from(size.height),
                    ) {
                        let _ = surface.resize(w, h);
                    }
                    self.window = Some(window.clone());
                    self.surface = Some(surface);
                }
                if let Some(window) = self.window.as_ref() {
                    // État initial du bouton 🔊 : le moteur reste l'unique
                    // propriétaire du mute (sans moteur : « actif »).
                    if let Some(app) = APP.get() {
                        let sender = {
                            let state =
                                self.state.lock().unwrap_or_else(|e| e.into_inner());
                            state.sender.clone()
                        };
                        if let Some(sender) = sender {
                            if let Ok(st) =
                                crate::voice_native::voice_native_get_screenshare_audio_state(
                                    app.clone(),
                                    sender,
                                )
                            {
                                self.muted = st.muted;
                            }
                        }
                    }
                    window.set_visible(true);
                    window.request_redraw();
                }
            }
            UserEvent::Hide => self.hide(),
            UserEvent::Frame => {
                let Some(window) = self.window.as_ref() else {
                    return;
                };
                if self.last_paint.elapsed() >= MIN_DECODE_INTERVAL {
                    window.request_redraw();
                } else {
                    // Trop tôt : on repassera au prochain tour — la dernière
                    // image sera peinte, pas une vieille.
                    self.pending_redraw_at = Some(self.last_paint + MIN_DECODE_INTERVAL);
                    event_loop.set_control_flow(ControlFlow::WaitUntil(
                        self.last_paint + MIN_DECODE_INTERVAL,
                    ));
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::RedrawRequested => self.paint(),
            WindowEvent::Resized(size) => {
                if let Some(surface) = self.surface.as_mut() {
                    if let (Ok(w), Ok(h)) = (
                        std::num::NonZeroU32::try_from(size.width),
                        std::num::NonZeroU32::try_from(size.height),
                    ) {
                        let _ = surface.resize(w, h);
                    }
                }
                if let Some(window) = self.window.as_ref() {
                    window.request_redraw();
                }
            }
            WindowEvent::CloseRequested => {
                close();
                event_loop.set_control_flow(ControlFlow::Wait);
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                // Boutons dessinés (haut-droite) : le clic agit — maison =
                // revenir sur Sion, haut-parleur = son du partage. Ailleurs,
                // fenêtre sans décoration → on déplace en glissant.
                if let Some(size) = self.window.as_ref().map(|w| w.inner_size()) {
                    match hit_button(self.cursor, size.width, size.height) {
                        Some(PipButton::BackToApp) => {
                            // Comme le PIP de Firefox : on rend la main à
                            // l'application et la vignette se referme.
                            self.focus_main_window();
                            close();
                            return;
                        }
                        Some(PipButton::ToggleShareAudio) => {
                            self.toggle_share_audio();
                            return;
                        }
                        None => {}
                    }
                }
                if let Some(window) = self.window.as_ref() {
                    if let Err(err) = window.drag_window() {
                        log::debug!("[Sion][PIP] drag_window indisponible: {err:?}");
                    }
                }
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Right, .. } => {
                close();
            }
            WindowEvent::KeyboardInput { event: key, .. } => {
                use winit::keyboard::{Key, NamedKey};
                let is_escape = key.state == ElementState::Pressed
                    && matches!(key.logical_key, Key::Named(NamedKey::Escape));
                if is_escape {
                    close();
                }
            }
            WindowEvent::Destroyed => {
                self.window = None;
                self.surface = None;
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(at) = self.pending_redraw_at.take() {
            let now = Instant::now();
            if now >= at {
                if let Some(window) = self.window.as_ref() {
                    window.request_redraw();
                }
            } else {
                self.pending_redraw_at = Some(at);
            }
        }
    }
}

// ── Boutons dessinés (retour à Sion, son du partage) ───────────────────────
//
// La fenêtre n'embarque pas de fonte : les affordances sont dessinées en
// rectangles (fond assombri + glyphes blancs). Même géométrie que
// `hit_button` — une seule source de vérité pour le dessin et le clic.

fn put(buf: &mut [u32], w: u32, h: u32, x: u32, y: u32, color: u32) {
    if x < w && y < h {
        buf[(y * w + x) as usize] = color;
    }
}

fn darken(buf: &mut [u32], w: u32, h: u32, x: u32, y: u32) {
    if x < w && y < h {
        let i = (y * w + x) as usize;
        buf[i] = (buf[i] >> 1) & 0x007F7F7F;
    }
}

fn draw_button(
    buf: &mut [u32],
    w: u32,
    h: u32,
    (bx, by): (u32, u32),
    glyph: impl Fn(&mut [u32], u32, u32, u32, u32),
) {
    for y in by..by + BTN {
        for x in bx..bx + BTN {
            darken(buf, w, h, x, y);
        }
    }
    let border = 0x00D0D0D0;
    for x in bx..bx + BTN {
        put(buf, w, h, x, by, border);
        put(buf, w, h, x, by + BTN - 1, border);
    }
    for y in by..by + BTN {
        put(buf, w, h, bx, y, border);
        put(buf, w, h, bx + BTN - 1, y, border);
    }
    glyph(buf, w, h, bx, by);
}

/// Maison — revenir sur Sion (le bouton gauche).
fn house_glyph(buf: &mut [u32], w: u32, h: u32, bx: u32, by: u32) {
    let white = 0x00FFFFFF;
    for i in 0..6u32 {
        for x in (11 - i)..=(12 + i) {
            put(buf, w, h, bx + x, by + 5 + i, white);
        }
    }
    for y in 10..19u32 {
        for x in 7..17u32 {
            put(buf, w, h, bx + x, by + y, white);
        }
    }
    // Porte : réassombrie (le fond du bouton réapparaît).
    for y in 13..19u32 {
        for x in 10..14u32 {
            darken(buf, w, h, bx + x, by + y);
        }
    }
}

/// Haut-parleur — son du partage (barre oblique quand il est coupé).
fn speaker_glyph(buf: &mut [u32], w: u32, h: u32, bx: u32, by: u32, muted: bool) {
    let white = 0x00FFFFFF;
    for y in 9..15u32 {
        for x in 6..10u32 {
            put(buf, w, h, bx + x, by + y, white);
        }
    }
    for i in 0..5u32 {
        for y in (9 - i)..(15 + i) {
            put(buf, w, h, bx + 10 + i, by + y, white);
        }
    }
    if muted {
        for i in 0..15u32 {
            put(buf, w, h, bx + 5 + i, by + 4 + i, white);
            put(buf, w, h, bx + 5 + i, by + 5 + i, white);
        }
    } else {
        for y in 9..15u32 {
            put(buf, w, h, bx + 16, by + y, white);
        }
        for y in 7..17u32 {
            put(buf, w, h, bx + 18, by + y, white);
        }
    }
}

/// Peint les deux boutons par-dessus l'image déjà blittée.
fn draw_controls(buf: &mut [u32], w: u32, h: u32, muted: bool) {
    let (back, mute) = button_rects(w, h);
    draw_button(buf, w, h, back, house_glyph);
    draw_button(buf, w, h, mute, |b, ww, hh, x, y| {
        speaker_glyph(b, ww, hh, x, y, muted)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Géométrie des boutons : le dessin et le clic doivent tomber sur les
    /// mêmes zones (source de vérité unique).
    #[test]
    fn boutons_du_pip_dans_le_coin() {
        let (back, mute) = button_rects(480, 270);
        assert_eq!(mute, (480 - BTN_MARGIN - BTN, BTN_MARGIN));
        assert_eq!(back, (mute.0 - BTN_GAP - BTN, BTN_MARGIN));
        // Centres des boutons → la bonne action ; le milieu de l'image → rien.
        let center = |(x, y): (u32, u32)| (x as f64 + BTN as f64 / 2.0, y as f64 + BTN as f64 / 2.0);
        assert_eq!(hit_button(center(back), 480, 270), Some(PipButton::BackToApp));
        assert_eq!(hit_button(center(mute), 480, 270), Some(PipButton::ToggleShareAudio));
        assert_eq!(hit_button((240.0, 135.0), 480, 270), None);
        // Hors zone (coin opposé) → aucun bouton.
        assert_eq!(hit_button((5.0, 5.0), 480, 270), None);
    }

    /// Test fenêtré (opt-in) : vérifie que l'event loop winit se construit
    /// réellement dans son thread — c'est le point de panne silencieux du
    /// PIP natif (échec = `open` renvoie false, aucune fenêtre). Lancer avec
    /// `SION_PIP_WINDOW_TEST=1` : une fenêtre PIP apparaît ~1,5 s.
    #[test]
    fn fenetre_native_souvre_et_se_ferme() {
        if std::env::var("SION_PIP_WINDOW_TEST").is_err() {
            eprintln!("ignoré (fenêtré) : SION_PIP_WINDOW_TEST=1 pour l'exécuter");
            return;
        }
        assert!(open("@test:sion"), "open() a échoué — event loop winit en thread ?");
        assert!(is_open(), "la fenêtre devrait être marquée ouverte");
        std::thread::sleep(std::time::Duration::from_millis(1500));
        close();
        assert!(!is_open(), "la fenêtre devrait être fermée");
    }

    #[test]
    fn blit_ajuste_en_conservant_le_ratio() {
        // Source 4:2 dans une surface 2:2 → bandes noires à gauche/droite.
        let img = image::RgbImage::from_pixel(4, 2, image::Rgb([255, 0, 0]));
        let mut dst = vec![0xFFFFFFFFu32; 2 * 2];
        blit_fit(&mut dst, 2, 2, &img);
        // 2x2 rendu centré : deux colonnes rouges, rien de blanc.
        assert_eq!(dst[0], 0x00FF0000);
        assert_eq!(dst[1], 0x00FF0000);
        assert!(dst.iter().all(|&p| p != 0x00FFFFFF));
    }

    #[test]
    fn blit_remplit_toute_la_surface_quand_les_ratios_correspondent() {
        let img = image::RgbImage::from_pixel(2, 1, image::Rgb([0, 255, 0]));
        let mut dst = vec![0u32; 4 * 2];
        blit_fit(&mut dst, 4, 2, &img);
        assert!(dst.iter().all(|&p| p == 0x0000FF00));
    }
}
