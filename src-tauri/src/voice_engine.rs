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
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::options::TrackPublishOptions;

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
    /// Parité JS : suppression de bruit Chromium forcée à off (la pipeline
    /// RNNoise du projet la remplace, cf. `connectToRoom`).
    pub fn publish_microphone(&self) -> Result<(), String> {
        let room_guard = self.room.lock().map_err(|e| e.to_string())?;
        let room = room_guard.as_ref().ok_or("pas de session SFU")?;
        let audio = PlatformAudio::new().map_err(|e| format!("audio natif: {}", e))?;
        // Best-effort : un ADM qui refuse ce réglage ne doit pas bloquer l'appel.
        let _ = audio.set_noise_suppression(false, false);
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
        *self.mic_sid.lock().map_err(|e| e.to_string())? = Some(sid);
        // L'ADM coupe parfois son playout tout seul (observé : muet côté
        // PipeWire alors que tout le reste est OK) — on ré-impose démute.
        ensure_playout_unmuted();
        Ok(())
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
        *self.local_meter_stop.lock().map_err(|e| e.to_string())? = Some(stop_tx);
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
            let audio_guard = self.audio.lock().map_err(|e| e.to_string())?;
            if let Some(audio) = audio_guard.as_ref() {
                let _ = audio.start_recording();
            }
            drop(audio_guard);
            self.publish_microphone()
        } else {
            let sid = self.mic_sid.lock().map_err(|e| e.to_string())?.take();
            let room_guard = self.room.lock().map_err(|e| e.to_string())?;
            if let (Some(room), Some(sid)) = (room_guard.as_ref(), sid) {
                let _ = self.rt.block_on(room.local_participant().unpublish_track(&sid));
            }
            drop(room_guard);
            let audio_guard = self.audio.lock().map_err(|e| e.to_string())?;
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
        self.deafened
            .store(deafened, std::sync::atomic::Ordering::Relaxed);
        let room_guard = self.room.lock().map_err(|e| e.to_string())?;
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
        for participant in room.remote_participants().values() {            let identity = participant.identity().to_string();
            for publication in participant.track_publications().values() {
                if publication.kind() != TrackKind::Audio {
                    continue;
                }
                publication.set_subscribed(!deafened);
                touched += 1;
                if !deafened {
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
        }
        log::info!("[Sion][voix-native] sourdine={} ({} piste(s) audio)", deafened, touched);
        if !deafened {
            ensure_playout_unmuted();
        }
        Ok(touched)
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
                                if publication.is_muted() {
                                    let _ = tx.send(VoiceEngineEvent::TrackMutedChanged {
                                        identity: id.clone(),
                                        muted: true,
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
                        let _ = tx.send(VoiceEngineEvent::ParticipantJoined {
                            identity: p.identity().to_string(),
                            name: p.name(),
                        });
                    }
                    RoomEvent::ParticipantDisconnected(p) => {
                        let id = p.identity().to_string();
                        let _ = tx.send(VoiceEngineEvent::ParticipantLeft { identity: id });
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
                            log::info!("[Sion][voix-native] piste audio souscrite {} ({})", sid, participant.identity());
                            let fresh = attached
                                .lock()
                                .map(|mut a| a.insert(sid))
                                .unwrap_or(false);
                            if fresh {
                                spawn_rms_task(
                                    &rt_handle,
                                    &tx,
                                    participant.identity().to_string(),
                                    audio_track.rtc_track(),
                                );
                            }
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track: RemoteTrack::Video(_),
                        ..
                    } => {
                        // Rendu vidéo natif : étape "partage d'écran" du chantier.
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
        let (room, events) = self
            .rt
            .block_on(Room::connect(url, token, RoomOptions::default()))
            .map_err(|e| format!("connect LiveKit: {}", e))?;
        let identity = room.local_participant().identity().to_string();
        self.deafened
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.attached
            .lock()
            .map(|mut a| a.clear())
            .unwrap_or_default();
        self.spawn_event_pump(events);
        *self.room.lock().map_err(|e| e.to_string())? = Some(room);
        // Le démute one-shot au publish ne suffit pas (l'ADM se remute
        // parfois en cours d'appel) : garde périodique jusqu'au disconnect.
        *self.watchdog_stop.lock().map_err(|e| e.to_string())? =
            Some(start_playout_watchdog(&self.deafened));
        Ok(identity)
    }

    fn disconnect(&mut self) {
        let room = self.room.lock().map(|mut g| g.take()).unwrap_or(None);
        if let Some(room) = room {
            let _ = self.rt.block_on(room.close());
        }
        // L'ADM se coupe quand le dernier `PlatformAudio` tombe ; le meter
        // local s'arrête quand son canal stop se ferme.
        *self.audio.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.local_meter_stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.watchdog_stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
    fn quality_str_covers_sdk_values() {        assert_eq!(connection_quality_str(&ConnectionQuality::Excellent), "excellent");
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
