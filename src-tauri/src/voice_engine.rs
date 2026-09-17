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
//! - le rond vert distant suit les identités `ActiveSpeakersChanged` du SFU ;
//!   le niveau local vient directement de la capture APM WebRTC.

use std::sync::Mutex;

use base64::Engine as _;
use livekit::e2ee::key_provider::KeyDerivationAlgorithm;
use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::prelude::*;

/// Options du provider E2EE : fenêtre de ratchet + anneau alignés sur
/// Element Call (`MatrixKeyProvider` JS : 10 / 256). Tolérance 10 comme le
/// worker E2EE livekit-client (défaut JS) : un `MissingKey` transitoire
/// (clé en retard de quelques ms sur les frames) ne doit pas invalider la
/// clé définitivement — avec -1 (défaut Rust, "no tolerance"), le cryptor
/// restait collé en `MissingKey` après l'arrivée de la clé alors que le JS
/// récupérait. Sel + KDF par défaut du SDK (compatibles livekit-client).
fn e2ee_key_provider_options() -> KeyProviderOptions {
    KeyProviderOptions {
        ratchet_window_size: 10,
        key_ring_size: 256,
        failure_tolerance: 10,
        // Dérivation HKDF-SHA256 comme livekit-client (le worker importe
        // les clés brutes en HKDF et ratchette en HKDF) : avec le PBKDF2
        // par défaut du SDK, les clés de frames dérivées diffèrent et tout
        // déchiffrement croisé JS↔natif échoue (`DecryptionFailed`).
        key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
        ..Default::default()
    }
}

/// Keystore E2EE partagé par tous les moteurs du processus (cloné à chaque
/// `Engine::new`, même objet C++ sous-jacent via `SharedPtr`) : l'historique
/// des clés SURVIT aux rejoins, comme le provider JS long-vécu. Sans ça,
/// chaque join repart vide et toute frame sous ancien index adopté reste en
/// `MissingKey` définitif pendant que le JS (historique complet) entend.
#[allow(dead_code)]
static E2EE_STORE: std::sync::OnceLock<KeyProvider> = std::sync::OnceLock::new();

fn shared_e2ee_store() -> KeyProvider {
    E2EE_STORE
        .get_or_init(|| KeyProvider::new(e2ee_key_provider_options()))
        .clone()
}
use livekit::options::{
    AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding,
};
use livekit::track::VideoQuality;
use livekit::webrtc::desktop_capturer::{
    CaptureError, CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use livekit::webrtc::video_frame::native::VideoFrameBufferExt as _;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use tauri::Emitter as _;

use crate::voice_native::{RmsSpeakingDetector, VoiceEngine};

/// Événement moteur → front. Forme stable et sérialisable : les commandes
/// Tauri les réémettent tels quels (`voice-native-*`), le front consomme la
/// même forme que pour le chemin JS.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceEngineEvent {
    ParticipantJoined {
        identity: String,
        name: String,
    },
    ParticipantLeft {
        identity: String,
    },
    SpeakingChanged {
        identity: String,
        speaking: bool,
    },
    TrackMutedChanged {
        identity: String,
        muted: bool,
    },
    QualityChanged {
        identity: String,
        quality: String,
    },
    DataReceived {
        topic: Option<String>,
        payload_b64: String,
        sender: Option<String>,
    },
    /// Partage d'écran distant (présence) : le front affiche/masque la vue.
    /// Les pixels arrivent séparément par le WebSocket vidéo local (JPEG).
    VideoPresence {
        sender: String,
        sharing: bool,
    },
    /// Le partage d'écran distant publie aussi du son (piste
    /// `ScreenshareAudio`) : le front affiche le contrôle 🔊/🔇.
    /// Indépendant du mute local (voir `set_screenshare_audio_subscribed`).
    ShareAudioPresence {
        sender: String,
        has_audio: bool,
    },
    RoomDisconnected {
        reason: String,
    },
    RoomReconnecting,
    RoomReconnected,
    /// État E2EE d'un participant (`New/Ok/MissingKey/DecryptionFailed/…`) :
    /// le diagnostic décisif en salon chiffré (clés importées mais silence
    /// = `MissingKey` ou `DecryptionFailed` ici, pas de devinette).
    E2eeStateChanged {
        identity: String,
        state: String,
    },
}

/// Plafond d'énumération des périphériques ADM.
///
/// L'ADM WebRTC renvoie `-1` comme nombre de périphériques tant qu'il n'a pas
/// fini d'énumérer (constaté au démarrage sous WRY : 3 devices une fois prêt,
/// `-1` sinon). Or `PlatformAudio::recording_devices()` convertit ce `-1` en
/// `usize` (`usize::MAX`) et construit `0..usize::MAX` : chaque `find()`/`next()`
/// boucle alors sans fin et gèle le thread appelant (commande Tauri synchrone
/// = thread principal). On borne donc TOUJOURS l'itération.
const MAX_AUDIO_DEVICE_SCAN: usize = 64;

/// Un périphérique ADM est « réel » dès qu'il expose un nom ou un GUID. Tant
/// que l'énumération n'a pas eu lieu, les index invalides renvoient les deux
/// vides.
fn audio_device_is_real(name: &str, id: &str) -> bool {
    !name.trim().is_empty() || !id.trim().is_empty()
}

/// Liste bornée des micros réellement exposés par l'ADM.
pub(crate) fn list_recording_devices(audio: &PlatformAudio) -> Vec<RecordingDeviceInfo> {
    audio
        .recording_devices()
        .take(MAX_AUDIO_DEVICE_SCAN)
        .filter(|d| audio_device_is_real(&d.name, d.id.as_str()))
        .collect()
}

/// Liste bornée des sorties réellement exposées par l'ADM.
pub(crate) fn list_playout_devices(audio: &PlatformAudio) -> Vec<PlayoutDeviceInfo> {
    audio
        .playout_devices()
        .take(MAX_AUDIO_DEVICE_SCAN)
        .filter(|d| audio_device_is_real(&d.name, d.id.as_str()))
        .collect()
}

/// Snapshot des périphériques vus par l'ADM (diagnostic + futurs réglages).
/// Installe un sink de logs WebRTC → `log` (sinon WebRTC reste muet :
/// échecs de la boucle PipeWire, états du stream, portail… invisibles).
/// Le sink vit pour tout le processus — on le « fuit » volontairement.
#[cfg(feature = "native-voice")]
pub fn install_webrtc_log_sink() {
    use std::sync::Once;
    use webrtc_sys::webrtc::ffi::{new_log_sink, LoggingSeverity};
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let sink = new_log_sink(|message, severity| {
            // WebRTC est extrêmement bavard (un log par ping STUN) : on ne
            // garde que les erreurs/avertissements et les messages qui
            // touchent la capture d'écran. Filtre sans allocation (pas de
            // to_lowercase) : ce chemin est appelé pour CHAQUE ligne WebRTC.
            let keep = match severity {
                LoggingSeverity::Error | LoggingSeverity::Warning => true,
                _ => {
                    message.contains("PipeWire")
                        || message.contains("pipewire")
                        || message.contains("screencast")
                        || message.contains("ScreenCast")
                        || message.contains("portal")
                        || message.contains("Portal")
                        || message.contains("apturer")
                        || message.contains("ayland")
                }
            };
            if !keep {
                return;
            }
            let msg = format!("[webrtc] {message}");
            match severity {
                LoggingSeverity::Error => log::error!("{msg}"),
                LoggingSeverity::Warning => log::warn!("{msg}"),
                _ => log::info!("{msg}"),
            }
        });
        std::mem::forget(sink);
    });
}

/// Crée un `PlatformAudio` temporaire (refcount +1 le temps de l'appel).
/// Sondage non bloquant : la liste peut être vide si l'ADM n'a pas fini
/// d'énumérer, l'UI la rafraîchit de toute façon.
pub fn platform_audio_snapshot() -> Result<
    (
        Vec<crate::voice_native::NativeAudioDevice>,
        Vec<crate::voice_native::NativeAudioDevice>,
    ),
    String,
> {
    use crate::voice_native::NativeAudioDevice;
    let audio = PlatformAudio::new().map_err(|e| format!("audio natif: {}", e))?;
    let to_native = |id: &str, name: &str, index: usize| NativeAudioDevice {
        id: id.to_string(),
        name: name.to_string(),
        index,
    };
    let recording = list_recording_devices(&audio)
        .into_iter()
        .map(|d| to_native(d.id.as_str(), &d.name, d.index))
        .collect();
    let playout = list_playout_devices(&audio)
        .into_iter()
        .map(|d| to_native(d.id.as_str(), &d.name, d.index))
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
            muted: entry.get("mute").and_then(|m| m.as_bool()).unwrap_or(false),
            corked: entry
                .get("corked")
                .and_then(|c| c.as_bool())
                .unwrap_or(false),
            sink: entry.get("sink").and_then(|s| s.as_u64()),
            media: props
                .and_then(|p| p.get("media.name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string()),
            volume_display: entry.get("volume").and_then(find_volume_display),
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
                    log::info!(
                        "[Sion][voix-native] playout ADM démute (sink-input {})",
                        st.index
                    )
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
        .spawn(move || loop {
            match stop_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !deafened.load(std::sync::atomic::Ordering::Relaxed) {
                        ensure_playout_unmuted();
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
pub fn mic_publish_options(max_bitrate: u64) -> TrackPublishOptions {
    TrackPublishOptions {
        source: TrackSource::Microphone,
        audio_encoding: Some(AudioEncoding { max_bitrate }),
        dtx: false,
        red: false,
        ..Default::default()
    }
}

/// Options de publication du partage d'écran local. `source: Screenshare`
/// (SANS ÇA, les pairs trient la piste en caméra et la vue ne l'affiche
/// pas) ; le reste en défaut du SDK (simulcast VP8 — les viewers demandent
/// la couche haute comme pour les partages JS).
pub fn screenshare_publish_options(
    max_bitrate: u64,
    max_framerate: u32,
    codec: &str,
) -> TrackPublishOptions {
    // Demande le backend matériel générique pour H264/AV1. La fabrique
    // webrtc-sys ordonne alors les backends réels selon la plateforme
    // (NVENC sur NVIDIA, VAAPI sur Linux/Intel/AMD, VideoToolbox sur Apple)
    // et retombe proprement sur le logiciel si le pilote échoue.
    let (video_codec, video_encoder) = match codec {
        "h264" => (VideoCodec::H264, VideoEncoderBackend::Hardware),
        "av1" => (VideoCodec::AV1, VideoEncoderBackend::Hardware),
        "vp8" => (VideoCodec::VP8, VideoEncoderBackend::Auto),
        _ => (VideoCodec::VP9, VideoEncoderBackend::Auto),
    };
    TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_encoding: Some(VideoEncoding {
            max_bitrate,
            max_framerate: max_framerate as f64,
        }),
        video_codec,
        video_encoder,
        ..Default::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenShareConfig {
    pub max_width: u32,
    pub max_height: u32,
    pub framerate: u32,
    pub max_bitrate: u64,
}

/// Convertit les choix du menu en limites de capture et d'encodage. Les
/// valeurs suivent les presets LiveKit JS déjà utilisés par Sion ; les deux
/// combinaisons 5 i/s manquantes dans le SDK JS sont interpolées.
pub fn screenshare_config(resolution: &str, framerate: u32) -> Result<ScreenShareConfig, String> {
    let (max_width, max_height) = match resolution {
        "720p" => (1280, 720),
        "1080p" => (1920, 1080),
        "1440p" => (2560, 1440),
        _ => return Err(format!("résolution de partage invalide: {resolution}")),
    };
    let max_bitrate = match (resolution, framerate) {
        ("720p", 5) => 800_000,
        ("720p", 15) => 1_500_000,
        ("720p", 30) => 2_000_000,
        ("720p", 60) => 3_500_000,
        ("1080p", 5) => 1_200_000,
        ("1080p", 15) => 2_500_000,
        ("1080p", 30) => 5_000_000,
        ("1080p", 60) => 6_000_000,
        ("1440p", 5) => 2_000_000,
        ("1440p", 15) => 5_000_000,
        ("1440p", 30) => 8_000_000,
        ("1440p", 60) => 14_000_000,
        (_, _) => return Err(format!("cadence de partage invalide: {framerate}")),
    };
    Ok(ScreenShareConfig {
        max_width,
        max_height,
        framerate,
        max_bitrate,
    })
}

fn fit_screenshare_dimensions(width: u32, height: u32, config: ScreenShareConfig) -> (u32, u32) {
    if width <= config.max_width && height <= config.max_height {
        return (width & !1, height & !1);
    }
    let by_width = config.max_width as f64 / width as f64;
    let by_height = config.max_height as f64 / height as f64;
    let scale = by_width.min(by_height);
    let fitted_width = ((width as f64 * scale).floor() as u32 & !1).max(2);
    let fitted_height = ((height as f64 * scale).floor() as u32 & !1).max(2);
    (fitted_width, fitted_height)
}

/// Pousse une frame PCM `i16` (format du `NativeAudioStream`) dans le
/// détecteur RMS sans allocation intermédiaire.
#[cfg(test)]
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

/// Applique le gain local WebRTC à la source d'une piste distante. Le SDK
/// Rust n'expose pas encore cette méthode, mais son handle public permet de
/// rejoindre l'API `AudioSourceInterface::SetVolume` du pont webrtc-sys.
fn set_remote_audio_volume(
    track: &livekit::webrtc::audio_track::RtcAudioTrack,
    volume: f32,
) -> bool {
    track.set_volume(volume as f64)
}

/// Calcule les transitions du rond vert à partir de la liste d'orateurs
/// fournie par LiveKit. La comparaison par identité évite de lier le niveau
/// d'une piste décodée au mauvais participant quand plusieurs pistes audio
/// sont souscrites ou remplacées simultanément.
fn speaking_set_changes(
    previous: &mut std::collections::HashSet<String>,
    next: std::collections::HashSet<String>,
) -> Vec<(String, bool)> {
    let mut changes: Vec<_> = previous
        .difference(&next)
        .map(|identity| (identity.clone(), false))
        .chain(
            next.difference(previous)
                .map(|identity| (identity.clone(), true)),
        )
        .collect();
    changes.sort_by(|a, b| a.0.cmp(&b.0));
    *previous = next;
    changes
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

/// RGBA32 → JPEG à qualité donnée. La piste LiveKit décodée est déjà en I420 :
/// réencoder en 4:4:4 ne recrée aucun détail chromatique, mais double presque
/// le volume. La pompe utilise donc 4:2:0 et garde la luminance du texte à sa
/// pleine définition ; 4:4:4 reste disponible pour les tests comparatifs.
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

/// La fin d'une piste `ScreenshareAudio` retire-t-elle le contrôle 🔊 ?
/// Non si c'est NOUS qui avons désinscrit (mute local du partage ou
/// sourdine globale) : la publication existe toujours côté émetteur, le
/// contrôle doit rester pour pouvoir réactiver. Oui sinon (l'émetteur a
/// coupé son partage : `TrackUnpublished` gère déjà ce cas, ceci couvre
/// les `TrackUnsubscribed` spontanés). Fonction pure (testée).
fn share_audio_presence_kept(share_muted: bool, deafened: bool) -> bool {
    share_muted || deafened
}

/// Une publication est-elle un partage d'écran vidéo ? (caméras distantes
/// ignorées en natif, MVP). Fonction pure (testée) : le seeding (pistes
/// déjà là au join) et le live (TrackSubscribed) partagent ce prédicat.
fn is_screenshare_video(kind: TrackKind, source: TrackSource) -> bool {
    matches!(kind, TrackKind::Video) && matches!(source, TrackSource::Screenshare)
}

/// État d'un partage d'écran local (émission) : drapeau stop pour les
/// threads de capture + sids des pistes publiées (pour dépublier au stop).
struct LocalShareState {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    video_sid: TrackSid,
    audio_sid: Option<TrackSid>,
    /// Fil de la pompe audio du partage. **Joint avant toute dépublication** :
    /// sans ça sa dernière poussée pouvait tomber sur une piste déjà détruite
    /// (`SIGSEGV` dans `AudioTransportImpl::SendProcessedData`) ou croiser le
    /// micro (`SIGABRT` `RaceDetected` dans `AudioSendStream::SendAudioData`).
    /// Constaté en test le 13/09.
    audio_pump: Option<std::thread::JoinHandle<()>>,
}

/// Pompe audio du partage : PCM système (f32 48 kHz mono 20 ms, capturé
/// SANS Sion — pas d'écho) → i16 → `AudioFrame` poussée dans une source
/// native (traitements OFF, comme `main` : sur une boucle, l'écho
/// cancellerait le signal lui-même). Se termine sur `stop` ou fin de
/// capture (le Receiver est éjecté quand on arrête de drainer).
fn run_share_audio_pump(
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    audio_source: livekit::webrtc::audio_source::native::NativeAudioSource,
    rt: tokio::runtime::Handle,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use livekit::webrtc::audio_frame::AudioFrame;
    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let frame = match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(f) => f,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if frame.len() < 3840 {
            continue;
        }
        let mut samples = Vec::with_capacity(960);
        for chunk in frame[..3840].chunks_exact(4) {
            let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            samples.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
        }
        let af = AudioFrame {
            data: std::borrow::Cow::Owned(samples),
            sample_rate: 48000,
            num_channels: 1,
            samples_per_channel: 960,
        };
        let _ = rt.block_on(audio_source.capture_frame(&af));
    }
    log::info!("[Sion][voix-native] pompe audio du partage terminée");
}

/// Boucle de capture d'écran : tourne sur un thread propriétaire (le
/// `DesktopCapturer` webrtc n'est pas partageable), pompe `capture_frame`
/// à ~15 im/s et pousse chaque frame dans la `VideoSource` publiée.
/// `DesktopFrame` (BGRA sur Linux) → I420 (SIMD libyuv, PAS de swizzle :
/// `argb_to_i420` lit en fait du BGRA — noms tournés dans ce binding,
/// prouvé par tests) → `VideoFrame`.
/// Se termine sur `stop` (ou erreur permanente : dialogue portail refusé…).
fn run_share_capture(
    mut capturer: DesktopCapturer,
    source: CaptureSource,
    video_source: livekit::webrtc::video_source::native::NativeVideoSource,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    config: ScreenShareConfig,
    ready_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
    capture_armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    capture_failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    app: Option<tauri::AppHandle<crate::TauriRuntime>>,
) {
    use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
    // Stats capture (diagnostic lenteur : la source fournit-elle assez vite,
    // et à quel coût de conversion ?).
    let mut captured: u64 = 0;
    let mut conv_ms_total: u128 = 0;
    let mut stat_since = std::time::Instant::now();
    let mut temp_errors: u64 = 0;
    let stop_cb = std::sync::Arc::clone(&stop);
    let capture_armed_outer = std::sync::Arc::clone(&capture_armed);
    let mut ready_tx = Some(ready_tx);
    // Ce rappel est invoqué par libwebrtc, donc depuis C++ : une panique qui
    // le traverse abandonne le processus entier (`__fastfail`, visible sous
    // Windows comme 0xC0000409 dans `ucrtbase.dll`) au lieu de dérouler. Tout
    // ce qui suit est donc gardé : une panique devient une panne de capture
    // journalisée, le partage se dépublie proprement et l'application vit.
    capturer.start_capture(Some(source), move |result| {
        let guarded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let frame = match result {
                Ok(f) => f,
                Err(CaptureError::Temporary) => {
                    temp_errors += 1;
                    if temp_errors == 1 || temp_errors % 150 == 0 {
                        log::info!(
                            "[Sion][voix-native] capture écran en attente de première image ({} erreurs temporaires)",
                            temp_errors
                        );
                    }
                    return;
                }
                Err(CaptureError::Permanent) => {
                    log::warn!("[Sion][voix-native] capture écran en erreur permanente — arrêt");
                    capture_failed.store(true, std::sync::atomic::Ordering::Release);
                    stop_cb.store(true, std::sync::atomic::Ordering::Relaxed);
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Err(
                            "KDE/Wayland n'a fourni aucune image (sélection annulée ou source invalide)"
                                .to_string(),
                        ));
                    } else if capture_armed.load(std::sync::atomic::Ordering::Acquire) {
                        if let Some(app) = app.as_ref() {
                            let _ = app.emit(
                                "voice-native-local-share-failed",
                                &serde_json::json!({
                                    "reason": "La capture d'écran s'est interrompue"
                                }),
                            );
                        }
                    }
                    return;
                }
            };
            let (w, h) = (frame.width().max(0) as u32, frame.height().max(0) as u32);
            if w < 2 || h < 2 {
                return;
            }
            // Le menu fixe le cadre maximal ; on conserve le ratio de la source.
            // Les dimensions paires sont exigées par I420.
            let (cw, ch) = fit_screenshare_dimensions(w, h, config);
            // Le stride vient du capturer natif. Un stride absurde (négatif
            // côté C++, donc énorme une fois converti) faisait déborder le
            // calcul de taille minimale en release — où les dépassements
            // d'entiers enroulent au lieu de paniquer : le garde-fou passait
            // alors à tort et `argb_to_i420` lisait hors du tampon. Tout est
            // vérifié, et un stride hors bornes fait simplement sauter l'image.
            let raw_stride = frame.stride();
            if raw_stride <= 0 {
                return;
            }
            let src_stride = raw_stride as usize;
            let Some(needed) = (h as usize)
                .checked_sub(1)
                .and_then(|rows| rows.checked_mul(src_stride))
                .and_then(|base| (w as usize).checked_mul(4).and_then(|last| base.checked_add(last)))
            else {
                return;
            };
            if src_stride < (w as usize) * 4 || frame.data().len() < needed {
                return;
            }
            let t0 = std::time::Instant::now();
            let mut i420 = I420Buffer::with_strides(w, h, w, (w + 1) / 2, (w + 1) / 2);
            let (sy, su, sv) = i420.strides();
            let (dy, du, dv) = i420.data_mut();
            livekit::webrtc::native::yuv_helper::argb_to_i420(
                frame.data(),
                src_stride as u32,
                dy,
                sy,
                du,
                su,
                dv,
                sv,
                w as i32,
                h as i32,
            );
            if cw != w || ch != h {
                i420 = i420.scale(cw as i32, ch as i32);
            }
            let vf = VideoFrame::new(VideoRotation::VideoRotation0, i420);
            video_source.capture_frame(&vf);
            // Le SFU ne voit la piste qu'après cette preuve qu'une vraie image a
            // été obtenue. Cela évite la piste noire quand le portail Wayland
            // restaure une source périmée ou que l'utilisateur annule.
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Ok(()));
            }
            captured += 1;
            conv_ms_total += t0.elapsed().as_millis();
            if stat_since.elapsed().as_secs() >= 30 {
                let secs = stat_since.elapsed().as_secs_f64();
                log::info!(
                    "[Sion][voix-native] partage local : {:.1} im/s capturées, conv {}ms",
                    captured as f64 / secs,
                    conv_ms_total / captured.max(1) as u128
                );
                captured = 0;
                conv_ms_total = 0;
                stat_since = std::time::Instant::now();
            }
        }));
        if let Err(payload) = guarded {
            let cause = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panique sans message".to_string());
            log::error!(
                "[Sion][voix-native] panique dans la capture d'écran — partage interrompu : {}",
                cause
            );
            capture_failed.store(true, std::sync::atomic::Ordering::Release);
            stop_cb.store(true, std::sync::atomic::Ordering::Relaxed);
            if capture_armed.load(std::sync::atomic::Ordering::Acquire) {
                if let Some(app) = app.as_ref() {
                    let _ = app.emit(
                        "voice-native-local-share-failed",
                        &serde_json::json!({
                            "reason": "La capture d'écran s'est interrompue"
                        }),
                    );
                }
            }
        }
    });
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        capturer.capture_frame();
        std::thread::sleep(std::time::Duration::from_secs_f64(
            1.0 / config.framerate as f64,
        ));
    }
    if !capture_armed_outer.load(std::sync::atomic::Ordering::Acquire) {
        // Abandon avant publication (timeout de première image) : le portail
        // peut encore dérouler ses callbacks sur son contexte GLib privé et
        // toucher au capturer. On le « fuit » plutôt que de le détruire sous
        // ses pieds (use-after-free).
        std::mem::forget(capturer);
        log::warn!(
            "[Sion][voix-native] capture écran abandonnée avant publication — capturer conservé"
        );
    }
    log::info!("[Sion][voix-native] thread de capture écran terminé");
}

/// Échantillonne le plan Y (1 octet sur 32) pour la détection de changement.
/// Fonction pure (testée).
fn y_samples(y: &[u8]) -> Vec<u8> {
    y.iter().step_by(32).copied().collect()
}

/// Qualité JPEG + cadence adaptatives (contrôleur pur, testé).
///
/// Ce flux JPEG ne touche jamais le réseau externe (WebSocket local vers la webview) :
/// la cible (~8 Mo/s) ne protège que le CPU d'encodage, le décodage image et
/// les copies locales. Ordre de dégradation volontaire :
/// 1. baisser la qualité (90 → 75) — le texte reste lisible ;
/// 2. PUIS SEULEMENT baisser la cadence (10 → 5 → 2,5 im/s).
/// L'inverse (écraser la qualité à plancher en gardant 12 im/s) donne du
/// pixelisé permanent même sur écran fixe — observé en prod.
const VIDEO_TARGET_BPS: u64 = 8_000_000;
const VIDEO_Q_MIN: u8 = 75;
const VIDEO_Q_MAX: u8 = 90;
/// Paliers de cadence (ms entre frames) : jusqu'à 25 im/s si la source et la
/// machine suivent, puis 12,5 et 6,25. Un encodage encore actif fait simplement
/// sauter le tick ; il ne peut jamais former un backlog.
const VIDEO_TICKS_MS: [u64; 3] = [40, 80, 160];

/// État du contrôleur : qualité + palier de cadence courants.
#[derive(Debug, PartialEq, Eq)]
struct VideoBudget {
    quality: u8,
    tick_step: usize,
}

fn adapt_budget(current: &VideoBudget, bytes_last_window: u64, window_secs: u64) -> VideoBudget {
    if window_secs == 0 {
        return VideoBudget {
            quality: current.quality,
            tick_step: current.tick_step,
        };
    }
    let over = bytes_last_window > VIDEO_TARGET_BPS * window_secs;
    if over {
        if current.quality > VIDEO_Q_MIN {
            VideoBudget {
                quality: current.quality.saturating_sub(6).max(VIDEO_Q_MIN),
                tick_step: current.tick_step,
            }
        } else if current.tick_step + 1 < VIDEO_TICKS_MS.len() {
            VideoBudget {
                quality: current.quality,
                tick_step: current.tick_step + 1,
            }
        } else {
            VideoBudget {
                quality: current.quality,
                tick_step: current.tick_step,
            }
        }
    } else if current.tick_step > 0 {
        VideoBudget {
            quality: current.quality,
            tick_step: current.tick_step - 1,
        }
    } else {
        VideoBudget {
            quality: current.quality.saturating_add(2).min(VIDEO_Q_MAX),
            tick_step: current.tick_step,
        }
    }
}

/// Compteurs diagnostiques du data-channel (stutter curseurs constaté en
/// prod) : paquets curseur émis/reçus par fenêtre de stats. Lus (et remis à
/// zéro) par la pompe vidéo dans sa ligne de stats 30 s — donc visibles
/// dans les logs Rust sans DevTools.
static CURSOR_TX_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CURSOR_RX_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Dernier paquet curseur reçu (Instant brut, ms) + plus grand trou
/// inter-paquets de la fenêtre : un flux régulier donne ~16 ms ; des
/// rafales espacées de secondes donnent des trous de plusieurs secondes
/// (= saccades visibles, quelle que soit la moyenne).
static CURSOR_RX_LAST_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CURSOR_RX_MAX_GAP_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn take_cursor_counts() -> (u64, u64) {
    let rx = CURSOR_RX_COUNT.swap(0, std::sync::atomic::Ordering::Relaxed);
    if rx == 0 {
        // Fenêtre sans paquets (personne ne pointe) : on oublie le dernier
        // timestamp, sinon le PREMIER paquet de la prochaine fenêtre mesure
        // un "trou" qui n'est que de l'inactivité — faux positif systématique.
        CURSOR_RX_LAST_MS.store(0, std::sync::atomic::Ordering::Relaxed);
    }
    (
        CURSOR_TX_COUNT.swap(0, std::sync::atomic::Ordering::Relaxed),
        rx,
    )
}

/// Plus grand trou inter-paquets (ms) depuis le dernier appel (remise à zéro).
/// 0 = moins de 2 paquets reçus dans la fenêtre (rien à mesurer).
pub fn take_cursor_max_gap_ms() -> u64 {
    CURSOR_RX_MAX_GAP_MS.swap(0, std::sync::atomic::Ordering::Relaxed)
}

/// Ticker diagnostique indépendant : toutes les 30 s, une ligne
/// `curseurs tx/rx/trou-max` — même sans partage vidéo regardé (la pompe
/// vidéo ne tourne que pour un partage distant, ce qui rendait les stats
/// aveugles quand on partage soi-même). Lancé une seule fois par
/// processus (thread global, silencieux hors activité).
pub fn ensure_cursor_stats_thread() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    std::thread::Builder::new()
        .name("sion-cursor-stats".into())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let (tx, rx) = take_cursor_counts();
            let gap = take_cursor_max_gap_ms();
            if tx + rx > 0 {
                log::info!(
                    "[Sion][voix-native] curseurs tx {}/s rx {}/s trou-max {}ms",
                    tx as f64 / 30.0,
                    rx as f64 / 30.0,
                    gap
                );
            }
        })
        .ok();
}

fn note_cursor_rx(now_ms: u64) {
    CURSOR_RX_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let prev = CURSOR_RX_LAST_MS.swap(now_ms, std::sync::atomic::Ordering::Relaxed);
    if prev != 0 {
        let gap = now_ms.saturating_sub(prev);
        CURSOR_RX_MAX_GAP_MS.fetch_max(gap, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Horloge monotone (ms) sans dépendance supplémentaire.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Conversion d'une frame décodée vers la surface native intégrée.
///
/// Ni JPEG, ni socket, ni budget de débit : les pixels ne quittent pas le
/// processus, il n'y a donc rien à budgéter. `scratch` est le tampon BGRA
/// rendu par la publication précédente (la file est latest-wins, l'image
/// remplacée allait être libérée) : en régime établi cette fonction n'alloue
/// plus rien, là où l'ancien chemin allouait et zérotait 8,3 Mo par image en
/// 1080p.
///
/// Le balayage `y_samples` de l'ancien pont n'est pas fait ici : il ne servait
/// qu'à éviter un ré-encodage JPEG sur écran fixe, et coûtait un parcours du
/// plan Y complet pour un résultat inutilisé côté natif.
/// Adaptateur zéro-copie : le thread de rendu EGL lit directement les plans
/// que libwebrtc vient de décoder, sans passer par un tampon intermédiaire.
struct I420Planes(livekit::webrtc::video_frame::I420Buffer);

impl crate::native_video_surface::PlanarFrame for I420Planes {
    fn dimensions(&self) -> (u32, u32) {
        use livekit::webrtc::video_frame::VideoBuffer as _;
        (self.0.width(), self.0.height())
    }

    fn planes(&self) -> (&[u8], &[u8], &[u8]) {
        self.0.data()
    }

    fn strides(&self) -> (u32, u32, u32) {
        self.0.strides()
    }
}

fn convert_to_native_surface(
    sender: String,
    frame: livekit::webrtc::video_frame::BoxVideoFrame,
    mut scratch: Vec<u8>,
) -> Vec<u8> {
    let buf = frame.buffer.as_ref();
    let (sw, sh) = (buf.width(), buf.height());
    // Aucun consommateur natif visible (montage React, vue masquée, PIP
    // fermé) : jeter la frame plutôt que convertir du 1080p pour personne. La
    // suivante amorcera la surface dès qu'un rectangle est publié. C'est aussi
    // ce qui remplace l'ancien `wants_frames` : les bornes combinent déjà la
    // surface intégrée et la fenêtre PIP.
    let Some((dw, dh)) = crate::native_video_surface::preferred_frame_dimensions(&sender, sw, sh)
    else {
        return scratch;
    };
    if dw == 0 || dh == 0 {
        return scratch;
    }
    // Résolution SOURCE : c'est elle qui donne son ratio à la boîte DOM. La
    // taille réduite `dw x dh` dérive de cette boîte — l'annoncer refermerait
    // une boucle et ferait osciller l'image.
    crate::native_video_surface::announce_source_dimensions(&sender, sw, sh);
    let mut i420 = buf.to_i420();
    // La réduction reste faite ici même en mode planaire : elle est bien moins
    // chère qu'une conversion BGRA et divise d'autant le volume téléversé vers
    // le GPU. L'ajustement final au rectangle visible, lui, appartient au
    // shader.
    if dw != sw || dh != sh {
        i420 = i420.scale(dw as i32, dh as i32);
    }
    // Renderer EGL en place : les plans partent tels quels, la conversion
    // YUV→RGB est faite par le fragment shader. Plus aucun `libyuv::I420ToARGB`
    // sur le chemin chaud, et 1,5 o/px transférés au lieu de 4.
    if crate::native_video_surface::prefers_planar(&sender) {
        crate::native_video_surface::on_planar_frame(sender, Box::new(I420Planes(i420)));
        return scratch;
    }
    // Cairo `Format::ARgb32` et le blit GDI attendent des octets BGRA sur une
    // machine little-endian. Le binding libyuv expose précisément cet ordre
    // via `VideoFormatType::ARGB` (test `libyuv_to_argb_produit_le_bgra_de_cairo`).
    scratch.resize(dw as usize * dh as usize * 4, 0);
    i420.to_argb(
        livekit::webrtc::video_frame::VideoFormatType::ARGB,
        &mut scratch,
        dw * 4,
        dw as i32,
        dh as i32,
    );
    crate::native_video_surface::on_frame(sender, dw, dh, scratch).unwrap_or_default()
}

/// Pompe vidéo : partage d'écran distant → JPEG adaptatif par WebSocket local
/// binaire. Le flux décodé par libwebrtc EST fluide et net
/// (vrai codec adaptatif côté SFU) ; le pont JPEG n'en garde que l'essentiel :
/// - cadence jusqu'à 25 im/s + file "latest" (1 frame) : aucun backlog, le réseau ou le
///   CPU lent fait juste baisser le débit effectif ;
/// - écran strictement fixe (échantillons Y identiques) = 0 encodage ;
/// - qualité JPEG + cadence adaptatives (v4 : cible ~8 Mo/s locale,
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
        // `available()` est posé une fois pour toutes par `attach()` au
        // démarrage, avant qu'aucune pompe n'existe : le mode est stable pour
        // toute la durée du partage.
        let native_mode = crate::native_video_surface::replaces_legacy_transport();
        // Mode natif : une seule conversion en vol, tampon BGRA recyclé.
        let mut native_pending: Option<tokio::task::JoinHandle<Vec<u8>>> = None;
        let mut native_scratch: Vec<u8> = Vec::new();
        let mut native_count: u64 = 0;
        loop {
            tokio::select! {
                _ = &mut stop => break,
                frame = stream.next() => {
                    let Some(frame) = frame else { break };
                    stat_arrived += 1;
                    latest = Some(frame);
                }
                // Récolte de la conversion native dès qu'elle finit, sans
                // polling ni tick : `&mut JoinHandle` est annulable, la tâche
                // survit aux tours de `select!` où cette branche n'est pas
                // retenue.
                recycled = async { native_pending.as_mut().unwrap().await },
                    if native_pending.is_some() =>
                {
                    native_pending = None;
                    native_scratch = recycled.unwrap_or_default();
                }
                _ = ticker.tick(), if !native_mode => {
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
                                                "[Sion][voix-native] frames vidéo {} ({}x{} → {}x{}, {} o jpeg q{} 420, conv {}ms enc {}ms)",
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
                                        crate::native_video_transport::broadcast(
                                            &sender, dw, dh, &jpeg,
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
                            // La source est déjà I420. Une seconde sortie 4:2:0
                            // conserve sa luminance pleine résolution et évite
                            // le surcoût trompeur d'un JPEG 4:4:4.
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
                            let emitted = encode_jpeg_rgba(dw, dh, &rgba, q, false)
                                .ok()
                                .map(|jpeg| (jpeg, dw, dh, conv_ms, t0.elapsed().as_millis()));
                            (samples, (sw, sh), emitted)
                        }));
                    }
                }
            }
            // ── Mode natif : relance immédiate, sans ticker ───────────────
            // L'ancien pont JPEG cadençait à 40 ms (`VIDEO_TICKS_MS[0]`) pour
            // tenir un budget de débit local. En natif il n'y a plus de débit
            // à tenir, et ce ticker coûtait cher : plafond à 25 im/s, chute à
            // 12,5 dès qu'une conversion dépassait un tick, et battement
            // contre le drain GTK (40 ms contre 16 ms) qui produisait du
            // judder à cadence pourtant stable. Ici la frame la plus récente
            // part dès que la précédente est convertie — le latest-wins
            // interdit tout backlog.
            if native_mode && native_pending.is_none() {
                if let Some(frame) = latest.take() {
                    let target = sender.clone();
                    let buffer = std::mem::take(&mut native_scratch);
                    native_pending = Some(tokio::task::spawn_blocking(move || {
                        convert_to_native_surface(target, frame, buffer)
                    }));
                    native_count += 1;
                    if native_count == 1 {
                        log::info!(
                            "[Sion][voix-native] frames vidéo {} en surface native (sans JPEG ni ticker)",
                            sender
                        );
                    }
                    if stat_since.elapsed().as_secs() >= 30 {
                        let secs = stat_since.elapsed().as_secs_f64();
                        log::info!(
                            "[Sion][voix-native] vidéo {} : reçues {:.1} im/s, converties {:.1} im/s (surface native)",
                            sender,
                            stat_arrived as f64 / secs,
                            native_count as f64 / secs
                        );
                        stat_arrived = 0;
                        native_count = 0;
                        stat_since = tokio::time::Instant::now();
                    }
                }
            }
        }
        log::info!("[Sion][voix-native] fin de partage {}", sender);
        crate::native_video_surface::remove(&sender);
        crate::native_video_transport::remove(&sender);
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
        log::warn!(
            "[Sion][voix-native] partage {} ignoré (pas de AppHandle)",
            sender
        );
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
    audio_devices: Mutex<(String, String)>,
    /// Débit Opus du profil choisi dans les réglages. Une modification à chaud
    /// republie la piste micro avec cette valeur.
    mic_max_bitrate: Mutex<u64>,
    /// Polls scalar telemetry from the WebRTC capture post-processor for the
    /// local speaking indicator. No parallel CPAL microphone stream.
    local_meter_stop: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Chien de garde playout ADM (re-démute si l'ADM se remute en cours
    /// d'appel). Même cycle de vie que le meter local.
    watchdog_stop: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Sourdine casque : les nouvelles pistes audio sont désinscrites d'office.
    deafened: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Désir de mute persistant : un mute demandé AVANT toute publication
    /// (F8 hors appel, join-muté précoce, moteur pas encore connecté) ne
    /// doit pas se perdre en silence — sinon store "muté" + micro live
    /// pour toute la session. Consulté à chaque publication.
    mic_muted: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Piste micro publiée conservée pour mute/unmute SANS republier : un
    /// unpublish/republish à chaque F8/F9 provoque une renégociation SDP, et
    /// certains clients (production JS) décrochent dessus.
    mic_track: Mutex<Option<LocalAudioTrack>>,
    /// Passe à `true` quand la piste conservée doit être republiée au prochain
    /// unmute (changement de périphérique ou de débit pendant le mute) : un
    /// `unmute()` sur l'ancienne piste sortirait du silence avec l'ADM neuf.
    mic_needs_republish: std::sync::atomic::AtomicBool,
    /// Partage d'écran local (émission) : `Some` tant que le thread de
    /// capture tourne et que la piste est publiée.
    local_share: Mutex<Option<LocalShareState>>,
    /// Expéditeurs dont le son du partage est coupé localement (miroir du
    /// `screenShareAudioMuted` JS) : survivre au undeafen global (qui
    /// réinscrit tout) sans réactiver leur partage.
    share_audio_muted: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
    /// Gain local du son de chaque partage, conservé pendant les
    /// réabonnements/republications de la session.
    share_audio_volume: std::sync::Arc<Mutex<std::collections::HashMap<String, f32>>>,
    /// Pompes vidéo (partage d'écran) : un canal stop par expéditeur.
    /// Clé = identité LiveKit (un partage actif à la fois par pair, MVP).
    video_stops:
        std::sync::Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    /// Poignée Tauri pour émettre les changements d'état depuis les pompes
    /// vidéo (le canal broadcast reste réservé aux petits événements).
    event_app: Mutex<Option<tauri::AppHandle<crate::TauriRuntime>>>,
    event_tx: tokio::sync::broadcast::Sender<VoiceEngineEvent>,
    /// Clés E2EE MatrixRTC (salons chiffrés) : alimenté par le front via
    /// `voice_native_set_e2ee_key`, miroir exact du `MatrixKeyProvider` JS
    /// (mêmes clés brutes, mêmes identités `@user:serveur:device`, clé
    /// propre incluse — MatrixRTC la réémet pour nous chiffrer).
    /// `KeyProvider::set_key` est `&self` : pas de verrou nécessaire.
    e2ee_keys: KeyProvider,
    /// Notre dernière clé (identité, index, octets) : le SDK chiffre nos
    /// paquets data avec le DERNIER index global (`get_latest_key_index`,
    /// toutes identités confondues) — l'import d'une clé paire écrase le
    /// nôtre et fait échouer nos publishes (`Failed to encrypt`). On
    /// rejoue la nôtre avant réessai (cf. `publish_data`).
    e2ee_own_key: Mutex<Option<(String, i32, Vec<u8>)>>,
    /// Identités ayant déjà fourni une clé (télémétrie first-key, miroir JS).
    e2ee_seen: std::sync::Arc<Mutex<std::collections::HashSet<(String, i32)>>>,
}

/// Vrai si l'erreur ressemble à un échec de chiffrement data (clé latest
/// globale écrasée par une clé paire — cf. `publish_data`).
fn is_encrypt_error(e: &str) -> bool {
    e.to_lowercase().contains("encrypt")
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
        // Keystore partagé inter-moteurs (cf. `shared_e2ee_store`) : pas de
        // provider frais ici, sinon l'historique meurt à chaque join.
        let e2ee_keys = shared_e2ee_store();
        Ok(Self {
            rt,
            room: Mutex::new(None),
            audio: Mutex::new(None),
            mic_sid: Mutex::new(None),
            audio_devices: Mutex::new((String::new(), String::new())),
            mic_max_bitrate: Mutex::new(48_000),
            local_meter_stop: Mutex::new(None),
            watchdog_stop: Mutex::new(None),
            deafened: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            mic_muted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            mic_track: Mutex::new(None),
            mic_needs_republish: std::sync::atomic::AtomicBool::new(false),
            local_share: Mutex::new(None),
            share_audio_muted: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            share_audio_volume: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            video_stops: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            event_app: Mutex::new(None),
            event_tx,
            e2ee_keys,
            e2ee_seen: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            e2ee_own_key: Mutex::new(None),
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
        // Compatibilité du diagnostic historique : la détection distante
        // utilise désormais les identités SFU et n'attache plus de sinks PCM.
        0
    }

    pub fn configure_audio_devices(&self, input: String, output: String) {
        *self.audio_devices.lock().unwrap_or_else(|e| e.into_inner()) = (input, output);
    }

    pub fn configure_audio_quality(&self, max_bitrate: u64) {
        *self
            .mic_max_bitrate
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = max_bitrate;
    }

    /// Applique un nouveau profil Opus à la session active. LiveKit ne permet
    /// pas de modifier l'encodage d'une publication existante : une piste
    /// fraîche est donc publiée, comme sur le chemin JS.
    pub fn switch_audio_quality(&self, max_bitrate: u64) -> Result<(), String> {
        self.configure_audio_quality(max_bitrate);
        if !self.mic_muted.load(std::sync::atomic::Ordering::Relaxed) {
            self.publish_microphone()?;
        } else {
            self.mic_needs_republish
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    /// Maintient la capture uniquement pour le vumètre des réglages quand le
    /// micro est dépublié. Quand le micro est en ligne, son propre cycle de vie
    /// reste prioritaire et l'arrêt du test ne coupe rien.
    pub fn set_microphone_test_enabled(&self, enabled: bool) -> Result<(), String> {
        let guard = self.audio.lock().map_err(|e| e.to_string())?;
        let audio = guard.as_ref().ok_or("audio natif non démarré")?;
        if enabled && self.mic_muted.load(std::sync::atomic::Ordering::Relaxed) {
            audio.start_recording().map_err(|e| e.to_string())
        } else if self.mic_muted.load(std::sync::atomic::Ordering::Relaxed) {
            audio.stop_recording().map_err(|e| e.to_string())
        } else {
            Ok(())
        }
    }

    /// Validate before stopping the ADM: the SDK otherwise silently falls back
    /// to device 0 when a stale GUID is passed to its hot-swap methods. After an
    /// input hot-swap, republish the device track: some desktop ADMs restart
    /// successfully but leave the existing WebRTC track producing silence.
    pub fn switch_audio_device(&self, kind: &str, id: &str) -> Result<(), String> {
        let capture_sequence_before = sion_native_audio::capture_level().0;
        let republish_microphone;
        #[cfg(target_os = "linux")]
        let mut input_device_name: Option<String> = None;
        {
            let guard = self.audio.lock().map_err(|e| e.to_string())?;
            let audio = guard.as_ref().ok_or("audio natif non démarré")?;
            let mut selected = self.audio_devices.lock().map_err(|e| e.to_string())?;
            match kind {
                "input" => {
                    let device = list_recording_devices(audio)
                        .into_iter()
                        .find(|d| {
                            if id.is_empty() {
                                d.index == 0
                            } else {
                                d.id.as_str() == id
                            }
                        })
                        .ok_or("microphone indisponible")?;
                    log::info!(
                        "[Sion][voix-native] changement micro demandé id={} index={} nom={}",
                        id,
                        device.index,
                        device.name
                    );
                    #[cfg(target_os = "linux")]
                    {
                        input_device_name = Some(device.name.clone());
                    }
                    audio
                        .switch_recording_device(&device.id)
                        .map_err(|e| e.to_string())?;
                    selected.0 = id.to_string();
                    if self.mic_muted.load(std::sync::atomic::Ordering::Relaxed) {
                        audio.stop_recording().map_err(|e| e.to_string())?;
                    }
                    // Always publish a fresh LiveKit track after the ADM
                    // stop/init/start cycle. On Linux the PipeWire stream is
                    // routed before this publish and once more from
                    // `publish_microphone`, after the new SID is live.
                    republish_microphone =
                        !self.mic_muted.load(std::sync::atomic::Ordering::Relaxed);
                    if !republish_microphone {
                        self.mic_needs_republish
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                "output" => {
                    let device = list_playout_devices(audio)
                        .into_iter()
                        .find(|d| {
                            if id.is_empty() {
                                d.index == 0
                            } else {
                                d.id.as_str() == id
                            }
                        })
                        .ok_or("sortie audio indisponible")?;
                    audio
                        .switch_playout_device(&device.id)
                        .map_err(|e| e.to_string())?;
                    selected.1 = id.to_string();
                    republish_microphone = false;
                }
                _ => return Err("type de périphérique invalide".into()),
            }
        }
        if kind == "input" {
            #[cfg(target_os = "linux")]
            crate::route_native_microphone(if id.is_empty() {
                None
            } else {
                input_device_name.as_deref()
            })?;
            if republish_microphone {
                self.publish_microphone()?;
            }
            let identity = self
                .room
                .lock()
                .map_err(|e| e.to_string())?
                .as_ref()
                .map(|r| r.local_participant().identity().to_string());
            if let Some(identity) = identity {
                if let Err(err) = self.start_local_meter(identity) {
                    log::warn!("[Sion][voix-native] indicateur micro indisponible: {}", err);
                }
            }
            let selected = id.to_string();
            std::thread::Builder::new()
                .name("sion-mic-switch-check".into())
                .spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let (sequence_after, rms) = sion_native_audio::capture_level();
                    log::info!(
                        "[Sion][voix-native] contrôle micro id={} trames={} rms={:.5}",
                        selected,
                        sequence_after.saturating_sub(capture_sequence_before),
                        rms
                    );
                })
                .map_err(|e| format!("contrôle microphone: {e}"))?;
        }
        Ok(())
    }

    /// Publie le micro via l'ADM natif. Équivalent de `createLocalAudioTrack`
    /// + `publishTrack` côté JS, sans `getUserMedia` ni shim PulseAudio :
    /// la sélection de périphérique passe par `PlatformAudio`.
    ///
    /// RNNoise runs inside the WebRTC capture APM, alongside AEC/AGC. Its software
    /// configuration is enforced by the vendored capture-processing extension.
    pub fn publish_microphone(&self) -> Result<(), String> {
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        let audio = PlatformAudio::new().map_err(|e| format!("audio natif: {}", e))?;
        // Re-publishing after mute retains the active ADM routing; restarting
        // playout here would interrupt remote audio on every unmute.
        if self.audio.lock().map_err(|e| e.to_string())?.is_none() {
            let mut selected = self.audio_devices.lock().map_err(|e| e.to_string())?;
            // Force l'énumération ADM : tant que la capture n'est pas
            // initialisée, `recording_devices()` peut rester vide (compteur
            // -1) et tout `switch_recording_device` échoue en DeviceNotFound.
            if let Err(e) = audio.start_recording() {
                log::warn!("[Sion][voix-native] pré-initialisation capture ADM: {e}");
            }
            // Une liste encore partielle (GUID zéro) juste après
            // l'acquisition fait aussi échouer le switch : on réessaie
            // jusqu'à ce que l'énumération soit réellement prête, avec un
            // plafond global.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let inputs = list_recording_devices(&audio);
                let outputs = list_playout_devices(&audio);
                if !inputs.is_empty() && !outputs.is_empty() {
                    // A saved device may have been unplugged since the last
                    // call. Resolve the fallback explicitly rather than pass a
                    // stale GUID.
                    let input = inputs
                        .iter()
                        .find(|d| d.id.as_str() == selected.0)
                        .or_else(|| inputs.first())
                        .cloned()
                        .ok_or("aucun microphone disponible")?;
                    let output = outputs
                        .iter()
                        .find(|d| d.id.as_str() == selected.1)
                        .or_else(|| outputs.first())
                        .cloned()
                        .ok_or("aucune sortie audio disponible")?;
                    if !selected.0.is_empty() && input.id.as_str() != selected.0 {
                        log::warn!(
                            "[Sion][voix-native] microphone mémorisé absent, utilisation du défaut"
                        );
                        selected.0.clear();
                    }
                    if !selected.1.is_empty() && output.id.as_str() != selected.1 {
                        log::warn!(
                            "[Sion][voix-native] sortie mémorisée absente, utilisation du défaut"
                        );
                        selected.1.clear();
                    }
                    let input_ready = audio.switch_recording_device(&input.id);
                    let output_ready =
                        input_ready
                            .as_ref()
                            .map_err(|e| e.to_string())
                            .and_then(|_| {
                                audio
                                    .switch_playout_device(&output.id)
                                    .map_err(|e| e.to_string())
                            });
                    match (input_ready, output_ready) {
                        (Ok(()), Ok(())) => break,
                        (Err(AudioError::DeviceNotFound), _) | (Ok(()), Err(_))
                            if std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        (Err(e), _) => return Err(format!("sélection micro: {e}")),
                        (_, Err(e)) => return Err(format!("sélection sortie: {e}")),
                    }
                } else if std::time::Instant::now() >= deadline {
                    return Err(
                        "périphériques audio natifs indisponibles (ADM non initialisé)".into(),
                    );
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
        // Desktop software AEC/AGC/RNNoise is configured by the capture APM
        // extension; PlatformAudio's setters only control hardware effects.
        // Diagnostic routage : quels périphériques l'ADM voit-il ?
        // (énumération bornée : `recording_devices()` boucle si l'ADM est -1)
        log::info!(
            "[Sion][voix-native] ADM entree=[{}] sortie=[{}]",
            list_recording_devices(&audio)
                .iter()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>()
                .join(" | "),
            list_playout_devices(&audio)
                .iter()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>()
                .join(" | ")
        );
        let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        let track_handle = track.clone();
        // Anti-fantôme : si une publication précédente traîne encore (unmute
        // sans unpublish préalable), on la retire d'abord — sinon deux
        // micros vivent et aucun unmute futur ne peut les taire tous les deux.
        if let Some(old) = self
            .mic_sid
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            log::warn!(
                "[Sion][voix-native] micro déjà publié ({}) — dépublication avant re-publish",
                old
            );
            let _ = self
                .rt
                .block_on(room.local_participant().unpublish_track(&old));
        }
        let publication = self
            .rt
            .block_on(
                room.local_participant().publish_track(
                    LocalTrack::Audio(track),
                    mic_publish_options(
                        *self
                            .mic_max_bitrate
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()),
                    ),
                ),
            )
            .map_err(|e| format!("publish mic: {}", e))?;
        let sid = publication.sid();
        log::info!("[Sion][voix-native] micro publié sid={}", sid);
        *self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()) = Some(sid);
        *self.mic_track.lock().unwrap_or_else(|e| e.into_inner()) = Some(track_handle.clone());
        // Mute désiré AVANT cette publication (F8 hors appel, join muté…) :
        // on laisse la publication en place mais muette — pas de dépublication
        // (elle forcerait une renégociation et un republish au premier unmute).
        if self.mic_muted.load(std::sync::atomic::Ordering::Relaxed) {
            log::info!("[Sion][voix-native] micro publié déjà muté — piste muette");
            {
                let _rt_enter = self.rt.enter();
                track_handle.mute();
            }
            // `audio` local, pas encore stocké dans le garde : on coupe sa
            // capture directement (sinon elle tourne pour rien).
            let _ = audio.stop_recording();
        }
        crate::transcribe::note_native_mic_enabled(
            !self.mic_muted.load(std::sync::atomic::Ordering::Relaxed),
        );
        // Garder l'ADM vivant tant que la session vit : sans ce garde, le
        // refcount retombe à zéro dès la fin de cette fonction et l'ADM
        // démonte son playout quelques secondes après le join (sink-input
        // "playout absent" alors que les frames continuent = silence total).
        *self.audio.lock().unwrap_or_else(|e| e.into_inner()) = Some(audio);
        #[cfg(target_os = "linux")]
        {
            let selected_input = self
                .audio_devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .0
                .clone();
            if !selected_input.is_empty() {
                let selected_name = self
                    .audio
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .and_then(|audio| {
                        list_recording_devices(audio)
                            .into_iter()
                            .find(|device| device.id.as_str() == selected_input)
                            .map(|device| device.name.clone())
                    })
                    .ok_or("microphone natif mémorisé introuvable")?;
                crate::route_native_microphone(Some(&selected_name))?;
            }
        }
        // Filet résiduel : si l'ADM s'est déjà muté tout seul, on démute.
        ensure_playout_unmuted();
        Ok(())
    }

    /// Publie un paquet data-channel (soundboard, AFK, curseurs…).
    /// `reliable: true` comme le chemin JS (`publishData { reliable: true }`) ;
    /// `false` = LOSSY pour les flux à 60 Hz (curseur) où le prochain paquet
    /// répare la perte.
    ///
    /// En salon chiffré, un échec de chiffrement rejoue d'abord notre clé
    /// (redevient latest global) et réessaie une fois : sans ça, toute clé
    /// paire importée après la nôtre casse nos publishes suivants.
    pub fn publish_data(
        &self,
        topic: &str,
        payload: Vec<u8>,
        reliable: bool,
    ) -> Result<(), String> {
        let len = payload.len();
        if topic == crate::voice_native::TOPIC_CURSOR
            || topic == crate::voice_native::TOPIC_CURSOR_CLICK
        {
            CURSOR_TX_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // Diagnostic : cible réellement envoyée (doit être l'identité du
            // partageur, sinon son overlay filtre le paquet).
            static CURSOR_TX_LOG: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(0);
            let n = CURSOR_TX_LOG.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n < 3 || n % 300 == 0 {
                log::info!(
                    "[Sion][Cursor] tx {} : {}",
                    topic,
                    String::from_utf8_lossy(&payload)
                );
            }
        }
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        let packet = DataPacket {
            payload,
            topic: Some(topic.to_string()),
            reliable,
            destination_identities: Vec::new(),
        };
        let send = |room: &Room| {
            self.rt
                .block_on(room.local_participant().publish_data(packet.clone()))
                .map_err(|e| format!("publish data: {}", e))
        };
        match send(room) {
            Ok(()) => {}
            Err(e) if is_encrypt_error(&e) => {
                // Le SDK chiffre avec le DERNIER index global (toutes
                // identités) : une clé paire importée après la nôtre casse
                // nos publishes. On rejoue notre clé (redevient latest) et
                // on réessaie une fois.
                let own = self
                    .e2ee_own_key
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                match own {
                    Some((id, idx, bytes)) => {
                        if self.e2ee_keys.set_key(&id.as_str().into(), idx, bytes) {
                            log::info!(
                                "[Sion][voix-native][E2EE] latest réaligné sur notre index {} — réessai data",
                                idx
                            );
                            send(room)?;
                        } else {
                            return Err(e);
                        }
                    }
                    None => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
        // Debug : à 60 Hz (curseur), l'info spammerait le log.
        log::debug!(
            "[Sion][voix-native] data publié topic={} ({} o)",
            topic,
            len
        );
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
        start_remote_video_pump(self.rt.handle(), app, &self.video_stops, sender, rtc_track);
    }

    /// Stoppe la pompe vidéo d'un expéditeur (unsubscribe, leave).
    pub fn stop_remote_video(&self, sender: &str) {
        stop_remote_video_pump(&self.video_stops, sender);
    }

    /// Vrai si on partage notre écran (émission en cours).
    pub fn is_screensharing(&self) -> bool {
        self.local_share
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Le partage local publie-t-il aussi le son du système ? Permet au front
    /// de retrouver cet état après un rechargement de webview, au lieu de le
    /// déduire d'une intention passée qu'il a oubliée.
    pub fn is_screenshare_audio_published(&self) -> bool {
        self.local_share
            .lock()
            .map(|g| g.as_ref().is_some_and(|share| share.audio_sid.is_some()))
            .unwrap_or(false)
    }

    /// Démarre le partage d'écran local : capture (écran principal par
    /// défaut, curseur inclus) → piste vidéo `Screenshare` publiée.
    /// Idempotent (déjà en partage = no-op OK). `with_audio=false` :
    /// vidéo seule (les viewers voient "sans son", comme un partage JS
    /// sans la case audio).
    pub fn start_screensharing(
        &self,
        source_id: Option<u64>,
        with_audio: bool,
        config: ScreenShareConfig,
        video_codec: &str,
    ) -> Result<bool, String> {
        // Même exigence de contexte Tokio que `set_deafened`.
        let _rt_enter = self.rt.enter();
        if self.is_screensharing() {
            return Ok(self
                .local_share
                .lock()
                .map(|share| share.as_ref().and_then(|s| s.audio_sid.as_ref()).is_some())
                .unwrap_or(false));
        }
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        // Repères de démarrage. Un plantage sur ce chemin abandonne le
        // processus — 0xC0000409 sous Windows, même site dans `ucrtbase` que
        // celui du 17/09 — et le journal s'arrêtait sur la ligne que libwebrtc
        // écrit en créant son capturer, sans dire QUEL appel suivant abandonne.
        // Ces traces encadrent chacun d'eux : la dernière écrite désigne le
        // coupable, ce qu'aucune pile d'appels ne nous donnera pour un
        // `abort()` en C++.
        log::info!("[Sion][voix-native] partage : création du capturer");
        let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
        opts.set_include_cursor(true);
        let capturer =
            DesktopCapturer::new(opts).ok_or("capture d'écran indisponible (portail Wayland ?)")?;
        log::info!("[Sion][voix-native] partage : capturer créé, énumération des sources");
        let sources = capturer.get_source_list();
        log::info!(
            "[Sion][voix-native] partage : {} source(s) énumérée(s)",
            sources.len()
        );
        for listed in &sources {
            log::info!(
                "[Sion][voix-native] source écran candidate {} (\"{}\", display_id={})",
                listed.id(),
                listed.title(),
                listed.display_id()
            );
        }
        let source = match source_id {
            Some(wanted) => sources
                .iter()
                .find(|s| s.id() == wanted)
                .cloned()
                .ok_or_else(|| format!("source de capture {} introuvable", wanted))?,
            None => sources
                .into_iter()
                .next()
                .ok_or("aucun écran détecté pour le partage")?,
        };
        log::info!(
            "[Sion][voix-native] partage local : source {} (\"{}\")",
            source.id(),
            source.title()
        );
        // Source vidéo "screencast" (le SFU optimise texte/partage plutôt
        // que caméra) ; la résolution suit les frames capturées.
        let video_source = livekit::webrtc::video_source::native::NativeVideoSource::new(
            livekit::webrtc::video_source::VideoResolution {
                width: config.max_width,
                height: config.max_height,
            },
            true,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen-share",
            livekit::webrtc::video_source::RtcVideoSource::Native(video_source.clone()),
        );
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let capture_armed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let capture_failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Le signal de première image n'est plus attendu ici : cette attente
        // (jusqu'à 60 s) gardait le moteur hors du holder, donc le mutex
        // global restait pris et TOUTES les commandes vocales synchrones
        // (publis de curseur à 60 Hz, mute…) bloquaient le thread principal —
        // UI figée pendant la sélection d'écran. On publie immédiatement ; une
        // panne du portail remonte ensuite via `local-share-failed`, qui
        // dépublie. Le récepteur reste pour compat du canal.
        let (ready_tx, _ready_rx) = std::sync::mpsc::sync_channel(1);
        let stop_thread = std::sync::Arc::clone(&stop);
        let armed_thread = std::sync::Arc::clone(&capture_armed);
        let failed_thread = std::sync::Arc::clone(&capture_failed);
        let app = self
            .event_app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        log::info!("[Sion][voix-native] partage : démarrage du fil de capture");
        std::thread::Builder::new()
            .name("sion-share-capture".into())
            .spawn(move || {
                run_share_capture(
                    capturer,
                    source,
                    video_source,
                    stop_thread,
                    config,
                    ready_tx,
                    armed_thread,
                    failed_thread,
                    app,
                );
            })
            .map_err(|e| format!("thread capture: {}", e))?;
        log::info!("[Sion][voix-native] partage : publication de la piste vidéo");
        let publication = match self.rt.block_on(room.local_participant().publish_track(
            LocalTrack::Video(track),
            screenshare_publish_options(config.max_bitrate, config.framerate, video_codec),
        )) {
            Ok(publication) => publication,
            Err(e) => {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                return Err(format!("publish partage: {}", e));
            }
        };
        let sid = publication.sid();
        log::info!("[Sion][voix-native] partage local publié sid={}", sid);
        // Son du système : seulement si demandé (case audio). Sans lui les
        // viewers voient "sans son" (détecté via l'absence de piste
        // ScreenshareAudio, comme en JS).
        let mut audio_pump: Option<std::thread::JoinHandle<()>> = None;
        let audio_sid = if with_audio {
            match Self::start_share_audio(self.rt.handle(), room, &stop) {
                Ok(Some((sid, pump))) => {
                    audio_pump = Some(pump);
                    Some(sid)
                }
                Ok(None) => None,
                Err(e) => {
                    log::warn!("[Sion][voix-native] son du partage indisponible: {}", e);
                    None
                }
            }
        } else {
            log::info!("[Sion][voix-native] partage local sans le son (opt-out)");
            None
        };
        let audio_published = audio_sid.is_some();
        *self.local_share.lock().unwrap_or_else(|e| e.into_inner()) = Some(LocalShareState {
            stop: std::sync::Arc::clone(&stop),
            video_sid: sid,
            audio_sid,
            audio_pump,
        });
        // À partir d'ici, une panne ultérieure déclenche l'événement front qui
        // remet le bouton à zéro et demande la dépublication des pistes.
        capture_armed.store(true, std::sync::atomic::Ordering::Release);
        if capture_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.stop_screensharing()?;
            return Err("la capture d'écran s'est interrompue pendant la publication".to_string());
        }
        Ok(audio_published)
    }

    /// Stoppe le partage d'écran local (drapeaux stop + dépublications).
    /// Idempotent (pas de partage = no-op OK). La vidéo est dépubliée en
    /// dernier, après l'audio (miroir JS : évite une renégociation qui
    /// réveillerait une capture déjà morte).
    pub fn stop_screensharing(&self) -> Result<(), String> {
        let _rt_enter = self.rt.enter();
        let state = self
            .local_share
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some(mut state) = state else {
            return Ok(());
        };
        state.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        // 1) Fermer la capture système : le canal se termine, la pompe le voit
        //    (elle sort en ≤ 50 ms — voir sa boucle).
        crate::system_audio::system_audio_stop();
        // 2) Attendre la pompe AVANT la moindre dépublication : sinon sa
        //    dernière poussée tombait sur une piste détruite (SIGSEGV dans
        //    `AudioTransportImpl::SendProcessedData`) ou croisait le micro
        //    (SIGABRT `RaceDetected` dans `AudioSendStream::SendAudioData`).
        //    Constaté en test le 13/09.
        if let Some(pump) = state.audio_pump.take() {
            if pump.join().is_err() {
                log::warn!("[Sion][voix-native] pompe audio du partage terminée sur panique");
            }
        }
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(room) = room_guard.as_ref() {
            // Audio d'abord (miroir JS), vidéo en dernier.
            if let Some(audio_sid) = &state.audio_sid {
                let _ = self
                    .rt
                    .block_on(room.local_participant().unpublish_track(audio_sid));
            }
            let _ = self
                .rt
                .block_on(room.local_participant().unpublish_track(&state.video_sid));
        }
        log::info!("[Sion][voix-native] partage local arrêté");
        Ok(())
    }

    /// Démarre la capture du son système pour le partage local et publie la
    /// piste `ScreenshareAudio`. Retourne le sid publié (ou une erreur —
    /// l'appelant continue sans le son, mode "sans son" côté viewers).
    /// Traitements OFF (boucle = écho garanti sinon), parité JS.
    pub fn start_share_audio(
        rt: &tokio::runtime::Handle,
        room: &Room,
        stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Option<(TrackSid, std::thread::JoinHandle<()>)>, String> {
        use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
        crate::system_audio::system_audio_start(None).map_err(|e| format!("capture: {}", e))?;
        let rx = crate::system_audio::system_audio_subscribe()
            .ok_or_else(|| "plateforme non supportée".to_string())?;
        let audio_source = livekit::webrtc::audio_source::native::NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: false,
                noise_suppression: false,
                auto_gain_control: false,
            },
            48000,
            1,
            100,
        );
        let track = LocalAudioTrack::create_audio_track(
            "screen-share-audio",
            RtcAudioSource::Native(audio_source.clone()),
        );
        let sid = rt
            .block_on(room.local_participant().publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    dtx: false,
                    red: false,
                    ..Default::default()
                },
            ))
            .map_err(|e| format!("publish son du partage: {}", e))?
            .sid();
        log::info!(
            "[Sion][voix-native] son du partage local publié sid={}",
            sid
        );
        let stop_thread = std::sync::Arc::clone(stop);
        let rt_thread = rt.clone();
        let pump = std::thread::Builder::new()
            .name("sion-share-audio".into())
            .spawn(move || {
                run_share_audio_pump(rx, audio_source, rt_thread, stop_thread);
            })
            .map_err(|e| format!("thread audio: {}", e))?;
        Ok(Some((sid, pump)))
    }

    /// Read the level from the actual WebRTC capture, without opening a second
    /// microphone. Only scalar telemetry crosses threads; no PCM crosses IPC.
    pub fn start_local_meter(&self, identity: String) -> Result<(), String> {
        self.local_meter_stop
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let tx = self.event_tx.clone();
        let muted = self.mic_muted.clone();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("sion-voice-local-meter".into())
            .spawn(move || {
                let mut detector = RmsSpeakingDetector::new();
                let mut sequence = sion_native_audio::capture_level().0;
                loop {
                    match stop_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    let (next, level) = sion_native_audio::capture_level();
                    let level =
                        if next != sequence && !muted.load(std::sync::atomic::Ordering::Relaxed) {
                            level
                        } else {
                            0.0
                        };
                    sequence = next;
                    if let Some(speaking) = detector.push_rms(level) {
                        let _ = tx.send(VoiceEngineEvent::SpeakingChanged {
                            identity: identity.clone(),
                            speaking,
                        });
                    }
                }
            })
            .map_err(|e| format!("thread meter: {}", e))?;
        *self
            .local_meter_stop
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(stop_tx);
        Ok(())
    }

    /// `true` si une publication micro est actuellement enregistrée (le
    /// store front peut mentir suite à une désync historique : le deafen
    /// consulte cette vérité terrain avant de faire confiance au store).
    pub fn is_microphone_published(&self) -> bool {
        // Une piste conservée mais muette ne transmet rien : elle ne doit pas
        // être vue comme "micro live" par le garde-fou deafen.
        self.mic_sid
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
            && !self.mic_muted.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Importe une clé E2EE MatrixRTC (commande `voice_native_set_e2ee_key`,
    /// alimentée par le `MatrixKeyProvider` JS). Miroir de
    /// `onEncryptionKey` : mêmes clés brutes, index partagés. Retourne
    /// `false` si le provider refuse (ne doit pas arriver : log + poursuite,
    /// une clé manquée se répare à la prochaine rotation / re-flush).
    ///
    /// Si la clé est LA NÔTRE, nos cryptors d'envoi sont réindexés dessus
    /// (`set_key_index`) : le SDK Rust ne le fait pas seul (aucun appel dans
    /// livekit 0.8.4 — livekit-client le fait via event `SetKey`), et sans ça
    /// le sender reste à l'index de création (0) → `MissingKey` local et
    /// micro inaudible dès la première rotation de notre clé.
    pub fn set_e2ee_key(&self, identity: &str, key_index: i32, key: Vec<u8>) -> bool {
        let key_len = key.len();
        let ok = self
            .e2ee_keys
            .set_key(&identity.into(), key_index, key.clone());
        if ok {
            // Preuve de stockage (diagnostic MissingKey persistant) : le
            // provider rend-il ce qu'on vient d'écrire, sous la même identité ?
            let back = self.e2ee_keys.get_key(&identity.into(), key_index);
            match back {
                Some(b) if b.len() == key_len => {}
                other => log::warn!(
                    "[Sion][voix-native][E2EE] stockage incohérent {} index={} : relu {:?}",
                    identity,
                    key_index,
                    other.map(|b| b.len())
                ),
            }
            let fresh = self
                .e2ee_seen
                .lock()
                .map(|mut s| s.insert((identity.to_string(), key_index)))
                .unwrap_or(false);
            // Télémétrie first-key comme côté JS (rotations suivantes
            // silencieuses pour ne pas noyer le log).
            if fresh {
                log::info!(
                    "[Sion][voix-native][E2EE] première clé de {} index={}",
                    identity,
                    key_index
                );
            } else {
                // Rotations : chaque index compte pour diagnostiquer un
                // `MissingKey` persistant (clé en retard vs introuvable).
                // INFO (pas debug) : rares et décisives.
                log::info!(
                    "[Sion][voix-native][E2EE] rotation {} index={}",
                    identity,
                    key_index
                );
            }
            // Notre propre clé : réindexer nos cryptors d'envoi (voir doc).
            self.bump_own_sender_index(identity, key_index);
            // Mémoriser pour `publish_data` (refresh du latest global).
            if self.is_local_identity(identity) {
                *self.e2ee_own_key.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((identity.to_string(), key_index, key));
            }
        } else {
            log::warn!(
                "[Sion][voix-native][E2EE] clé refusée de {} index={}",
                identity,
                key_index
            );
        }
        ok
    }

    /// Aligne nos cryptors d'envoi sur notre index courant (cf. `set_e2ee_key`).
    /// No-op si `identity` n'est pas la nôtre ou sans session (la clé est de
    /// toute façon stockée : le prochain import — ou le re-bump au publish —
    /// alignera).
    fn bump_own_sender_index(&self, identity: &str, key_index: i32) {
        if !self.is_local_identity(identity) {
            return;
        }
        let room_guard = self.room.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = room_guard.as_ref() else {
            return;
        };
        let mut bumped = 0;
        for ((id, _sid), cryptor) in room.e2ee_manager().frame_cryptors() {
            if id.to_string() == identity {
                cryptor.set_key_index(key_index);
                bumped += 1;
            }
        }
        if bumped > 0 {
            log::info!(
                "[Sion][voix-native][E2EE] sender réindexé sur {} ({} cryptor(s))",
                key_index,
                bumped
            );
        }
    }

    /// Vrai si `identity` est notre identité LiveKit locale (comparaison
    /// exacte, même format `@user:serveur:device` que MatrixRTC).
    fn is_local_identity(&self, identity: &str) -> bool {
        self.room
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|room| room.local_participant().identity().to_string() == identity)
    }

    /// Coupe / rétablit le micro. Comme préconisé par le SDK (et par notre
    /// `refreshMicrophoneForDenoise` côté JS) : unpublish + stop d'un côté,
    /// start + re-publish de l'autre. Le désir est enregistré AVANT tout
    /// (même sans session : un mute précoce sera honoré au publish).
    pub fn set_microphone_enabled(&self, enabled: bool) -> Result<(), String> {
        self.mic_muted
            .store(!enabled, std::sync::atomic::Ordering::Relaxed);
        // Tap de transcription natif : coupe immédiatement l'audio (le
        // segment en cours est fermé côté transcribe.rs).
        crate::transcribe::note_native_mic_enabled(enabled);
        let track = self
            .mic_track
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if enabled {
            let audio_guard = self.audio.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(audio) = audio_guard.as_ref() {
                let _ = audio.start_recording();
            }
            drop(audio_guard);
            let needs_republish = self
                .mic_needs_republish
                .swap(false, std::sync::atomic::Ordering::Relaxed);
            if let Some(track) = track {
                if needs_republish {
                    // Périphérique/débit changés pendant le mute : une
                    // nouvelle piste est nécessaire (l'ancienne resterait
                    // muette après le hot-swap ADM).
                    log::info!(
                        "[Sion][voix-native] micro réactivé — republish requis après changement"
                    );
                    return self.publish_microphone();
                }
                {
                    // `track.mute()/unmute()` notifie la room via une tâche
                    // tokio : sans contexte runtime, le SDK panique
                    // ("no reactor running") et le mute n'est pas appliqué.
                    let _rt_enter = self.rt.enter();
                    track.unmute();
                }
                log::info!("[Sion][voix-native] micro réactivé (piste conservée, sans republish)");
                return Ok(());
            }
            // Aucune piste conservée (première publication ou après un
            // changement de périphérique) : publier normalement.
            self.publish_microphone()
        } else {
            match track {
                Some(track) => {
                    {
                        // Même exigence de contexte Tokio que `unmute`.
                        let _rt_enter = self.rt.enter();
                        track.mute();
                    }
                    log::info!(
                        "[Sion][voix-native] micro muté (piste conservée, sans dépublication)"
                    );
                }
                None => log::info!("[Sion][voix-native] micro déjà coupé (aucune piste)"),
            }
            let audio_guard = self.audio.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(audio) = audio_guard.as_ref() {
                // Le vumètre des réglages et l'alerte « parler en étant
                // muet » utilisent cette même capture sans publier de piste.
                if !crate::voice_native::microphone_monitor_requested() {
                    let _ = audio.stop_recording();
                }
            }
            Ok(())
        }
    }

    /// Sourdine casque : (dés)inscrit toutes les pistes audio distantes.
    /// Retourne le nombre de pistes touchées (0 sans session = no-op OK).
    /// Au retour (`false`), les pistes sont réinscrites. Le rond vert distant
    /// reste piloté par `ActiveSpeakersChanged`, indépendamment des sinks PCM.
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
        let mut touched = 0;
        // Sons de partage coupés localement : le undeafen global ne doit pas
        // les réactiver (miroir du `screenShareAudioMuted` JS).
        let share_muted = self
            .share_audio_muted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for participant in room.remote_participants().values() {
            let identity = participant.identity().to_string();
            for publication in participant.track_publications().values() {
                if publication.kind() != TrackKind::Audio {
                    continue;
                }
                let is_share_audio = publication.source() == TrackSource::ScreenshareAudio;
                let want = !deafened && !(is_share_audio && share_muted.contains(&identity));
                publication.set_subscribed(want);
                touched += 1;
            }
        }
        log::info!(
            "[Sion][voix-native] sourdine={} ({} piste(s) audio)",
            deafened,
            touched
        );
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
                // Pas de détecteur RMS sur le son du partage (miroir JS :
                publication.set_subscribed(subscribed);
            }
        }
        log::info!(
            "[Sion][voix-native] son du partage {} : {}",
            sender,
            if found {
                if subscribed {
                    "rétabli"
                } else {
                    "coupé"
                }
            } else {
                "aucune piste ScreenshareAudio"
            }
        );
        Ok(found)
    }

    pub fn set_screenshare_audio_volume(&self, sender: &str, volume: f32) -> Result<bool, String> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("volume du partage invalide (0 à 1 attendu)".into());
        }
        self.share_audio_volume
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(sender.to_string(), volume);
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
                if publication.source() != TrackSource::ScreenshareAudio {
                    continue;
                }
                if let Some(RemoteTrack::Audio(track)) = publication.track() {
                    found = true;
                    if !set_remote_audio_volume(&track.rtc_track(), volume) {
                        return Err("gain du partage refusé par WebRTC".into());
                    }
                }
            }
        }
        log::info!(
            "[Sion][voix-native] volume du partage {} : {:.0}%{}",
            sender,
            volume * 100.0,
            if found { "" } else { " (mémorisé)" }
        );
        Ok(found)
    }

    /// État local (mute + volume) du son de partage d'un expéditeur — relu
    /// par le front au chargement de la webview : un reload JS ne doit pas
    /// perdre les coupures réglées au niveau moteur (sinon l'UI affiche
    /// « à fond » pour une piste restée coupée et l'utilisateur n'entend rien).
    pub fn screenshare_audio_state(&self, sender: &str) -> (bool, f32) {
        let muted = self
            .share_audio_muted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(sender);
        let volume = self
            .share_audio_volume
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(sender)
            .copied()
            .unwrap_or(1.0);
        (muted, volume)
    }

    fn spawn_event_pump(
        &self,
        mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
        local_identity: String,
    ) {
        let tx = self.event_tx.clone();
        // Partagé avec `set_deafened` : les nouvelles pistes reçues pendant
        // la sourdine doivent être immédiatement désinscrites.
        let deafened = self.deafened.clone();
        // Son du partage coupé localement : une (ré)inscription SFU ne doit
        // pas le réactiver toute seule (voir `set_deafened`).
        let share_audio_muted = self.share_audio_muted.clone();
        let share_audio_volume = self.share_audio_volume.clone();
        // Pompe vidéo : handles possédés (la tâche est `'static`, pas de `&self`).
        let video_stops = self.video_stops.clone();
        let video_app = self
            .event_app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let video_rt = self.rt.handle().clone();
        self.rt.spawn(async move {
            let mut remote_speakers = std::collections::HashSet::<String>::new();
            // Liveness de la pompe (diagnostic 2026-09-12, bug de re-partage) :
            // la boucle ci-dessous peut se terminer SANS bruit (stream fermé
            // après une renégociation ratée) — plus aucun événement salle
            // n'est alors traité : souscriptions muettes, partages fantômes,
            // indicateurs figés. On trace l'entrée et la sortie.
            log::info!("[Sion][voix-native] pompe d'événements salle démarrée");
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
                                // SAUF le son du partage : son mute n'est pas
                                // celui de la voix (ni resync, ni RMS — voir
                                // branche TrackSubscribed).
                                let is_share_audio = publication.kind() == TrackKind::Audio
                                    && publication.source() == TrackSource::ScreenshareAudio;
                                if !is_share_audio {
                                    let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                                        identity: id.clone(),
                                        muted: publication.is_muted(),
                                    });
                                }
                                // Présence du son de partage pour les pistes
                                // déjà là (le front affiche le contrôle 🔊).
                                if is_share_audio {
                                    let _ = tx.send(VoiceEngineEvent::ShareAudioPresence {
                                        sender: id.clone(),
                                        has_audio: true,
                                    });
                                }
                                // Partage d'écran déjà en cours au join (ou
                                // au reload) : sans ça, la vue n'apparaît que
                                // si le partage DÉMARRE pendant la session.
                                if is_screenshare_video(publication.kind(), publication.source()) {
                                    log::info!(
                                        "[Sion][voix-native] partage d'écran déjà actif {} ({})",
                                        publication.sid(),
                                        id
                                    );
                                    let _ = tx.send(VoiceEngineEvent::VideoPresence {
                                        sender: id.clone(),
                                        sharing: true,
                                    });
                                    // Demander la couche haute uniquement pour
                                    // une publication réellement simulcastée.
                                    // Sur une piste mono-couche (anciens clients
                                    // notamment), forcer une dimension peut
                                    // sélectionner une couche inexistante et
                                    // laisser le décodeur noir sans erreur.
                                    if publication.simulcasted() {
                                        publication.set_video_quality(VideoQuality::High);
                                        publication.update_video_dimensions(TrackDimension(2560, 1440));
                                    } else {
                                        publication.set_enabled(true);
                                    }
                                    if let Some(RemoteTrack::Video(video_track)) = publication.track() {
                                        start_remote_video_pump(
                                            &video_rt,
                                            video_app.clone(),
                                            &video_stops,
                                            id.clone(),
                                            video_track.rtc_track(),
                                        );
                                    }
                                }
                                if deafened.load(std::sync::atomic::Ordering::Relaxed) {
                                    if publication.kind() == TrackKind::Audio {
                                        publication.set_subscribed(false);
                                    }
                                    continue;
                                }
                                // Pas de RMS sur le son du partage (miroir JS).
                                if is_share_audio {
                                    continue;
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
                        remote_speakers.remove(&id);
                        log::info!(
                            "[Sion][voix-native] participant parti {} raison={:?}",
                            id,
                            p.disconnect_reason()
                        );
                        stop_remote_video_pump(&video_stops, &id);
                        share_audio_muted
                            .lock()
                            .map(|mut m| m.remove(id.as_str()))
                            .unwrap_or(false);
                        share_audio_volume
                            .lock()
                            .map(|mut volumes| volumes.remove(id.as_str()))
                            .unwrap_or(None);
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
                        // Robustesse re-partage (2026-09-12) : après un arrêt
                        // puis relance du partage en pleine session, le
                        // ré-abonnement automatique du SDK n'est pas garanti —
                        // observé : plus aucune image reçue, aucun événement
                        // de souscription. On force l'abonnement des pistes de
                        // partage dès leur publication (idempotent).
                        if is_screenshare_video(publication.kind(), publication.source()) {
                            publication.set_subscribed(true);
                        }
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
                                let volume = share_audio_volume
                                    .lock()
                                    .map(|volumes| volumes.get(sender.as_str()).copied().unwrap_or(1.0))
                                    .unwrap_or(1.0);
                                if !set_remote_audio_volume(&audio_track.rtc_track(), volume) {
                                    log::warn!("[Sion][voix-native] gain du partage refusé {}", sender);
                                }
                                // Son du partage coupé localement : on ne le
                                // réactive pas tout seul (voir commande).
                                // Dans tous les cas, PAS de resync mute (le
                                // mute du partage n'est pas le mute de la
                                // voix) et PAS de RMS (miroir JS : un jeu
                                // bruyant allumerait le rond vert).
                                if share_audio_muted
                                    .lock()
                                    .map(|m| m.contains(sender.as_str()))
                                    .unwrap_or(false)
                                {
                                    publication.set_subscribed(false);
                                }
                                continue;
                            }
                            log::info!("[Sion][voix-native] piste audio souscrite {} ({}) chiffrement={:?}", sid, sender, publication.encryption_type());
                            // Resync : une republication (fin de sourdine
                            // distante) démarre non-mutée sans TrackUnmuted.
                            let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                                identity: sender.clone(),
                                muted: publication.is_muted(),
                            });
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track: RemoteTrack::Video(video_track),
                        publication,
                        participant,
                        ..
                    } => {
                        let sender = participant.identity().to_string();
                        if is_screenshare_video(publication.kind(), publication.source()) {
                            // Couche haute + dimensions de rendu uniquement
                            // pour le simulcast. Une piste mono-couche doit
                            // rester sur sa dimension annoncée : certains SFU
                            // renvoient sinon une couche absente (écran noir).
                            if publication.simulcasted() {
                                publication.set_video_quality(VideoQuality::High);
                                // Preserve enough headroom for ultrawide and
                                // 1440p shares; local rendering remains capped
                                // independently by the capture pipeline.
                                publication.update_video_dimensions(TrackDimension(2560, 1440));
                            } else {
                                publication.set_enabled(true);
                            }
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
                            // Unsub LOCAL (mute du partage ou sourdine) : la
                            // publication existe toujours, on garde le
                            // contrôle pour pouvoir réactiver (sinon le
                            // bouton disparaît et le unmute est impossible).
                            let locally_muted = share_audio_muted
                                .lock()
                                .map(|m| m.contains(sender.as_str()))
                                .unwrap_or(false);
                            let globally_deafened =
                                deafened.load(std::sync::atomic::Ordering::Relaxed);
                            if share_audio_presence_kept(locally_muted, globally_deafened) {
                                log::info!(
                                    "[Sion][voix-native] son du partage désinscrit localement {} ({})",
                                    audio_track.sid(),
                                    sender
                                );
                            } else {
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
                    RoomEvent::ActiveSpeakersChanged { speakers } => {
                        // Le SFU associe chaque niveau audio au SID du
                        // participant puis le SDK le résout en identité. On
                        // filtre notre propre identité : son rond vert reste
                        // piloté par le niveau APM local, plus réactif.
                        let next = speakers
                            .into_iter()
                            .map(|participant| participant.identity().to_string())
                            .filter(|identity| identity != &local_identity)
                            .collect();
                        for (identity, speaking) in
                            speaking_set_changes(&mut remote_speakers, next)
                        {
                            log::debug!(
                                "[Sion][voix-native] parole SFU {}={}",
                                identity,
                                speaking
                            );
                            let _ = tx.send(VoiceEngineEvent::SpeakingChanged {
                                identity,
                                speaking,
                            });
                        }
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
                        if topic.as_deref() == Some(crate::voice_native::TOPIC_CURSOR)
                            || topic.as_deref() == Some(crate::voice_native::TOPIC_CURSOR_CLICK)
                        {
                            note_cursor_rx(now_ms());
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
                    RoomEvent::E2eeStateChanged { participant, state } => {
                        let identity = participant.identity().to_string();
                        let state = format!("{:?}", state);
                        log::info!(
                            "[Sion][voix-native][E2EE] état {} : {}",
                            identity, state
                        );
                        let _ = tx.send(VoiceEngineEvent::E2eeStateChanged { identity, state });
                    }
                    _ => {}
                }
            }
            log::warn!(
                "[Sion][voix-native] pompe d'événements salle TERMINÉE — la salle ne sera plus \
                 mise à jour (souscriptions, partages, mutes) jusqu'à reconnexion"
            );
        });
    }
}

impl VoiceEngine for LiveKitEngine {
    fn connect(&mut self, url: &str, token: &str, encrypted: bool) -> Result<String, String> {
        if url.trim().is_empty() {
            return Err("URL LiveKit vide".into());
        }
        if token.trim().is_empty() {
            return Err("Token LiveKit vide".into());
        }
        // Salon chiffré : E2EE GCM adossé aux clés MatrixRTC (cf.
        // `set_e2ee_key`). Sans ça, les frames distantes restent
        // indéchiffrables — audio distant muet. Le data-channel est chiffré
        // du même coup (`with_dc_encryption` auto), comme côté JS.
        let mut options = RoomOptions::default();
        // Le SFU peut arrêter les couches simulcast qu'aucun participant ne
        // demande. Cela économise l'encodage et l'upload du sharer sans changer
        // le plafond résolution/cadence choisi dans le menu.
        options.dynacast = true;
        if encrypted {
            options.encryption = Some(E2eeOptions {
                encryption_type: EncryptionType::Gcm,
                key_provider: self.e2ee_keys.clone(),
            });
            log::info!("[Sion][voix-native][E2EE] salon chiffré : E2EE GCM activé");
        }
        // Chronométrage du join (diagnostic : les pairs renvoient leur état
        // ~500 ms après nous avoir vus — si ce connect dépasse ça, leurs
        // rebroadcasts tombent avant que notre data-channel soit prêt).
        let t0 = std::time::Instant::now();
        let (room, events) = self
            .rt
            .block_on(Room::connect(url, token, options))
            .map_err(|e| format!("connect LiveKit: {}", e))?;
        log::info!(
            "[Sion][voix-native] session SFU établie en {}ms (signal+PC+data-channel)",
            t0.elapsed().as_millis()
        );
        let identity = room.local_participant().identity().to_string();
        self.deafened
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.mic_muted
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.share_audio_muted
            .lock()
            .map(|mut m| m.clear())
            .unwrap_or_default();
        self.share_audio_volume
            .lock()
            .map(|mut volumes| volumes.clear())
            .unwrap_or_default();
        // Un partage local ne survit pas au changement de room (la piste
        // meurt avec l'ancienne) : on coupe le thread, sans dépublier
        // (room déjà remplacée — `disconnect` s'en chargeait avant).
        if let Some(stale) = self
            .local_share
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            stale.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.spawn_event_pump(events, identity.clone());
        *self.room.lock().unwrap_or_else(|e| e.into_inner()) = Some(room);
        // Stats curseurs indépendantes (voir `ensure_cursor_stats_thread`).
        ensure_cursor_stats_thread();
        // Le démute one-shot au publish ne suffit pas (l'ADM se remute
        // parfois en cours d'appel) : garde périodique jusqu'au disconnect.
        *self.watchdog_stop.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(start_playout_watchdog(&self.deafened));
        Ok(identity)
    }

    fn disconnect(&mut self) {
        // Couper d'abord le partage local éventuel (sinon pistes fantômes
        // + parec qui tourne dans le vide).
        if let Some(share) = self
            .local_share
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            share.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            crate::system_audio::system_audio_stop();
        }
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
        *self.mic_track.lock().unwrap_or_else(|e| e.into_inner()) = None;
        crate::transcribe::note_native_mic_enabled(false);
        *self
            .local_meter_stop
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self.watchdog_stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.share_audio_muted
            .lock()
            .map(|mut m| m.clear())
            .unwrap_or_default();
        self.share_audio_volume
            .lock()
            .map(|mut volumes| volumes.clear())
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
        assert!(engine.connect("", "jwt", false).is_err());
        assert!(engine.connect("wss://x", "", false).is_err());
        assert!(engine.connect("  ", "jwt", false).is_err());
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
        assert!(engine
            .publish_data("sion-soundboard", vec![1, 2, 3], true)
            .is_err());
    }

    #[test]
    fn screenshare_volume_is_validated_and_remembered_without_a_track() {
        let engine = LiveKitEngine::new().expect("runtime tokio");
        assert_eq!(engine.set_screenshare_audio_volume("peer", 0.35), Ok(false));
        assert_eq!(
            engine
                .share_audio_volume
                .lock()
                .unwrap()
                .get("peer")
                .copied(),
            Some(0.35)
        );
        for invalid in [f32::NAN, -0.01, 1.01] {
            assert!(engine
                .set_screenshare_audio_volume("peer", invalid)
                .is_err());
        }
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
        assert!(
            j420.len() < j444.len(),
            "420={} 444={}",
            j420.len(),
            j444.len()
        );
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

    /// Cairo `Format::ARgb32` lit BGRA en mémoire sur nos machines
    /// little-endian. Ce test verrouille le format demandé au chemin GTK :
    /// une frame rouge doit donc sortir B=0, G=0, R=255, A=255.
    #[test]
    fn libyuv_to_argb_produit_le_bgra_de_cairo() {
        use livekit::webrtc::video_frame::{I420Buffer, VideoFormatType};
        let mut buf = I420Buffer::new(2, 2);
        let (dy, du, dv) = buf.data_mut();
        dy.fill(82);
        du.fill(90);
        dv.fill(240);
        let mut out = [0u8; 16];
        buf.to_argb(VideoFormatType::ARGB, &mut out, 8, 2, 2);
        let expected = [0u8, 0, 255, 255];
        assert!(
            out[..4]
                .iter()
                .zip(expected)
                .all(|(got, expected)| (*got as i16 - expected as i16).abs() <= 25),
            "BGRA rouge attendu, obtenu {:?}",
            &out[..4]
        );
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
    fn share_audio_presence_survit_au_mute_local() {
        // Mute local ou sourdine : on garde le contrôle (pas de has_audio=false).
        assert!(share_audio_presence_kept(true, false));
        assert!(share_audio_presence_kept(false, true));
        assert!(share_audio_presence_kept(true, true));
        // Vrai retrait côté émetteur : le contrôle doit se masquer.
        assert!(!share_audio_presence_kept(false, false));
    }

    /// Rotation des noms DANS CE BINDING (prouvé) : `abgr_to_i420` lit en
    /// fait du RGBA (le vert ABGR [255,0,255,0] sort en magenta Y≈107), et
    /// `argb_to_i420` lit du BGRA (cf. test suivant). Le rouge est un faux
    /// ami (palindrome [255,0,0,255] dans les deux ordres). En pratique :
    /// `DesktopFrame` (BGRA) passe par `argb_to_i420` SANS swizzle.
    #[test]
    fn abgr_to_i420_lit_du_rgba() {
        use livekit::webrtc::video_frame::I420Buffer;
        fn convert(px: [u8; 4]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
            let input = px.repeat(4);
            let mut buf = I420Buffer::new(2, 2);
            let (sy, su, sv) = buf.strides();
            let (dy, du, dv) = buf.data_mut();
            livekit::webrtc::native::yuv_helper::abgr_to_i420(
                &input, 8, dy, sy, du, su, dv, sv, 2, 2,
            );
            let (dy, du, dv) = buf.data();
            (dy.to_vec(), du.to_vec(), dv.to_vec())
        }
        // Rouge : palindrome, correct dans les deux ordres (Y≈82).
        let (y, _, _) = convert([255, 0, 0, 255]);
        assert!((y[0] as i16 - 82).abs() <= 25, "Y={:?}", y);
        // Vert ABGR [255,0,255,0] lu comme RGBA = magenta (Y≈107, pas 145).
        let (y, _, _) = convert([255, 0, 255, 0]);
        assert!((y[0] as i16 - 107).abs() <= 25, "Y={:?}", y);
    }

    /// Pendant : `argb_to_i420` lit-il du BGRA ? (si les noms sont tournés
    /// comme de l'autre côté, argb↔BGRA se correspondent).
    /// Vert BGRA [0,255,0,255] → Y≈145, U≈54, V≈34.
    #[test]
    fn argb_to_i420_ordre_des_canaux() {
        use livekit::webrtc::video_frame::I420Buffer;
        let bgra_green = [0u8, 255, 0, 255].repeat(4);
        let mut buf = I420Buffer::new(2, 2);
        let (sy, su, sv) = buf.strides();
        let (dy, du, dv) = buf.data_mut();
        livekit::webrtc::native::yuv_helper::argb_to_i420(
            &bgra_green,
            8,
            dy,
            sy,
            du,
            su,
            dv,
            sv,
            2,
            2,
        );
        let (dy, du, dv) = buf.data();
        eprintln!("vert-via-argb: Y={:?} U={:?} V={:?}", dy, du, dv);
        assert!((dy[0] as i16 - 145).abs() <= 25, "Y={:?}", dy);
        assert!((du[0] as i16 - 54).abs() <= 25, "U={:?}", du);
        assert!((dv[0] as i16 - 34).abs() <= 25, "V={:?}", dv);
    }

    #[test]
    fn screenshare_publish_options_marque_la_source() {
        // Sans source=Screenshare, les pairs trient la piste en caméra.
        let opts = screenshare_publish_options(2_500_000, 15, "vp8");
        assert_eq!(opts.source, TrackSource::Screenshare);
        let encoding = opts.video_encoding.expect("encodage explicite");
        assert_eq!(encoding.max_bitrate, 2_500_000);
        assert_eq!(encoding.max_framerate, 15.0);
        assert_eq!(opts.video_codec, VideoCodec::VP8);
        // Défaut (nom inconnu) = VP9, le plus net.
        assert_eq!(
            screenshare_publish_options(1, 1, "autre").video_codec,
            VideoCodec::VP9
        );
        // H.264 = encodeur matériel VAAPI préféré.
        let h264 = screenshare_publish_options(1, 1, "h264");
        assert_eq!(h264.video_codec, VideoCodec::H264);
        assert_eq!(h264.video_encoder, VideoEncoderBackend::Hardware);
        // AV1 = matériel aussi (VAAPI) : même chemin que H.264, meilleure
        // efficacité quand tout le monde le décode en matériel.
        let av1 = screenshare_publish_options(1, 1, "av1");
        assert_eq!(av1.video_codec, VideoCodec::AV1);
        assert_eq!(av1.video_encoder, VideoEncoderBackend::Hardware);
    }

    #[test]
    fn screenshare_config_respecte_menu_et_ratio() {
        let hd = screenshare_config("1080p", 30).unwrap();
        assert_eq!(hd.max_width, 1920);
        assert_eq!(hd.max_height, 1080);
        assert_eq!(hd.max_bitrate, 5_000_000);
        assert_eq!(fit_screenshare_dimensions(2560, 1072, hd), (1920, 804));

        let qhd = screenshare_config("1440p", 60).unwrap();
        assert_eq!(fit_screenshare_dimensions(2560, 1440, qhd), (2560, 1440));
        assert_eq!(qhd.max_bitrate, 14_000_000);
        assert!(screenshare_config("4k", 30).is_err());
        assert!(screenshare_config("1080p", 24).is_err());
    }

    #[test]
    fn is_screenshare_video_filtre_camera_et_audio() {
        use livekit::track::{TrackKind, TrackSource};
        assert!(is_screenshare_video(
            TrackKind::Video,
            TrackSource::Screenshare
        ));
        // Caméra distante : ignorée en natif (MVP).
        assert!(!is_screenshare_video(TrackKind::Video, TrackSource::Camera));
        // Audio (micro comme partage) : jamais de la vidéo.
        assert!(!is_screenshare_video(
            TrackKind::Audio,
            TrackSource::Microphone
        ));
        assert!(!is_screenshare_video(
            TrackKind::Audio,
            TrackSource::ScreenshareAudio
        ));
    }

    #[test]
    fn adapt_budget_degrade_qualite_avant_cadence() {
        let start = VideoBudget {
            quality: 86,
            tick_step: 0,
        };
        // Sous la cible : qualité remonte, cadence intacte.
        assert_eq!(
            adapt_budget(&start, 100_000, 2),
            VideoBudget {
                quality: 88,
                tick_step: 0
            }
        );
        // Au-dessus : qualité baisse vite, cadence intacte.
        assert_eq!(
            adapt_budget(&start, VIDEO_TARGET_BPS * 2 + 1, 2),
            VideoBudget {
                quality: 80,
                tick_step: 0
            }
        );
        // Coincé au plancher qualité + toujours au-dessus : cadence baisse.
        let floor = VideoBudget {
            quality: VIDEO_Q_MIN,
            tick_step: 0,
        };
        assert_eq!(
            adapt_budget(&floor, VIDEO_TARGET_BPS * 2 + 1, 2),
            VideoBudget {
                quality: VIDEO_Q_MIN,
                tick_step: 1
            }
        );
        // Dernier palier : on reste (pas de panique, pas de recul).
        let last = VideoBudget {
            quality: VIDEO_Q_MIN,
            tick_step: VIDEO_TICKS_MS.len() - 1,
        };
        assert_eq!(adapt_budget(&last, VIDEO_TARGET_BPS * 2 + 1, 2), last);
        // Budget redevenu sain : cadence remonte AVANT la qualité.
        let slow = VideoBudget {
            quality: VIDEO_Q_MIN,
            tick_step: 1,
        };
        assert_eq!(
            adapt_budget(&slow, 100_000, 2),
            VideoBudget {
                quality: VIDEO_Q_MIN,
                tick_step: 0
            }
        );
        // Bornes qualité.
        assert_eq!(
            adapt_budget(
                &VideoBudget {
                    quality: 89,
                    tick_step: 0
                },
                0,
                2
            ),
            VideoBudget {
                quality: 90,
                tick_step: 0
            }
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
    fn fresh_engine_reports_mic_not_published() {
        // Vérité terrain pour le garde-fou deafen : sans session, rien
        // n'est publié (le store front peut prétendre le contraire).
        let engine = LiveKitEngine::new().expect("runtime tokio");
        assert!(!engine.is_microphone_published());
    }

    #[test]
    fn e2ee_options_mirror_element_call() {
        // Parité JS dure : le worker livekit-client tourne avec
        // ratchetWindow 10 / keyring 256 / failureTolerance 10 / HKDF. Un
        // écart ici = comportement E2EE divergent (cf. MissingKey collant
        // avec -1, DecryptionFailed avec PBKDF2).
        let opts = e2ee_key_provider_options();
        assert_eq!(opts.ratchet_window_size, 10);
        assert_eq!(opts.key_ring_size, 256);
        assert_eq!(opts.failure_tolerance, 10);
        assert!(matches!(
            opts.key_derivation_algorithm,
            KeyDerivationAlgorithm::HKDF
        ));
    }

    #[test]
    fn e2ee_keystore_survives_engine_replacement() {
        // L'historique des clés survit aux rejoins (même objet C++ partagé
        // via `SharedPtr`) : un moteur frais voit les clés des sessions
        // précédentes, comme le provider JS long-vécu.
        let a = LiveKitEngine::new().expect("runtime tokio");
        assert!(a.set_e2ee_key("@x:srv:D1", 7, vec![0x11u8; 16]));
        let b = LiveKitEngine::new().expect("runtime tokio");
        let back = b.e2ee_keys.get_key(&"@x:srv:D1".into(), 7);
        assert_eq!(back, Some(vec![0x11u8; 16]));
        // Sans session : le bump sender est un no-op silencieux (pas de
        // panique sur le holder vide).
        b.bump_own_sender_index("@x:srv:D1", 7);
    }

    #[test]
    fn e2ee_key_provider_roundtrip() {
        // Pont E2EE : le provider accepte les clés MatrixRTC brutes
        // (pairs + propre) et les rend (index partagés avec livekit-client).
        // 16 octets = taille réelle MatrixRTC (AES-128).
        let engine = LiveKitEngine::new().expect("runtime tokio");
        let key = vec![0xA5u8; 16];
        assert!(engine.set_e2ee_key("@alice:srv:DEV1", 0, key.clone()));
        // Rotation : même identité, nouvel index — acceptée aussi.
        assert!(engine.set_e2ee_key("@alice:srv:DEV1", 1, key));
        // Clé propre (chiffrement de nos frames) : même chemin.
        assert!(engine.set_e2ee_key("@moi:srv:DEV9", 0, vec![0x5Au8; 16]));
        // AES-256 acceptée aussi.
        assert!(engine.set_e2ee_key("@bob:srv:DEV2", 0, vec![0x5Au8; 32]));
    }

    #[test]
    fn mute_desire_survives_until_publish() {
        // Sans session : le mute est enregistré (pas perdu en silence) et
        // une intention d'unmute ultérieure l'efface — même si le publish
        // échoue faute de session.
        let engine = LiveKitEngine::new().expect("runtime tokio");
        assert!(engine.set_microphone_enabled(false).is_ok());
        assert!(engine.mic_muted.load(std::sync::atomic::Ordering::Relaxed));
        assert!(engine.set_microphone_enabled(true).is_err());
        assert!(!engine.mic_muted.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn mic_options_advertise_microphone_source() {
        // Sans source=Microphone, les pairs JS ne trouvent pas la publication
        // (isMicrophoneEnabled) et nous affichent mutés alors que l'audio passe.
        let opts = mic_publish_options(48_000);
        assert_eq!(opts.source, TrackSource::Microphone);
        assert_eq!(opts.audio_encoding.unwrap().max_bitrate, 48_000);
        // Parité publishDefaults JS.
        assert!(!opts.dtx);
        assert!(!opts.red);
    }

    #[test]
    fn quality_str_covers_sdk_values() {
        assert_eq!(
            connection_quality_str(&ConnectionQuality::Excellent),
            "excellent"
        );
        assert_eq!(connection_quality_str(&ConnectionQuality::Good), "good");
        assert_eq!(connection_quality_str(&ConnectionQuality::Poor), "poor");
        assert_eq!(connection_quality_str(&ConnectionQuality::Lost), "lost");
    }

    #[test]
    fn speaker_set_changes_conserve_les_identites_lors_d_un_swap() {
        let mut previous = std::collections::HashSet::from(["@picsou:srv:DEV".to_string()]);
        let next = std::collections::HashSet::from(["@narkow:srv:DEV".to_string()]);
        assert_eq!(
            speaking_set_changes(&mut previous, next),
            vec![
                ("@narkow:srv:DEV".to_string(), true),
                ("@picsou:srv:DEV".to_string(), false),
            ]
        );
        assert_eq!(
            previous,
            std::collections::HashSet::from(["@narkow:srv:DEV".to_string()])
        );
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
        let identity = engine.connect(&url, &token, false).expect("connect SFU");
        assert!(!identity.is_empty());
        assert!(engine.is_connected());
        engine.disconnect();
        assert!(!engine.is_connected());
    }
}
