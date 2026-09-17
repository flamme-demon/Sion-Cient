# Patch Sion — tauri-runtime-wry 2.11.4

## Problème

Sous Linux, le gestionnaire de redimensionnement sans décorations supposait
une hiérarchie GTK fixe `WebView -> GtkBox -> GtkWindow`. Un `GtkOverlay`
intermédiaire faisait échouer le `downcast().unwrap()` au premier clic et
arrêtait le processus dans un callback GTK. Replacer une WebView déjà réalisée
dans cet overlay s'est également montré fragile avec sa couche accélérée sous
Wayland.

Le problème amont est suivi dans :
https://github.com/tauri-apps/wry/issues/1808

## Correctif

`src/undecorated_resizing.rs` recherche maintenant la première `GtkWindow`
dans les ancêtres de la WebView. Le redimensionnement souris et tactile reste
donc actif quelle que soit la profondeur des conteneurs, sans `unwrap()` dans
les callbacks GTK.

Dans `src/lib.rs`, le `GtkOverlay` est créé et ajouté au vbox avant `build_gtk`,
puis la WebView est construite directement comme son enfant principal. C'est
le chemin Sion par défaut ; `SION_DISABLE_NATIVE_VIDEO_SURFACE=1` rétablit le
conteneur publié par `tauri-runtime-wry` 2.11.4 pour le diagnostic.

## Retrait

Supprimer ce fork et l'entrée `tauri-runtime-wry` de `[patch.crates-io]` dès
qu'une version stable Tauri reprend un correctif équivalent.
