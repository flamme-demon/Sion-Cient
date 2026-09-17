//! Suivi des bureaux virtuels Windows pour la fenêtre d'overlay.
//!
//! **Le problème.** Sous Windows, une fenêtre appartient au bureau virtuel sur
//! lequel elle a été créée. L'overlay des curseurs naît au démarrage du
//! partage : changer de bureau le laisse derrière, et les viewers ne voient
//! plus leurs pointeurs alors que le partage, lui, suit l'écran.
//!
//! **Pourquoi pas l'épinglage.** Windows sait afficher une fenêtre sur tous les
//! bureaux, mais l'API correspondante (`IVirtualDesktopPinnedApps`) n'est pas
//! documentée et ses identifiants d'interface changent à chaque version
//! majeure : du code qui marche casse silencieusement à la mise à jour
//! suivante. L'équivalent manuel — clic droit dans la Vue des tâches — n'est
//! pas davantage disponible : l'overlay est sans décoration, traversant aux
//! clics et n'y figure pas.
//!
//! **Ce qu'on fait.** `IVirtualDesktopManager` est documenté et stable depuis
//! Windows 10. On vérifie périodiquement si l'overlay est resté en arrière et,
//! le cas échéant, on le déplace sur le bureau courant — dont l'identifiant est
//! lu sur la fenêtre au premier plan, forcément visible. L'overlay SUIT donc
//! l'utilisateur au lieu d'exister partout à la fois ; pour des curseurs de
//! viewers, c'est équivalent, un seul bureau étant visible à la fois.
//!
//! Le suivi vit sur son propre fil : la boucle de rendu de l'overlay dort en
//! `ControlFlow::Wait` quand rien ne bouge, et la réveiller une fois par
//! seconde pour cette vérification lui coûterait du CPU sur la machine qui
//! capture et encode déjà.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow};

/// Intervalle de vérification. Assez court pour que le retard ne se voie pas
/// après un changement de bureau, assez long pour être invisible côté CPU.
const INTERVALLE: Duration = Duration::from_millis(700);

/// Démarre le suivi pour une fenêtre. Le fil s'arrête de lui-même quand la
/// fenêtre disparaît ou quand `arret` passe à vrai.
pub fn suivre(hwnd_brut: isize, arret: Arc<AtomicBool>) {
    let _ = std::thread::Builder::new()
        .name("sion-overlay-bureaux".into())
        .spawn(move || boucle(hwnd_brut, arret));
}

fn boucle(hwnd_brut: isize, arret: Arc<AtomicBool>) {
    let hwnd = HWND(hwnd_brut as *mut core::ffi::c_void);
    // COM par fil : ce fil est le sien, donc il l'initialise. Un `S_FALSE`
    // signifie « déjà initialisé », ce qui n'est pas une erreur.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let gestionnaire: IVirtualDesktopManager =
        match unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL) } {
            Ok(g) => g,
            Err(err) => {
                log::warn!(
                    "[Sion][CursorOverlay] gestionnaire de bureaux virtuels indisponible: {err}"
                );
                return;
            }
        };

    let mut echecs = 0u32;
    while !arret.load(Ordering::Relaxed) {
        std::thread::sleep(INTERVALLE);
        if arret.load(Ordering::Relaxed) {
            break;
        }
        if !unsafe { IsWindow(hwnd) }.as_bool() {
            // Fenêtre détruite : plus rien à suivre.
            return;
        }
        let ici = match unsafe { gestionnaire.IsWindowOnCurrentVirtualDesktop(hwnd) } {
            Ok(v) => v.as_bool(),
            Err(_) => continue,
        };
        if ici {
            echecs = 0;
            continue;
        }
        // Resté en arrière. L'identifiant du bureau visible se lit sur la
        // fenêtre au premier plan : l'API ne l'expose pas directement.
        let premier_plan = unsafe { GetForegroundWindow() };
        if premier_plan.0.is_null() {
            continue;
        }
        let cible = match unsafe { gestionnaire.GetWindowDesktopId(premier_plan) } {
            Ok(guid) => guid,
            Err(_) => continue,
        };
        match unsafe { gestionnaire.MoveWindowToDesktop(hwnd, &cible) } {
            Ok(()) => {
                echecs = 0;
                log::info!("[Sion][CursorOverlay] overlay ramené sur le bureau virtuel courant");
            }
            Err(err) => {
                // Certaines configurations refusent le déplacement. On le dit
                // une fois puis on se tait : répéter l'avertissement à chaque
                // cycle noierait le journal pendant tout le partage.
                echecs += 1;
                if echecs == 1 {
                    log::warn!(
                        "[Sion][CursorOverlay] déplacement entre bureaux refusé ({err}) — \
                         l'overlay restera sur son bureau d'origine"
                    );
                }
            }
        }
    }
}
