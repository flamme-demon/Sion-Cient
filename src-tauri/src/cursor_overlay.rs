//! Native cursor overlay window — transparent, click-through, always-on-top.
//!
//! Replaces the previous Tauri-webview approach which was broken on Linux
//! under the CEF runtime fork (the fork doesn't forward `transparent: true`
//! to CEF window creation, so additional webviews came up opaque). We draw
//! the overlay ourselves with winit + tiny-skia — works on Linux (X11 +
//! Wayland) and Windows, roughly one Rust backend instead of CEF-specific
//! quirks on every platform.
//!
//! Architecture:
//!   - A single background thread hosts the winit event loop. It's spawned
//!     on first `cursor_overlay_open` and stays alive until the app exits
//!     or `cursor_overlay_shutdown` is called.
//!   - The JS side pushes cursor/click events via `cursor_overlay_push*`
//!     commands; they land in a shared `Mutex<OverlayState>`.
//!   - The event loop requests a redraw at ~60 Hz whenever the state is
//!     non-empty. tiny-skia draws cursor arrows + click ripples into a
//!     `Pixmap`, which `softbuffer` blits to the window surface.
//!   - `winit` itself handles X11/Wayland selection and ARGB visuals via
//!     `with_transparent(true)` + `with_cursor_hittest(false)` — no
//!     platform-specific XShape / set_input_region code to maintain.
//!
//! Why not use winit across ALL windowing (replacing CEF): winit is a
//! windowing library, it doesn't render webviews. The main Sion UI needs
//! the full HTML/CSS/JS stack, so CEF stays for that. This overlay only
//! paints cursors and ripples — simple enough for native 2D.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use softbuffer::{Context, Surface};
use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

// Re-imports listed here are all used by the text-rendering path
// (`Font::outline_glyph`, `PxScale`, `ScaleFont` extension methods).
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId, WindowLevel};

/// Embedded font for the cursor name pill — DejaVu Sans Bold (Bitstream
/// Vera derivative, free license). ~700 KB; loaded once on first redraw.
const FONT_BYTES: &[u8] = include_bytes!("../assets/DejaVuSans-Bold.ttf");
static FONT: OnceLock<Option<FontRef<'static>>> = OnceLock::new();
fn font() -> Option<&'static FontRef<'static>> {
    FONT.get_or_init(|| {
        FontRef::try_from_slice(FONT_BYTES).ok()
    }).as_ref()
}

/// One remote viewer's cursor, kept between frames until `expires_at`.
/// We track both the network-reported target position and the currently-
/// rendered position so we can lerp between updates and hide the 30 Hz
/// broadcast cadence.
#[derive(Clone, Debug)]
struct CursorEntry {
    identity: String,
    /// Display name to render in the pill below the cursor.
    name: String,
    /// Latest broadcast position (normalised [0, 1]).
    target_x: f32,
    target_y: f32,
    /// Smoothed render position; eased toward target every frame.
    render_x: f32,
    render_y: f32,
    expires_at: Instant,
}

/// One one-shot click ripple. Animates for ~600 ms then is swept.
#[derive(Clone, Debug)]
struct ClickEntry {
    /// JS-side id — kept purely for debugging / log correlation.
    #[allow(dead_code)]
    id: String,
    identity: String,
    x: f32,
    y: f32,
    born_at: Instant,
    expires_at: Instant,
}

#[derive(Default)]
struct OverlayState {
    cursors: HashMap<String, CursorEntry>,
    clicks: Vec<ClickEntry>,
}

/// Messages the Tauri commands send to the event loop thread via
/// `EventLoopProxy::send_event`.
#[derive(Debug)]
#[allow(dead_code)]
enum UserEvent {
    Show,
    Hide,
    /// App is quitting — close the loop cleanly. Unused today; kept for
    /// when we eventually wire a Tauri `exit` hook to tear this down.
    Shutdown,
}

struct OverlayHandle {
    state: Arc<Mutex<OverlayState>>,
    proxy: EventLoopProxy<UserEvent>,
    thread_alive: Arc<AtomicBool>,
}

static HANDLE: OnceLock<OverlayHandle> = OnceLock::new();

/// Start the winit event-loop thread on first use. Idempotent — subsequent
/// calls return the existing handle.
///
/// On Linux the `EventLoop` is `!Send` (it holds `Rc`s into the compositor
/// connection), so it must be constructed *inside* the thread that will
/// run it. We ship the `EventLoopProxy` back out via a oneshot channel —
/// the proxy IS `Send`, that's its whole point.
fn get_or_start_handle() -> Option<&'static OverlayHandle> {
    if let Some(h) = HANDLE.get() {
        return Some(h);
    }

    let state = Arc::new(Mutex::new(OverlayState::default()));
    let thread_alive = Arc::new(AtomicBool::new(true));
    let (proxy_tx, proxy_rx) = std::sync::mpsc::channel::<Option<EventLoopProxy<UserEvent>>>();

    let state_clone = state.clone();
    let alive_clone = thread_alive.clone();
    thread::Builder::new()
        .name("sion-cursor-overlay".into())
        .spawn(move || {
            // `with_any_thread(true)` lets us build + run the loop off
            // the OS main thread. Supported on Linux (X11/Wayland) and
            // Windows; not macOS (Sion doesn't target macOS anyway).
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
            }
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

    let proxy = match proxy_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("[Sion][CursorOverlay] event loop thread failed to initialise");
            return None;
        }
        Err(err) => {
            log::warn!("[Sion][CursorOverlay] timed out waiting for event-loop proxy: {err:?}");
            return None;
        }
    };

    let handle = OverlayHandle { state, proxy, thread_alive };
    let _ = HANDLE.set(handle);
    HANDLE.get()
}

// ── winit app ──────────────────────────────────────────────────────────

struct App {
    state: Arc<Mutex<OverlayState>>,
    window: Option<Arc<Window>>,
    // softbuffer needs its Context bound to the window; keep both alive.
    surface: Option<Surface<Arc<Window>, Arc<Window>>>,
    // Canvas-space pixmap, resized to match the window.
    pixmap: Option<Pixmap>,
    last_frame: Instant,
    frame_counter: u64,
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
        let mon = event_loop.primary_monitor()
            .or_else(|| event_loop.available_monitors().next());
        let (size, pos) = if let Some(m) = mon {
            log::info!("[Sion][CursorOverlay] using monitor {:?} size={:?} pos={:?}", m.name(), m.size(), m.position());
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

        // Linux X11/Wayland: make sure the window shows on all workspaces
        // so it overlays the sharer's current work area even if they
        // switch virtual desktops during the share.
        // (winit 0.30 doesn't have a portable API for this; it's a
        // nice-to-have rather than a blocker.)

        Some(window)
    }

    fn redraw(&mut self) {
        let (Some(window), Some(surface), Some(pixmap)) = (self.window.as_ref(), self.surface.as_mut(), self.pixmap.as_mut()) else {
            log::warn!("[Sion][CursorOverlay] redraw skipped — window/surface/pixmap not ready");
            return;
        };

        // Sweep expired entries + ease render position toward target.
        // Broadcasts arrive at ~60 Hz, matching our redraw cadence. We
        // mostly snap (lerp 0.7) so the cursor feels native-smooth, with
        // just enough easing to absorb a dropped packet or two without
        // visible "skip" — at 0.7 a 50 px gap collapses to <2 px in 4
        // frames (~67 ms) which the eye reads as smooth motion.
        let now = Instant::now();
        let (cursor_count, click_count) = {
            let mut state = match self.state.lock() {
                Ok(s) => s,
                Err(poisoned) => poisoned.into_inner(),
            };
            state.cursors.retain(|_, c| c.expires_at > now);
            state.clicks.retain(|c| c.expires_at > now);
            for c in state.cursors.values_mut() {
                let lerp = 0.7_f32;
                c.render_x += (c.target_x - c.render_x) * lerp;
                c.render_y += (c.target_y - c.render_y) * lerp;
            }
            (state.cursors.len(), state.clicks.len())
        };

        // Log every ~60 frames (~1s @ 60Hz) when we have something to draw,
        // so the user can see the redraw loop is alive in the log.
        self.frame_counter = self.frame_counter.wrapping_add(1);
        if (cursor_count > 0 || click_count > 0) && self.frame_counter % 60 == 0 {
            log::info!(
                "[Sion][CursorOverlay] frame #{} cursors={} clicks={}",
                self.frame_counter, cursor_count, click_count,
            );
        }

        // Clear the pixmap (fully transparent).
        pixmap.fill(Color::TRANSPARENT);

        let (ww, wh) = {
            let size = window.inner_size();
            (size.width as f32, size.height as f32)
        };

        draw::draw(pixmap, ww, wh, &self.state.lock().unwrap(), now);

        // Blit into the softbuffer surface.
        if let Ok(mut buffer) = surface.buffer_mut() {
            // softbuffer expects BGRA or platform-native u32. tiny-skia
            // produces RGBA premultiplied. We repack on copy.
            let src = pixmap.data();
            let dst = &mut buffer;
            let total = dst.len().min(src.len() / 4);
            for i in 0..total {
                let off = i * 4;
                let r = src[off] as u32;
                let g = src[off + 1] as u32;
                let b = src[off + 2] as u32;
                let a = src[off + 3] as u32;
                dst[i] = (a << 24) | (r << 16) | (g << 8) | b;
            }
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
                let Some(window) = self.build_window(event_loop) else { return; };
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
                if let (Ok(w), Ok(h)) = (std::num::NonZeroU32::try_from(size.width), std::num::NonZeroU32::try_from(size.height)) {
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
                    size.width, size.height, pos,
                    if self.pixmap.is_some() { "ok" } else { "ALLOC FAILED" },
                );
            }
            UserEvent::Hide => {
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

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _window_id: WindowId, event: WindowEvent) {
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
                self.redraw();
                // Keep animating while we have cursors or active clicks.
                let pending = {
                    let s = self.state.lock().unwrap();
                    !s.cursors.is_empty() || !s.clicks.is_empty()
                };
                if pending {
                    event_loop.set_control_flow(ControlFlow::WaitUntil(
                        Instant::now() + Duration::from_millis(16),
                    ));
                    if let Some(w) = &self.window { w.request_redraw(); }
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
                if let Some(w) = &self.window { w.request_redraw(); }
            }
            _ => {}
        }
    }
}

// ── drawing ─────────────────────────────────────────────────────────────

mod draw {
    use super::*;

    pub(super) fn draw(pixmap: &mut Pixmap, w: f32, h: f32, state: &OverlayState, now: Instant) {
        for click in &state.clicks {
            draw_ripple(pixmap, w, h, click, now);
        }
        for cursor in state.cursors.values() {
            draw_cursor(pixmap, w, h, cursor);
        }
    }

    fn color_for_identity(identity: &str) -> Color {
        let mut h: i32 = 0;
        for c in identity.chars() {
            h = ((h.wrapping_shl(5)).wrapping_sub(h)).wrapping_add(c as i32);
        }
        let hue = (h.unsigned_abs() % 360) as f32;
        let (r, g, b) = hsl_to_rgb(hue, 0.75, 0.55);
        Color::from_rgba8(r, g, b, 255)
    }

    fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
        let m = l - c / 2.0;
        let (r, g, b) = match h as u32 {
            0..=59 => (c, x, 0.0),
            60..=119 => (x, c, 0.0),
            120..=179 => (0.0, c, x),
            180..=239 => (0.0, x, c),
            240..=299 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        (
            ((r + m) * 255.0) as u8,
            ((g + m) * 255.0) as u8,
            ((b + m) * 255.0) as u8,
        )
    }

    fn draw_cursor(pixmap: &mut Pixmap, w: f32, h: f32, cursor: &CursorEntry) {
        let x = (cursor.render_x.clamp(0.0, 1.0)) * w;
        let y = (cursor.render_y.clamp(0.0, 1.0)) * h;
        let color = color_for_identity(&cursor.identity);

        // Compact arrow path (~14×17 units) modelled on the macOS / GNOME
        // cursor shape — tip at (0,0), short tail down-right, no overhang.
        let scale = 1.4_f32;
        let mut pb = PathBuilder::new();
        pb.move_to(x + 0.0 * scale,  y + 0.0 * scale);   // tip
        pb.line_to(x + 0.0 * scale,  y + 14.0 * scale);  // left side down
        pb.line_to(x + 3.5 * scale,  y + 11.0 * scale);  // notch
        pb.line_to(x + 6.0 * scale,  y + 16.0 * scale);  // tail tip
        pb.line_to(x + 7.5 * scale,  y + 15.0 * scale);  // tail base
        pb.line_to(x + 5.0 * scale,  y + 10.0 * scale);  // notch up
        pb.line_to(x + 10.0 * scale, y + 10.0 * scale);  // right side
        pb.close();
        let path = match pb.finish() { Some(p) => p, None => return };

        // White stroke first (wider) for contrast against any background.
        let mut stroke_paint = Paint::default();
        stroke_paint.set_color(Color::from_rgba8(255, 255, 255, 255));
        stroke_paint.anti_alias = true;
        let stroke = Stroke {
            width: 2.0,
            line_join: tiny_skia::LineJoin::Round,
            ..Stroke::default()
        };
        pixmap.stroke_path(&path, &stroke_paint, &stroke, Transform::identity(), None);

        // Coloured fill.
        let mut fill_paint = Paint::default();
        fill_paint.set_color(color);
        fill_paint.anti_alias = true;
        pixmap.fill_path(&path, &fill_paint, FillRule::Winding, Transform::identity(), None);

        // Name pill — drawn just below + right of the cursor tail so it
        // doesn't sit on top of the click target. Coloured background +
        // white text + soft shadow rectangle for legibility on busy
        // screens. The pill is anchored at (x, y + cursor_height).
        if !cursor.name.is_empty() {
            let pill_anchor_x = x + 4.0;
            let pill_anchor_y = y + (16.0 * scale) + 4.0;
            draw_name_pill(pixmap, w, h, pill_anchor_x, pill_anchor_y, &cursor.name, color);
        }
    }

    /// Render a coloured pill containing the cursor owner's name. tiny-skia
    /// has no text support, so we lay out the glyphs with `ab_glyph` and
    /// blend each rasterised mask straight into the pixmap.
    fn draw_name_pill(
        pixmap: &mut Pixmap,
        w: f32,
        h: f32,
        anchor_x: f32,
        anchor_y: f32,
        name: &str,
        color: Color,
    ) {
        let Some(font) = font() else { return };

        // Cap displayed text to keep the pill from running off the screen
        // edge. 28 chars covers most Matrix display names without spilling.
        const MAX_CHARS: usize = 28;
        let display: String = if name.chars().count() > MAX_CHARS {
            name.chars().take(MAX_CHARS - 1).collect::<String>() + "…"
        } else {
            name.to_string()
        };

        let px = 18.0_f32;
        let scale_font = font.as_scaled(PxScale::from(px));
        let ascent = scale_font.ascent();
        let descent = scale_font.descent();
        let line_h = ascent - descent;

        // Layout: walk glyphs to compute total width.
        let mut text_w = 0.0_f32;
        let mut chars_iter = display.chars().peekable();
        while let Some(ch) = chars_iter.next() {
            let glyph_id = scale_font.glyph_id(ch);
            text_w += scale_font.h_advance(glyph_id);
            if let Some(&next) = chars_iter.peek() {
                text_w += scale_font.kern(glyph_id, scale_font.glyph_id(next));
            }
        }

        let pad_x = 8.0_f32;
        let pad_y = 4.0_f32;
        let pill_w = text_w + pad_x * 2.0;
        let pill_h = line_h + pad_y * 2.0;

        // Clamp the pill onto the screen so it never disappears past an edge.
        let pill_x = anchor_x.min(w - pill_w - 2.0).max(2.0);
        let pill_y = anchor_y.min(h - pill_h - 2.0).max(2.0);

        // Rounded-ish rectangle background. tiny-skia has no native rounded
        // rect, but a fill_rect with a 1-px border looks fine at this size.
        if let Some(rect) = Rect::from_xywh(pill_x, pill_y, pill_w, pill_h) {
            let mut bg_paint = Paint::default();
            bg_paint.set_color(color);
            bg_paint.anti_alias = false;
            pixmap.fill_rect(rect, &bg_paint, Transform::identity(), None);
        }

        // Draw each glyph in white with the same shadow trick (drop a
        // semi-transparent black silhouette one pixel down-right first).
        let baseline_y = pill_y + pad_y + ascent;
        let mut pen_x = pill_x + pad_x;
        let mut chars_iter = display.chars().peekable();
        while let Some(ch) = chars_iter.next() {
            let glyph_id = scale_font.glyph_id(ch);
            let glyph = glyph_id.with_scale_and_position(
                PxScale::from(px),
                ab_glyph::point(pen_x, baseline_y),
            );
            if let Some(outlined) = font.outline_glyph(glyph) {
                let bb = outlined.px_bounds();
                outlined.draw(|gx, gy, alpha| {
                    let dx = bb.min.x as i32 + gx as i32;
                    let dy = bb.min.y as i32 + gy as i32;
                    if dx < 0 || dy < 0 { return; }
                    let (px_w, px_h) = (pixmap.width() as i32, pixmap.height() as i32);
                    if dx >= px_w || dy >= px_h { return; }
                    let idx = (dy as u32 * pixmap.width() + dx as u32) as usize * 4;
                    let data = pixmap.data_mut();
                    if idx + 3 >= data.len() { return; }
                    // Source over: white text with `alpha`, blend over the
                    // existing premultiplied background.
                    let src_a = (alpha * 255.0) as u32;
                    let inv = 255 - src_a;
                    data[idx]     = ((255 * src_a + data[idx]     as u32 * inv) / 255) as u8;
                    data[idx + 1] = ((255 * src_a + data[idx + 1] as u32 * inv) / 255) as u8;
                    data[idx + 2] = ((255 * src_a + data[idx + 2] as u32 * inv) / 255) as u8;
                    data[idx + 3] = ((255 * src_a + data[idx + 3] as u32 * inv) / 255) as u8;
                });
            }
            pen_x += scale_font.h_advance(glyph_id);
            if let Some(&next) = chars_iter.peek() {
                pen_x += scale_font.kern(glyph_id, scale_font.glyph_id(next));
            }
        }
    }

    fn draw_ripple(pixmap: &mut Pixmap, w: f32, h: f32, click: &ClickEntry, now: Instant) {
        let x = (click.x.clamp(0.0, 1.0)) * w;
        let y = (click.y.clamp(0.0, 1.0)) * h;
        let color = color_for_identity(&click.identity);

        // 3 concentric rings, each with a stagger, animating from 0.4 to
        // 3.0 scale and opacity 0.85 → 0 over 600 ms. Mirrors the SVG
        // `sion-ripple` keyframe animation in the old Tauri overlay.
        let base_radius = 18.0_f32;
        let total_ms = 600.0_f32;
        for (i, stagger_ms) in [0.0, 120.0, 240.0].iter().enumerate() {
            let elapsed = (now.saturating_duration_since(click.born_at).as_millis() as f32) - stagger_ms;
            if elapsed <= 0.0 || elapsed >= total_ms { continue; }
            let t = elapsed / total_ms; // 0..1
            let scale = 0.4 + (3.0 - 0.4) * t;
            let alpha_f = 0.85 * (1.0 - t);
            let alpha = (alpha_f.clamp(0.0, 1.0) * 255.0) as u8;
            let radius = base_radius * scale;
            if radius < 1.0 { continue; }
            let mut pb = PathBuilder::new();
            pb.push_circle(x, y, radius);
            let path = match pb.finish() { Some(p) => p, None => continue };
            let mut paint = Paint::default();
            // Use the identity colour with per-ring alpha.
            paint.set_color(Color::from_rgba8(
                (color.red() * 255.0) as u8,
                (color.green() * 255.0) as u8,
                (color.blue() * 255.0) as u8,
                alpha,
            ));
            paint.anti_alias = true;
            let _ = i;
            let stroke = Stroke {
                width: 3.0,
                line_join: tiny_skia::LineJoin::Round,
                ..Stroke::default()
            };
            pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn cursor_overlay_open() -> bool {
    let Some(handle) = get_or_start_handle() else { return false; };
    if !handle.thread_alive.load(Ordering::Acquire) {
        log::warn!("[Sion][CursorOverlay] thread is not alive anymore, open skipped");
        return false;
    }
    let _ = handle.proxy.send_event(UserEvent::Show);
    true
}

#[tauri::command]
pub fn cursor_overlay_close() {
    let Some(handle) = HANDLE.get() else { return; };
    let _ = handle.proxy.send_event(UserEvent::Hide);
    if let Ok(mut state) = handle.state.lock() {
        state.cursors.clear();
        state.clicks.clear();
    }
}

#[tauri::command]
pub fn cursor_overlay_push(identity: String, name: String, x: f32, y: f32, expires_at_ms: u64) {
    let Some(handle) = HANDLE.get() else { return; };
    if let Ok(mut state) = handle.state.lock() {
        let ttl = Duration::from_millis(expires_at_ms.saturating_sub(now_ms()));
        state.cursors.entry(identity.clone())
            .and_modify(|c| {
                // Existing cursor: just update target + name, keep render
                // position so the lerp continues from where we are.
                c.target_x = x;
                c.target_y = y;
                c.name = name.clone();
                c.expires_at = Instant::now() + ttl;
            })
            .or_insert_with(|| CursorEntry {
                identity,
                name,
                target_x: x,
                target_y: y,
                // Seed render = target on first appearance so the cursor
                // shows up at the right spot, not at (0, 0).
                render_x: x,
                render_y: y,
                expires_at: Instant::now() + ttl,
            });
    }
    let _ = handle.proxy.send_event(UserEvent::Show); // kick redraw
}

#[tauri::command]
pub fn cursor_overlay_clear(identity: String) {
    let Some(handle) = HANDLE.get() else { return; };
    if let Ok(mut state) = handle.state.lock() {
        state.cursors.remove(&identity);
    }
}

#[tauri::command]
pub fn cursor_overlay_push_click(id: String, identity: String, x: f32, y: f32, expires_at_ms: u64) {
    let Some(handle) = HANDLE.get() else { return; };
    if let Ok(mut state) = handle.state.lock() {
        let now = Instant::now();
        let ttl = Duration::from_millis(expires_at_ms.saturating_sub(now_ms()));
        state.clicks.push(ClickEntry {
            id,
            identity,
            x,
            y,
            born_at: now,
            expires_at: now + ttl,
        });
    }
    let _ = handle.proxy.send_event(UserEvent::Show);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
