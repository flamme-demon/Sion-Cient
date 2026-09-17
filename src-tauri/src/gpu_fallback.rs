//! Repli « page blanche NVIDIA » — WebKitGTK et le renderer DMA-BUF.
//!
//! Sur certains pilotes NVIDIA (bug WebKit 303811, « Blank WebView on NVIDIA
//! RTX 50 series (Blackwell) - GBM buffer fail », toujours ouvert), le web
//! process meurt quelques secondes après le démarrage sur
//! `Failed to create GBM buffer of size … : Invalid argument` : la fenêtre
//! reste blanche alors que l'appli tourne (le front se connecte au serveur de
//! raccourcis, puis la page se recharge en boucle).
//!
//! Le contournement amont est `WEBKIT_DISABLE_DMABUF_RENDERER=1`, mais on ne
//! le pose **pas** par défaut : il coûte une copie d'image par frame et
//! désactive blur/transformées 3D (cf. retour du mainteneur WebKitGTK sur le
//! bug 303811), sur toutes les machines Linux y compris celles qui vont bien.
//!
//! Mécanique, au plus une fois par installation :
//!   1. le web process meurt (« crashed ») dans la fenêtre de démarrage et un
//!      pilote NVIDIA est chargé ;
//!   2. on écrit un marqueur dans le dossier de config ;
//!   3. on relance l'appli, une fois, avec `WEBKIT_DISABLE_DMABUF_RENDERER=1` ;
//!   4. aux lancements suivants, `main()` relit le marqueur et repose la
//!      variable avant l'init GTK (aucun autre changement : l'appli ne
//!      redémarre plus jamais pour ça).
//!
//! La valeur posée par l'utilisateur (`WEBKIT_DISABLE_DMABUF_RENDERER=…`,
//! dont `0` pour réclamer le chemin rapide) gagne toujours, et
//! `SION_DISABLE_GPU_FALLBACK=1` coupe toute la mécanique. Retour en arrière
//! après une mise à jour de pilote : supprimer le marqueur
//! (`~/.config/com.sion.client/webkit-disable-dmabuf-renderer`).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Variable lue par WebKitGTK (UI et web process) au démarrage.
pub const ENV_DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// Interrupteur général du repli (diagnostic, tests).
const ENV_KILL_SWITCH: &str = "SION_DISABLE_GPU_FALLBACK";
/// Diagnostic : traiter la machine comme si un pilote NVIDIA était chargé
/// (test de bout en bout sur un GPU sain, machine de dev).
const ENV_FORCE: &str = "SION_GPU_FALLBACK_FORCE";
/// Identifiant de l'appli (`tauri.conf.json`) — même dossier que `app_config_dir`.
const APP_ID: &str = "com.sion.client";
/// Marqueur : « le repli a déjà été déclenché sur cette installation ».
const MARKER_FILE: &str = "webkit-disable-dmabuf-renderer";
/// On ne relance que si le web process meurt dans les premières secondes : la
/// panne visée est une page blanche au démarrage. Un crash en pleine session
/// (partage d'écran, mémoire) ne doit pas tuer l'appel en cours — WebKit
/// recharge la page tout seul, on laisse faire.
const RELAUNCH_WINDOW: Duration = Duration::from_secs(90);

/// Chemin du marqueur (`~/.config/com.sion.client/<fichier>`).
pub fn marker_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_ID).join(MARKER_FILE))
}

fn kill_switch() -> bool {
    std::env::var_os(ENV_KILL_SWITCH).is_some()
}

/// L'utilisateur a-t-il déjà tranché lui-même (valeur posée, même `0`) ?
fn env_set_externally() -> bool {
    std::env::var_os(ENV_DISABLE_DMABUF).is_some()
}

/// Le marqueur existe-t-il (repli déjà déclenché une fois) ?
pub fn armed() -> bool {
    marker_path().map(|p| p.exists()).unwrap_or(false)
}

/// Pilote NVIDIA chargé ? (`/proc/driver/nvidia/version` n'existe que là.)
pub fn nvidia_present() -> bool {
    std::env::var_os(ENV_FORCE).is_some()
        || Path::new("/proc/driver/nvidia/version").exists()
        || Path::new("/sys/module/nvidia").exists()
}

/// À appeler depuis `main()`, **avant** l'init GTK : repose la variable si un
/// crash a déjà été constaté sur cette installation.
pub fn apply_marker_before_gtk() {
    if kill_switch() || env_set_externally() || !armed() {
        return;
    }
    std::env::set_var(ENV_DISABLE_DMABUF, "1");
    // Le logger Tauri n'existe pas encore à ce stade.
    eprintln!(
        "[Sion][gpu] repli NVIDIA déjà déclenché — renderer DMA-BUF désactivé. \
         Supprimez {} pour le réactiver après une mise à jour de pilote.",
        marker_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<marqueur>".into())
    );
}

/// Faut-il relancer ? Logique pure, testée ci-dessous.
fn should_relaunch(
    reason_is_crash: bool,
    already_armed: bool,
    env_set_externally: bool,
    nvidia: bool,
    uptime: Duration,
) -> bool {
    reason_is_crash && !already_armed && !env_set_externally && nvidia && uptime <= RELAUNCH_WINDOW
}

/// Branche la surveillance du web process (après création de la webview).
pub fn watch_web_process(app: &tauri::AppHandle, view: &webkit2gtk::WebView) {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    if kill_switch() {
        return;
    }
    let started = Instant::now();
    let app = app.clone();
    view.connect_web_process_terminated(move |_view, reason| {
        let crash = matches!(reason, WebProcessTerminationReason::Crashed);
        let uptime = started.elapsed();
        if !should_relaunch(
            crash,
            armed(),
            env_set_externally(),
            nvidia_present(),
            uptime,
        ) {
            log::warn!(
                "[Sion][gpu] web process terminé après {:.0?} (crash={}, nvidia={}, \
                 marqueur={}, variable posée={}) — pas de relance",
                uptime,
                crash,
                nvidia_present(),
                armed(),
                env_set_externally()
            );
            return;
        }
        match write_marker(uptime) {
            Ok(path) => log::warn!(
                "[Sion][gpu] web process tombé après {:.0?} — repli NVIDIA : {} écrit, \
                 relance avec {}=1",
                uptime,
                path.display(),
                ENV_DISABLE_DMABUF
            ),
            Err(err) => {
                log::error!("[Sion][gpu] marqueur impossible à écrire ({err}) — pas de relance");
                return;
            }
        }
        relaunch(&app);
    });
}

fn write_marker(uptime: Duration) -> std::io::Result<PathBuf> {
    let path = marker_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "dossier de configuration introuvable",
        )
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        &path,
        format!(
            "Déclenché {:?} après {} s de fonctionnement (web process tué par le pilote).\n\
             Supprimez ce fichier pour réactiver le renderer DMA-BUF de WebKitGTK\n\
             (après une mise à jour de pilote, par exemple).\n",
            std::time::SystemTime::now(),
            uptime.as_secs()
        ),
    )?;
    Ok(path)
}

/// Relance l'appli avec le contournement posé, puis quitte celle-ci.
fn relaunch(app: &tauri::AppHandle) {
    // Dans une AppImage, `current_exe()` pointe dans le montage (/tmp/.mount_*)
    // qui disparaît avec le processus : on repart de `$APPIMAGE` quand il est là.
    let Some(program) = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
    else {
        log::error!("[Sion][gpu] relance impossible : exécutable introuvable");
        return;
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.args(std::env::args_os().skip(1));
    cmd.env(ENV_DISABLE_DMABUF, "1");
    match cmd.spawn() {
        Ok(_) => {
            log::warn!(
                "[Sion][gpu] nouvelle instance lancée ({}) — fermeture de celle-ci",
                program.display()
            );
            app.exit(0);
        }
        Err(err) => log::error!("[Sion][gpu] relance impossible : {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relance_seulement_sur_crash_nvidia_precoce() {
        let t0 = Duration::from_secs(5);
        // Cas visé : crash au démarrage, NVIDIA, jamais déclenché.
        assert!(should_relaunch(true, false, false, true, t0));
        // Pas de NVIDIA : le repli est ciblé, on ne touche à rien.
        assert!(!should_relaunch(true, false, false, false, t0));
        // Déjà déclenché une fois : jamais deux relances.
        assert!(!should_relaunch(true, true, false, true, t0));
        // L'utilisateur a tranché (dont `0` = chemin rapide réclamé).
        assert!(!should_relaunch(true, false, true, true, t0));
        // Hors fenêtre de démarrage : un crash en session ne tue pas l'appel.
        assert!(!should_relaunch(
            true,
            false,
            false,
            true,
            RELAUNCH_WINDOW + Duration::from_secs(1)
        ));
        // Terminaison propre ou limite mémoire : rien à faire.
        assert!(!should_relaunch(false, false, false, true, t0));
    }
}
