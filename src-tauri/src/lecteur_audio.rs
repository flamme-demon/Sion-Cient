//! Piste sonore du lecteur vidéo natif.
//!
//! Même raison d'être que le côté image : le moteur web ne décode pas de façon
//! fiable chez tout le monde, donc ffmpeg le fait pour nous, dans un processus
//! séparé — voir `lecteur_video.rs` pour le détail du conflit de symboles qui
//! interdit la bibliothèque.
//!
//! ## Qui cadence quoi
//!
//! La carte son est l'horloge : elle consomme à taux fixe, et c'est elle qui
//! régule tout le reste. ffmpeg écrit son PCM dans un tube sans `-re` ; quand
//! la file se remplit, le tube se bouche et ffmpeg attend. Aucune horloge à
//! tenir, aucune dérive à corriger de ce côté.
//!
//! Le son est converti une fois pour toutes au format du périphérique par
//! ffmpeg lui-même — il sait le faire mieux que nous, et cela évite de
//! rééchantillonner à la main dans le rappel audio, où le moindre retard
//! s'entend.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// File d'échantillons entre ffmpeg et la carte son.
///
/// Bornée : sans plafond, ffmpeg décoderait le film entier en mémoire avant
/// que la première seconde ne soit jouée. Deux secondes suffisent à absorber
/// les à-coups du système sans retarder la mise en pause.
struct File {
    echantillons: Mutex<std::collections::VecDeque<f32>>,
    /// Réveille le producteur quand la carte son a fait de la place.
    place: Condvar,
    plafond: usize,
    fini: AtomicBool,
}

/// Lecture sonore en cours.
pub struct Audio {
    arret: Arc<AtomicBool>,
    enfant: Arc<Mutex<Option<std::process::Child>>>,
    /// Échantillons réellement remis à la carte son, pour situer la lecture.
    joues: Arc<AtomicU64>,
    taux: u32,
    canaux: u32,
    pause: Arc<AtomicBool>,
    volume: Arc<Mutex<f32>>,
    // Le flux cpal s'arrête quand il est détruit ; il doit donc vivre aussi
    // longtemps que la lecture. `cpal::Stream` n'est pas `Send`, il reste sur
    // le fil qui l'a créé — d'où le drapeau d'arrêt plutôt qu'un `drop` ici.
    _garde: (),
}

impl Audio {
    /// Position en millisecondes, d'après ce que la carte son a consommé.
    /// C'est la référence temporelle la plus fiable dont on dispose.
    pub fn position_ms(&self) -> u64 {
        let trames = self.joues.load(Ordering::Relaxed) / u64::from(self.canaux.max(1));
        trames * 1000 / u64::from(self.taux.max(1))
    }

    pub fn pause(&self, en_pause: bool) {
        self.pause.store(en_pause, Ordering::Relaxed);
    }

    pub fn regler_volume(&self, valeur: f32) {
        *self.volume.lock().unwrap_or_else(|e| e.into_inner()) = valeur.clamp(0.0, 1.5);
    }

    pub fn arreter(&self) {
        self.arret.store(true, Ordering::Relaxed);
        if let Some(mut proc) = self
            .enfant
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = proc.kill();
            let _ = proc.wait();
        }
    }
}

/// Démarre la piste sonore d'une source.
///
/// Renvoie `None` si le média n'a pas de son, ou si aucune sortie audio n'est
/// disponible : une vidéo muette vaut mieux qu'une vidéo qui refuse de partir.
pub fn demarrer(ffmpeg: &str, source: &str, depart_ms: u64) -> Option<Audio> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let hote = cpal::default_host();
    let peripherique = hote.default_output_device()?;
    let config = peripherique.default_output_config().ok()?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        log::warn!(
            "[Sion][lecteur] sortie audio en {:?}, non gérée — vidéo muette",
            config.sample_format()
        );
        return None;
    }
    let taux = config.sample_rate().0;
    let canaux = config.channels() as u32;

    // ffmpeg convertit directement au format du périphérique : ni
    // rééchantillonnage ni remixage à écrire de notre côté, et surtout rien de
    // tout cela dans le rappel audio, où le moindre retard s'entend.
    let mut commande = crate::hidden_command(ffmpeg);
    commande.args(["-hide_banner", "-loglevel", "error"]);
    // `-ss` AVANT `-i` : ffmpeg saute alors directement à l'image clé, au lieu
    // de décoder tout ce qui précède pour le jeter.
    if depart_ms > 0 {
        commande.args(["-ss", &format!("{:.3}", depart_ms as f64 / 1000.0)]);
    }
    commande
        .arg("-i")
        .arg(source)
        .args([
            "-vn",
            "-f",
            "f32le",
            "-ar",
            &taux.to_string(),
            "-ac",
            &canaux.to_string(),
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut enfant = commande.spawn().ok()?;
    let mut sortie = enfant.stdout.take()?;

    let file = Arc::new(File {
        echantillons: Mutex::new(std::collections::VecDeque::new()),
        place: Condvar::new(),
        plafond: (taux as usize) * (canaux as usize) * 2,
        fini: AtomicBool::new(false),
    });
    let arret = Arc::new(AtomicBool::new(false));
    let joues = Arc::new(AtomicU64::new(0));
    let pause = Arc::new(AtomicBool::new(false));
    let volume = Arc::new(Mutex::new(1.0f32));
    let enfant = Arc::new(Mutex::new(Some(enfant)));

    // Producteur : lit le PCM et remplit la file. Il s'endort quand elle est
    // pleine, ce qui bouche le tube et met ffmpeg en attente — la carte son
    // pilote ainsi tout le débit.
    {
        let file = Arc::clone(&file);
        let arret = Arc::clone(&arret);
        std::thread::Builder::new()
            .name("sion-lecteur-audio-lecture".into())
            .spawn(move || {
                let mut brut = vec![0u8; 8192];
                while !arret.load(Ordering::Relaxed) {
                    let lus = match sortie.read(&mut brut) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let mut garde = file
                        .echantillons
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    while garde.len() >= file.plafond && !arret.load(Ordering::Relaxed) {
                        let (g, _) = file
                            .place
                            .wait_timeout(garde, std::time::Duration::from_millis(100))
                            .unwrap_or_else(|e| e.into_inner());
                        garde = g;
                    }
                    for morceau in brut[..lus].chunks_exact(4) {
                        garde.push_back(f32::from_le_bytes([
                            morceau[0], morceau[1], morceau[2], morceau[3],
                        ]));
                    }
                }
                file.fini.store(true, Ordering::Relaxed);
            })
            .ok()?;
    }

    // Le flux cpal vit sur son propre fil : `Stream` n'est pas `Send`, et il
    // se tait dès qu'il est détruit. Le fil attend donc l'ordre d'arrêt.
    {
        let file = Arc::clone(&file);
        let arret_flux = Arc::clone(&arret);
        let joues_flux = Arc::clone(&joues);
        let pause_flux = Arc::clone(&pause);
        let volume_flux = Arc::clone(&volume);
        std::thread::Builder::new()
            .name("sion-lecteur-audio-sortie".into())
            .spawn(move || {
                let gain = Arc::clone(&volume_flux);
                let flux = peripherique.build_output_stream(
                    &config.into(),
                    move |tampon: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        if pause_flux.load(Ordering::Relaxed) {
                            tampon.fill(0.0);
                            return;
                        }
                        let v = *gain.lock().unwrap_or_else(|e| e.into_inner());
                        let mut garde = file
                            .echantillons
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let mut servis = 0u64;
                        for place in tampon.iter_mut() {
                            match garde.pop_front() {
                                Some(e) => {
                                    *place = e * v;
                                    servis += 1;
                                }
                                // File vide : du silence plutôt que la
                                // répétition du dernier tampon, qui
                                // s'entendrait comme un grésillement.
                                None => *place = 0.0,
                            }
                        }
                        drop(garde);
                        file.place.notify_one();
                        joues_flux.fetch_add(servis, Ordering::Relaxed);
                    },
                    move |err| log::warn!("[Sion][lecteur] flux audio : {err}"),
                    None,
                );
                let Ok(flux) = flux else {
                    log::warn!("[Sion][lecteur] sortie audio refusée — vidéo muette");
                    return;
                };
                if flux.play().is_err() {
                    return;
                }
                while !arret_flux.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                // `flux` est détruit ici, ce qui ferme le périphérique.
            })
            .ok()?;
    }

    Some(Audio {
        arret,
        enfant,
        joues,
        taux,
        canaux,
        pause,
        volume,
        _garde: (),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La position se déduit des échantillons remis à la carte son : c'est la
    /// seule horloge qui ne dérive pas de la lecture réelle.
    #[test]
    fn la_position_compte_les_trames_et_non_les_echantillons() {
        let audio = Audio {
            arret: Arc::new(AtomicBool::new(false)),
            enfant: Arc::new(Mutex::new(None)),
            joues: Arc::new(AtomicU64::new(96_000)),
            taux: 48_000,
            canaux: 2,
            pause: Arc::new(AtomicBool::new(false)),
            volume: Arc::new(Mutex::new(1.0)),
            _garde: (),
        };
        // 96 000 échantillons sur deux canaux = 48 000 trames = une seconde.
        assert_eq!(audio.position_ms(), 1000);
    }

    #[test]
    fn un_peripherique_muet_ne_divise_jamais_par_zero() {
        let audio = Audio {
            arret: Arc::new(AtomicBool::new(false)),
            enfant: Arc::new(Mutex::new(None)),
            joues: Arc::new(AtomicU64::new(1000)),
            taux: 0,
            canaux: 0,
            pause: Arc::new(AtomicBool::new(false)),
            volume: Arc::new(Mutex::new(1.0)),
            _garde: (),
        };
        let _ = audio.position_ms();
    }
}
