//! Pendant un appel, Sion ne doit pas passer après un jeu.
//!
//! Narkow (30/09) : Watch Dogs lancé sous Windows, la voix hachait dans les
//! deux sens — pas avec Discord. Les threads audio de WebRTC (capture, rendu)
//! sont déjà en priorité multimédia (MMCSS « Pro Audio »), mais le reste du
//! trajet — encodage Opus, chiffrement des trames, thread réseau qui envoie
//! et reçoit les paquets — tourne en priorité normale : un jeu qui occupe
//! tous les cœurs le fait attendre, les paquets partent et arrivent par
//! à-coups. Et Sion, en arrière-plan derrière le jeu en plein écran, peut
//! être bridé par Windows 11 (EcoQoS : fréquence réduite, cœurs économes).
//!
//! Le temps de l'appel : priorité « supérieure à la normale » (jamais une
//! baisse, si quelqu'un l'a montée à la main) et plus de bridage
//! d'arrière-plan. Tout revient à l'état d'origine en quittant l'appel.
//!
//! Linux : pas de changement. Son ordonnanceur partage le processeur
//! équitablement, et chaque application de bureau a son propre groupe
//! (cgroup) : un jeu n'y affame pas Sion, sauf s'il est « renicé »
//! (GameMode). Rien n'a été constaté.

#[cfg(windows)]
mod windows_impl {
    use std::sync::Mutex;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetPriorityClass, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        PROCESS_CREATION_FLAGS, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, PROCESS_POWER_THROTTLING_STATE,
    };

    /// En appel : la classe de priorité d'avant, pour la rendre en sortant.
    static AVANT: Mutex<Option<u32>> = Mutex::new(None);

    /// `controle` : les bridages que l'on décide soi-même ; `etat` : ceux
    /// que l'on garde. (0, 0) rend la main au système.
    fn bridage(controle: u32, etat: u32) -> windows::core::Result<()> {
        let s = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: controle,
            StateMask: etat,
        };
        unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                ProcessPowerThrottling,
                &s as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        }
    }

    pub fn entrer() {
        let mut avant = AVANT.lock().unwrap_or_else(|e| e.into_inner());
        if avant.is_some() {
            return; // déjà en appel (changement de salon)
        }
        let classe = unsafe { GetPriorityClass(GetCurrentProcess()) };
        let basse = [IDLE_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS]
            .iter()
            .any(|c| c.0 == classe);
        if basse {
            match unsafe { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) } {
                Ok(()) => log::info!("[Sion][voix] appel : priorité supérieure à la normale"),
                Err(e) => log::warn!("[Sion][voix] priorité de l'appel non relevée : {e}"),
            }
        }
        // Ni fréquence réduite (EcoQoS), ni résolution d'horloge ignorée en
        // arrière-plan : on décide des deux, et on n'en garde aucun.
        let controle = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
        match bridage(controle, 0) {
            Ok(()) => log::info!("[Sion][voix] appel : pas de bridage d'arrière-plan"),
            Err(e) => log::warn!("[Sion][voix] bridage d'arrière-plan non levé : {e}"),
        }
        *avant = Some(classe);
    }

    pub fn sortir() {
        let Some(classe) = AVANT.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        let actuelle = unsafe { GetPriorityClass(GetCurrentProcess()) };
        // Seulement si c'est toujours notre réglage (pas changé à la main depuis).
        if actuelle == ABOVE_NORMAL_PRIORITY_CLASS.0 && classe != actuelle {
            if let Err(e) = unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_CREATION_FLAGS(classe)) } {
                log::warn!("[Sion][voix] priorité d'origine non rendue : {e}");
            }
        }
        let _ = bridage(0, 0);
        log::info!("[Sion][voix] fin d'appel : priorité et bridage rendus au système");
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn priorite_relevee_pendant_l_appel_puis_rendue() {
            let origine = unsafe { GetPriorityClass(GetCurrentProcess()) };
            assert_eq!(origine, NORMAL_PRIORITY_CLASS.0, "le test part d'un processus normal");
            // Windows accepte de lever le bridage, puis de le rendre.
            let controle = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
            bridage(controle, 0).expect("bridage levé");
            bridage(0, 0).expect("bridage rendu");
            entrer();
            assert_eq!(unsafe { GetPriorityClass(GetCurrentProcess()) }, ABOVE_NORMAL_PRIORITY_CLASS.0);
            entrer(); // changement de salon : rien ne bouge
            sortir();
            assert_eq!(unsafe { GetPriorityClass(GetCurrentProcess()) }, origine);
            sortir(); // déjà sorti : sans effet
            assert_eq!(unsafe { GetPriorityClass(GetCurrentProcess()) }, origine);
        }
    }
}

/// Début d'un appel (connexion au serveur média).
pub fn entrer() {
    #[cfg(windows)]
    windows_impl::entrer();
}

/// Fin d'un appel.
pub fn sortir() {
    #[cfg(windows)]
    windows_impl::sortir();
}
