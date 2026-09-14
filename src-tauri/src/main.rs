// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ── Backend graphique sous Linux : Wayland par défaut (2026-09-13) ──────
    // On ne force PLUS X11. La fenêtre principale tourne en Wayland natif quand
    // la session en propose un (sinon GDK retombe seul sur X11).
    //
    // Le prix, assumé : le bouton « retour à Sion » du PIP ne peut pas relever
    // la fenêtre principale — le PIP est une fenêtre X11 (winit, forcée X11
    // pour l'always-on-top : Wayland n'en a pas pour un toplevel ordinaire) et
    // un client X11 ne peut pas fournir de jeton d'activation à une fenêtre
    // Wayland ; le compositeur se contente d'une demande d'attention (entrée
    // qui clignote). La sortie propre est le protocole xx-pip-v1 (PiP en
    // couche overlay) : KWin et Firefox l'implémentent déjà, mais il est
    // désactivé par défaut côté compositeur et absent de Mutter — voir
    // docs/roadmap-2.0.0.md §2.2.
    //
    // `SION_FORCE_X11=1` rétablit l'ancien comportement (tout X11/XWayland, la
    // relève `_NET_ACTIVE_WINDOW` refonctionne). `SION_KEEP_WAYLAND` reste
    // accepté (c'était l'opt-out du temps où X11 était le défaut).
    #[cfg(target_os = "linux")]
    if std::env::var_os("SION_FORCE_X11").is_some() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // ── Repli « page blanche NVIDIA » (2026-09-13) ─────────────────────────
    // Si le web process est déjà tombé une fois sur cette installation (pilote
    // NVIDIA, renderer DMA-BUF cassé), la variable doit être posée AVANT toute
    // init GTK/WebKit : c'est ici. Sinon rien ne se passe (cf. gpu_fallback).
    #[cfg(target_os = "linux")]
    app_lib::gpu_fallback::apply_marker_before_gtk();

    app_lib::run();
}
