# Patch Sion — notify-rust 4.18.0

## Problème

`notify-rust` 4.18.0 compile avec la feature `z` (zbus + async-io), mais le
graphe active `zbus/tokio` (via `ashpd/tokio` et `rfd/tokio`). Dans cette
configuration, `zbus::block_on` construit ou réutilise un runtime Tokio et
appelle `Runtime::block_on`.

`tauri-plugin-notification` exécute `Notification::show()` dans
`tauri::async_runtime::spawn(...)`, donc sur un worker Tokio :
`Runtime::block_on` y panique immédiatement avec « Cannot start a runtime
from within a runtime ». Les notifications partent en panique de thread et
n'atteignent jamais le bureau Linux.

## Correctif

`src/xdg/mod.rs` : les deux chemins `show_notification` zbus appellent
désormais `block_on_detached`, qui exécute `block_on` sur un thread std
`std::thread::scope` — sans runtime Tokio actif sur ce thread.

Aucune autre modification : le reste de la crate est identique à
`notify-rust` 4.18.0 (crates.io), à l'exception de `Cargo.lock` retiré.

## Retrait

Quand `notify-rust` publiera un correctif amont (ou quand `rfd`/`ashpd`
n'activeront plus `zbus/tokio`), supprimer ce fork et l'entrée
`notify-rust` de `[patch.crates-io]`.
