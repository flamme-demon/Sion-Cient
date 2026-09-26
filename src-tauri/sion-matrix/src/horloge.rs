//! Écart entre l'horloge locale et celle du serveur — port de
//! `src/services/serverClock.ts`.
//!
//! Mesuré sur l'en-tête HTTP `Date` d'une réponse du serveur, JAMAIS sur
//! l'horodatage d'un événement : un vieil événement ne dit rien de l'heure
//! courante. Seule exception, à sens unique : un événement daté dans le futur
//! prouve un retard local. Sert à juger l'expiration des participants vocaux —
//! une horloge fausse vidait sinon la liste (cas réel du 29/07/2026).
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// En deçà, l'écart est du bruit (l'en-tête `Date` est à la seconde).
pub(crate) const TOLERANCE_MS: i64 = 5 * 60 * 1000;
/// Une mesure se refait au bout de dix minutes.
const VALIDITE: Duration = Duration::from_secs(10 * 60);

pub(crate) fn maintenant_local() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
pub(crate) struct Horloge {
    /// (écart local − serveur en ms, instant de la mesure)
    mesure: Mutex<Option<(i64, Instant)>>,
    /// Retard local prouvé par un horodatage futur (négatif), à défaut de mesure.
    retard_prouve: Mutex<i64>,
}

impl Horloge {
    pub fn ecart_ms(&self) -> i64 {
        match *self.mesure.lock().unwrap() {
            Some((ecart, _)) => ecart,
            None => *self.retard_prouve.lock().unwrap(),
        }
    }

    /// L'heure du serveur, estimée — l'heure locale si l'écart est faible.
    pub fn maintenant_serveur(&self) -> i64 {
        let ecart = self.ecart_ms();
        let local = maintenant_local();
        if ecart.abs() <= TOLERANCE_MS {
            local
        } else {
            local - ecart
        }
    }

    /// Écart arrondi à la minute, 0 sous la tolérance (bandeau de l'interface).
    pub fn ecart_minutes(&self) -> i64 {
        let ecart = self.ecart_ms();
        if ecart.abs() > TOLERANCE_MS {
            (ecart as f64 / 60_000.0).round() as i64
        } else {
            0
        }
    }

    /// Un horodatage serveur plus avancé que l'horloge locale (au-delà de la
    /// tolérance) prouve un retard local.
    pub fn noter_horodatage(&self, ts: i64) {
        if ts <= 0 {
            return;
        }
        let derriere = maintenant_local() - ts;
        let mut prouve = self.retard_prouve.lock().unwrap();
        if derriere < -TOLERANCE_MS && derriere < *prouve {
            *prouve = derriere;
        }
    }

    pub fn perimee(&self) -> bool {
        self.mesure.lock().unwrap().is_none_or(|(_, quand)| quand.elapsed() > VALIDITE)
    }

    fn enregistrer(&self, avant: i64, apres: i64, serveur: i64) {
        let ecart = (avant + apres) / 2 - serveur;
        *self.mesure.lock().unwrap() = Some((ecart, Instant::now()));
        if ecart.abs() > TOLERANCE_MS {
            log::warn!("[Sion][horloge] horloge locale décalée de {} min par rapport au serveur", self.ecart_minutes());
        }
    }

    /// Mesure l'écart sur `GET /_matrix/client/versions`. Hors ligne : on
    /// garde la mesure précédente.
    pub async fn sonder(&self, base: &str) {
        let url = format!("{}/_matrix/client/versions", base.trim_end_matches('/'));
        let avant = maintenant_local();
        let Ok(reponse) = matrix_sdk::reqwest::Client::new().get(&url).send().await else { return };
        let apres = maintenant_local();
        let Some(date) = reponse.headers().get(matrix_sdk::reqwest::header::DATE) else { return };
        let Ok(date) = date.to_str() else { return };
        let Ok(serveur) = httpdate::parse_http_date(date) else { return };
        let Ok(serveur) = serveur.duration_since(UNIX_EPOCH) else { return };
        self.enregistrer(avant, apres, serveur.as_millis() as i64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sous_la_tolerance_on_garde_l_heure_locale() {
        let h = Horloge::default();
        let t = maintenant_local();
        h.enregistrer(t, t, t - 60_000); // une minute : du bruit
        assert_eq!(h.ecart_minutes(), 0);
        assert!((h.maintenant_serveur() - maintenant_local()).abs() < 1000);
    }

    #[test]
    fn horloge_en_avance_de_dix_heures_corrigee() {
        // Le cas de pierre, 29/07/2026 : horloge locale +10 h.
        let h = Horloge::default();
        let t = maintenant_local();
        let dix_heures = 10 * 3600 * 1000;
        h.enregistrer(t, t, t - dix_heures);
        assert_eq!(h.ecart_minutes(), 600);
        assert!((h.maintenant_serveur() - (maintenant_local() - dix_heures)).abs() < 1000);
    }

    #[test]
    fn un_horodatage_futur_prouve_un_retard_local() {
        let h = Horloge::default();
        h.noter_horodatage(maintenant_local() + 2 * 3600 * 1000);
        assert_eq!(h.ecart_minutes(), -120);
        // Un vieil événement ne prouve rien.
        let h2 = Horloge::default();
        h2.noter_horodatage(maintenant_local() - 30 * 24 * 3600 * 1000);
        assert_eq!(h2.ecart_minutes(), 0);
    }

    #[test]
    fn la_mesure_l_emporte_sur_la_preuve() {
        let h = Horloge::default();
        h.noter_horodatage(maintenant_local() + 2 * 3600 * 1000);
        let t = maintenant_local();
        h.enregistrer(t, t, t);
        assert_eq!(h.ecart_minutes(), 0);
        assert!(!h.perimee());
    }
}
