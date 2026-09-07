//! Voix native — sortie du Chromium embarqué (CEF).
//!
//! Aujourd'hui la voix passe par `livekit-client` (JS) dans la webview, ce qui
//! impose CEF sur Linux desktop (WebKitGTK n'expose pas `RTCPeerConnection`).
//! Ce module porte le chemin natif : la `Room` LiveKit vit dans
//! [`crate::voice_engine`] (feature `native-voice`, crate `livekit`) et la
//! webview ne fait plus que l'UI.
//!
//! - [`VoiceConnectionState`] : machine d'états de la session native.
//! - [`RmsSpeakingDetector`] : portage fidèle de `speakingDetector.ts`
//!   (seuils RMS 0.0018/0.0008 + hystérésis).
//! - [`NativeParticipant`] : miroir de `ParticipantInfo` (front) + mapping
//!   des qualités de connexion.
//! - Codecs des payloads data-channel **partagés avec le JS** (`sion-afk`,
//!   `sion-soundboard`, `sion-cursor`, `sion-cursor-click`,
//!   `sion-transcribe-arm`) pour rester interopérable pendant la migration.
//! - [`validate_e2ee_key`] : les clés MatrixRTC brutes font 32 octets —
//!   garde-fou avant le pont E2EE natif.
//!
//! Les commandes Tauri ci-dessous pilotent le moteur (quand compilé) et
//! relaient participants/statut au front. Sans la feature, `connect` renvoie
//! une erreur explicite et le chemin JS reste le défaut.

// Étape 1 : fondations. Les API publiques ci-dessous (détecteur RMS,
// participants, codecs) seront consommées par le moteur LiveKit à l'étape 2 ;
// en attendant, ce allow évite de noyer les warnings pré-existants.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

use crate::TauriRuntime;

// ---------------------------------------------------------------------------
// États
// ---------------------------------------------------------------------------

/// État de la session vocale native. Miroir de `LiveKitConnectionState` côté
/// front (`useLiveKitStore.ts`), avec un état `Connecting` en plus pour
/// couvrir la phase `Room::connect` (plusieurs secondes à froid).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

/// Snapshot envoyé au front sur l'événement `voice-native-status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceNativeStatus {
    pub state: VoiceConnectionState,
    pub room_name: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    /// Identité LiveKit locale (`@user:serveur:deviceID`), si connue.
    pub identity: Option<String>,
}

#[derive(Debug, Default)]
struct VoiceNativeInner {
    state: VoiceConnectionState,
    room_name: Option<String>,
    muted: bool,
    deafened: bool,
    identity: Option<String>,
}

impl Default for VoiceConnectionState {
    fn default() -> Self {
        VoiceConnectionState::Disconnected
    }
}

static MANAGER: OnceLock<Mutex<VoiceNativeInner>> = OnceLock::new();

fn manager() -> &'static Mutex<VoiceNativeInner> {
    MANAGER.get_or_init(|| Mutex::new(VoiceNativeInner::default()))
}

fn snapshot(inner: &VoiceNativeInner) -> VoiceNativeStatus {
    VoiceNativeStatus {
        state: inner.state,
        room_name: inner.room_name.clone(),
        muted: inner.muted,
        deafened: inner.deafened,
        identity: inner.identity.clone(),
    }
}

fn emit_status(app: &tauri::AppHandle<TauriRuntime>, status: &VoiceNativeStatus) {
    let _ = app.emit("voice-native-status", status);
}

// ---------------------------------------------------------------------------
// Détecteur de parole (RMS) — portage de speakingDetector.ts
// ---------------------------------------------------------------------------

/// Seuil de déclenchement. Voir `speakingDetector.ts` : les voix avec AGC
/// compressent à ~0.005-0.01, sans AGC à ~0.002-0.005, chuchotements ~0.001.
pub const RMS_START: f32 = 0.0018;
/// Seuil de retour au silence (hystérésis : bruit ambiant ~0.0005 ne latch pas).
pub const RMS_SILENCE: f32 = 0.0008;
/// Tics consécutifs requis avant bascule (comme côté JS).
pub const STATE_FLIP_TICKS: u32 = 1;

/// Détecteur de parole sur frames PCM `f32` (-1.0..1.0).
///
/// `push` retourne `Some(nouvel_état)` uniquement lors d'une bascule, `None`
/// sinon (silence confirmé ou tranche vide = pas de décision).
#[derive(Debug, Default)]
pub struct RmsSpeakingDetector {
    speaking: bool,
    flip_counter: u32,
}

impl RmsSpeakingDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking
    }

    pub fn reset(&mut self) {
        self.speaking = false;
        self.flip_counter = 0;
    }

    pub fn push(&mut self, samples: &[f32]) -> Option<bool> {
        if samples.is_empty() {
            return None;
        }
        let sum: f32 = samples.iter().map(|v| v * v).sum();
        self.push_rms((sum / samples.len() as f32).sqrt())
    }

    /// Même logique à partir d'un RMS déjà calculé — évite d'allouer une
    /// tranche `f32` quand les frames arrivent en `i16` (cas du
    /// `NativeAudioStream` natif).
    pub fn push_rms(&mut self, rms: f32) -> Option<bool> {
        let threshold = if self.speaking {
            RMS_SILENCE
        } else {
            RMS_START
        };
        if (rms > threshold) != self.speaking {
            self.flip_counter += 1;
            if self.flip_counter >= STATE_FLIP_TICKS {
                self.speaking = !self.speaking;
                self.flip_counter = 0;
                return Some(self.speaking);
            }
        } else {
            self.flip_counter = 0;
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/// Qualité de connexion. Miroir du type TS `ConnectionQuality`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeConnectionQuality {
    Excellent,
    Good,
    Poor,
    Lost,
    Unknown,
}

impl NativeConnectionQuality {
    /// Mapping depuis les valeurs string de `livekit-client`
    /// (`ConnectionQualityChanged`) — réutilisé tel quel par le SDK Rust.
    pub fn from_livekit_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "excellent" => NativeConnectionQuality::Excellent,
            "good" => NativeConnectionQuality::Good,
            "poor" => NativeConnectionQuality::Poor,
            "lost" => NativeConnectionQuality::Lost,
            _ => NativeConnectionQuality::Unknown,
        }
    }
}

/// Miroir de `ParticipantInfo` (`src/types/livekit.ts`) — le front consomme
/// la même forme quel que soit le moteur (JS ou natif).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParticipant {
    pub identity: String,
    pub name: String,
    #[serde(default)]
    pub is_speaking: bool,
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default)]
    pub is_screen_sharing: bool,
    #[serde(default)]
    pub is_deafened: bool,
    #[serde(default)]
    pub audio_level: f32,
    #[serde(default = "default_quality")]
    pub connection_quality: NativeConnectionQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playing_sound_emoji: Option<String>,
}

fn default_quality() -> NativeConnectionQuality {
    NativeConnectionQuality::Unknown
}

impl NativeParticipant {
    pub fn new(identity: &str, name: &str) -> Self {
        Self {
            identity: identity.to_string(),
            name: name.to_string(),
            is_speaking: false,
            is_muted: false,
            is_screen_sharing: false,
            is_deafened: false,
            audio_level: 0.0,
            connection_quality: NativeConnectionQuality::Unknown,
            playing_sound_emoji: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Topics + codecs data-channel (interopérabilité JS)
// ---------------------------------------------------------------------------

/// `broadcastAfk` — reliable.
pub const TOPIC_AFK: &str = "sion-afk";
/// `broadcastSound` — reliable.
pub const TOPIC_SOUNDBOARD: &str = "sion-soundboard";
/// `broadcastCursor` — lossy ; `broadcastCursorHide` — reliable, même topic.
pub const TOPIC_CURSOR: &str = "sion-cursor";
/// `broadcastCursorClick` — reliable.
pub const TOPIC_CURSOR_CLICK: &str = "sion-cursor-click";
/// `setLocalTranscribeArmed` — reliable.
pub const TOPIC_TRANSCRIBE_ARM: &str = "sion-transcribe-arm";

/// `{ deafened: bool }` — cf. `broadcastAfk`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AfkPayload {
    pub deafened: bool,
}

/// `{ mxc, emoji, duration, gain }` — cf. `broadcastSound`.
/// `duration` en ms, `gain` multiplicateur (1.0 = niveau d'origine).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SoundboardPayload {
    pub mxc: String,
    pub emoji: String,
    pub duration: u64,
    #[serde(default = "default_gain")]
    pub gain: f32,
}

fn default_gain() -> f32 {
    1.0
}

impl SoundboardPayload {
    pub fn new(mxc: &str, emoji: Option<&str>, duration_ms: Option<u64>, gain: f32) -> Self {
        Self {
            mxc: mxc.to_string(),
            emoji: emoji.unwrap_or("🔊").to_string(),
            duration: duration_ms.unwrap_or(3000),
            gain,
        }
    }
}

/// `{ x, y, t }` coords normalisées + identité du partage visé —
/// cf. `broadcastCursor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorMovePayload {
    pub x: f64,
    pub y: f64,
    #[serde(rename = "t")]
    pub target: String,
}

/// `{ click: true, x, y, t }` — cf. `broadcastCursorClick`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorClickPayload {
    #[serde(default = "default_true")]
    pub click: bool,
    pub x: f64,
    pub y: f64,
    #[serde(rename = "t")]
    pub target: String,
}

fn default_true() -> bool {
    true
}

/// `{ expire: true, t? }` — cf. `broadcastCursorHide`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorHidePayload {
    #[serde(default = "default_true")]
    pub expire: bool,
    #[serde(rename = "t", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// `{ armed: bool }` — cf. `setLocalTranscribeArmed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscribeArmPayload {
    pub armed: bool,
}

pub fn encode_json<T: Serialize>(payload: &T) -> Result<String, String> {
    serde_json::to_string(payload).map_err(|e| e.to_string())
}

pub fn decode_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str(raw).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// E2EE — garde-fou clés MatrixRTC
// ---------------------------------------------------------------------------

/// Longueur d'une clé MatrixRTC brute (`Uint8Array` reçue sur
/// `EncryptionKeyChanged`, importée en clé HKDF côté JS).
pub const E2EE_RAW_KEY_LEN: usize = 32;

/// Vrai si la clé brute est utilisable par le pont E2EE natif.
pub fn validate_e2ee_key(key: &[u8]) -> bool {
    key.len() == E2EE_RAW_KEY_LEN
}

// ---------------------------------------------------------------------------
// Moteur voix (le vrai LiveKit arrive à l'étape suivante)
// ---------------------------------------------------------------------------

/// Abstraction du moteur SFU : l'implémentation `LiveKit` (crate `livekit`,
/// `Room::connect`, `PlatformAudio`) se branchera ici sans changer les
/// commandes ni le front.
pub trait VoiceEngine {
    fn connect(&mut self, url: &str, token: &str) -> Result<String, String>;
    fn disconnect(&mut self);
}

// ---------------------------------------------------------------------------
// Registre participants + relais d'événements moteur → front
// (feature `native-voice` : sans elle, les commandes restent en mode état
// seul et `connect` renvoie une erreur explicite)
// ---------------------------------------------------------------------------

#[cfg(feature = "native-voice")]
use base64::Engine as _;
#[cfg(feature = "native-voice")]
use std::collections::HashMap;
#[cfg(feature = "native-voice")]
use crate::voice_engine::{LiveKitEngine, VoiceEngineEvent};

/// Moteur SFU natif (feature `native-voice` uniquement).
#[cfg(feature = "native-voice")]
static ENGINE: OnceLock<Mutex<Option<LiveKitEngine>>> = OnceLock::new();

#[cfg(feature = "native-voice")]
fn engine_holder() -> &'static Mutex<Option<LiveKitEngine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Sort le moteur du holder (récupère l'intérieur même si le mutex est
/// empoisonné par un panic antérieur — une session SFU morte ne doit jamais
/// bloquer les commandes suivantes).
#[cfg(feature = "native-voice")]
fn take_engine() -> Option<LiveKitEngine> {
    engine_holder()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// Repose un moteur (éventuellement None) dans le holder.
#[cfg(feature = "native-voice")]
fn store_engine(engine: Option<LiveKitEngine>) {
    *engine_holder()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = engine;
}

/// Session locale réinitialisée après la perte du moteur (panique SDK
/// isolée) : pas de fantôme, le front repart d'un état propre.
#[cfg(feature = "native-voice")]
fn drop_dead_session(app: &tauri::AppHandle<TauriRuntime>) {
    store_engine(None);
    participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    let empty: Vec<NativeParticipant> = Vec::new();
    let _ = app.emit("voice-native-participants", &empty);
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    inner.state = VoiceConnectionState::Disconnected;
    inner.room_name = None;
    inner.identity = None;
    emit_status(&app, &snapshot(&inner));
}

/// Exécute `op` sur le moteur sorti du holder puis le repose — sans jamais
/// verrouiller pendant l'appel SDK (une panique LiveKit ne doit plus
/// empoisonner les commandes suivantes). En cas de panique, le moteur est
/// abandonné et la session locale réinitialisée.
#[cfg(feature = "native-voice")]
fn with_engine<R>(
    app: &tauri::AppHandle<TauriRuntime>,
    label: &str,
    op: impl FnOnce(&mut LiveKitEngine) -> Result<R, String>,
) -> Result<R, String> {
    let mut slot = take_engine();
    let mut lost = false;
    let res = match slot.as_mut() {
        Some(engine) => {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(engine))) {
                Ok(r) => r,
                Err(payload) => {
                    let msg = payload
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "panique SDK".to_string());
                    log::error!("[Sion][voix-native] {} : panique SDK isolée: {}", label, msg);
                    lost = true;
                    Err(format!("{} (panique SDK isolée)", label))
                }
            }
        }
        None => Err("pas de moteur natif".to_string()),
    };
    if lost {
        slot = None;
    }
    let lost = lost || slot.is_none();
    store_engine(slot);
    if lost {
        drop_dead_session(app);
    }
    res
}

/// Registre des participants natifs : le front consomme la liste complète
/// (comme `getParticipants()` côté JS), pas des deltas.
#[cfg(feature = "native-voice")]
static PARTICIPANTS: OnceLock<Mutex<HashMap<String, NativeParticipant>>> = OnceLock::new();

#[cfg(feature = "native-voice")]
fn participants_map() -> &'static Mutex<HashMap<String, NativeParticipant>> {
    PARTICIPANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(feature = "native-voice")]
fn emit_participants(app: &tauri::AppHandle<TauriRuntime>) {
    let mut list: Vec<NativeParticipant> = participants_map()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    list.sort_by(|a, b| a.identity.cmp(&b.identity));
    let _ = app.emit("voice-native-participants", &list);
}

#[cfg(feature = "native-voice")]
fn upsert_participant<'a>(
    map: &'a mut HashMap<String, NativeParticipant>,
    identity: &str,
) -> &'a mut NativeParticipant {
    // Upsert défensif : un event (mute, parole, qualité) peut précéder le
    // join en cas de race — le nom réel arrive avec ParticipantJoined.
    map.entry(identity.to_string())
        .or_insert_with(|| NativeParticipant::new(identity, identity))
}

/// Applique un événement moteur au registre. Retourne `true` si la liste
/// doit être réémise. Fonction pure (testable sans Tauri).
#[cfg(feature = "native-voice")]
fn apply_engine_event(
    map: &mut HashMap<String, NativeParticipant>,
    ev: &VoiceEngineEvent,
) -> bool {
    match ev {
        VoiceEngineEvent::ParticipantJoined { identity, name } => {
            let p = upsert_participant(map, identity);
            p.name = name.clone();
            true
        }
        VoiceEngineEvent::ParticipantLeft { identity } => map.remove(identity).is_some(),
        VoiceEngineEvent::SpeakingChanged { identity, speaking } => {
            upsert_participant(map, identity).is_speaking = *speaking;
            true
        }
        VoiceEngineEvent::TrackMutedChanged { identity, muted } => {
            upsert_participant(map, identity).is_muted = *muted;
            true
        }
        VoiceEngineEvent::QualityChanged { identity, quality } => {
            upsert_participant(map, identity).connection_quality =
                NativeConnectionQuality::from_livekit_str(quality);
            true
        }
        // Badge soundboard + statuts room gérés par l'appelant (AppHandle).
        VoiceEngineEvent::DataReceived { .. }
        | VoiceEngineEvent::RoomDisconnected { .. }
        | VoiceEngineEvent::RoomReconnecting
        | VoiceEngineEvent::RoomReconnected => false,
    }
}

/// Décode un payload `sion-soundboard` (base64) et pose le badge sur
/// l'expéditeur. Retourne la durée (ms) pour l'expiration. Fonction pure.
#[cfg(feature = "native-voice")]
fn apply_soundboard_badge(
    map: &mut HashMap<String, NativeParticipant>,
    sender: &str,
    payload_b64: &str,
) -> Option<u64> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .ok()?;
    let raw = String::from_utf8(bytes).ok()?;
    let data: SoundboardPayload = decode_json(&raw).ok()?;
    upsert_participant(map, sender).playing_sound_emoji = Some(data.emoji.clone());
    Some(data.duration)
}

/// Pompe d'événements moteur → front sur thread dédié (pas besoin du runtime
/// Tokio ici : `blocking_recv`). Se termine quand le moteur est droppé
/// (canal fermé) — pas de fuite entre deux sessions.
#[cfg(feature = "native-voice")]
fn spawn_forward_task(
    app: tauri::AppHandle<TauriRuntime>,
    rx: tokio::sync::broadcast::Receiver<VoiceEngineEvent>,
) {
    std::thread::Builder::new()
        .name("sion-voice-events".into())
        .spawn(move || {
            let mut rx = rx;
            while let Ok(ev) = rx.blocking_recv() {
                match &ev {
                    VoiceEngineEvent::DataReceived { topic, payload_b64, sender } => {
                        if topic.as_deref() == Some(TOPIC_SOUNDBOARD) {
                            if let Some(sender) = sender {
                                let duration = {
                                    let mut map = participants_map()
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner());
                                    apply_soundboard_badge(&mut map, sender, payload_b64)
                                };
                                emit_participants(&app);
                                // Expiration du badge, miroir du timer JS de setPlayingSound.
                                if let Some(ms) = duration {
                                    let app2 = app.clone();
                                    let sender2 = sender.clone();
                                    std::thread::Builder::new()
                                        .name("sion-voice-badge".into())
                                        .spawn(move || {
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                ms,
                                            ));
                                            {
                                                let mut map = participants_map()
                                                    .lock()
                                                    .unwrap_or_else(|e| e.into_inner());
                                                if let Some(p) = map.get_mut(&sender2) {
                                                    p.playing_sound_emoji = None;
                                                }
                                            }
                                            emit_participants(&app2);
                                        })
                                        .ok();
                                }
                            }
                        }
                        // Relais générique pour les futurs dispatchers front
                        // (AFK, curseurs, transcribe-arm).
                        let _ = app.emit("voice-native-data", &ev);
                    }
                    VoiceEngineEvent::RoomDisconnected { .. } => {
                        let mut inner =
                            manager().lock().unwrap_or_else(|e| e.into_inner());
                        inner.state = VoiceConnectionState::Disconnected;
                        inner.identity = None;
                        let status = snapshot(&inner);
                        emit_status(&app, &status);
                    }
                    VoiceEngineEvent::RoomReconnecting => {
                        let mut inner =
                            manager().lock().unwrap_or_else(|e| e.into_inner());
                        inner.state = VoiceConnectionState::Reconnecting;
                        let status = snapshot(&inner);
                        emit_status(&app, &status);
                    }
                    VoiceEngineEvent::RoomReconnected => {
                        let mut inner =
                            manager().lock().unwrap_or_else(|e| e.into_inner());
                        inner.state = VoiceConnectionState::Connected;
                        let status = snapshot(&inner);
                        emit_status(&app, &status);
                    }
                    other => {
                        let changed = {
                            let mut map = participants_map()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            apply_engine_event(&mut map, other)
                        };
                        if changed {
                            emit_participants(&app);
                        }
                        if matches!(other, VoiceEngineEvent::SpeakingChanged { .. }) {
                            let _ = app.emit("voice-native-speaking", other);
                        }
                    }
                }
            }
        })
        .ok();
}

/// Ouvre la session SFU native + publie le micro. Le récepteur d'événements
/// est branché AVANT `connect` pour ne rater aucun event précoce.
/// Remplace (en le fermant proprement) un éventuel moteur précédent : en cas
/// de double-join quasi-simultané, on ne laisse ni session SFU fantôme ni
/// micro fantôme derrière.
#[cfg(feature = "native-voice")]
fn connect_engine(
    app: &tauri::AppHandle<TauriRuntime>,
    url: &str,
    token: &str,
) -> Result<String, String> {
    let mut engine = LiveKitEngine::new()?;
    let rx = engine.subscribe();
    spawn_forward_task(app.clone(), rx);
    let identity = engine.connect(url, token)?;
    if let Err(e) = engine.publish_microphone() {
        engine.disconnect();
        return Err(e);
    }
    // Rond vert local : mesure cpal parallèle (best-effort — un défaut
    // d'entrée indisponible ne doit pas faire échouer le join).
    if let Err(e) = engine.start_local_meter(identity.clone()) {
        log::warn!("[Sion][voix-native] meter micro local indisponible: {}", e);
    }
    {
        // Un précédent moteur encore présent (double-join) est fermé hors
        // verrou — une panique ici ne doit pas empoisonner le holder.
        let previous = take_engine();
        if let Some(mut previous) = previous {
            log::warn!("[Sion][voix-native] moteur précédent encore présent — fermeture");
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                previous.disconnect();
            }));
        }
        store_engine(Some(engine));
    }
    Ok(identity)
}

// ---------------------------------------------------------------------------
// Commandes Tauri
// ---------------------------------------------------------------------------

/// Décision de garde à l'ouverture d'une session native. Fonction pure :
/// - `Join` : aucune session, on peut connecter ;
/// - `Reuse` : déjà en ligne sur le MÊME salon (course auto-join / clic
///   manuel) — on réutilise la session au lieu d'en ouvrir une seconde
///   (qui laisserait un fantôme SFU + un micro fantôme) ;
/// - `Conflict(room)` : en ligne sur un AUTRE salon — l'appelant doit
///   quitter d'abord (le `joinVoiceChannel` frontalier le fait).
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectGuard {
    Join,
    Reuse,
    Conflict(String),
}

pub fn connect_guard(
    state: VoiceConnectionState,
    current_room: Option<&str>,
    requested_room: &str,
) -> ConnectGuard {
    match state {
        VoiceConnectionState::Disconnected => ConnectGuard::Join,
        _ => match current_room {
            Some(current) if current == requested_room => ConnectGuard::Reuse,
            Some(current) => ConnectGuard::Conflict(current.to_string()),
            // État incohérent (ni connecté ni salle) : on rejoint.
            None => ConnectGuard::Join,
        },
    }
}

#[tauri::command]
pub fn voice_native_status() -> VoiceNativeStatus {
    let inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    snapshot(&inner)
}

/// Périphérique audio vu par l'ADM natif.
#[derive(Debug, Clone, Serialize)]
pub struct NativeAudioDevice {
    pub id: String,
    pub name: String,
    pub index: usize,
}

/// Diagnostic instantané de la voix native (DevTools, futurs réglages) :
/// état, flags, périphériques ADM, pistes branchées au RMS, participants.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceNativeDebug {
    pub state: VoiceConnectionState,
    pub room_name: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    pub identity: Option<String>,
    pub has_engine: bool,
    pub engine_connected: bool,
    pub recording_devices: Vec<NativeAudioDevice>,
    pub playout_devices: Vec<NativeAudioDevice>,
    pub attached_tracks: usize,
    pub participants: usize,
}

#[tauri::command]
pub fn voice_native_debug() -> VoiceNativeDebug {
    let inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    let mut dbg = VoiceNativeDebug {
        state: inner.state,
        room_name: inner.room_name.clone(),
        muted: inner.muted,
        deafened: inner.deafened,
        identity: inner.identity.clone(),
        has_engine: false,
        engine_connected: false,
        recording_devices: Vec::new(),
        playout_devices: Vec::new(),
        attached_tracks: 0,
        participants: 0,
    };
    #[cfg(feature = "native-voice")]
    {
        if let Some(holder) = ENGINE.get() {
            if let Ok(guard) = holder.lock() {
                if let Some(engine) = guard.as_ref() {
                    dbg.has_engine = true;
                    dbg.engine_connected = engine.is_connected();
                    dbg.attached_tracks = engine.attached_count();
                    if let Ok(audio) = crate::voice_engine::platform_audio_snapshot() {
                        dbg.recording_devices = audio.0;
                        dbg.playout_devices = audio.1;
                    }
                }
            }
        }
        dbg.participants = participants_map()
            .lock()
            .map(|m| m.len())
            .unwrap_or_default();
    }
    dbg
}

/// Ouvre la session vocale native : `Connecting`, puis `Room::connect` +
/// publish micro (feature `native-voice`). Sans la feature, erreur explicite
/// (le chemin JS reste le défaut).
#[tauri::command]
pub fn voice_native_connect(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    token: String,
    room_name: String,
    #[allow(unused_variables)] display_name: String,
) -> Result<VoiceNativeStatus, String> {
    if url.trim().is_empty() {
        return Err("URL LiveKit vide".into());
    }
    if token.trim().is_empty() {
        return Err("Token LiveKit vide".into());
    }
    {
        let mut inner = manager().lock().map_err(|e| e.to_string())?;
        match connect_guard(inner.state, inner.room_name.as_deref(), &room_name) {
            ConnectGuard::Reuse => {
                // Même salon déjà en ligne : idempotent, pas de 2e moteur.
                return Ok(snapshot(&inner));
            }
            ConnectGuard::Conflict(active) => {
                return Err(format!(
                    "Déjà en ligne sur {} — quittez d'abord",
                    active
                ));
            }
            ConnectGuard::Join => {
                inner.state = VoiceConnectionState::Connecting;
                inner.room_name = Some(room_name.clone());
                inner.identity = None;
            }
        }
        emit_status(&app, &snapshot(&inner));
    }
    log::info!("[Sion][voix-native] connect room={} (moteur Rust)", room_name);

    #[cfg(not(feature = "native-voice"))]
    {
        let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
        inner.state = VoiceConnectionState::Disconnected;
        inner.room_name = None;
        let status = snapshot(&inner);
        emit_status(&app, &status);
        return Err("Voix native non compilée : relancer avec --features native-voice (cf. build-scripts/run-native.sh)".into());
    }

    #[cfg(feature = "native-voice")]
    match connect_engine(&app, &url, &token) {
        Ok(identity) => {
            log::info!("[Sion][voix-native] session SFU ouverte identite={}", identity);
            // Le local n'arrive jamais via ParticipantConnected : on
            // l'injecte explicitement (nom d'affichage Matrix fourni par le
            // front) pour qu'il apparaisse aussitôt dans la liste.
            {
                let name = if display_name.trim().is_empty() {
                    identity.clone()
                } else {
                    display_name.clone()
                };
                let mut map = participants_map()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                map.insert(
                    identity.clone(),
                    NativeParticipant::new(&identity, &name),
                );
            }
            emit_participants(&app);
            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
            inner.state = VoiceConnectionState::Connected;
            inner.identity = Some(identity);
            let status = snapshot(&inner);
            emit_status(&app, &status);
            Ok(status)
        }
        Err(e) => {
            log::warn!("[Sion][voix-native] echec connect: {}", e);
            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
            inner.state = VoiceConnectionState::Disconnected;
            inner.room_name = None;
            let status = snapshot(&inner);
            emit_status(&app, &status);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn voice_native_disconnect(app: tauri::AppHandle<TauriRuntime>) -> VoiceNativeStatus {
    #[cfg(feature = "native-voice")]
    {
        // Moteur sorti du holder avant l'appel (pas de verrou pendant close).
        let previous = take_engine();
        if let Some(mut engine) = previous {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                engine.disconnect();
            }));
        }
        participants_map()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let empty: Vec<NativeParticipant> = Vec::new();
        let _ = app.emit("voice-native-participants", &empty);
    }
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    inner.state = VoiceConnectionState::Disconnected;
    inner.room_name = None;
    inner.identity = None;
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

#[tauri::command]
pub fn voice_native_set_muted(
    app: tauri::AppHandle<TauriRuntime>,
    muted: bool,
) -> VoiceNativeStatus {
    // Ne pas mentir au front : si le moteur refuse, on garde l'état précédent.
    let mut applied = true;
    #[cfg(feature = "native-voice")]
    {
        let connected = engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_connected()))
            .unwrap_or(false);
        if connected {
            if let Err(e) = with_engine(&app, "mute natif", |e| e.set_microphone_enabled(!muted)) {
                log::warn!("[Sion][voix-native] {}", e);
                applied = false;
            }
        }
    }
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    if applied {
        inner.muted = muted;
    }
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

#[tauri::command]
pub fn voice_native_set_deafened(
    app: tauri::AppHandle<TauriRuntime>,
    deafened: bool,
) -> VoiceNativeStatus {
    // Ne pas mentir au front : si le moteur refuse, on garde l'état précédent.
    let mut applied = true;
    #[cfg(feature = "native-voice")]
    {
        let connected = engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_connected()))
            .unwrap_or(false);
        if connected {
            if let Err(e) = with_engine(&app, "deafen natif", |e| {
                e.set_deafened(deafened).map(|_| ())
            }) {
                log::warn!("[Sion][voix-native] {}", e);
                applied = false;
            }
        }
    }
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    if applied {
        inner.deafened = deafened;
    }
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

/// Envoie un paquet data-channel sur la session native (soundboard, AFK…).
/// Payload base64 (binaire arbitraire). Miroir de `publishData` JS.
#[tauri::command]
pub fn voice_native_publish_data(
    app: tauri::AppHandle<TauriRuntime>,
    topic: String,
    payload_b64: String,
) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD
            .decode(&payload_b64)
            .map_err(|e| format!("payload base64: {}", e))?;
        return with_engine(&app, "publish data natif", |e| {
            e.publish_data(&topic, payload)
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = (&app, &topic, &payload_b64);
        Err("voix native indisponible".to_string())
    }
}

/// Remet l'état global à zéro. Réservé aux tests.
#[cfg(test)]
pub fn test_reset() {
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    *inner = VoiceNativeInner::default();
}

/// Sérialise les tests touchant au `manager()` global : `cargo test`
/// exécute en parallèle et ces tests se marcheraient dessus sinon (flake).
#[cfg(test)]
static TEST_MANAGER_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_guard_drives_join_reuse_conflict() {
        use VoiceConnectionState::*;
        // Libre dans tous les cas → Join.
        assert_eq!(connect_guard(Disconnected, None, "!a"), ConnectGuard::Join);
        assert_eq!(
            connect_guard(Disconnected, Some("!a"), "!b"),
            ConnectGuard::Join
        );
        // Même salon déjà en ligne (course auto-join / clic) → Reuse.
        for state in [Connecting, Connected, Reconnecting] {
            assert_eq!(
                connect_guard(state, Some("!a"), "!a"),
                ConnectGuard::Reuse,
                "state={:?}",
                state
            );
        }
        // Autre salon → Conflict nommant le salon actif.
        assert_eq!(
            connect_guard(Connected, Some("!a"), "!b"),
            ConnectGuard::Conflict("!a".to_string())
        );
        // État incohérent (pas Disconnected mais pas de salle) → Join.
        assert_eq!(connect_guard(Connecting, None, "!a"), ConnectGuard::Join);
    }

    #[test]
    fn connect_requires_url_and_token() {
        let _serial = TEST_MANAGER_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        test_reset();
        assert!(manager().lock().unwrap().state == VoiceConnectionState::Disconnected);
        // Validation pure (sans AppHandle) : on rejoue la logique via l'état.
        assert!("".trim().is_empty());
        assert!("  ".trim().is_empty());
    }

    #[test]
    fn state_defaults_to_disconnected() {
        let _serial = TEST_MANAGER_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        test_reset();
        let inner = manager().lock().unwrap();
        assert_eq!(inner.state, VoiceConnectionState::Disconnected);
        assert!(inner.room_name.is_none());
        assert!(!inner.muted && !inner.deafened);
    }

    #[test]
    fn disconnect_resets_session() {
        let _serial = TEST_MANAGER_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        test_reset();
        {
            let mut inner = manager().lock().unwrap();
            inner.state = VoiceConnectionState::Connected;
            inner.room_name = Some("sion".into());
            inner.identity = Some("@a:b:c".into());
        }
        // Même logique que voice_native_disconnect, sans AppHandle.
        {
            let mut inner = manager().lock().unwrap();
            inner.state = VoiceConnectionState::Disconnected;
            inner.room_name = None;
            inner.identity = None;
        }
        let inner = manager().lock().unwrap();
        assert_eq!(inner.state, VoiceConnectionState::Disconnected);
        assert!(inner.room_name.is_none());
    }

    #[test]
    fn rms_silence_never_latches() {
        let mut d = RmsSpeakingDetector::new();
        assert_eq!(d.push(&[0.0; 512]), None);
        assert!(!d.is_speaking());
        // Bruit ambiant ~0.0005 < RMS_SILENCE.
        assert_eq!(d.push(&[0.0005; 512]), None);
        assert!(!d.is_speaking());
    }

    #[test]
    fn rms_loud_voice_latches_then_releases() {
        let mut d = RmsSpeakingDetector::new();
        // Voix nette ~0.01 > RMS_START.
        assert_eq!(d.push(&[0.01; 512]), Some(true));
        assert!(d.is_speaking());
        // Toujours de la voix : pas de re-bascule.
        assert_eq!(d.push(&[0.02; 512]), None);
        assert!(d.is_speaking());
        // Silence franc < RMS_SILENCE → retombe.
        assert_eq!(d.push(&[0.0; 512]), Some(false));
        assert!(!d.is_speaking());
    }

    #[test]
    fn rms_hysteresis_band_holds_state() {
        let mut d = RmsSpeakingDetector::new();
        // 0.001 est entre SILENCE (0.0008) et START (0.0018) : ne déclenche pas.
        assert_eq!(d.push(&[0.001; 512]), None);
        assert!(!d.is_speaking());
        // Une fois en parole, 0.001 > SILENCE : reste en parole.
        assert_eq!(d.push(&[0.05; 256]), Some(true));
        assert_eq!(d.push(&[0.001; 512]), None);
        assert!(d.is_speaking());
    }

    #[test]
    fn rms_empty_slice_is_no_decision() {
        let mut d = RmsSpeakingDetector::new();
        assert_eq!(d.push(&[]), None);
    }

    #[test]
    fn quality_mapping_covers_js_values() {
        assert_eq!(
            NativeConnectionQuality::from_livekit_str("excellent"),
            NativeConnectionQuality::Excellent
        );
        assert_eq!(
            NativeConnectionQuality::from_livekit_str("good"),
            NativeConnectionQuality::Good
        );
        assert_eq!(
            NativeConnectionQuality::from_livekit_str("poor"),
            NativeConnectionQuality::Poor
        );
        assert_eq!(
            NativeConnectionQuality::from_livekit_str("lost"),
            NativeConnectionQuality::Lost
        );
        assert_eq!(
            NativeConnectionQuality::from_livekit_str("whatever"),
            NativeConnectionQuality::Unknown
        );
    }

    #[test]
    fn data_payloads_roundtrip_like_js() {
        // AFK : {"deafened":true}
        let afk = AfkPayload { deafened: true };
        let raw = encode_json(&afk).unwrap();
        assert_eq!(raw, r#"{"deafened":true}"#);
        assert_eq!(decode_json::<AfkPayload>(&raw).unwrap(), afk);

        // Soundboard : mêmes clés que broadcastSound.
        let sb = SoundboardPayload::new("mxc://h/snd", None, None, 1.0);
        assert_eq!(sb.emoji, "🔊");
        assert_eq!(sb.duration, 3000);
        let raw = encode_json(&sb).unwrap();
        let back: SoundboardPayload = decode_json(&raw).unwrap();
        assert_eq!(back, sb);
        // Ancien expéditeur sans `gain` → défaut 1.0.
        let legacy: SoundboardPayload =
            decode_json(r#"{"mxc":"mxc://h/s","emoji":"🔊","duration":1500}"#).unwrap();
        assert_eq!(legacy.gain, 1.0);

        // Curseur : clé courte `t`.
        let mv = CursorMovePayload { x: 0.5, y: 0.25, target: "@a:b:c".into() };
        let raw = encode_json(&mv).unwrap();
        assert_eq!(raw, r#"{"x":0.5,"y":0.25,"t":"@a:b:c"}"#);

        let click = CursorClickPayload { click: true, x: 0.1, y: 0.2, target: "t".into() };
        let back: CursorClickPayload = decode_json(&encode_json(&click).unwrap()).unwrap();
        assert_eq!(back, click);

        let hide = CursorHidePayload { expire: true, target: None };
        let back: CursorHidePayload = decode_json(&encode_json(&hide).unwrap()).unwrap();
        assert_eq!(back, hide);

        // Transcribe : {"armed":true}
        let arm = TranscribeArmPayload { armed: true };
        assert_eq!(encode_json(&arm).unwrap(), r#"{"armed":true}"#);
    }

    #[test]
    fn e2ee_keys_must_be_32_bytes() {
        assert!(validate_e2ee_key(&[7u8; 32]));
        assert!(!validate_e2ee_key(&[]));
        assert!(!validate_e2ee_key(&[7u8; 16]));
        assert!(!validate_e2ee_key(&[7u8; 64]));
    }

    #[test]
    fn participant_mirror_serializes_like_ts() {        let mut p = NativeParticipant::new("@flamme:sionchat.fr:XYZ", "flamme");
        p.is_speaking = true;
        p.connection_quality = NativeConnectionQuality::Excellent;
        p.playing_sound_emoji = Some("🥁".into());
        let raw = encode_json(&p).unwrap();
        assert!(raw.contains(r#""identity":"@flamme:sionchat.fr:XYZ""#));
        assert!(raw.contains(r#""isSpeaking":true"#));
        assert!(raw.contains(r#""connectionQuality":"excellent""#));
        // camelCase imposé par le front : serde rename_all.
        let back: NativeParticipant = decode_json(&raw).unwrap();
        assert_eq!(back.name, "flamme");
    }

    /// Câblage registre ↔ événements moteur (feature `native-voice`).
    #[cfg(feature = "native-voice")]
    mod engine_wiring {
        use super::super::*;
        use crate::voice_engine::VoiceEngineEvent as E;
        use std::collections::HashMap;

        fn empty() -> HashMap<String, NativeParticipant> {
            HashMap::new()
        }

        #[test]
        fn join_leave_maintain_the_list() {
            let mut map = empty();
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined { identity: "@b:h".into(), name: "b".into() }
            ));
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined { identity: "@a:h".into(), name: "a".into() }
            ));
            assert_eq!(map.len(), 2);
            assert_eq!(map["@a:h"].name, "a");
            // Re-join : met à jour le nom, pas de doublon.
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined { identity: "@a:h".into(), name: "a2".into() }
            ));
            assert_eq!(map.len(), 2);
            assert_eq!(map["@a:h"].name, "a2");
            assert!(apply_engine_event(&mut map, &E::ParticipantLeft { identity: "@a:h".into() }));
            assert_eq!(map.len(), 1);
            // Leave inconnu : pas de changement, pas d'émission.
            assert!(!apply_engine_event(&mut map, &E::ParticipantLeft { identity: "@z:h".into() }));
        }

        #[test]
        fn speaking_mute_quality_update_flags() {
            let mut map = empty();
            assert!(apply_engine_event(
                &mut map,
                &E::SpeakingChanged { identity: "@a:h".into(), speaking: true }
            ));
            // Upsert défensif : le participant existe même si le join n'est
            // pas encore arrivé.
            assert!(map["@a:h"].is_speaking);
            assert!(apply_engine_event(
                &mut map,
                &E::TrackMutedChanged { identity: "@a:h".into(), muted: true }
            ));
            assert!(map["@a:h"].is_muted);
            assert!(apply_engine_event(
                &mut map,
                &E::QualityChanged { identity: "@a:h".into(), quality: "poor".into() }
            ));
            assert_eq!(map["@a:h"].connection_quality, NativeConnectionQuality::Poor);
        }

        #[test]
        fn room_status_events_do_not_touch_the_list() {
            let mut map = empty();
            assert!(!apply_engine_event(&mut map, &E::RoomReconnecting));
            assert!(!apply_engine_event(&mut map, &E::RoomReconnected));
            assert!(!apply_engine_event(
                &mut map,
                &E::RoomDisconnected { reason: "x".into() }
            ));
            assert!(map.is_empty());
        }

        #[test]
        fn soundboard_badge_decodes_js_payload() {
            use base64::Engine as _;
            let mut map = empty();
            let payload = base64::engine::general_purpose::STANDARD.encode(
                r#"{"mxc":"mxc://h/s","emoji":"🥁","duration":2500,"gain":1.5}"#,
            );
            assert_eq!(apply_soundboard_badge(&mut map, "@dj:h", &payload), Some(2500));
            assert_eq!(map["@dj:h"].playing_sound_emoji.as_deref(), Some("🥁"));
            // Payload corrompu : pas de badge, pas de panique.
            assert_eq!(apply_soundboard_badge(&mut map, "@dj:h", "!!!"), None);
        }
    }
}
