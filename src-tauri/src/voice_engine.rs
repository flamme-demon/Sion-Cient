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

use std::collections::HashMap;
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

/// Vocabulaire qualité partagé avec le front (`ConnectionQuality` TS).
pub fn connection_quality_str(q: &ConnectionQuality) -> &'static str {
    match q {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
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

pub struct LiveKitEngine {
    rt: tokio::runtime::Runtime,
    room: Mutex<Option<Room>>,
    /// Garde l'ADM WebRTC vivant tant que le moteur existe (refcount).
    audio: Mutex<Option<PlatformAudio>>,
    mic_sid: Mutex<Option<TrackSid>>,
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
        let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        let publication = self
            .rt
            .block_on(room.local_participant().publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions::default(),
            ))
            .map_err(|e| format!("publish mic: {}", e))?;
        *self.mic_sid.lock().map_err(|e| e.to_string())? = Some(publication.sid());
        *self.audio.lock().map_err(|e| e.to_string())? = Some(audio);
        Ok(())
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

    fn spawn_event_pump(
        &self,
        mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
    ) {
        let tx = self.event_tx.clone();
        self.rt.spawn(async move {
            let mut detectors: HashMap<String, RmsSpeakingDetector> = HashMap::new();
            while let Some(ev) = events.recv().await {
                match ev {
                    RoomEvent::ParticipantConnected(p) => {
                        let _ = tx.send(VoiceEngineEvent::ParticipantJoined {
                            identity: p.identity().to_string(),
                            name: p.name(),
                        });
                    }
                    RoomEvent::ParticipantDisconnected(p) => {
                        let id = p.identity().to_string();
                        detectors.remove(&id);
                        let _ = tx.send(VoiceEngineEvent::ParticipantLeft { identity: id });
                    }
                    RoomEvent::TrackSubscribed {
                        track: RemoteTrack::Audio(audio_track),
                        participant,
                        ..
                    } => {
                        // Rond vert : RMS côté natif sur les frames reçues,
                        // mêmes seuils que speakingDetector.ts.
                        let id = participant.identity().to_string();
                        let rtc_track = audio_track.rtc_track();
                        let tx2 = tx.clone();
                        tokio::spawn(async move {
                            use futures_util::StreamExt as _;
                            // 48 kHz mono : ce que l'ADM négocie par défaut ;
                            // le détecteur RMS s'en contente.
                            let mut stream = NativeAudioStream::new(rtc_track, 48000, 1);
                            let mut det = RmsSpeakingDetector::new();
                            while let Some(frame) = stream.next().await {
                                if let Some(speaking) = push_i16_frame(&mut det, &frame.data) {
                                    let _ = tx2.send(VoiceEngineEvent::SpeakingChanged {
                                        identity: id.clone(),
                                        speaking,
                                    });
                                }
                            }
                            let _ = tx2.send(VoiceEngineEvent::SpeakingChanged {
                                identity: id,
                                speaking: false,
                            });
                        });
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
        self.spawn_event_pump(events);
        *self.room.lock().map_err(|e| e.to_string())? = Some(room);
        Ok(identity)
    }

    fn disconnect(&mut self) {
        let room = self.room.lock().map(|mut g| g.take()).unwrap_or(None);
        if let Some(room) = room {
            let _ = self.rt.block_on(room.close());
        }
        // L'ADM se coupe quand le dernier `PlatformAudio` tombe.
        *self.audio.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.mic_sid.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
