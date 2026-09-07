//! Moteur LiveKit natif — voix sans Chromium.
//!
//! Compilé uniquement avec `--features native-voice` (dépendance `livekit`
//! optionnelle : libwebrtc est trop volumineux pour les builds par défaut
//! tant que le chemin JS reste la voix de production).
//!
//! [`LiveKitEngine`] implémente [`VoiceEngine`](crate::voice_native::VoiceEngine)
//! avec un runtime Tokio dédié (les commandes Tauri restent synchrones) :
//! - `connect` ouvre la session SFU et démarre la pompe d'événements
//!   (participants, mute, qualité, data-channels) vers un canal broadcast
//!   que les commandes Tauri relaieront au front ;
//! - `publish_microphone` capture via le module audio natif de WebRTC
//!   (`PlatformAudio`, équivalent du `getUserMedia` + `shim` actuels) ;
//! - chaque piste audio distante est branchée sur un [`RmsSpeakingDetector`]
//!   (mêmes seuils que `speakingDetector.ts`) pour le rond vert.

use std::sync::Mutex;

use base64::Engine as _;
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::video_frame::native::VideoFrameBufferExt as _;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::options::TrackPublishOptions;
use tauri::Emitter as _;

use crate::voice_native::{RmsSpeakingDetector, VoiceEngine};

/// Événement moteur → front. Forme stable et sérialisable : les commandes
/// Tauri les réémettent tels quels (`voice-native-*`), le front consomme la
/// même forme que pour le chemin JS.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceEngineEvent {
    ParticipantJoined { identity: String, name: String },
    ParticipantLeft { identity: String },
    SpeakingChanged { identity: String, speaking: bool },
    TrackMutedChanged { identity: String, muted: bool },
    QualityChanged { identity: String, quality: String },
    DataReceived { topic: Option<String>, payload_b64: String, sender: Option<String> },
    /// Partage d'écran distant (présence) : le front affiche/masque la vue.
    /// Les pixels arrivent séparément (`voice-native-frame`, JPEG).
    VideoPresence { sender: String, sharing: bool },
    /// Le partage d'écran distant publie aussi du son (piste
    /// `ScreenshareAudio`) : le front affiche le contrôle 🔊/🔇.
    /// Indépendant du mute local (voir `set_screenshare_audio_subscribed`).
    ShareAudioPresence { sender: String, has_audio: bool },
    RoomDisconnected { reason: String },
    RoomReconnecting,
    RoomReconnected,
}

/// Snapshot des périphériques vus par l'ADM (diagnostic + futurs réglages).
/// Crée un `PlatformAudio` temporaire (refcount +1 le temps de l'appel).
pub fn platform_audio_snapshot() -> Result<
    (
        Vec<crate::voice_native::NativeAudioDevice>,
        Vec<crate::voice_native::NativeAudioDevice>,
    ),
    String,
> {
    use crate::voice_native::NativeAudioDevice;
    let audio = PlatformAudio::new().map_err(|e| format!("audio natif: {}", e))?;
    let recording = audio
        .recording_devices()
        .map(|d| NativeAudioDevice {
            id: d.id.as_str().to_string(),
            name: d.name.clone(),
            index: d.index,
        })
        .collect();
    let playout = audio
        .playout_devices()
        .map(|d| NativeAudioDevice {
            id: d.id.as_str().to_string(),
            name: d.name.clone(),
            index: d.index,
        })
        .collect();
    Ok((recording, playout))
}

/// Extrait les index des sink-inputs de playout de l'ADM WebRTC depuis un
/// `pactl -f json list sink-inputs`. Fonction pure (testée). Conservée pour
/// les tests ; le chemin réel utilise `adm_playout_states` (plus riche).
#[allow(dead_code)]
fn adm_playout_indices(pactl_json: &str) -> Vec<u64> {
    adm_playout_states(pactl_json)
        .into_iter()
        .map(|s| s.index)
        .collect()
}

/// État d'un sink-input ADM (diagnostic du silence : muet, bouchonné,
/// routage, volume). Parsing défensif : toute forme inattendue donne
/// des `None`/`false`, jamais d'erreur.
#[derive(Debug, PartialEq, Eq)]
struct AdmuiPlayoutState {
    index: u64,
    muted: bool,
    corked: bool,
    sink: Option<u64>,
    media: Option<String>,
    volume_display: Option<String>,
}

fn find_volume_display(volume: &serde_json::Value) -> Option<String> {
    let obj = volume.as_object()?;
    for channel in obj.values() {
        if let Some(display) = channel.get("display").and_then(|d| d.as_str()) {
            return Some(display.to_string());
        }
    }
    None
}

fn adm_playout_states(pactl_json: &str) -> Vec<AdmuiPlayoutState> {
    let mut out = Vec::new();
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(pactl_json) else {
        return out;
    };
    for entry in &entries {
        let props = entry.get("properties");
        let is_adm = props
            .and_then(|p| p.get("application.name"))
            .and_then(|n| n.as_str())
            == Some("WEBRTC VoiceEngine");
        if !is_adm {
            continue;
        }
        let Some(index) = entry.get("index").and_then(|i| i.as_u64()) else {
            continue;
        };
        out.push(AdmuiPlayoutState {
            index,
            muted: entry
                .get("mute")
                .and_then(|m| m.as_bool())
                .unwrap_or(false),
            corked: entry
                .get("corked")
                .and_then(|c| c.as_bool())
                .unwrap_or(false),
            sink: entry.get("sink").and_then(|s| s.as_u64()),
            media: props
                .and_then(|p| p.get("media.name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string()),
            volume_display: entry
                .get("volume")
                .and_then(find_volume_display),
        });
    }
    out
}

/// L'ADM WebRTC coupe parfois son propre playout (sink-input muet côté
/// PipeWire — observé en prod : frames reçues, casque OK, silence total,
/// parfois APRÈS un démute réussi au join). On ré-impose démute + on
/// journalise l'état complet (corké ? routé où ? volume ?) pour traquer
/// le motif. Best-effort, Linux uniquement (pactl). Ne touche jamais au
/// volume ni à l'état corké : démute seul (correctif prouvé), le reste
/// est journalisé pour diagnostic.
fn ensure_playout_unmuted() {
    #[cfg(target_os = "linux")]
    {
        let list = std::process::Command::new("pactl")
            .args(["-f", "json", "list", "sink-inputs"])
            .output();
        let Ok(list) = list else { return };
        let states = adm_playout_states(&String::from_utf8_lossy(&list.stdout));
        if states.is_empty() {
            log::warn!("[Sion][voix-native] aucun sink-input ADM (playout absent)");
            return;
        }
        for st in states {
            log::info!(
                "[Sion][voix-native] playout ADM sink-input {}: muet={} corke={} sink={:?} media={:?} volume={:?}",
                st.index,
                st.muted,
                st.corked,
                st.sink,
                st.media,
                st.volume_display,
            );
            if st.corked {
                log::warn!(
                    "[Sion][voix-native] playout ADM {} corké (bouchonné côté système)",
                    st.index
                );
            }
            if !st.muted {
                continue;
            }
            let status = std::process::Command::new("pactl")
                .args(["set-sink-input-mute", &st.index.to_string(), "0"])
                .status();
            match status {
                Ok(s) if s.success() => {
                    log::info!("[Sion][voix-native] playout ADM démute (sink-input {})", st.index)
                }
                _ => log::warn!(
                    "[Sion][voix-native] impossible de démuter le playout {}",
                    st.index
                ),
            }
        }
    }
}

/// Chien de garde playout : l'ADM se remute parfois EN COURS d'appel
/// (démute au join insuffisant — silence alors que tout est vert).
/// Tant que la session vit, on ré-impose démute toutes les 5 s (no-op
/// loggé quand tout est déjà OK). Même motif stop que le meter local :
/// fermer le canal stop (disconnect / remplacement moteur) tue le thread.
fn start_playout_watchdog(
    deafened: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> std::sync::mpsc::Sender<()> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let deafened = std::sync::Arc::clone(deafened);
    std::thread::Builder::new()
        .name("sion-voice-playout-watchdog".into())
        .spawn(move || {
            loop {
                match stop_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if !deafened.load(std::sync::atomic::Ordering::Relaxed) {
                            ensure_playout_unmuted();
                        }
                    }
                }
            }
        })
        .ok();
    stop_tx
}
pub fn connection_quality_str(q: &ConnectionQuality) -> &'static str {
    match q {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

/// Options de publication du micro. Parité JS (`publishDefaults` +
/// `source: Track.Source.Microphone` dans `livekitService`) :
/// - `source: Microphone` — SANS ÇA, les pairs ne trouvent pas la
///   publication micro (`isMicrophoneEnabled == false`) et nous affichent
///   mutés alors que l'audio passe ;
/// - `dtx/red: false` comme le chemin JS.
pub fn mic_publish_options() -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::Microphone,
        dtx: false,
        red: false,
        ..Default::default()
    }
}

/// Pousse une frame PCM `i16` (format du `NativeAudioStream`) dans le
/// détecteur RMS sans allocation intermédiaire.
pub fn push_i16_frame(det: &mut RmsSpeakingDetector, samples: &[i16]) -> Option<bool> {
    if samples.is_empty() {
        return None;
    }
    let sum: f64 = samples
        .iter()
        .map(|v| {
            let n = *v as f64 / 32768.0;
            n * n
        })
        .sum();
    det.push_rms((sum / samples.len() as f64).sqrt() as f32)
}

/// Attache un détecteur de parole (rond vert) à une piste audio distante.
/// À la fin du stream (unpublish), retombe à `speaking: false`.
fn spawn_rms_task(
    rt: &tokio::runtime::Handle,
    tx: &tokio::sync::broadcast::Sender<VoiceEngineEvent>,
    identity: String,
    rtc_track: livekit::webrtc::audio_track::RtcAudioTrack,
) {
    let tx2 = tx.clone();
    rt.spawn(async move {
        use futures_util::StreamExt as _;
        // 48 kHz mono : ce que l'ADM négocie par défaut ;
        // le détecteur RMS s'en contente.
        let mut stream = NativeAudioStream::new(rtc_track, 48000, 1);
        let mut det = RmsSpeakingDetector::new();
        let mut first_frame = true;
        while let Some(frame) = stream.next().await {
            if first_frame {
                first_frame = false;
                log::info!(
                    "[Sion][voix-native] frames distantes recues {} ({} Hz, {} canaux)",
                    identity,
                    frame.sample_rate,
                    frame.num_channels
                );
            }
            if let Some(speaking) = push_i16_frame(&mut det, &frame.data) {
                let _ = tx2.send(VoiceEngineEvent::SpeakingChanged {
                    identity: identity.clone(),
                    speaking,
                });
            }
        }
        log::info!("[Sion][voix-native] fin de piste distante {}", identity);
        let _ = tx2.send(VoiceEngineEvent::SpeakingChanged { identity, speaking: false });
    });
}

/// Dimensions d'émission d'une frame vidéo : largeur plafonnée à 2560
/// (un écran 2560px réduit à 1920 reste flou en plein écran ; le CPU
/// encaisse ~2,8 Mpx en SIMD), dimensions paires (exigées par le scale
/// I420). Fonction pure (testée).
fn video_emit_dims(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let (mut w, mut h) = if width > 2560 {
        (2560, height.saturating_mul(2560) / width)
    } else {
        (width, height)
    };
    w &= !1;
    h &= !1;
    (w.max(2), h.max(2))
}

/// RGB24 → JPEG à qualité donnée (0-100). `jpeg-rusturbo` (SIMD, ~5×
/// l'encodeur scalaire de `image`). Réservé aux tests : la pompe utilise
/// directement le RGBA sorti de libyuv.
#[cfg(test)]
fn encode_jpeg_rgb(width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    encode_jpeg_rgba(width, height, &rgb_to_rgba(rgb), quality, true)
}

/// RGB24 → RGBA32 (canal alpha opaque). La conversion I420→RGBA se fait
/// déjà en SIMD (libyuv) ; ce pont ne sert qu'au test unitaire.
#[cfg(test)]
fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .flat_map(|px| [px[0], px[1], px[2], 255])
        .collect()
}

/// RGBA32 → JPEG à qualité donnée, toujours en 4:4:4 (pas de
/// sous-échantillonnage chroma : le texte reste net même en mouvement ;
/// ~2× plus gros que le 4:2:0 mais IPC local et CPU SIMD encaissent).
/// `full_chroma=false` (4:2:0) réservé aux tests comparatifs.
fn encode_jpeg_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    quality: u8,
    full_chroma: bool,
) -> Result<Vec<u8>, String> {
    use jpeg_rusturbo::ChromaSubsampling::{Yuv420, Yuv444};
    let mut out = Vec::new();
    let mut enc = jpeg_rusturbo::JpegEncoder::new_with_quality(&mut out, quality);
    enc.set_subsampling(if full_chroma { Yuv444 } else { Yuv420 });
    enc.encode_rgba(rgba, width, height)
        .map_err(|e| format!("jpeg: {}", e))?;
    Ok(out)
}

/// Échantillonne le plan Y (1 octet sur 32) pour la détection de changement.
/// Fonction pure (testée).
fn y_samples(y: &[u8]) -> Vec<u8> {
    y.iter().step_by(32).copied().collect()
}

/// Qualité JPEG + cadence adaptatives (contrôleur pur, testé).
///
/// Ce flux JPEG ne touche jamais le réseau (IPC local vers la webview) :
/// la cible (~4 Mo/s) ne protège que le CPU d'encodage et le décodage
/// image de Chromium. Ordre de dégradation volontaire :
/// 1. baisser la qualité (90 → 75) — le texte reste lisible ;
/// 2. PUIS SEULEMENT baisser la cadence (10 → 5 → 2,5 im/s).
/// L'inverse (écraser la qualité à plancher en gardant 12 im/s) donne du
/// pixelisé permanent même sur écran fixe — observé en prod.
const VIDEO_TARGET_BPS: u64 = 4_000_000;
const VIDEO_Q_MIN: u8 = 75;
const VIDEO_Q_MAX: u8 = 90;
/// Paliers de cadence (ms entre frames) : on ne descend que coincé au
/// plancher qualité, on remonte dès que le budget le permet. Base 80 ms
/// (~12 im/s) : la source LiveKit ne dépasse 15 im/s qu'en preset 30fps.
const VIDEO_TICKS_MS: [u64; 3] = [80, 160, 320];

/// État du contrôleur : qualité + palier de cadence courants.
#[derive(Debug, PartialEq, Eq)]
struct VideoBudget {
    quality: u8,
    tick_step: usize,
}

fn adapt_budget(current: &VideoBudget, bytes_last_window: u64, window_secs: u64) -> VideoBudget {
    if window_secs == 0 {
        return VideoBudget { quality: current.quality, tick_step: current.tick_step };
    }
    let over = bytes_last_window > VIDEO_TARGET_BPS * window_secs;
    if over {
        if current.quality > VIDEO_Q_MIN {
            VideoBudget { quality: current.quality.saturating_sub(6).max(VIDEO_Q_MIN), tick_step: current.tick_step }
        } else if current.tick_step + 1 < VIDEO_TICKS_MS.len() {
            VideoBudget { quality: current.quality, tick_step: current.tick_step + 1 }
        } else {
            VideoBudget { quality: current.quality, tick_step: current.tick_step }
        }
    } else if current.tick_step > 0 {
        VideoBudget { quality: current.quality, tick_step: current.tick_step - 1 }
    } else {
        VideoBudget { quality: current.quality.saturating_add(2).min(VIDEO_Q_MAX), tick_step: current.tick_step }
    }
}

/// Pompe vidéo : partage d'écran distant → JPEG ~10 im/s vers le front
/// (`voice-native-frame`). Le flux décodé par libwebrtc EST fluide et net
/// (vrai codec adaptatif côté SFU) ; le pont JPEG n'en garde que l'essentiel :
/// - tick 100 ms + file "latest" (1 frame) : aucun backlog, le réseau ou le
///   CPU lent fait juste baisser le débit effectif ;
/// - écran strictement fixe (échantillons Y identiques) = 0 encodage ;
/// - qualité JPEG + cadence adaptatives (v3 : cible ~2,5 Mo/s d'IPC local,
///   on dégrade la qualité 90 → 75 AVANT de toucher à la cadence) ;
/// - conversion + encodage (CPU) dans `spawn_blocking`, jamais sur le runtime.
/// Se termine sur `stop` (unsubscribe, leave, disconnect) ou fin de piste.
#[allow(clippy::too_many_arguments)]
fn spawn_video_pump(
    rt: &tokio::runtime::Handle,
    app: tauri::AppHandle<crate::TauriRuntime>,
    sender: String,
    rtc_track: livekit::webrtc::video_track::RtcVideoTrack,
    stop: tokio::sync::oneshot::Receiver<()>,
) {
    rt.spawn(async move {
        use futures_util::StreamExt as _;
        let mut stream = NativeVideoStream::new(rtc_track);
        log::info!("[Sion][voix-native] partage d'écran reçu de {}", sender);
        let mut stop = stop;
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(VIDEO_TICKS_MS[0]));
        // `latest` = dernière frame décodée (écrase la précédente : pas de
        // backlog) ; `pending` = encodage en cours (un seul à la fois).
        let mut latest: Option<livekit::webrtc::video_frame::BoxVideoFrame> = None;
        // Encodage en cours (un seul à la fois) : (échantillons Y, dims
        // source, JPEG émis ou None si image strictement inchangée, avec
        // temps conversion et encodage en ms pour le diagnostic).
        let mut pending: Option<
            tokio::task::JoinHandle<(
                Vec<u8>,
                (u32, u32),
                Option<(Vec<u8>, u32, u32, u128, u128)>,
            )>,
        > = None;
        let mut prev_samples: Vec<u8> = Vec::new();
        let mut budget = VideoBudget { quality: 86, tick_step: 0 };
        let mut window: std::collections::VecDeque<(tokio::time::Instant, usize)> =
            std::collections::VecDeque::new();
        let mut first = true;
        let mut stat_count: u64 = 0;
        let mut stat_bytes: u64 = 0;
        let mut stat_conv_ms: u128 = 0;
        let mut stat_enc_ms: u128 = 0;
        // Frames décodées ARRIVÉES (vs émises) : si le SFU ne nous sert
        // qu'un filet (couche en pause, dynacast), ça se voit ici.
        let mut stat_arrived: u64 = 0;
        let mut stat_since = tokio::time::Instant::now();
        loop {
            tokio::select! {
                _ = &mut stop => break,
                frame = stream.next() => {
                    let Some(frame) = frame else { break };
                    stat_arrived += 1;
                    latest = Some(frame);
                }
                _ = ticker.tick() => {
                    // Récolte de l'encodage précédent (sans attendre).
                    if let Some(h) = pending.take() {
                        if h.is_finished() {
                            match h.await {
                                Ok((samples, src_dims, emitted)) => {
                                    prev_samples = samples;
                                    // Image inchangée (emitted = None) : on
                                    // garde simplement l'affichée.
                                    if let Some((jpeg, dw, dh, conv_ms, enc_ms)) = emitted {
                                        let now = tokio::time::Instant::now();
                                        window.push_back((now, jpeg.len()));
                                        while window.front().is_some_and(|(t, _)| now.duration_since(*t).as_secs() >= 2) {
                                            window.pop_front();
                                        }
                                        let win_bytes: usize = window.iter().map(|(_, n)| n).sum();
                                        let next = adapt_budget(&budget, win_bytes as u64, 2);
                                        if next.tick_step != budget.tick_step {
                                            ticker = tokio::time::interval(std::time::Duration::from_millis(
                                                VIDEO_TICKS_MS[next.tick_step],
                                            ));
                                        }
                                        budget = next;
                                        stat_count += 1;
                                        stat_bytes += jpeg.len() as u64;
                                        stat_enc_ms += enc_ms;
                                        stat_conv_ms += conv_ms;
                                        if first {
                                            first = false;
                                            log::info!(
                                                "[Sion][voix-native] frames vidéo {} ({}x{} → {}x{}, {} o jpeg q{} 444, conv {}ms enc {}ms)",
                                                sender, src_dims.0, src_dims.1, dw, dh, jpeg.len(), budget.quality, conv_ms, enc_ms
                                            );
                                        }
                                        if stat_since.elapsed().as_secs() >= 30 {
                                            let secs = stat_since.elapsed().as_secs_f64();
                                            log::info!(
                                                "[Sion][voix-native] vidéo {} : reçues {:.1} im/s, émises {:.1} im/s, q{}, pas {}{}, {:.0} Ko/s, conv {}ms enc {}ms",
                                                sender,
                                                stat_arrived as f64 / secs,
                                                stat_count as f64 / secs,
                                                budget.quality,
                                                VIDEO_TICKS_MS[budget.tick_step],
                                                "ms",
                                                stat_bytes as f64 / secs / 1024.0,
                                                stat_conv_ms / stat_count.max(1) as u128,
                                                stat_enc_ms / stat_count.max(1) as u128
                                            );
                                            stat_arrived = 0;
                                            stat_count = 0;
                                            stat_bytes = 0;
                                            stat_conv_ms = 0;
                                            stat_enc_ms = 0;
                                            stat_since = tokio::time::Instant::now();
                                        }
                                        use base64::Engine as _;
                                        let _ = app.emit(
                                            "voice-native-frame",
                                            &serde_json::json!({
                                                "sender": sender,
                                                "width": dw,
                                                "height": dh,
                                                "jpeg_b64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
                                            }),
                                        );
                                    }
                                }
                                Err(e) => log::warn!("[Sion][voix-native] encodage vidéo {} : {}", sender, e),
                            }
                        } else {
                            pending = Some(h);
                            continue;
                        }
                    }
                    // Nouvel encodage si une frame fraîche attend.
                    if let Some(frame) = latest.take() {
                        let q = budget.quality;
                        let prev = std::mem::take(&mut prev_samples);
                        pending = Some(tokio::task::spawn_blocking(move || {
                            let buf = frame.buffer.as_ref();
                            let (sw, sh) = (buf.width(), buf.height());
                            let (dw, dh) = video_emit_dims(sw, sh);
                            let mut i420 = buf.to_i420();
                            if dw != 0 && (dw != sw || dh != sh) {
                                i420 = i420.scale(dw as i32, dh as i32);
                            }
                            let (dy, _, _) = i420.data();
                            let samples = y_samples(dy);
                            // Écran strictement fixe (mêmes échantillons) :
                            // on garde l'image affichée, zéro encodage.
                            if dw == 0 || (!prev.is_empty() && prev == samples) {
                                return (samples, (sw, sh), None);
                            }
                            // Toujours 4:4:4 (texte net même en mouvement) :
                            // ~2× plus gros que le 4:2:0 mais IPC local et
                            // CPU SIMD encaissent ; le contrôleur qualité /
                            // cadence reste la soupape.
                            // ATTENTION : le binding inverse RGBA↔ABGR et
                            // BGRA↔ARGB (vérifié empiriquement, test
                            // `libyuv_to_argb_ordre_des_canaux`) — on demande
                            // ABGR pour obtenir des octets RGBA.
                            let t0 = std::time::Instant::now();
                            let mut rgba = vec![0u8; (dw * dh * 4) as usize];
                            i420.to_argb(
                                livekit::webrtc::video_frame::VideoFormatType::ABGR,
                                &mut rgba,
                                dw * 4,
                                dw as i32,
                                dh as i32,
                            );
                            let conv_ms = t0.elapsed().as_millis();
                            let emitted = encode_jpeg_rgba(dw, dh, &rgba, q, true)
                                .ok()
                                .map(|jpeg| (jpeg, dw, dh, conv_ms, t0.elapsed().as_millis()));
                            (samples, (sw, sh), emitted)
                        }));
                    }
                }
            }
        }
        log::info!("[Sion][voix-native] fin de partage {}", sender);
        let _ = app.emit(
            "voice-native-frame-stopped",
            &serde_json::json!({ "sender": sender }),
        );
    });
}

/// Démarre (ou remplace) la pompe vidéo d'un partage d'écran distant.
/// Fonction libre (pas de `&self`) pour être appelable depuis la pompe
/// d'événements, qui vit dans une tâche `'static` sans accès au moteur.
fn start_remote_video_pump(
    rt: &tokio::runtime::Handle,
    app: Option<tauri::AppHandle<crate::TauriRuntime>>,
    video_stops: &std::sync::Arc<
        Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    >,
    sender: String,
    rtc_track: livekit::webrtc::video_track::RtcVideoTrack,
) {
    let Some(app) = app else {
        log::warn!("[Sion][voix-native] partage {} ignoré (pas de AppHandle)", sender);
        return;
    };
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    if let Some(prev) = video_stops
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sender.clone(), stop_tx)
    {
        let _ = prev.send(());
    }
    spawn_video_pump(rt, app, sender, rtc_track, stop_rx);
}

/// Stoppe la pompe vidéo d'un expéditeur (unsubscribe, leave).
/// Fonction libre, même raison que `start_remote_video_pump`.
fn stop_remote_video_pump(
    video_stops: &std::sync::Arc<
        Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    >,
    sender: &str,
) {
    let prev = video_stops
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(sender);
    if prev.is_some() {
        log::info!("[Sion][voix-native] partage {} arrêté", sender);
    }
    if let Some(prev) = prev {
        let _ = prev.send(());
    }
}

pub struct LiveKitEngine {
    rt: tokio::runtime::Runtime,
    room: Mutex<Option<Room>>,
    /// Garde l'ADM WebRTC vivant tant que le moteur existe (refcount).
    audio: Mutex<Option<PlatformAudio>>,
    mic_sid: Mutex<Option<TrackSid>>,
    /// Capture cpal parallèle, analyse seule (rond vert local) : l'ADM ne
    /// donnant pas accès à ses frames, on mesure le même défaut d'entrée.
    /// `cpal::Stream` n'étant ni Send ni Sync, il vit dans un thread
    /// propriétaire qui meurt quand le canal stop se ferme (disconnect).
    local_meter_stop: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Chien de garde playout ADM (re-démute si l'ADM se remute en cours
    /// d'appel). Même cycle de vie que le meter local.
    watchdog_stop: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Sourdine casque : les nouvelles pistes audio sont désinscrites d'office.
    deafened: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// SIDs audio déjà branchés sur un détecteur RMS (anti-doublons).
    attached: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
    /// Expéditeurs dont le son du partage est coupé localement (miroir du
    /// `screenShareAudioMuted` JS) : survivre au undeafen global (qui
    /// réinscrit tout) sans réactiver leur partage.
    share_audio_muted: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
    /// Pompes vidéo (partage d'écran) : un canal stop par expéditeur.
    /// Clé = identité LiveKit (un partage actif à la fois par pair, MVP).
    video_stops:
        std::sync::Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    /// Poignée Tauri pour émettre les frames (`voice-native-frame`) depuis
    /// les pompes vidéo (le canal broadcast reste réservé aux petits events).
    event_app: Mutex<Option<tauri::AppHandle<crate::TauriRuntime>>>,
    event_tx: tokio::sync::broadcast::Sender<VoiceEngineEvent>,
}

// Étape suivante : instancié par les commandes `voice_native_*` quand le
// basculement natif sera activé (le chemin JS reste le défaut).
#[allow(dead_code)]
impl LiveKitEngine {
    pub fn new() -> Result<Self, String> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("sion-voice-rt")
            .build()
            .map_err(|e| format!("runtime voix: {}", e))?;
        let (event_tx, _) = tokio::sync::broadcast::channel(256);
        Ok(Self {
            rt,
            room: Mutex::new(None),
            audio: Mutex::new(None),
            mic_sid: Mutex::new(None),
            local_meter_stop: Mutex::new(None),
            watchdog_stop: Mutex::new(None),
            deafened: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            attached: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            share_audio_muted: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            video_stops: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            event_app: Mutex::new(None),
            event_tx,
        })
    }

    /// S'abonne aux événements moteur (pompe + détecteurs parole).
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<VoiceEngineEvent> {
        self.event_tx.subscribe()
    }

    /// Vrai si une session SFU est ouverte.
    pub fn is_connected(&self) -> bool {
        self.room.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Nombre de pistes audio distantes branchées au détecteur RMS.
    pub fn attached_count(&self) -> usize {
        self.attached
            .lock()
            .map(|a| a.len())
            .unwrap_or_default()
    }

    /// Publie le micro via l'ADM natif. Équivalent de `createLocalAudioTrack`
    /// + `publishTrack` côté JS, sans `getUserMedia` ni shim PulseAudio :
    /// la sélection de périphérique passe par `PlatformAudio`.
    ///
    /// Traitement audio : le pipeline RNNoise du projet (worklet JS sur la
    /// piste micro) ne s'applique PAS ici — et `set_noise_suppression`
    /// ci-dessous ne coupe que le traitement MATÉRIEL (no-op sur desktop,
    /// où seul l'APM logiciel WebRTC tourne). Autrement dit, en natif c'est
    /// l'APM logiciel WebRTC (AEC/AGC/NS, cf. log `apm effectif`) qui traite
    /// le micro, pas RNNoise. Réglages `echoCancellation`/`autoGainControl`
    /// des settings : non propagés (pas d'API logicielle exposée).
    pub fn publish_microphone(&self) -> Result<(), String> {
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        let audio = PlatformAudio::new().map_err(|e| format!("audio natif: {}", e))?;
        // Best-effort : un ADM qui refuse ce réglage ne doit pas bloquer l'appel.
        // (Ne touche que le NS matériel — voir doc ci-dessus.)
        let _ = audio.set_noise_suppression(false, false);
        // Vérité terrain : quel traitement est VRAIMENT actif ?
        log::info!(
            "[Sion][voix-native] apm effectif aec={:?} agc={:?} ns={:?}",
            audio.active_aec_type(),
            audio.active_agc_type(),
            audio.active_ns_type()
        );
        // Diagnostic routage : quels périphériques l'ADM voit-il ?
        log::info!(
            "[Sion][voix-native] ADM entree=[{}] sortie=[{}]",
            audio
                .recording_devices()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>()
                .join(" | "),
            audio
                .playout_devices()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>()
                .join(" | ")
        );
        let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        let publication = self
            .rt
            .block_on(room.local_participant().publish_track(
                LocalTrack::Audio(track),
                mic_publish_options(),
            ))
            .map_err(|e| format!("publish mic: {}", e))?;
        let sid = publication.sid();
        log::info!("[Sion][voix-native] micro publié sid={}", sid);
        *self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()) = Some(sid);
        // Garder l'ADM vivant tant que la session vit : sans ce garde, le
        // refcount retombe à zéro dès la fin de cette fonction et l'ADM
        // démonte son playout quelques secondes après le join (sink-input
        // "playout absent" alors que les frames continuent = silence total).
        *self.audio.lock().unwrap_or_else(|e| e.into_inner()) = Some(audio);
        // Filet résiduel : si l'ADM s'est déjà muté tout seul, on démute.
        ensure_playout_unmuted();
        Ok(())
    }

    /// Publie un paquet data-channel (soundboard, AFK, curseurs…).
    /// `reliable: true` comme le chemin JS (`publishData { reliable: true }`) ;
    /// `false` = LOSSY pour les flux à 60 Hz (curseur) où le prochain paquet
    /// répare la perte.
    pub fn publish_data(&self, topic: &str, payload: Vec<u8>, reliable: bool) -> Result<(), String> {
        let len = payload.len();
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        let packet = DataPacket {
            payload,
            topic: Some(topic.to_string()),
            reliable,
            destination_identities: Vec::new(),
        };
        self.rt
            .block_on(room.local_participant().publish_data(packet))
            .map_err(|e| format!("publish data: {}", e))?;
        // Debug : à 60 Hz (curseur), l'info spammerait le log.
        log::debug!("[Sion][voix-native] data publié topic={} ({} o)", topic, len);
        Ok(())
    }

    /// Poignée d'émission des frames vidéo (posée par `connect_engine`,
    /// le `connect` du trait ne reçoit pas le `AppHandle`).
    pub fn set_event_app(&self, app: tauri::AppHandle<crate::TauriRuntime>) {
        *self.event_app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    /// Démarre (ou remplace) la pompe vidéo d'un partage d'écran distant.
    pub fn track_remote_video(
        &self,
        sender: String,
        rtc_track: livekit::webrtc::video_track::RtcVideoTrack,
    ) {
        let app = self
            .event_app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        start_remote_video_pump(
            self.rt.handle(),
            app,
            &self.video_stops,
            sender,
            rtc_track,
        );
    }

    /// Stoppe la pompe vidéo d'un expéditeur (unsubscribe, leave).
    pub fn stop_remote_video(&self, sender: &str) {
        stop_remote_video_pump(&self.video_stops, sender);
    }

    /// Démarre la mesure du micro local (rond vert) : l'ADM WebRTC ne donnant
    /// pas accès à ses frames capturées, on ouvre le même défaut d'entrée
    /// via cpal en analyse seule (parallèle à la capture ADM, sans publier).
    /// Mêmes seuils RMS que `speakingDetector.ts`.
    ///
    /// `cpal::Stream` n'étant ni Send ni Sync, TOUT vit dans le thread dédié
    /// (création, play, drop) ; fermer le canal stop (disconnect) fait sortir
    /// le thread. Best-effort : un défaut indisponible ne fait que logger.
    pub fn start_local_meter(&self, identity: String) -> Result<(), String> {
        let tx = self.event_tx.clone();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("sion-voice-local-meter".into())
            .spawn(move || {
                Self::run_local_meter(&tx, &identity, &stop_rx);
            })
            .map_err(|e| format!("thread meter: {}", e))?;
        *self.local_meter_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop_tx);
        Ok(())
    }

    fn run_local_meter(
        tx: &tokio::sync::broadcast::Sender<VoiceEngineEvent>,
        identity: &str,
        stop_rx: &std::sync::mpsc::Receiver<()>,
    ) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use std::sync::Arc;

        fn feed(
            tx: &tokio::sync::broadcast::Sender<VoiceEngineEvent>,
            det: &Arc<Mutex<RmsSpeakingDetector>>,
            rms: f32,
            id: &str,
        ) {
            let flipped = det.lock().map(|mut d| d.push_rms(rms)).unwrap_or(None);
            if let Some(speaking) = flipped {
                let _ = tx.send(VoiceEngineEvent::SpeakingChanged {
                    identity: id.to_string(),
                    speaking,
                });
            }
        }

        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            log::warn!("[Sion][voix-native] meter local : pas de périphérique d'entrée");
            return;
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[Sion][voix-native] meter local : config entrée: {}", e);
                return;
            }
        };

        let err_fn =
            |err| log::warn!("[Sion][voix-native] meter micro local: {}", err);
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let (tx, det, id) = (
                    tx.clone(),
                    Arc::new(Mutex::new(RmsSpeakingDetector::new())),
                    identity.to_string(),
                );
                match device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        if data.is_empty() {
                            return;
                        }
                        let sum: f32 = data.iter().map(|v| v * v).sum();
                        feed(&tx, &det, (sum / data.len() as f32).sqrt(), &id);
                    },
                    err_fn,
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[Sion][voix-native] meter local : stream f32: {}", e);
                        return;
                    }
                }
            }
            cpal::SampleFormat::I16 => {
                let (tx, det, id) = (
                    tx.clone(),
                    Arc::new(Mutex::new(RmsSpeakingDetector::new())),
                    identity.to_string(),
                );
                match device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        if data.is_empty() {
                            return;
                        }
                        let sum: f64 = data
                            .iter()
                            .map(|v| {
                                let n = *v as f64 / 32768.0;
                                n * n
                            })
                            .sum();
                        feed(&tx, &det, (sum / data.len() as f64).sqrt() as f32, &id);
                    },
                    err_fn,
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[Sion][voix-native] meter local : stream i16: {}", e);
                        return;
                    }
                }
            }
            cpal::SampleFormat::U16 => {
                let (tx, det, id) = (
                    tx.clone(),
                    Arc::new(Mutex::new(RmsSpeakingDetector::new())),
                    identity.to_string(),
                );
                match device.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _| {
                        if data.is_empty() {
                            return;
                        }
                        let sum: f64 = data
                            .iter()
                            .map(|v| {
                                let n = (*v as f64 - 32768.0) / 32768.0;
                                n * n
                            })
                            .sum();
                        feed(&tx, &det, (sum / data.len() as f64).sqrt() as f32, &id);
                    },
                    err_fn,
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[Sion][voix-native] meter local : stream u16: {}", e);
                        return;
                    }
                }
            }
            fmt => {
                log::warn!("[Sion][voix-native] meter local : format {:?}", fmt);
                return;
            }
        };
        if let Err(e) = stream.play() {
            log::warn!("[Sion][voix-native] meter local : play: {}", e);
            return;
        }
        // Bloque jusqu'au disconnect (fermeture du canal), puis drop le
        // stream sur ce même thread.
        let _ = stop_rx.recv();
    }

    /// Coupe / rétablit le micro. Comme préconisé par le SDK (et par notre
    /// `refreshMicrophoneForDenoise` côté JS) : unpublish + stop d'un côté,
    /// start + re-publish de l'autre.
    pub fn set_microphone_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            let audio_guard = self.audio.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(audio) = audio_guard.as_ref() {
                let _ = audio.start_recording();
            }
            drop(audio_guard);
            self.publish_microphone()
        } else {
            let sid = self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()).take();
            let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
            if let (Some(room), Some(sid)) = (room_guard.as_ref(), sid) {
                let _ = self.rt.block_on(room.local_participant().unpublish_track(&sid));
            }
            drop(room_guard);
            let audio_guard = self.audio.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(audio) = audio_guard.as_ref() {
                let _ = audio.stop_recording();
            }
            Ok(())
        }
    }

    /// Sourdine casque : (dés)inscrit toutes les pistes audio distantes.
    /// Retourne le nombre de pistes touchées (0 sans session = no-op OK).
    /// Au retour (`false`), les pistes sont réinscrites et le RMS ré-accroché
    /// (le registre `attached` est purgé : d'éventuelles tâches orphelines
    /// n'émettent que des booléens idempotents).
    pub fn set_deafened(&self, deafened: bool) -> Result<usize, String> {
        // Les commandes Tauri sync tournent hors runtime Tokio, mais le SDK
        // exige un contexte (`Handle::current()` dans `set_subscribed`) —
        // sans ça, panique "there is no reactor running" + session tuée.
        let _rt_enter = self.rt.enter();
        self.deafened
            .store(deafened, std::sync::atomic::Ordering::Relaxed);
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = room_guard.as_ref() else {
            return Ok(0);
        };
        if !deafened {
            self.attached
                .lock()
                .map(|mut a| a.clear())
                .unwrap_or_default();
        }
        let mut touched = 0;
        // Sons de partage coupés localement : le undeafen global ne doit pas
        // les réactiver (miroir du `screenShareAudioMuted` JS).
        let share_muted = self
            .share_audio_muted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for participant in room.remote_participants().values() {            let identity = participant.identity().to_string();
            for publication in participant.track_publications().values() {
                if publication.kind() != TrackKind::Audio {
                    continue;
                }
                let is_share_audio = publication.source() == TrackSource::ScreenshareAudio;
                let want = !deafened && !(is_share_audio && share_muted.contains(&identity));
                publication.set_subscribed(want);
                touched += 1;
                if !want {
                    continue;
                }
                if let Some(RemoteTrack::Audio(audio_track)) = publication.track() {
                    let sid = publication.sid().to_string();
                    let fresh = self
                        .attached
                        .lock()
                        .map(|mut a| a.insert(sid))
                        .unwrap_or(false);
                    if fresh {
                        spawn_rms_task(
                            self.rt.handle(),
                            &self.event_tx,
                            identity.clone(),
                            audio_track.rtc_track(),
                        );
                    }
                }
            }
        }
        log::info!("[Sion][voix-native] sourdine={} ({} piste(s) audio)", deafened, touched);
        if !deafened {
            ensure_playout_unmuted();
        }
        Ok(touched)
    }

    /// Coupe / rétablit le SON du partage d'écran d'un expéditeur (miroir du
    /// toggle 🔊 JS), sans toucher aux voix. Retourne `true` si une piste
    /// `ScreenshareAudio` de cet expéditeur existe (false = pas de son
    /// partagé, le front masque le contrôle).
    pub fn set_screenshare_audio_subscribed(
        &self,
        sender: &str,
        subscribed: bool,
    ) -> Result<bool, String> {
        // Même exigence de contexte Tokio que `set_deafened`.
        let _rt_enter = self.rt.enter();
        if subscribed {
            self.share_audio_muted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(sender);
        } else {
            self.share_audio_muted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sender.to_string());
        }
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = room_guard.as_ref() else {
            return Ok(false);
        };
        let mut found = false;
        for participant in room.remote_participants().values() {
            if participant.identity().as_str() != sender {
                continue;
            }
            for publication in participant.track_publications().values() {
                if publication.kind() != TrackKind::Audio
                    || publication.source() != TrackSource::ScreenshareAudio
                {
                    continue;
                }
                found = true;
                // Le RMS est ré-accroché explicitement (pas via l'event, qui
                // peut tarder) ; `attached` purgé du sid pour éviter le
                // doublon quand l'event arrivera.
                let sid = publication.sid().to_string();
                self.attached
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(sid.as_str());
                publication.set_subscribed(subscribed);
                if subscribed {
                    if let Some(RemoteTrack::Audio(audio_track)) = publication.track() {
                        let fresh = self
                            .attached
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(sid);
                        if fresh {
                            spawn_rms_task(
                                self.rt.handle(),
                                &self.event_tx,
                                sender.to_string(),
                                audio_track.rtc_track(),
                            );
                        }
                    }
                }
            }
        }
        log::info!(
            "[Sion][voix-native] son du partage {} : {}",
            sender,
            if found {
                if subscribed { "rétabli" } else { "coupé" }
            } else {
                "aucune piste ScreenshareAudio"
            }
        );
        Ok(found)
    }

    fn spawn_event_pump(
        &self,
        mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
    ) {
        let tx = self.event_tx.clone();
        let rt_handle = self.rt.handle().clone();
        // Partagés avec `set_deafened` (désinscription des nouvelles pistes
        // quand on est sourdine + ré-accrochage RMS au retour).
        let attached = self.attached.clone();
        let deafened = self.deafened.clone();
        // Son du partage coupé localement : une (ré)inscription SFU ne doit
        // pas le réactiver toute seule (voir `set_deafened`).
        let share_audio_muted = self.share_audio_muted.clone();
        // Pompe vidéo : handles possédés (la tâche est `'static`, pas de `&self`).
        let video_stops = self.video_stops.clone();
        let video_app = self
            .event_app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let video_rt = self.rt.handle().clone();
        self.rt.spawn(async move {
            while let Some(ev) = events.recv().await {
                match ev {
                    RoomEvent::Connected { participants_with_tracks } => {
                        // Participants déjà présents (aucun ParticipantConnected
                        // ne sera émis pour eux) + leurs pistes existantes.
                        log::info!(
                            "[Sion][voix-native] seeding Connected: {} participant(s) distant(s)",
                            participants_with_tracks.len()
                        );
                        for (participant, publications) in &participants_with_tracks {
                            let id = participant.identity().to_string();
                            let _ = tx.send(VoiceEngineEvent::ParticipantJoined {
                                identity: id.clone(),
                                name: participant.name(),
                            });
                            for publication in publications {
                                // L'état live de la publication fait foi (et pas
                                // notre cache) : un unpublish+republish (ex. fin
                                // de sourdine côté JS) ne réémet pas forcément
                                // de TrackUnmuted, d'où un mute fantôme sinon.
                                let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                                    identity: id.clone(),
                                    muted: publication.is_muted(),
                                });
                                // Présence du son de partage pour les pistes
                                // déjà là (le front affiche le contrôle 🔊).
                                if publication.kind() == TrackKind::Audio
                                    && publication.source() == TrackSource::ScreenshareAudio
                                {
                                    let _ = tx.send(VoiceEngineEvent::ShareAudioPresence {
                                        sender: id.clone(),
                                        has_audio: true,
                                    });
                                }
                                if deafened.load(std::sync::atomic::Ordering::Relaxed) {
                                    if publication.kind() == TrackKind::Audio {
                                        publication.set_subscribed(false);
                                    }
                                    continue;
                                }
                                if let Some(RemoteTrack::Audio(audio_track)) =
                                    publication.track()
                                {
                                    let sid = publication.sid().to_string();
                                    let fresh = attached
                                        .lock()
                                        .map(|mut a| a.insert(sid))
                                        .unwrap_or(false);
                                    if fresh {
                                        spawn_rms_task(
                                            &rt_handle,
                                            &tx,
                                            id.clone(),
                                            audio_track.rtc_track(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    RoomEvent::ParticipantConnected(p) => {
                        log::info!(
                            "[Sion][voix-native] participant rejoint {} ({})",
                            p.identity(),
                            p.name()
                        );
                        let _ = tx.send(VoiceEngineEvent::ParticipantJoined {
                            identity: p.identity().to_string(),
                            name: p.name(),
                        });
                    }
                    RoomEvent::ParticipantDisconnected(p) => {
                        let id = p.identity().to_string();
                        log::info!("[Sion][voix-native] participant parti {}", id);
                        stop_remote_video_pump(&video_stops, &id);
                        share_audio_muted
                            .lock()
                            .map(|mut m| m.remove(id.as_str()))
                            .unwrap_or(false);
                        let _ = tx.send(VoiceEngineEvent::ParticipantLeft { identity: id });
                    }
                    RoomEvent::TrackPublished { publication, participant } => {
                        log::info!(
                            "[Sion][voix-native] piste publiée {} ({}, {:?}/{:?}, muette={})",
                            publication.sid(),
                            participant.identity(),
                            publication.kind(),
                            publication.source(),
                            publication.is_muted()
                        );
                    }
                    RoomEvent::TrackUnpublished { publication, participant } => {
                        log::info!(
                            "[Sion][voix-native] piste dépubliée {} ({})",
                            publication.sid(),
                            participant.identity()
                        );
                        // Son du partage retiré côté émetteur : masquer le
                        // contrôle 🔊 (pas de réinscription possible).
                        if publication.kind() == TrackKind::Audio
                            && publication.source() == TrackSource::ScreenshareAudio
                        {
                            let _ = tx.send(VoiceEngineEvent::ShareAudioPresence {
                                sender: participant.identity().to_string(),
                                has_audio: false,
                            });
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track: RemoteTrack::Audio(audio_track),
                        publication,
                        participant,
                        ..
                    } => {
                        // Rond vert : RMS côté natif sur les frames reçues,
                        // mêmes seuils que speakingDetector.ts. Sous sourdine,
                        // on désinscrit d'office (retour sonore au undeafen).
                        if deafened.load(std::sync::atomic::Ordering::Relaxed) {
                            log::info!("[Sion][voix-native] piste {} désinscrite (sourdine)", publication.sid());
                            publication.set_subscribed(false);
                        } else {
                            let sid = publication.sid().to_string();
                            let sender = participant.identity().to_string();
                            let is_share_audio = publication.source() == TrackSource::ScreenshareAudio;
                            if is_share_audio {
                                log::info!("[Sion][voix-native] piste audio de partage souscrite {} ({})", sid, sender);
                                let _ = tx.send(VoiceEngineEvent::ShareAudioPresence {
                                    sender: sender.clone(),
                                    has_audio: true,
                                });
                            } else {
                                log::info!("[Sion][voix-native] piste audio souscrite {} ({})", sid, sender);
                            }
                            // Son du partage coupé localement : on ne le
                            // réactive pas tout seul (voir commande).
                            let share_still_muted = is_share_audio
                                && share_audio_muted
                                    .lock()
                                    .map(|m| m.contains(sender.as_str()))
                                    .unwrap_or(false);
                            if share_still_muted {
                                publication.set_subscribed(false);
                            } else {
                                // Resync : une republication (fin de sourdine
                                // distante) démarre non-mutée sans TrackUnmuted.
                                let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                                    identity: sender.clone(),
                                    muted: publication.is_muted(),
                                });
                                let fresh = attached
                                    .lock()
                                    .map(|mut a| a.insert(sid))
                                    .unwrap_or(false);
                                if fresh {
                                    spawn_rms_task(
                                        &rt_handle,
                                        &tx,
                                        sender,
                                        audio_track.rtc_track(),
                                    );
                                }
                            }
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track: RemoteTrack::Video(video_track),
                        publication,
                        participant,
                        ..
                    } => {
                        let sender = participant.identity().to_string();
                        if publication.source() == TrackSource::Screenshare {
                            // Couche haute + dimensions de rendu : sans ça le
                            // SFU ne sert que la sous-couche (ex. 1280px pour
                            // un écran 2560px) et le texte est illisible.
                            publication.set_video_quality(VideoQuality::High);
                            publication.update_video_dimensions(TrackDimension(1920, 1080));
                            // Échelle des couches (diagnostic : que propose le
                            // SFU ?). Pas d'API pour lister les couches
                            // simulcast — dimension + simulcast + dims des
                            // frames décodées ci-dessous = l'échelle servie.
                            let dim = publication.dimension();
                            log::info!(
                                "[Sion][voix-native] partage d'écran souscrit {} ({}, simulcast={}, codec={}, dim_annoncee={}x{})",
                                publication.sid(),
                                sender,
                                publication.simulcasted(),
                                publication.mime_type(),
                                dim.0,
                                dim.1
                            );
                            let _ = tx.send(VoiceEngineEvent::VideoPresence {
                                sender: sender.clone(),
                                sharing: true,
                            });
                            start_remote_video_pump(
                                &video_rt,
                                video_app.clone(),
                                &video_stops,
                                sender,
                                video_track.rtc_track(),
                            );
                        } else {
                            log::info!(
                                "[Sion][voix-native] piste vidéo caméra ignorée {} ({})",
                                publication.sid(),
                                sender
                            );
                        }
                    }
                    RoomEvent::TrackUnsubscribed {
                        track: RemoteTrack::Video(video_track),
                        participant,
                        ..
                    } => {
                        let sender = participant.identity().to_string();
                        log::info!(
                            "[Sion][voix-native] partage désinscrit {} ({})",
                            video_track.sid(),
                            sender
                        );
                        stop_remote_video_pump(&video_stops, &sender);
                        let _ = tx.send(VoiceEngineEvent::VideoPresence {
                            sender,
                            sharing: false,
                        });
                    }
                    RoomEvent::TrackUnsubscribed {
                        track: RemoteTrack::Audio(audio_track),
                        publication,
                        participant,
                        ..
                    } => {
                        // Seul le son du partage intéresse le front (l'icône
                        // 🔊) ; les voix se contentent de la fin de piste RMS.
                        if publication.source() == TrackSource::ScreenshareAudio {
                            let sender = participant.identity().to_string();
                            log::info!(
                                "[Sion][voix-native] son du partage désinscrit {} ({})",
                                audio_track.sid(),
                                sender
                            );
                            let _ = tx.send(VoiceEngineEvent::ShareAudioPresence {
                                sender,
                                has_audio: false,
                            });
                        }
                    }
                    RoomEvent::TrackMuted { participant, .. } => {
                        let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                            identity: participant.identity().to_string(),
                            muted: true,
                        });
                    }
                    RoomEvent::TrackUnmuted { participant, .. } => {
                        let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                            identity: participant.identity().to_string(),
                            muted: false,
                        });
                    }
                    RoomEvent::ConnectionQualityChanged { quality, participant } => {
                        let _ = tx.send(VoiceEngineEvent::QualityChanged {
                            identity: participant.identity().to_string(),
                            quality: connection_quality_str(&quality).to_string(),
                        });
                    }
                    RoomEvent::DataReceived { payload, topic, participant, .. } => {
                        // Journal systématique (topic/expéditeur/taille) : le
                        // data-channel est le seul vecteur des états live
                        // (AFK, soundboard, curseurs) — un paquet manquant
                        // doit se voir, pas se deviner. Le curseur (60 Hz)
                        // reste en debug pour ne pas noyer le log.
                        let sender = participant.as_ref().map(|p| p.identity().to_string());
                        if topic.as_deref() == Some(crate::voice_native::TOPIC_CURSOR) {
                            log::debug!(
                                "[Sion][voix-native] data reçu topic=sion-cursor de={:?} ({} o)",
                                sender,
                                payload.len()
                            );
                        } else {
                            log::info!(
                                "[Sion][voix-native] data reçu topic={:?} de={:?} ({} o)",
                                topic,
                                sender,
                                payload.len()
                            );
                        }
                        let _ = tx.send(VoiceEngineEvent::DataReceived {
                            topic,
                            payload_b64: base64::engine::general_purpose::STANDARD
                                .encode(payload.as_slice()),
                            sender: participant.map(|p| p.identity().to_string()),
                        });
                    }
                    RoomEvent::Disconnected { reason } => {
                        let _ = tx.send(VoiceEngineEvent::RoomDisconnected {
                            reason: format!("{:?}", reason),
                        });
                    }
                    RoomEvent::Reconnecting => {
                        let _ = tx.send(VoiceEngineEvent::RoomReconnecting);
                    }
                    RoomEvent::Reconnected => {
                        let _ = tx.send(VoiceEngineEvent::RoomReconnected);
                    }
                    _ => {}
                }
            }
        });
    }
}

impl VoiceEngine for LiveKitEngine {
    fn connect(&mut self, url: &str, token: &str) -> Result<String, String> {
        if url.trim().is_empty() {
            return Err("URL LiveKit vide".into());
        }
        if token.trim().is_empty() {
            return Err("Token LiveKit vide".into());
        }
        // Chronométrage du join (diagnostic : les pairs renvoient leur état
        // ~500 ms après nous avoir vus — si ce connect dépasse ça, leurs
        // rebroadcasts tombent avant que notre data-channel soit prêt).
        let t0 = std::time::Instant::now();
        let (room, events) = self
            .rt
            .block_on(Room::connect(url, token, RoomOptions::default()))
            .map_err(|e| format!("connect LiveKit: {}", e))?;
        log::info!(
            "[Sion][voix-native] session SFU établie en {}ms (signal+PC+data-channel)",
            t0.elapsed().as_millis()
        );
        let identity = room.local_participant().identity().to_string();
        self.deafened
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.attached
            .lock()
            .map(|mut a| a.clear())
            .unwrap_or_default();
        self.share_audio_muted
            .lock()
            .map(|mut m| m.clear())
            .unwrap_or_default();
        self.spawn_event_pump(events);
        *self.room.lock().unwrap_or_else(|e| e.into_inner()) = Some(room);
        // Le démute one-shot au publish ne suffit pas (l'ADM se remute
        // parfois en cours d'appel) : garde périodique jusqu'au disconnect.
        *self.watchdog_stop.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(start_playout_watchdog(&self.deafened));
        Ok(identity)
    }

    fn disconnect(&mut self) {
        let room = self.room.lock().map(|mut g| g.take()).unwrap_or(None);
        if let Some(room) = room {
            let _ = self.rt.block_on(room.close());
        }
        // Plus aucune frame : les pompes vidéo meurent via leurs canaux stop
        // (leurs events `frame-stopped` partent avant la fin de l'ADM).
        for (_, stop) in self
            .video_stops
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = stop.send(());
        }
        *self.event_app.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // L'ADM se coupe quand le dernier `PlatformAudio` tombe ; le meter
        // local s'arrête quand son canal stop se ferme.
        *self.audio.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.local_meter_stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.watchdog_stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.share_audio_muted
            .lock()
            .map(|mut m| m.clear())
            .unwrap_or_default();
        self.deafened
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_rejects_empty_credentials_without_touching_network() {
        let mut engine = LiveKitEngine::new().expect("runtime tokio");
        assert!(!engine.is_connected());
        assert!(engine.connect("", "jwt").is_err());
        assert!(engine.connect("wss://x", "").is_err());
        assert!(engine.connect("  ", "jwt").is_err());
        assert!(!engine.is_connected());
    }

    #[test]
    fn disconnect_is_idempotent() {
        let mut engine = LiveKitEngine::new().expect("runtime tokio");
        engine.disconnect();
        engine.disconnect();
        assert!(!engine.is_connected());
    }

    #[test]
    fn publish_without_session_fails_cleanly() {
        let engine = LiveKitEngine::new().expect("runtime tokio");
        assert!(engine.publish_microphone().is_err());
        // Mute sans session : unpublish inexistant = no-op OK.
        assert!(engine.set_microphone_enabled(false).is_ok());
        // Data sans session : erreur propre, pas de panique.
        assert!(engine.publish_data("sion-soundboard", vec![1, 2, 3], true).is_err());
    }

    #[test]
    fn i16_frames_drive_the_same_hysteresis() {
        let mut det = RmsSpeakingDetector::new();
        // Silence.
        assert_eq!(push_i16_frame(&mut det, &[0; 480]), None);
        // Voix nette : 3000/32768 ≈ 0.09 > RMS_START.
        assert_eq!(push_i16_frame(&mut det, &[3000; 480]), Some(true));
        // Bande d'hystérésis : 40/32768 ≈ 0.0012 > SILENCE → reste en parole.
        assert_eq!(push_i16_frame(&mut det, &[40; 480]), None);
        assert!(det.is_speaking());
        // Retour au silence franc.
        assert_eq!(push_i16_frame(&mut det, &[0; 480]), Some(false));
        assert_eq!(push_i16_frame(&mut det, &[]), None);
    }

    #[test]
    fn video_emit_dims_plafonne_et_pairise() {
        assert_eq!(video_emit_dims(0, 0), (0, 0));
        assert_eq!(video_emit_dims(2560, 1072), (2560, 1072));
        assert_eq!(video_emit_dims(1920, 1080), (1920, 1080));
        assert_eq!(video_emit_dims(1280, 720), (1280, 720));
        assert_eq!(video_emit_dims(640, 480), (640, 480));
        // Dimensions impaires → pairisées (I420).
        assert_eq!(video_emit_dims(641, 481), (640, 480));
        // Ultrawide large : ratio conservé sous le plafond.
        assert_eq!(video_emit_dims(3440, 1440), (2560, 1070));
    }

    #[test]
    fn jpeg_encode_produit_un_vrai_jpeg() {
        let rgb = vec![128u8; 8 * 8 * 3];
        let jpeg = encode_jpeg_rgb(8, 8, &rgb, 80).expect("encode jpeg");
        assert!(jpeg.len() > 2);
        assert_eq!(&jpeg[0..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn jpeg_rgba_420_plus_petit_que_444() {
        // Damier haute fréquence : le 4:2:0 doit compacter plus fort.
        let mut rgba = vec![0u8; 64 * 64 * 4];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            let v = if (i / 64 + i % 64) % 2 == 0 { 30 } else { 220 };
            px[0] = v;
            px[1] = 255 - v;
            px[2] = 128;
            px[3] = 255;
        }
        let j444 = encode_jpeg_rgba(64, 64, &rgba, 80, true).expect("444");
        let j420 = encode_jpeg_rgba(64, 64, &rgba, 80, false).expect("420");
        assert_eq!(&j444[0..2], &[0xFF, 0xD8]);
        assert_eq!(&j420[0..2], &[0xFF, 0xD8]);
        assert!(j420.len() < j444.len(), "420={} 444={}", j420.len(), j444.len());
    }

    /// Garde-fou du swap RGBA↔ABGR / BGRA↔ARGB du binding (écran rouge en
    /// prod) : on demande ABGR et on DOIT lire du RGBA. Tolérance ±25
    /// (arrondis libyuv + plage limitée BT.601).
    #[test]
    fn libyuv_to_argb_ordre_des_canaux() {
        use livekit::webrtc::video_frame::{I420Buffer, VideoFormatType};
        fn convert(y: u8, u: u8, v: u8) -> [u8; 4] {
            let mut buf = I420Buffer::new(2, 2);
            let (dy, du, dv) = buf.data_mut();
            dy.fill(y);
            du.fill(u);
            dv.fill(v);
            let mut out = [0u8; 16];
            buf.to_argb(VideoFormatType::ABGR, &mut out, 8, 2, 2);
            [out[0], out[1], out[2], out[3]]
        }
        let near = |got: [u8; 4], exp: [u8; 4]| {
            got.iter()
                .zip(exp.iter())
                .all(|(g, e)| (*g as i16 - *e as i16).abs() <= 25)
        };
        // Rouge / vert / bleu purs + blanc, lus en ordre RGBA.
        assert!(near(convert(82, 90, 240), [255, 0, 0, 255]), "rouge");
        assert!(near(convert(145, 54, 34), [0, 255, 0, 255]), "vert");
        assert!(near(convert(41, 240, 110), [0, 0, 255, 255]), "bleu");
        assert!(near(convert(235, 128, 128), [255, 255, 255, 255]), "blanc");
    }

    /// L'encodeur lit bien du RGBA dans l'ordre (rouge encodé = rouge
    /// décodé, via le décodeur `image` en référence).
    #[test]
    fn jpeg_rgba_conserve_les_canaux() {
        let mut rgba = vec![0u8; 16 * 16 * 4];
        for px in rgba.chunks_exact_mut(4) {
            px[0] = 220;
            px[1] = 30;
            px[2] = 40;
            px[3] = 255;
        }
        let jpeg = encode_jpeg_rgba(16, 16, &rgba, 85, true).expect("encode");
        let img = image::load_from_memory(&jpeg).expect("decode").to_rgb8();
        let px = img.get_pixel(8, 8);
        assert!(px[0] > 150 && px[1] < 110 && px[2] < 120, "px={:?}", px);
    }

    #[test]
    fn adapt_budget_degrade_qualite_avant_cadence() {
        let start = VideoBudget { quality: 86, tick_step: 0 };
        // Sous la cible (~4 Mo/s sur 2 s) : qualité remonte, cadence intacte.
        assert_eq!(
            adapt_budget(&start, 100_000, 2),
            VideoBudget { quality: 88, tick_step: 0 }
        );
        // Au-dessus : qualité baisse vite, cadence intacte.
        assert_eq!(
            adapt_budget(&start, 9_000_000, 2),
            VideoBudget { quality: 80, tick_step: 0 }
        );
        // Coincé au plancher qualité + toujours au-dessus : cadence baisse.
        let floor = VideoBudget { quality: VIDEO_Q_MIN, tick_step: 0 };
        assert_eq!(
            adapt_budget(&floor, 9_000_000, 2),
            VideoBudget { quality: VIDEO_Q_MIN, tick_step: 1 }
        );
        // Dernier palier : on reste (pas de panique, pas de recul).
        let last = VideoBudget { quality: VIDEO_Q_MIN, tick_step: VIDEO_TICKS_MS.len() - 1 };
        assert_eq!(adapt_budget(&last, 9_000_000, 2), last);
        // Budget redevenu sain : cadence remonte AVANT la qualité.
        let slow = VideoBudget { quality: VIDEO_Q_MIN, tick_step: 1 };
        assert_eq!(
            adapt_budget(&slow, 100_000, 2),
            VideoBudget { quality: VIDEO_Q_MIN, tick_step: 0 }
        );
        // Bornes qualité.
        assert_eq!(
            adapt_budget(&VideoBudget { quality: 89, tick_step: 0 }, 0, 2),
            VideoBudget { quality: 90, tick_step: 0 }
        );
        // Fenêtre vide : pas de division par zéro, inchangé.
        assert_eq!(adapt_budget(&start, 0, 0), start);
    }
    #[test]
    fn adm_playout_indices_filtre_livraison() {
        let fixture = r#"[
            {"index": 11, "properties": {"application.name": "Firefox"}},
            {"index": 22, "properties": {"application.name": "WEBRTC VoiceEngine", "media.name": "playStream"}},
            {"index": 33, "properties": {"application.name": "WEBRTC VoiceEngine", "media.name": "recStream"}},
            {"index": 44, "properties": {}},
            {"index": "nan", "properties": {"application.name": "WEBRTC VoiceEngine"}}
        ]"#;
        assert_eq!(adm_playout_indices(fixture), vec![22, 33]);
        assert!(adm_playout_indices("pas du json").is_empty());
        assert!(adm_playout_indices("{}").is_empty());
    }

    #[test]
    fn adm_playout_states_rapporte_muet_bouche_routage() {
        let fixture = r#"[
            {"index": 11, "mute": false, "properties": {"application.name": "Firefox"}},
            {"index": 22, "mute": true, "corked": false, "sink": 31,
             "volume": {"front-left": {"value": 65536, "display": "100%"}},
             "properties": {"application.name": "WEBRTC VoiceEngine", "media.name": "playStream"}},
            {"index": 33, "mute": false, "corked": true, "sink": 117,
             "properties": {"application.name": "WEBRTC VoiceEngine", "media.name": "recStream"}},
            {"index": 44, "properties": {"application.name": "WEBRTC VoiceEngine"}}
        ]"#;
        let states = adm_playout_states(fixture);
        assert_eq!(states.len(), 3);
        assert_eq!(
            states[0],
            AdmuiPlayoutState {
                index: 22,
                muted: true,
                corked: false,
                sink: Some(31),
                media: Some("playStream".to_string()),
                volume_display: Some("100%".to_string()),
            }
        );
        assert_eq!(states[1].index, 33);
        assert!(!states[1].muted);
        assert!(states[1].corked);
        assert_eq!(states[1].sink, Some(117));
        // Pas d'index → ignoré (comme indices).
        assert_eq!(states[2].index, 44);
        assert!(!states[2].muted);
        assert!(adm_playout_states("pas du json").is_empty());
    }

    #[test]
    fn deafen_without_session_is_noop() {
        let engine = LiveKitEngine::new().expect("runtime tokio");
        assert_eq!(engine.set_deafened(true), Ok(0));
        assert_eq!(engine.set_deafened(false), Ok(0));
    }

    #[test]
    fn mic_options_advertise_microphone_source() {
        // Sans source=Microphone, les pairs JS ne trouvent pas la publication
        // (isMicrophoneEnabled) et nous affichent mutés alors que l'audio passe.
        let opts = mic_publish_options();
        assert_eq!(opts.source, TrackSource::Microphone);
        // Parité publishDefaults JS.
        assert!(!opts.dtx);
        assert!(!opts.red);
    }

    #[test]
    fn quality_str_covers_sdk_values() {
        assert_eq!(connection_quality_str(&ConnectionQuality::Excellent), "excellent");
        assert_eq!(connection_quality_str(&ConnectionQuality::Good), "good");
        assert_eq!(connection_quality_str(&ConnectionQuality::Poor), "poor");
        assert_eq!(connection_quality_str(&ConnectionQuality::Lost), "lost");
    }

    #[test]
    fn engine_events_serialize_for_tauri_emit() {
        let ev = VoiceEngineEvent::SpeakingChanged {
            identity: "@a:b:c".into(),
            speaking: true,
        };
        let raw = serde_json::to_string(&ev).unwrap();
        assert!(raw.contains(r#""type":"speaking_changed""#));
        assert!(raw.contains(r#""speaking":true"#));

        let ev = VoiceEngineEvent::DataReceived {
            topic: Some("sion-afk".into()),
            payload_b64: "e30=".into(),
            sender: None,
        };
        let raw = serde_json::to_string(&ev).unwrap();
        assert!(raw.contains(r#""type":"data_received""#));
    }

    /// Connexion réelle contre un SFU — ignoré par défaut (besoin d'un
    /// serveur + token valides). Lancer avec :
    /// `LIVEKIT_TEST_URL=wss://... LIVEKIT_TEST_TOKEN=... cargo test
    /// --features native-voice live_connect -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_connect() {
        let url = std::env::var("LIVEKIT_TEST_URL").expect("LIVEKIT_TEST_URL requis");
        let token = std::env::var("LIVEKIT_TEST_TOKEN").expect("LIVEKIT_TEST_TOKEN requis");
        let mut engine = LiveKitEngine::new().expect("runtime tokio");
        let identity = engine.connect(&url, &token).expect("connect SFU");
        assert!(!identity.is_empty());
        assert!(engine.is_connected());
        engine.disconnect();
        assert!(!engine.is_connected());
    }
}
