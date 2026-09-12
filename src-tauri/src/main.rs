// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ── Backend graphique X11/XWayland sous Linux (2026-09-12) ──────────────
    // La fenêtre principale Wayland-native ne peut PAS être relevée/focus par
    // une autre fenêtre du même processus : Wayland exige un jeton
    // d'activation lié à un geste utilisateur, et le PIP (fenêtre X11 de
    // winit, forcée X11 pour l'always-on-top) ne peut pas en fournir — le
    // compositeur se contente de faire clignoter l'entrée. Sous XWayland, la
    // relève par `_NET_ACTIVE_WINDOW` (méthode des pagers, cf. `pip_window`)
    // fonctionne, et l'app rejoint l'overlay-curseurs/PIP déjà en X11.
    // Écran en échelle 1 → aucun compromis de netteté. Opt-out :
    // `SION_KEEP_WAYLAND=1`.
    #[cfg(target_os = "linux")]
    if std::env::var_os("SION_KEEP_WAYLAND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    app_lib::run();
}
