//! Sortie audio locale pour les retours d'action, indépendante de WebRTC.
//!
//! Les cues de micro et de sourdine sont normalement mixés dans le rendu
//! WebRTC : ils entrent ainsi dans la référence d'annulation d'écho, ce qui
//! évite que le micro ne les renvoie aux autres.
//!
//! La sourdine casse ce chemin. Elle désabonne toutes les pistes distantes, et
//! sans rien à rendre le traitement de rendu n'est plus invoqué : le clip y est
//! accepté puis jamais sorti (constaté le 16/09, reconfirmé le 18/09 avec le
//! flux de sortie pourtant ni muet ni bouchonné). Le repli sur la balise audio
//! du navigateur, lui, met deux à trois secondes à sortir quand le moteur natif
//! tient le périphérique — le son de la mise en sourdine arrivait donc toujours
//! trop tard, quand il n'était pas coupé par le geste suivant.
//!
//! Ce module ouvre donc son propre flux de sortie, le temps du clip. Il ne sert
//! QUE pendant la sourdine : le micro y étant coupé, se passer de la référence
//! d'écho est sans conséquence.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Fréquence des clips fournis par le front (mono).
const TAUX_SOURCE: u32 = 48_000;

/// Étire un clip mono 48 kHz vers la fréquence et le nombre de canaux du
/// périphérique, par interpolation linéaire. Les cues durent moins d'une
/// seconde : la qualité d'un rééchantillonneur polyphasé n'y est pas audible.
///
/// Rendu entrelacé, prêt à être copié tel quel dans le tampon de sortie.
fn adapter(source: &[f32], taux_sortie: u32, canaux: usize) -> Vec<f32> {
    if source.is_empty() || canaux == 0 {
        return Vec::new();
    }
    let ratio = taux_sortie as f64 / TAUX_SOURCE as f64;
    let sorties = ((source.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(sorties * canaux);
    for i in 0..sorties {
        let pos = i as f64 / ratio;
        let gauche = pos.floor() as usize;
        let frac = (pos - gauche as f64) as f32;
        let a = source.get(gauche).copied().unwrap_or(0.0);
        let b = source.get(gauche + 1).copied().unwrap_or(a);
        let echantillon = a + (b - a) * frac;
        for _ in 0..canaux {
            out.push(echantillon);
        }
    }
    out
}

/// Joue un clip mono 48 kHz sur la sortie par défaut du système.
///
/// Rend la main immédiatement : la lecture se poursuit sur un fil dédié, qui
/// meurt avec le clip. Best-effort — un cue qui ne sort pas ne doit jamais
/// empêcher la sourdine de s'appliquer.
pub fn jouer_clip_local(samples: Vec<i16>, gain: f32) {
    if samples.is_empty() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("sion-cue-local".into())
        .spawn(move || {
            if let Err(err) = jouer_bloquant(samples, gain) {
                log::warn!("[Sion][cue] sortie locale indisponible : {err}");
            }
        });
}

fn jouer_bloquant(samples: Vec<i16>, gain: f32) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let hote = cpal::default_host();
    let peripherique = hote
        .default_output_device()
        .ok_or_else(|| "aucune sortie par défaut".to_string())?;
    let config = peripherique
        .default_output_config()
        .map_err(|e| format!("configuration de sortie illisible : {e}"))?;
    let taux = config.sample_rate().0;
    let canaux = config.channels() as usize;

    let mono: Vec<f32> = samples
        .iter()
        .map(|s| (*s as f32 / 32768.0) * gain)
        .collect();
    let entrelace = adapter(&mono, taux, canaux);
    let total = entrelace.len();

    let fini = Arc::new(AtomicBool::new(false));
    let fini_flux = Arc::clone(&fini);
    let mut lu = 0usize;

    // Seul le format f32 est traité : c'est celui que rendent PulseAudio,
    // PipeWire et WASAPI partagé. Un périphérique exotique en i16 retombera
    // sur l'avertissement plutôt que sur un son déformé.
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!(
            "format de sortie non géré : {:?}",
            config.sample_format()
        ));
    }

    let flux = peripherique
        .build_output_stream(
            &config.into(),
            move |tampon: &mut [f32], _: &cpal::OutputCallbackInfo| {
                for place in tampon.iter_mut() {
                    *place = entrelace.get(lu).copied().unwrap_or(0.0);
                    lu += 1;
                }
                if lu >= total {
                    fini_flux.store(true, Ordering::Release);
                }
            },
            move |err| log::warn!("[Sion][cue] flux de sortie local : {err}"),
            None,
        )
        .map_err(|e| format!("flux de sortie refusé : {e}"))?;
    flux.play().map_err(|e| format!("lecture refusée : {e}"))?;

    // Attente bornée : la durée du clip, plus une marge pour la latence du
    // périphérique. Sans borne, un périphérique qui cesse de réclamer des
    // frames retiendrait le fil indéfiniment.
    let duree_ms = (total.max(1) as u64 * 1000) / (taux as u64 * canaux as u64);
    let limite = std::time::Instant::now() + std::time::Duration::from_millis(duree_ms + 1_500);
    while !fini.load(Ordering::Acquire) && std::time::Instant::now() < limite {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Laisse le périphérique vider ce qu'il a déjà en file avant la fermeture,
    // sans quoi la fin du clip est tronquée.
    std::thread::sleep(std::time::Duration::from_millis(120));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_duplique_sur_chaque_canal_sans_changer_la_duree() {
        let source = vec![0.5f32; 480]; // 10 ms à 48 kHz
        let out = adapter(&source, 48_000, 2);
        assert_eq!(out.len(), 960, "480 trames × 2 canaux");
        assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn adapter_suit_la_frequence_du_peripherique() {
        let source = vec![0.25f32; 480];
        // 44,1 kHz : la même durée compte moins de trames.
        let out = adapter(&source, 44_100, 1);
        assert_eq!(out.len(), 441);
    }

    #[test]
    fn adapter_tolere_un_clip_vide_ou_sans_canal() {
        assert!(adapter(&[], 48_000, 2).is_empty());
        assert!(adapter(&[0.1, 0.2], 48_000, 0).is_empty());
    }
}
