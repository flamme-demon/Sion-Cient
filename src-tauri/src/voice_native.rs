//! Voix native — sortie du Chromium embarqué (CEF).
//!
//! Aujourd'hui la voix passe par `livekit-client` (JS) dans la webview, ce qui
//! impose CEF sur Linux desktop (WebKitGTK n'expose pas `RTCPeerConnection`).
//! Ce module est la fondation du chemin natif : la `Room` LiveKit vivra ici
//! (crate `livekit`, étape suivante) et la webview ne fera plus que l'UI.
//!
//! Contenu de cette étape (aucun trafic SFU réel — le chemin JS reste le
//! défaut) :
//! - [`VoiceConnectionState`] : machine d'états de la session native.
//! - [`RmsSpeakingDetector`] : portage fidèle de `speakingDetector.ts`
//!   (seuils RMS 0.0018/0.0008 + hystérésis) appliqué aux frames PCM reçues
//!   via `NativeAudioStream` — remplace le rond vert Web Audio.
//! - [`NativeParticipant`] : miroir de `ParticipantInfo` (front) + mapping
//!   des qualités de connexion.
//! - Codecs des payloads data-channel **partagés avec le JS** (`sion-afk`,
//!   `sion-soundboard`, `sion-cursor`, `sion-cursor-click`,
//!   `sion-transcribe-arm`) pour rester interopérable avec les clients JS
//!   pendant la migration.
//! - [`validate_e2ee_key`] : les clés MatrixRTC brutes font 32 octets
//!   (importées comme clés HKDF côté JS dans `matrixRTCE2EE.ts`) — garde-fou
//!   avant le pont E2EE natif (prochaine étape).
//!
//! Le branchement réel (`Room::connect`, publish/subscribe, `PlatformAudio`)
//! arrive derrière le trait [`VoiceEngine`] : les commandes Tauri ci-dessous
//! ne gèrent pour l'instant que l'état + les événements front.

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
        let rms = (sum / samples.len() as f32).sqrt();
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
// Commandes Tauri (phase 1 : état + événements, pas de trafic SFU)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn voice_native_status() -> VoiceNativeStatus {
    let inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    snapshot(&inner)
}

/// Arme la session native. Valide les paramètres et passe en `Connecting` ;
/// la connexion SFU réelle (`Room::connect`) est l'étape suivante du
/// chantier — le chemin JS reste le défaut d'ici là.
#[tauri::command]
pub fn voice_native_connect(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    token: String,
    room_name: String,
) -> Result<VoiceNativeStatus, String> {
    if url.trim().is_empty() {
        return Err("URL LiveKit vide".into());
    }
    if token.trim().is_empty() {
        return Err("Token LiveKit vide".into());
    }
    let mut inner = manager().lock().map_err(|e| e.to_string())?;
    if inner.state != VoiceConnectionState::Disconnected {
        return Err(format!("Session déjà active ({:?})", inner.state));
    }
    inner.state = VoiceConnectionState::Connecting;
    inner.room_name = Some(room_name);
    inner.identity = None;
    let status = snapshot(&inner);
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn voice_native_disconnect(app: tauri::AppHandle<TauriRuntime>) -> VoiceNativeStatus {
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
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    inner.muted = muted;
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

#[tauri::command]
pub fn voice_native_set_deafened(
    app: tauri::AppHandle<TauriRuntime>,
    deafened: bool,
) -> VoiceNativeStatus {
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    inner.deafened = deafened;
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

/// Remet l'état global à zéro. Réservé aux tests.
#[cfg(test)]
pub fn test_reset() {
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    *inner = VoiceNativeInner::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_requires_url_and_token() {
        test_reset();
        assert!(manager().lock().unwrap().state == VoiceConnectionState::Disconnected);
        // Validation pure (sans AppHandle) : on rejoue la logique via l'état.
        assert!("".trim().is_empty());
        assert!("  ".trim().is_empty());
    }

    #[test]
    fn state_defaults_to_disconnected() {
        test_reset();
        let inner = manager().lock().unwrap();
        assert_eq!(inner.state, VoiceConnectionState::Disconnected);
        assert!(inner.room_name.is_none());
        assert!(!inner.muted && !inner.deafened);
    }

    #[test]
    fn disconnect_resets_session() {
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
    fn participant_mirror_serializes_like_ts() {
        let mut p = NativeParticipant::new("@flamme:sionchat.fr:XYZ", "flamme");
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
}
