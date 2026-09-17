//! Hôte winit de l'overlay curseurs — **Windows** (tout ce qui n'est pas Linux).
//!
//! Historique : c'est l'hôte qui servait aussi Linux jusqu'à la réécriture X11
//! du 13/09/2026. Raison du changement (cf. `cursor_overlay_x11.rs`) : winit
//! n'autorise qu'UNE `EventLoop` par processus et le PIP natif préchauffe la
//! sienne au démarrage, donc l'overlay ne pouvait plus la créer
//! (`RecreationAttempt`) — il parle désormais X11 directement sur Linux.
//!
//! Ici, rien d'autre que la fenêtre et la boucle : fenêtre ARGB sans
//! décoration, always-on-top, traversante (`set_cursor_hittest(false)`), blit
//! softbuffer. L'état partagé, le dessin (`super::draw`), les commandes Tauri
//! et le repack vivent dans le module parent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use softbuffer::{Context, Surface};
use tiny_skia::{Color, Pixmap};
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId, WindowLevel};

use super::{OverlayState, UserEvent};

/// Hôte winit (Windows) — inchangé depuis l'origine, à ceci près qu'il ne
/// construit plus la boucle sur Linux (c'est `x11_host` qui s'en charge).
///
/// On Linux l'`EventLoop` est `!Send` (elle tient des `Rc` sur la connexion au
/// compositeur) : elle doit être construite *dans* le fil qui la fait tourner.
/// On renvoie donc le `EventLoopProxy` par un canal oneshot — le proxy EST
/// `Send`, c'est tout son intérêt.
pub(super) fn start(
    state: Arc<Mutex<OverlayState>>,
    thread_alive: Arc<AtomicBool>,
) -> Option<EventLoopProxy<UserEvent>> {
    let (proxy_tx, proxy_rx) = std::sync::mpsc::channel::<Option<EventLoopProxy<UserEvent>>>();

    let state_clone = state.clone();
    let alive_clone = thread_alive.clone();
    thread::Builder::new()
        .name("sion-cursor-overlay".into())
        .spawn(move || {
            // `with_any_thread(true)` lets us build + run the loop off
            // the OS main thread.
            #[cfg(target_os = "windows")]
            use winit::platform::windows::EventLoopBuilderExtWindows;

            let mut builder = EventLoop::<UserEvent>::with_user_event();
            #[cfg(target_os = "windows")]
            {
                EventLoopBuilderExtWindows::with_any_thread(&mut builder, true);
            }

            let event_loop = match builder.build() {
                Ok(el) => el,
                Err(err) => {
                    log::warn!("[Sion][CursorOverlay] winit EventLoop build failed: {err:?}");
                    let _ = proxy_tx.send(None);
                    alive_clone.store(false, Ordering::Release);
                    return;
                }
            };
            // Ship the proxy back before we give up control to run_app.
            let _ = proxy_tx.send(Some(event_loop.create_proxy()));

            let mut app = App::new(state_clone);
            if let Err(err) = event_loop.run_app(&mut app) {
                log::warn!("[Sion][CursorOverlay] event loop exited with error: {err:?}");
            }
            alive_clone.store(false, Ordering::Release);
            log::info!("[Sion][CursorOverlay] event loop thread stopped");
        })
        .ok()?;

    match proxy_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(p)) => Some(p),
        Ok(None) => {
            log::warn!("[Sion][CursorOverlay] event loop thread failed to initialise");
            None
        }
        Err(err) => {
            log::warn!("[Sion][CursorOverlay] timed out waiting for event-loop proxy: {err:?}");
            None
        }
    }
}

// ── winit app (Windows) ────────────────────────────────────────────────

struct App {
    state: Arc<Mutex<OverlayState>>,
    window: Option<Arc<Window>>,
    // softbuffer needs its Context bound to the window; keep both alive.
    surface: Option<Surface<Arc<Window>, Arc<Window>>>,
    // Canvas-space pixmap, resized to match the window.
    pixmap: Option<Pixmap>,
    last_frame: Instant,
    frame_counter: u64,
    /// Cumul du temps passé dans `redraw()` (diagnostic, voir ci-dessus).
    redraw_ms_total: u64,
    redraw_count: u64,
    /// Arrête le fil qui ramène l'overlay sur le bureau virtuel courant
    /// (Windows). Inutilisé ailleurs, mais gardé sans `cfg` pour que la
    /// structure reste identique sur toutes les cibles.
    desktop_stop: Arc<AtomicBool>,
}

impl App {
    fn new(state: Arc<Mutex<OverlayState>>) -> Self {
        Self {
            state,
            window: None,
            surface: None,
            pixmap: None,
            last_frame: Instant::now(),
            frame_counter: 0,
            redraw_ms_total: 0,
            redraw_count: 0,
            desktop_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Build the window targeting the primary monitor. Borderless, full
    /// monitor size, transparent, always on top, click-through.
    ///
    /// `primary_monitor()` returns None on Wayland (the concept is
    /// X11-specific — Wayland has no canonical "primary"), so we fall
    /// back to the first available monitor. As a last resort we use a
    /// reasonable default size so the window still appears even on
    /// headless/CI setups.
    fn build_window(&self, event_loop: &ActiveEventLoop) -> Option<Arc<Window>> {
        let mon = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next());
        let (size, pos) = if let Some(m) = mon {
            log::info!(
                "[Sion][CursorOverlay] using monitor {:?} size={:?} pos={:?}",
                m.name(),
                m.size(),
                m.position()
            );
            (
                winit::dpi::PhysicalSize::new(m.size().width, m.size().height),
                winit::dpi::PhysicalPosition::new(m.position().x, m.position().y),
            )
        } else {
            log::warn!("[Sion][CursorOverlay] no monitor reported by winit — falling back to 1920x1080 at (0,0)");
            (
                winit::dpi::PhysicalSize::new(1920u32, 1080u32),
                winit::dpi::PhysicalPosition::new(0i32, 0i32),
            )
        };

        let attrs = WindowAttributes::default()
            .with_title("Sion cursor overlay")
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_inner_size(size)
            .with_position(pos);

        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(err) => {
                log::warn!("[Sion][CursorOverlay] create_window failed: {err:?}");
                return None;
            }
        };

        // Click-through: the OS forwards mouse events under the window.
        // winit 0.30 exposes this directly.
        if let Err(err) = window.set_cursor_hittest(false) {
            log::warn!("[Sion][CursorOverlay] set_cursor_hittest(false) failed: {err:?}");
        }

        // Le collage « tous bureaux » n'a pas le même mécanisme selon la
        // plateforme. Sous Linux c'est `_NET_WM_STATE_STICKY`, posé par
        // `cursor_overlay_x11.rs`. Sous Windows aucun équivalent documenté
        // n'existe : une fenêtre appartient au bureau virtuel où elle est née
        // et y reste. « Toujours au-dessus » ne suffit donc pas — l'overlay
        // disparaît dès que l'utilisateur change de bureau, alors que le
        // partage, lui, suit l'écran. On le fait suivre.
        #[cfg(target_os = "windows")]
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            // Drapeau remis à zéro : une fenêtre neuve ne doit pas hériter de
            // l'arrêt demandé pour la précédente.
            self.desktop_stop.store(false, Ordering::Relaxed);
            match window.window_handle().map(|h| h.as_raw()) {
                Ok(RawWindowHandle::Win32(handle)) => {
                    crate::virtual_desktop::suivre(
                        handle.hwnd.get(),
                        std::sync::Arc::clone(&self.desktop_stop),
                    );
                }
                _ => log::warn!(
                    "[Sion][CursorOverlay] handle Win32 indisponible — pas de suivi des bureaux"
                ),
            }
        }

        Some(window)
    }

    fn redraw(&mut self) {
        let (Some(window), Some(surface), Some(pixmap)) = (
            self.window.as_ref(),
            self.surface.as_mut(),
            self.pixmap.as_mut(),
        ) else {
            log::warn!("[Sion][CursorOverlay] redraw skipped — window/surface/pixmap not ready");
            return;
        };

        // Sweep expired entries. Positions are already sampled at ~60 Hz and
        // are painted as received, avoiding another 30–70 ms before capture.
        let now = Instant::now();
        let (cursor_count, click_count) = {
            let mut state = match self.state.lock() {
                Ok(s) => s,
                Err(poisoned) => poisoned.into_inner(),
            };
            state.cursors.retain(|_, c| c.expires_at > now);
            state.clicks.retain(|c| c.expires_at > now);
            (state.cursors.len(), state.clicks.len())
        };

        // Log every ~60 frames (~1s @ 60Hz) when we have something to draw,
        // so the user can see the redraw loop is alive in the log.
        self.frame_counter = self.frame_counter.wrapping_add(1);
        if (cursor_count > 0 || click_count > 0) && self.frame_counter % 60 == 0 {
            log::info!(
                "[Sion][CursorOverlay] frame #{} cursors={} clicks={}",
                self.frame_counter,
                cursor_count,
                click_count,
            );
        }

        // Clear the pixmap (fully transparent).
        pixmap.fill(Color::TRANSPARENT);

        let (ww, wh) = {
            let size = window.inner_size();
            (size.width as f32, size.height as f32)
        };

        super::draw::draw(pixmap, ww, wh, &self.state.lock().unwrap(), now);

        // Blit into the softbuffer surface.
        if let Ok(mut buffer) = surface.buffer_mut() {
            // softbuffer expects BGRA or platform-native u32. tiny-skia
            // produces RGBA premultiplied. We repack on copy — en parallèle
            // (scope) : 7,4 Mpx en scalaire -O0 prenaient >100 ms/frame et
            // l'event loop ne suivait plus (curseur saccadé pour tous).
            super::repack_rgba_to_bgra_parallel(&mut buffer, pixmap.data());
            let _ = buffer.present();
        }

        self.last_frame = now;
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {
        // winit 0.30 requires window creation in `resumed`. We don't
        // actually create the window until the first `Show` user event —
        // no point running a window when there's nothing to paint.
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Show => {
                if self.window.is_some() {
                    if let Some(w) = &self.window {
                        w.set_visible(true);
                        w.request_redraw();
                    }
                    return;
                }
                let Some(window) = self.build_window(event_loop) else {
                    return;
                };
                // softbuffer context/surface are bound to the window.
                let context = match Context::new(window.clone()) {
                    Ok(c) => c,
                    Err(err) => {
                        log::warn!("[Sion][CursorOverlay] softbuffer context failed: {err:?}");
                        return;
                    }
                };
                let mut surface = match Surface::new(&context, window.clone()) {
                    Ok(s) => s,
                    Err(err) => {
                        log::warn!("[Sion][CursorOverlay] softbuffer surface failed: {err:?}");
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
                let pixmap = Pixmap::new(size.width, size.height);
                self.window = Some(window.clone());
                self.surface = Some(surface);
                self.pixmap = pixmap;
                window.request_redraw();
                let pos = window.outer_position().ok();
                log::info!(
                    "[Sion][CursorOverlay] window created size={}x{} pos={:?} pixmap={}",
                    size.width,
                    size.height,
                    pos,
                    if self.pixmap.is_some() {
                        "ok"
                    } else {
                        "ALLOC FAILED"
                    },
                );
            }
            UserEvent::Hide => {
                // Arrête le suivi des bureaux virtuels sans attendre que la
                // destruction de la fenêtre soit constatée.
                self.desktop_stop.store(true, Ordering::Relaxed);
                if let Some(w) = self.window.take() {
                    w.set_visible(false);
                    // Drop the window so the compositor truly releases it.
                    drop(w);
                }
                self.surface = None;
                self.pixmap = None;
                log::info!("[Sion][CursorOverlay] window hidden");
            }
            UserEvent::Shutdown => {
                self.window = None;
                self.surface = None;
                self.pixmap = None;
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                // User closed the window (shouldn't happen since it's
                // undecorated, but belt-and-suspenders): hide rather than
                // exit so the loop can reopen it.
                if let Some(w) = &self.window {
                    w.set_visible(false);
                }
                event_loop.set_control_flow(ControlFlow::Wait);
            }
            WindowEvent::RedrawRequested => {
                // Mesure du coût réel du rendu (diagnostic : l'overlay
                // plein écran en software est suspecté de saturer le CPU
                // du sharer — voir logs `redraw Nms`).
                let t_redraw = Instant::now();
                self.redraw();
                self.redraw_ms_total += t_redraw.elapsed().as_millis() as u64;
                self.redraw_count += 1;
                if self.redraw_count % 300 == 0 {
                    log::info!(
                        "[Sion][CursorOverlay] redraw {}ms en moyenne ({} frames)",
                        self.redraw_ms_total / self.redraw_count.max(1),
                        self.redraw_count
                    );
                    self.redraw_ms_total = 0;
                    self.redraw_count = 0;
                }
                // Redessin conditionné : à 60 Hz en continu, le remplissage
                // plein écran + le texte à chaque frame coûtent cher sur la
                // machine du sharer (qui capture + encode déjà) → saccades
                // pour tout le monde. On n'anime que si nécessaire :
                // - clics actifs : on maintient une cadence d'animation ;
                // - sinon (curseurs figés) : on dort jusqu'à la prochaine
                //   expiration (sweep), zéro CPU entre-temps.
                let (animate, wake_at) = {
                    let s = self.state.lock().unwrap();
                    let clicks = !s.clicks.is_empty();
                    let mut wake: Option<Instant> = None;
                    for c in s.cursors.values() {
                        wake = Some(wake.map_or(c.expires_at, |t| t.min(c.expires_at)));
                    }
                    for c in &s.clicks {
                        wake = Some(wake.map_or(c.expires_at, |t| t.min(c.expires_at)));
                    }
                    (clicks, wake)
                };
                // Cadence ~30 Hz pour les clics : à 5120 px de large, le
                // remplissage plein écran + le texte à chaque frame saturent
                // inutilement le CPU du sharer, qui capture et encode déjà.
                if animate {
                    event_loop.set_control_flow(ControlFlow::WaitUntil(
                        Instant::now() + Duration::from_millis(33),
                    ));
                    if let Some(w) = &self.window {
                        w.request_redraw();
                    }
                } else if let Some(t) = wake_at {
                    // Un seul redraw à l'expiration (le sweep purge alors).
                    // `request_redraw` dès maintenant : la demande reste en
                    // file et n'est servie qu'au réveil à `t`.
                    if let Some(w) = &self.window {
                        w.request_redraw();
                    }
                    event_loop.set_control_flow(ControlFlow::WaitUntil(t));
                } else {
                    event_loop.set_control_flow(ControlFlow::Wait);
                }
            }
            WindowEvent::Resized(size) => {
                if let (Some(surface), Ok(w), Ok(h)) = (
                    self.surface.as_mut(),
                    std::num::NonZeroU32::try_from(size.width),
                    std::num::NonZeroU32::try_from(size.height),
                ) {
                    let _ = surface.resize(w, h);
                }
                self.pixmap = Pixmap::new(size.width, size.height);
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            _ => {}
        }
    }
}
