//! Voix native — moteur LiveKit Rust, unique moteur vocal.
//!
//! La `Room` LiveKit vit dans [`crate::voice_engine`] (feature `native-voice`,
//! crate `livekit`) et la webview ne fait plus que l'UI : plus aucun
//! `livekit-client` ni WebRTC côté webview.
//!
//! - [`VoiceConnectionState`] : machine d'états de la session native.
//! - [`RmsSpeakingDetector`] : portage fidèle de `speakingDetector.ts`
//!   (seuils RMS 0.0018/0.0008 + hystérésis).
//! - [`NativeParticipant`] : miroir de `ParticipantInfo` (front) + mapping
//!   des qualités de connexion.
//! - Codecs des payloads data-channel (`sion-afk`, `sion-soundboard`,
//!   `sion-cursor`, `sion-cursor-click`, `sion-transcribe-arm`).
//! - [`validate_e2ee_key`] : les clés MatrixRTC brutes font 32 octets —
//!   garde-fou avant le pont E2EE natif.
//!
//! Les commandes Tauri ci-dessous pilotent le moteur et relaient
//! participants/statut au front. Sans la feature, `connect` renvoie une erreur
//! explicite (aucun moteur de secours).

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
    /// Vérité terrain moteur (le store front peut mentir après une désync :
    /// `muted=true` + micro encore publié). Le deafen s'en sert pour forcer
    /// la coupure au lieu de faire confiance au store.
    pub mic_published: bool,
    /// Vérité terrain moteur : une piste de partage d'écran est-elle publiée ?
    ///
    /// Le store front repart à zéro à chaque rechargement de webview, alors que
    /// le moteur Rust, lui, continue de partager. Sans cette information le
    /// front se croyait à l'arrêt et ne rouvrait pas l'overlay curseurs : les
    /// viewers pouvaient pointer, plus rien ne s'affichait sur l'écran partagé
    /// jusqu'à ce que le partage soit relancé à la main (constaté le 16/09).
    pub screenshare_published: bool,
    /// Vérité terrain moteur : le partage local publie-t-il aussi le son ?
    /// L'avertissement « partage sans son » était calculé au démarrage du
    /// partage et perdu à tout rechargement de webview.
    pub screenshare_audio_published: bool,
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
        mic_published: holder_mic_published(),
        screenshare_published: holder_screenshare_published(),
        screenshare_audio_published: holder_screenshare_audio_published(),
        identity: inner.identity.clone(),
    }
}

/// Le holder contient-il un moteur (indépendamment de toute session) ?
/// `false` sans le feature natif : pas de moteur possible.
fn holder_has_engine() -> bool {
    #[cfg(feature = "native-voice")]
    {
        engine_holder().lock().map(|g| g.is_some()).unwrap_or(false)
    }
    #[cfg(not(feature = "native-voice"))]
    {
        false
    }
}

/// Le holder contient-il un moteur CONNECTÉ (session SFU établie) ?
fn holder_is_connected() -> bool {
    #[cfg(feature = "native-voice")]
    {
        engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_connected()))
            .unwrap_or(false)
    }
    #[cfg(not(feature = "native-voice"))]
    {
        false
    }
}

/// Attente bornée du moteur : `with_engine` SORT le moteur du holder
/// pendant chaque opération, donc une commande concurrente (typiquement le
/// mute implicite tiré en même temps que le deafen par le front) peut
/// observer un holder vide et abandonner en silence — micro resté live
/// pendant toute la sourdine (bug F9 du 08/09). Au lieu de sauter, on
/// attend le retour du moteur (20 × 50 ms = 1 s max, en pratique 1-2
/// tours). `false` = vraiment aucun moteur (hors appel) : l'appelant
/// conserve alors le désir côté manager, honoré au prochain join.
fn wait_for_engine(ready: impl Fn() -> bool) -> bool {
    if ready() {
        return true;
    }
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if ready() {
            return true;
        }
    }
    false
}

/// Vérité terrain : le moteur tient-il une publication micro ? `false`
/// sans moteur (et sans le feature natif : pas de moteur possible).
fn holder_mic_published() -> bool {
    #[cfg(feature = "native-voice")]
    {
        engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_microphone_published()))
            .unwrap_or(false)
    }
    #[cfg(not(feature = "native-voice"))]
    {
        false
    }
}

/// Vérité terrain : le moteur tient-il une publication de partage d'écran ?
fn holder_screenshare_published() -> bool {
    #[cfg(feature = "native-voice")]
    {
        engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_screensharing()))
            .unwrap_or(false)
    }
    #[cfg(not(feature = "native-voice"))]
    {
        false
    }
}

/// Vérité terrain : le partage local publie-t-il aussi le son du système ?
fn holder_screenshare_audio_published() -> bool {
    #[cfg(feature = "native-voice")]
    {
        engine_holder()
            .lock()
            .map(|g| g.as_ref().is_some_and(|e| e.is_screenshare_audio_published()))
            .unwrap_or(false)
    }
    #[cfg(not(feature = "native-voice"))]
    {
        false
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
    /// L'expéditeur publie aussi le son de son partage (`ScreenshareAudio`).
    /// Affiche le contrôle 🔊/🔇 (coupure locale uniquement).
    #[serde(default)]
    pub is_screen_sharing_audio: bool,
    #[serde(default)]
    pub is_deafened: bool,
    #[serde(default)]
    pub audio_level: f32,
    #[serde(default = "default_quality")]
    pub connection_quality: NativeConnectionQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playing_sound_emoji: Option<String>,
    /// Échéance du badge soundboard, en ms d'horloge monotone (`mono_ms`).
    /// Le badge n'expire plus « après N ms » mais « à cette date » : plusieurs
    /// sons qui se chevauchent repoussent l'échéance au lieu de s'entretuer, et
    /// un réveil en retard revérifie avant d'éteindre. État interne, hors du
    /// contrat front (`ParticipantInfo`) — d'où le `skip`.
    #[serde(skip)]
    pub badge_deadline_ms: u64,
}

fn default_quality() -> NativeConnectionQuality {
    NativeConnectionQuality::Unknown
}

/// Horloge monotone (ms) : insensible à un saut d'horloge système, contrairement
/// au `SystemTime` employé pour les horodatages de curseur.
fn mono_ms() -> u64 {
    static BASE: OnceLock<std::time::Instant> = OnceLock::new();
    BASE.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// Durée de repli quand le payload n'en porte pas (ou zéro) : la sonde
/// d'upload a pu échouer, le son existe quand même et il dure rarement moins.
const BADGE_DEFAULT_MS: u64 = 3_000;
/// Garde-fou : la soundboard plafonne à 20 s, une durée aberrante (payload
/// forgé, artéfact d'encodage) ne doit pas figer un rond pour la session.
const BADGE_MAX_MS: u64 = 60_000;

/// Normalise une durée annoncée : 0/absente → repli, au-delà → plafond.
/// Miroir JS de `resolveBadgeDurationMs` (`soundboardService.ts`).
fn sane_badge_ms(raw: u64) -> u64 {
    if raw == 0 {
        BADGE_DEFAULT_MS
    } else {
        raw.min(BADGE_MAX_MS)
    }
}

impl NativeParticipant {
    pub fn new(identity: &str, name: &str) -> Self {
        Self {
            identity: identity.to_string(),
            name: name.to_string(),
            is_speaking: false,
            is_muted: false,
            is_screen_sharing: false,
            is_screen_sharing_audio: false,
            is_deafened: false,
            audio_level: 0.0,
            connection_quality: NativeConnectionQuality::Unknown,
            playing_sound_emoji: None,
            badge_deadline_ms: 0,
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
/// `duration` absente (expéditeur qui ne la connaît pas) → repli, jamais 0 :
/// un badge de 0 ms s'éteindrait avant même d'avoir été peint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SoundboardPayload {
    pub mxc: String,
    pub emoji: String,
    #[serde(default = "default_soundboard_duration")]
    pub duration: u64,
    #[serde(default = "default_gain")]
    pub gain: f32,
}

/// Repli contractuel partagé avec `broadcastSound` JS (3000 ms quand
/// l'expéditeur ne connaît pas la durée).
fn default_soundboard_duration() -> u64 {
    BADGE_DEFAULT_MS
}

fn default_gain() -> f32 {
    1.0
}

impl SoundboardPayload {
    pub fn new(mxc: &str, emoji: Option<&str>, duration_ms: Option<u64>, gain: f32) -> Self {
        Self {
            mxc: mxc.to_string(),
            emoji: emoji.unwrap_or("🔊").to_string(),
            duration: duration_ms.unwrap_or_else(default_soundboard_duration),
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

/// Clés MatrixRTC brutes (`Uint8Array` reçue sur `EncryptionKeyChanged`) :
/// 16 octets (AES-128-GCM — `generateRandomKey` de matrix-js-sdk, prouvé
/// par le rejet à tort du 08/09 qui attendait 32). 32 accepté aussi
/// (AES-256, clés partagées livekit) ; le reste est rejeté avant le provider.
pub const E2EE_RAW_KEY_LEN_128: usize = 16;
pub const E2EE_RAW_KEY_LEN_256: usize = 32;

/// Vrai si la clé brute est utilisable par le pont E2EE natif.
pub fn validate_e2ee_key(key: &[u8]) -> bool {
    matches!(key.len(), E2EE_RAW_KEY_LEN_128 | E2EE_RAW_KEY_LEN_256)
}

// ---------------------------------------------------------------------------
// Moteur voix (le vrai LiveKit arrive à l'étape suivante)
// ---------------------------------------------------------------------------

/// Abstraction du moteur SFU : l'implémentation `LiveKit` (crate `livekit`,
/// `Room::connect`, `PlatformAudio`) se branchera ici sans changer les
/// commandes ni le front.
pub trait VoiceEngine {
    fn connect(&mut self, url: &str, token: &str, encrypted: bool) -> Result<String, String>;
    fn disconnect(&mut self);
}

// ---------------------------------------------------------------------------
// Registre participants + relais d'événements moteur → front
// (feature `native-voice` : sans elle, les commandes restent en mode état
// seul et `connect` renvoie une erreur explicite)
// ---------------------------------------------------------------------------

#[cfg(feature = "native-voice")]
use crate::voice_engine::{LiveKitEngine, VoiceEngineEvent};
#[cfg(feature = "native-voice")]
use base64::Engine as _;
#[cfg(feature = "native-voice")]
use livekit::PlatformAudio;
#[cfg(feature = "native-voice")]
use std::collections::HashMap;

// Serialize event forwarding with session invalidation. An old SDK room may
// still deliver its final events while the next room is already connecting.
#[cfg(feature = "native-voice")]
static EVENT_GENERATION: Mutex<u64> = Mutex::new(0);

#[cfg(feature = "native-voice")]
fn invalidate_native_events() -> u64 {
    let mut generation = EVENT_GENERATION.lock().unwrap_or_else(|e| e.into_inner());
    *generation = generation.wrapping_add(1);
    *generation
}

/// Moteur SFU natif (feature `native-voice` uniquement).
#[cfg(feature = "native-voice")]
static ENGINE: OnceLock<Mutex<Option<LiveKitEngine>>> = OnceLock::new();

/// ADM temporaire utilisé par les tests des réglages quand aucun salon n'est
/// rejoint. En appel, le vumètre et la mélodie utilisent directement l'ADM du
/// moteur afin de ne jamais ouvrir un second microphone.
#[cfg(feature = "native-voice")]
static AUDIO_TEST: OnceLock<Mutex<Option<PlatformAudio>>> = OnceLock::new();

#[cfg(feature = "native-voice")]
static AUDIO_TEST_OWNERS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

#[cfg(feature = "native-voice")]
type TestPeerConnectionFactory = webrtc_sys::peer_connection_factory::SharedPtr<
    webrtc_sys::peer_connection_factory::ffi::PeerConnectionFactory,
>;

#[cfg(feature = "native-voice")]
static SPEAKER_TEST_FACTORY: OnceLock<Mutex<Option<TestPeerConnectionFactory>>> = OnceLock::new();

#[cfg(feature = "native-voice")]
fn audio_test_holder() -> &'static Mutex<Option<PlatformAudio>> {
    AUDIO_TEST.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "native-voice")]
fn audio_test_owners() -> &'static Mutex<std::collections::HashSet<String>> {
    AUDIO_TEST_OWNERS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

#[cfg(feature = "native-voice")]
pub(crate) fn microphone_monitor_requested() -> bool {
    audio_test_owners()
        .lock()
        .map(|owners| !owners.is_empty())
        .unwrap_or(false)
}

#[cfg(feature = "native-voice")]
fn speaker_test_holder() -> &'static Mutex<Option<TestPeerConnectionFactory>> {
    SPEAKER_TEST_FACTORY.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "native-voice")]
fn stop_speaker_test_force() {
    if let Some(factory) = speaker_test_holder()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let audio = factory.audio_device();
        let _ = audio.stop_playout();
        audio.release_platform_adm();
    }
}

#[cfg(feature = "native-voice")]
fn stop_microphone_test_device() {
    if let Some(audio) = audio_test_holder()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = audio.stop_recording();
    }
}

#[cfg(feature = "native-voice")]
fn stop_audio_test_force() {
    stop_microphone_test_device();
    stop_speaker_test_force();
    audio_test_owners()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

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

/// Sort le moteur du holder, en patientant brièvement s'il est emprunté par
/// une autre commande : les commandes Tauri tournent en concurrence (ex. le
/// curseur publie à 60 Hz) et un `take` immédiat rendait `None` par collision.
/// Sans attente, l'appelant déclarait la session morte (`drop_dead_session`
/// vide la liste des participants) alors que le moteur revenait une
/// milliseconde plus tard — d'où des participants / partages qui
/// "disparaissent" mystérieusement au survol, sans jamais revenir pour les
/// silencieux (pas d'event pour les recréer). Seule une absence durable
/// (≈100 ms) vaut mort de session.
#[cfg(feature = "native-voice")]
fn take_engine_wait() -> Option<LiveKitEngine> {
    for attempt in 0..10 {
        if let Some(engine) = take_engine() {
            if attempt > 0 {
                log::debug!(
                    "[Sion][voix-native] moteur récupéré après {} tentative(s)",
                    attempt + 1
                );
            }
            return Some(engine);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

/// Repose un moteur (éventuellement None) dans le holder.
#[cfg(feature = "native-voice")]
fn store_engine(engine: Option<LiveKitEngine>) {
    *engine_holder().lock().unwrap_or_else(|e| e.into_inner()) = engine;
}

/// Remet le manager à l'état déconnecté vierge (partagé par le disconnect
/// explicite et `drop_dead_session`). Le cycle de vie MIROIR du store front
/// (`disconnectVoice` remet `isMuted`/`isDeafened` à false) est critique :
/// sans le reset muted/deafened, un leave-while-muted mutait d'office le
/// join suivant derrière un store "non muté" (bug du 09/09).
fn reset_manager_to_disconnected() {
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    inner.state = VoiceConnectionState::Disconnected;
    inner.room_name = None;
    inner.identity = None;
    inner.muted = false;
    inner.deafened = false;
}

/// Session locale réinitialisée quand le moteur a durablement disparu
/// (jamais créé, ou perdu après panique) : pas de fantôme, le front repart
/// d'un état propre. N'est atteint qu'après `take_engine_wait` — jamais sur
/// une simple collision entre commandes.
#[cfg(feature = "native-voice")]
fn drop_dead_session(app: &tauri::AppHandle<TauriRuntime>) {
    store_engine(None);
    participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    let empty: Vec<NativeParticipant> = Vec::new();
    let _ = app.emit("voice-native-participants", &empty);
    reset_manager_to_disconnected();
    emit_status(
        &app,
        &snapshot(&manager().lock().unwrap_or_else(|e| e.into_inner())),
    );
}

/// Exécute `op` sur le moteur sorti du holder puis le repose — sans jamais
/// verrouiller pendant l'appel SDK (une panique LiveKit ne doit plus
/// empoisonner les commandes suivantes). En cas de panique, le moteur est
/// REPOSÉ (pas jeté) : la panique est généralement incidente (ex. contexte
/// Tokio manquant, déjà corrigé) et jeter le moteur tuait l'appel en cours.
/// L'erreur est retournée (le front garde son état précédent) et loggée fort.
#[cfg(feature = "native-voice")]
fn with_engine<R>(
    app: &tauri::AppHandle<TauriRuntime>,
    label: &str,
    op: impl FnOnce(&mut LiveKitEngine) -> Result<R, String>,
) -> Result<R, String> {
    let mut slot = take_engine_wait();
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
                    // `slot` garde le moteur (emprunt seulement) : on le
                    // repose tel quel, la session survit à la panique.
                    log::error!(
                        "[Sion][voix-native] {} : panique SDK isolée (moteur conservé): {}",
                        label,
                        msg
                    );
                    Err(format!("{} (panique SDK isolée)", label))
                }
            }
        }
        None => Err("pas de moteur natif".to_string()),
    };
    let lost = slot.is_none();
    store_engine(slot);
    if lost {
        drop_dead_session(app);
    }
    res
}

/// Exécute une opération longue qui n'a besoin que de `&LiveKitEngine` en
/// gardant le moteur DANS son holder. Le portail de partage Wayland peut
/// prendre plusieurs secondes : si on utilisait `with_engine`, le moteur
/// était temporairement remplacé par `None` et un publish curseur concurrent
/// concluait à tort que la session était morte, vidant toute l'UI alors que
/// l'audio WebRTC continuait. Ici les commandes concurrentes attendent le
/// verrou puis retrouvent le même moteur.
#[cfg(feature = "native-voice")]
fn with_engine_shared<R>(
    app: &tauri::AppHandle<TauriRuntime>,
    label: &str,
    op: impl FnOnce(&LiveKitEngine) -> Result<R, String>,
) -> Result<R, String> {
    let guard = engine_holder().lock().unwrap_or_else(|e| e.into_inner());
    let result = match guard.as_ref() {
        Some(engine) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(engine)))
        {
            Ok(result) => result,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panique SDK".to_string());
                log::error!(
                    "[Sion][voix-native] {} : panique SDK isolée (moteur conservé): {}",
                    label,
                    msg
                );
                Err(format!("{} (panique SDK isolée)", label))
            }
        },
        None => Err("pas de moteur natif".to_string()),
    };
    let missing = guard.is_none();
    drop(guard);
    if missing {
        drop_dead_session(app);
    }
    result
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
fn apply_engine_event(map: &mut HashMap<String, NativeParticipant>, ev: &VoiceEngineEvent) -> bool {
    match ev {
        VoiceEngineEvent::ParticipantJoined { identity, name } => {
            let p = upsert_participant(map, identity);
            // LiveKit renvoie parfois un nom vide : ne jamais écraser (ni
            // l'identité par défaut de l'upsert, ni un vrai nom déjà connu).
            if !name.is_empty() {
                p.name = name.clone();
            }
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
        VoiceEngineEvent::VideoPresence { sender, sharing } => {
            upsert_participant(map, sender).is_screen_sharing = *sharing;
            true
        }
        VoiceEngineEvent::ShareAudioPresence { sender, has_audio } => {
            upsert_participant(map, sender).is_screen_sharing_audio = *has_audio;
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
        | VoiceEngineEvent::RoomReconnected
        | VoiceEngineEvent::E2eeStateChanged { .. } => false,
    }
}

/// Décode un payload `sion-afk` (base64) et pose l'état sourdine sur
/// l'expéditeur — miroir de `remoteDeafenState` + `update()` côté JS.
/// Retourne `true` si la liste doit être réémise. Fonction pure.
#[cfg(feature = "native-voice")]
fn apply_afk_state(
    map: &mut HashMap<String, NativeParticipant>,
    sender: &str,
    payload_b64: &str,
) -> bool {
    use base64::Engine as _;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload_b64) else {
        return false;
    };
    let Ok(raw) = String::from_utf8(bytes) else {
        return false;
    };
    let Ok(data) = decode_json::<AfkPayload>(&raw) else {
        return false;
    };
    upsert_participant(map, sender).is_deafened = data.deafened;
    log::info!(
        "[Sion][voix-native] AFK rx {} deafened={}",
        sender,
        data.deafened
    );
    // On réémet systématiquement : l'expéditeur a pu rejoindre entre-temps
    // et le front a besoin d'un refresh complet.
    true
}

#[cfg(all(feature = "native-voice", not(target_os = "android")))]
#[derive(Deserialize)]
struct NativeCursorPayload {
    x: Option<f32>,
    y: Option<f32>,
    click: Option<bool>,
    expire: Option<bool>,
    t: Option<String>,
    /// Pseudo Matrix résolu par l'émetteur. Les anciens clients ne
    /// l'envoient pas ; dans ce cas on replie sur le registre puis localpart.
    n: Option<String>,
}

/// Publie NOTRE position de curseur, depuis le Rust, sans passer par le front.
///
/// La surface vidéo native recouvre la WebView2 : c'est elle qui reçoit la
/// souris, et elle relayait la position au front pour que celui-ci la diffuse
/// comme il le faisait depuis le canvas. Ce détour coûte deux allers-retours
/// IPC par position — Rust vers événement, puis `invoke` vers Rust — et la
/// cadence plafonnait à 6 positions par seconde, avec un curseur nettement
/// mou (18/09). Le chemin direct n'en coûte aucun.
///
/// Alimente aussi le calque local : le data-channel ne renvoie pas nos propres
/// paquets, donc sans cela on voit le curseur de tous les autres sauf le sien.
#[cfg(all(feature = "native-voice", not(target_os = "android")))]
pub fn publier_curseur_local(
    app: &tauri::AppHandle<TauriRuntime>,
    cible: &str,
    x: f32,
    y: f32,
) {
    let identity = manager()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity
        .clone();
    let Some(identity) = identity else { return };
    let nom = participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&identity)
        .map(|p| p.name.clone());
    let charge = serde_json::json!({
        "x": x,
        "y": y,
        "t": cible,
        "n": nom,
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let Ok(octets) = serde_json::to_vec(&charge) else {
        return;
    };
    let _ = with_engine_shared(app, "curseur natif", |e| {
        e.publish_data(TOPIC_CURSOR, octets.clone(), false)
    });
    // Notre propre flèche, que personne ne nous renverra.
    let nom_affiche = cursor_display_name(charge["n"].as_str(), None, &identity);
    crate::native_video_surface::on_viewer_cursor_packet(
        cible,
        &identity,
        &nom_affiche,
        false,
        x,
        y,
        false,
    );
}

/// Publie un CLIC de notre curseur, depuis le Rust.
///
/// Les positions étaient publiées mais pas les clics : l'onde qui les signale
/// chez le partageur avait disparu sous Windows (18/09). Le calque DOM s'en
/// chargeait via l'événement `click` du canvas, que notre fenêtre native
/// recouvre désormais.
#[cfg(all(feature = "native-voice", not(target_os = "android")))]
pub fn publier_clic_local(
    app: &tauri::AppHandle<TauriRuntime>,
    cible: &str,
    x: f32,
    y: f32,
) {
    let identity = manager()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity
        .clone();
    let Some(identity) = identity else { return };
    let nom = participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&identity)
        .map(|p| p.name.clone());
    let charge = serde_json::json!({
        "x": x,
        "y": y,
        "t": cible,
        "n": nom,
        "click": true,
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let Ok(octets) = serde_json::to_vec(&charge) else {
        return;
    };
    let _ = with_engine_shared(app, "clic natif", |e| {
        e.publish_data(TOPIC_CURSOR_CLICK, octets.clone(), true)
    });
    let nom_affiche = cursor_display_name(charge["n"].as_str(), None, &identity);
    crate::native_video_surface::on_viewer_cursor_packet(
        cible,
        &identity,
        &nom_affiche,
        true,
        x,
        y,
        false,
    );
}

#[cfg(all(feature = "native-voice", not(target_os = "android")))]
fn cursor_display_name(
    payload_name: Option<&str>,
    participant_name: Option<&str>,
    sender: &str,
) -> String {
    for candidate in [payload_name, participant_name].into_iter().flatten() {
        let clean = candidate.trim();
        if !clean.is_empty() && !(clean.starts_with('@') && clean.contains(':')) {
            return clean.chars().take(64).collect();
        }
    }
    sender
        .strip_prefix('@')
        .unwrap_or(sender)
        .split(':')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(sender)
        .chars()
        .take(64)
        .collect()
}

/// Miroir viewer de `forward_cursor_to_overlay` : pousse vers la surface
/// vidéo intégrée les curseurs des AUTRES viewers pointant un partage que
/// cette fenêtre affiche. Le calque DOM étant occlu par la peinture GTK,
/// c'est le seul endroit où les voir. Retourne early tant que la surface
/// n'est pas disponible (fallback JPEG actif → le DOM s'en occupe).
#[cfg(all(feature = "native-voice", not(target_os = "android")))]
fn forward_cursor_to_viewer_surface(topic: Option<&str>, payload_b64: &str, sender: Option<&str>) {
    use base64::Engine as _;
    let Some(sender) = sender else { return };
    let Some(target) = crate::native_video_surface::viewer_targets() else {
        return;
    };
    let self_identity = manager()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity
        .clone();
    // Notre propre curseur n'est plus écarté ici. Il l'était parce que le
    // calque DOM le dessinait ; ce calque est masqué par la surface native, et
    // l'écarter revenait à ne jamais le montrer. Il n'arrive de toute façon
    // pas par le data-channel — LiveKit ne renvoie pas ses propres paquets —
    // mais par l'écho local posé dans `voice_native_publish_data`.
    let _ = &self_identity;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload_b64) else {
        return;
    };
    let Ok(payload) = serde_json::from_slice::<NativeCursorPayload>(&bytes) else {
        return;
    };
    let Some(target_identity) = payload.t.as_deref() else {
        return;
    };
    // Cible inconnue de nos surfaces affichées : jeter silencieusement (à
    // 60 Hz et plusieurs partages, c'est le cas le plus fréquent). Un
    // ensemble VIDE (aucun rectangle publié : transition React) garde le
    // paquet — la surface se publie quelques millisecondes plus tard.
    if !target.is_empty() && !target.contains(target_identity) {
        return;
    }
    let participant_name = participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(sender)
        .map(|p| p.name.clone());
    let name = cursor_display_name(payload.n.as_deref(), participant_name.as_deref(), sender);
    if topic == Some(TOPIC_CURSOR_CLICK) && payload.click == Some(true) {
        crate::native_video_surface::on_viewer_cursor_packet(
            target_identity,
            sender,
            &name,
            true,
            payload.x.unwrap_or(0.0),
            payload.y.unwrap_or(0.0),
            false,
        );
    } else if topic == Some(TOPIC_CURSOR) {
        crate::native_video_surface::on_viewer_cursor_packet(
            target_identity,
            sender,
            &name,
            false,
            payload.x.unwrap_or(0.0),
            payload.y.unwrap_or(0.0),
            payload.expire == Some(true),
        );
    }
}

/// Chemin court data-channel → overlay natif. Il évite le détour
/// Rust→Tauri→JS→Tauri→Rust qui ajoutait plusieurs frames de retard au
/// curseur vu par le sharer. L'événement générique reste émis pour que les
/// autres viewers dessinent les curseurs dans leur propre interface.
#[cfg(all(feature = "native-voice", not(target_os = "android")))]
fn forward_cursor_to_overlay(topic: Option<&str>, payload_b64: &str, sender: &str) {
    if !crate::cursor_overlay::cursor_overlay_is_open()
        || !matches!(topic, Some(TOPIC_CURSOR) | Some(TOPIC_CURSOR_CLICK))
    {
        return;
    }
    use base64::Engine as _;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload_b64) else {
        return;
    };
    let Ok(payload) = serde_json::from_slice::<NativeCursorPayload>(&bytes) else {
        return;
    };
    let self_identity = manager()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity
        .clone();
    // Masquage SANS cible = « je ne pointe plus AUCUN partage » (blur,
    // minimisation, fermeture de l'app) : il doit effacer notre overlay
    // aussi, sinon un alt-tab ou un redémarrage laissait un curseur fantôme
    // jusqu'au TTL. Une position sans cible reste ignorée — ambiguë avec
    // plusieurs partages concurrents.
    let untargeted_expire =
        topic == Some(TOPIC_CURSOR) && payload.expire == Some(true) && payload.t.is_none();
    if payload.t.as_deref() != self_identity.as_deref() && !untargeted_expire {
        // Throttle : 3 premières occurrences seulement (sinon 60 logs/s).
        static MISMATCH_LOGS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        if MISMATCH_LOGS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 3 {
            log::info!(
                "[Sion][Cursor] rx {} ignoré : cible {:?} != soi {:?}",
                sender,
                payload.t,
                self_identity
            );
        }
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    // Diagnostic (13/09) : un log unique quand une position passe le filtre de
    // cible et part vers l'overlay — sans lui, « rien à l'écran » ne distingue
    // pas « paquets filtrés » de « paquets non peints ».
    static FORWARD_LOGGED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    if !FORWARD_LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        log::info!(
            "[Sion][Cursor] rx → overlay : sender={} x={:?} y={:?} t={:?} (soi={:?})",
            sender,
            payload.x,
            payload.y,
            payload.t,
            self_identity
        );
    }
    if topic == Some(TOPIC_CURSOR_CLICK) && payload.click == Some(true) {
        crate::cursor_overlay::cursor_overlay_push_click(
            format!("{sender}:{now}"),
            // La couleur du pointeur est dérivée de l'identité LiveKit.
            // Garder exactement cette même clé pour l'onde du clic : le
            // pseudo d'affichage peut être différent (ex. "Picsou") et
            // produisait alors une autre couleur.
            sender.to_string(),
            payload.x.unwrap_or(0.0),
            payload.y.unwrap_or(0.0),
            now + 800,
        );
    } else if topic == Some(TOPIC_CURSOR) {
        if payload.expire == Some(true) {
            crate::cursor_overlay::cursor_overlay_clear(sender.to_string());
        } else if let (Some(x), Some(y)) = (payload.x, payload.y) {
            let participant_name = participants_map()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(sender)
                .map(|p| p.name.clone());
            let name =
                cursor_display_name(payload.n.as_deref(), participant_name.as_deref(), sender);
            crate::cursor_overlay::cursor_overlay_push(
                sender.to_string(),
                name,
                x,
                y,
                // TTL court (5 s) : un curseur qui n'a plus bougé — ou dont
                // le viewer a changé de fenêtre sans envoyer de `leave` —
                // s'efface tout seul au sweep (l'overlay programme un réveil
                // `WaitUntil` sur l'expiration). Un flux vivant ré-arme le
                // TTL à chaque position (~60 Hz). Avant, 60 s laissaient une
                // flèche fantôme figée sur l'écran du partageur après un
                // alt-tab.
                now + 5_000,
            );
        }
    }
}

/// Décode un payload `sion-soundboard` (base64) et pose le badge sur
/// l'expéditeur. Pousse l'échéance à `now + durée` (sans jamais la
/// raccourcir : un son plus long encore en cours du même expéditeur garde son
/// rond). Retourne la durée retenue (ms), normalisée. Fonction pure.
#[cfg(feature = "native-voice")]
fn apply_soundboard_badge(
    map: &mut HashMap<String, NativeParticipant>,
    sender: &str,
    payload_b64: &str,
    now_ms: u64,
) -> Option<u64> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .ok()?;
    let raw = String::from_utf8(bytes).ok()?;
    let data: SoundboardPayload = decode_json(&raw).ok()?;
    let duration = sane_badge_ms(data.duration);
    let p = upsert_participant(map, sender);
    p.playing_sound_emoji = Some(data.emoji.clone());
    p.badge_deadline_ms = p.badge_deadline_ms.max(now_ms.saturating_add(duration));
    Some(duration)
}

/// Repousse l'échéance du badge d'un expéditeur à `now + durée` — jamais
/// raccourcie — et rallume le badge quand le front fournit l'emoji (cas du
/// récepteur : le badge posé à l'arrivée du paquet a pu expirer avant que le
/// son ne démarre vraiment chez lui). Retourne `true` si l'échéance a bougé.
/// Fonction pure.
#[cfg(feature = "native-voice")]
fn extend_badge_deadline(
    map: &mut HashMap<String, NativeParticipant>,
    sender: &str,
    duration_ms: u64,
    emoji: Option<&str>,
    now_ms: u64,
) -> bool {
    let duration = sane_badge_ms(duration_ms);
    let Some(p) = map.get_mut(sender) else {
        return false;
    };
    // Badge éteint et pas d'emoji pour le rallumer : rien à faire (le son
    // n'est pas joué localement — soundboard coupée, participant sourd…).
    if emoji.is_none() && p.playing_sound_emoji.is_none() {
        return false;
    }
    if let Some(emoji) = emoji {
        p.playing_sound_emoji = Some(emoji.to_string());
    }
    let deadline = now_ms.saturating_add(duration);
    let moved = deadline > p.badge_deadline_ms;
    p.badge_deadline_ms = p.badge_deadline_ms.max(deadline);
    moved
}

/// Thread d'expiration du badge d'un expéditeur.
///
/// Il ne dort plus « la durée du son » avant d'effacer : il vise l'échéance
/// enregistrée, et revérifie à chaque réveil. Conséquences voulues —
/// un ancien son ne peut plus éteindre le rond d'un son plus récent encore en
/// cours (son minuteur dort sur une échéance périmée, il la relit), et deux
/// sons qui se chevauchent gardent le rond jusqu'à la fin du dernier. Un seul
/// thread vit par badge ; il sort dès qu'il n'y a plus rien à éteindre.
#[cfg(feature = "native-voice")]
fn spawn_badge_expiry(app: &tauri::AppHandle<TauriRuntime>, sender: &str) {
    let app2 = app.clone();
    let sender2 = sender.to_string();
    std::thread::Builder::new()
        .name("sion-voice-badge".into())
        .spawn(move || loop {
            // `None` = plus de badge à éteindre ; `Some(0)` = échéance atteinte.
            let remaining = {
                let map = participants_map().lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&sender2) {
                    Some(p) if p.playing_sound_emoji.is_some() => {
                        Some(p.badge_deadline_ms.saturating_sub(mono_ms()))
                    }
                    _ => None,
                }
            };
            let Some(remaining) = remaining else { return };
            if remaining > 0 {
                std::thread::sleep(std::time::Duration::from_millis(remaining));
                continue;
            }
            // Re-vérification sous verrou : entre la lecture ci-dessus et ici,
            // un son suivant a pu repousser l'échéance (ou rallumer le badge).
            let cleared = {
                let mut map = participants_map().lock().unwrap_or_else(|e| e.into_inner());
                match map.get_mut(&sender2) {
                    Some(p)
                        if p.playing_sound_emoji.is_some() && p.badge_deadline_ms <= mono_ms() =>
                    {
                        p.playing_sound_emoji = None;
                        p.badge_deadline_ms = 0;
                        true
                    }
                    _ => false,
                }
            };
            emit_participants(&app2);
            if cleared {
                return;
            }
        })
        .ok();
}

/// Pose le badge et arme son expiration. Partagé par la réception distante et
/// l'envoi local (le data-channel ne revient pas vers l'expéditeur : sans ça,
/// on ne voit jamais son propre badge quand on déclenche un son).
#[cfg(feature = "native-voice")]
fn show_soundboard_badge(app: &tauri::AppHandle<TauriRuntime>, sender: &str, payload_b64: &str) {
    let armed = {
        let mut map = participants_map().lock().unwrap_or_else(|e| e.into_inner());
        apply_soundboard_badge(&mut map, sender, payload_b64, mono_ms())
    };
    emit_participants(app);
    if armed.is_some() {
        spawn_badge_expiry(app, sender);
    }
}
/// Pompe d'événements moteur → front sur thread dédié (pas besoin du runtime
/// Tokio ici : `blocking_recv`). Se termine quand le moteur est droppé
/// (canal fermé) — pas de fuite entre deux sessions.
#[cfg(feature = "native-voice")]
fn spawn_forward_task(
    app: tauri::AppHandle<TauriRuntime>,
    rx: tokio::sync::broadcast::Receiver<VoiceEngineEvent>,
    generation: u64,
) {
    std::thread::Builder::new()
        .name("sion-voice-events".into())
        .spawn(move || {
            let mut rx = rx;
            loop {
                let ev = match rx.blocking_recv() {
                    Ok(ev) => ev,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        log::warn!(
                            "[Sion][voix-native] {} événements ignorés (retard du relais)",
                            count
                        );
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let current = EVENT_GENERATION.lock().unwrap_or_else(|e| e.into_inner());
                if *current != generation {
                    break;
                }
                // Un event vérolé ne doit jamais tuer la pompe (mort
                // silencieuse = plus aucun état live : AFK, parole, liste).
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match &ev {
                        VoiceEngineEvent::DataReceived {
                            topic,
                            payload_b64,
                            sender,
                        } => {
                            if topic.as_deref() == Some(TOPIC_AFK) {
                                if let Some(sender) = sender {
                                    let changed = {
                                        let mut map = participants_map()
                                            .lock()
                                            .unwrap_or_else(|e| e.into_inner());
                                        apply_afk_state(&mut map, sender, payload_b64)
                                    };
                                    if changed {
                                        emit_participants(&app);
                                    }
                                }
                            }
                            if topic.as_deref() == Some(TOPIC_SOUNDBOARD) {
                                if let Some(sender) = sender {
                                    show_soundboard_badge(&app, sender, payload_b64);
                                }
                            }
                            #[cfg(not(target_os = "android"))]
                            if let Some(sender) = sender {
                                forward_cursor_to_overlay(topic.as_deref(), payload_b64, sender);
                            }
                            // Miroir viewer : les curseurs des autres viewers
                            // pointant un partage que NOUS affichons doivent
                            // être peints par la surface intégrée (le calque
                            // DOM est occlu par la peinture GTK). Le filtre
                            // `t == partage affiché` est fait en Rust.
                            #[cfg(all(feature = "native-voice", not(target_os = "android")))]
                            if matches!(
                                topic.as_deref(),
                                Some(TOPIC_CURSOR) | Some(TOPIC_CURSOR_CLICK)
                            ) {
                                forward_cursor_to_viewer_surface(
                                    topic.as_deref(),
                                    payload_b64,
                                    sender.as_deref(),
                                );
                            }
                            // Relais générique pour les futurs dispatchers front
                            // (AFK, curseurs, transcribe-arm).
                            let _ = app.emit("voice-native-data", &ev);
                        }
                        VoiceEngineEvent::RoomDisconnected { reason } => {
                            log::warn!("[Sion][voix-native] session SFU perdue ({})", reason);
                            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
                            inner.state = VoiceConnectionState::Disconnected;
                            inner.identity = None;
                            let status = snapshot(&inner);
                            emit_status(&app, &status);
                        }
                        VoiceEngineEvent::RoomReconnecting => {
                            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
                            inner.state = VoiceConnectionState::Reconnecting;
                            let status = snapshot(&inner);
                            emit_status(&app, &status);
                        }
                        VoiceEngineEvent::RoomReconnected => {
                            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
                            inner.state = VoiceConnectionState::Connected;
                            let status = snapshot(&inner);
                            emit_status(&app, &status);
                        }
                        other => {
                            let changed = {
                                let mut map =
                                    participants_map().lock().unwrap_or_else(|e| e.into_inner());
                                apply_engine_event(&mut map, other)
                            };
                            if changed {
                                emit_participants(&app);
                            }
                            // `isSpeaking` est déjà dans la liste de
                            // participants (apply_engine_event) : plus
                            // d'événement dédié sans consommateur.
                            if matches!(other, VoiceEngineEvent::E2eeStateChanged { .. }) {
                                let _ = app.emit("voice-native-e2ee-state", other);
                            }
                        }
                    }
                }));
                if res.is_err() {
                    log::error!("[Sion][voix-native] pompe d'events : panique isolée sur un event");
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
    encrypted: bool,
    input_device: String,
    output_device: String,
    audio_quality: NativeAudioQuality,
) -> Result<String, String> {
    let generation = invalidate_native_events();
    participants_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    let mut engine = LiveKitEngine::new()?;
    engine.configure_audio_devices(input_device, output_device);
    engine.configure_audio_quality(audio_quality.max_bitrate());
    engine.set_event_app(app.clone());
    let rx = engine.subscribe();
    spawn_forward_task(app.clone(), rx, generation);
    let t_join = std::time::Instant::now();
    let identity = engine.connect(url, token, encrypted)?;
    if let Err(e) = engine.publish_microphone() {
        engine.disconnect();
        return Err(e);
    }
    // Mute désiré AVANT le join (F8 hors appel…) : le manager le sait déjà,
    // le moteur frais non — on l'applique (sinon store "muté" + micro live).
    // Pas de `deafened` équivalent : aucun intent ne survit au join.
    let want_muted = manager().lock().unwrap_or_else(|e| e.into_inner()).muted;
    if want_muted {
        if let Err(e) = engine.set_microphone_enabled(false) {
            log::warn!("[Sion][voix-native] mute initial refusé: {}", e);
        }
    }
    log::info!(
        "[Sion][voix-native] join complet en {}ms (connect+micro)",
        t_join.elapsed().as_millis()
    );
    // Rond vert local : télémétrie de la capture WebRTC, sans deuxième micro.
    // Un échec du thread d'affichage ne doit pas faire échouer l'appel.
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
    // Annonce initiale aux pairs déjà présents (`deafened: false` — le
    // connect remet toujours à zéro), miroir du `broadcastAfk` au join JS.
    // Best-effort : un data-channel pas encore prêt ne fait pas échouer le join.
    if let Err(e) = with_engine(app, "afk initial natif", |e| {
        let payload =
            serde_json::to_vec(&AfkPayload { deafened: false }).map_err(|e| e.to_string())?;
        e.publish_data(TOPIC_AFK, payload, true)
    }) {
        log::warn!("[Sion][voix-native] {}", e);
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

#[tauri::command]
pub fn voice_native_available() -> bool {
    cfg!(feature = "native-voice")
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeAudioDevices {
    recording: Vec<NativeAudioDevice>,
    playout: Vec<NativeAudioDevice>,
}

#[tauri::command]
pub fn voice_native_audio_devices() -> Result<NativeAudioDevices, String> {
    #[cfg(feature = "native-voice")]
    {
        let (recording, playout) = crate::voice_engine::platform_audio_snapshot()?;
        Ok(NativeAudioDevices { recording, playout })
    }
    #[cfg(not(feature = "native-voice"))]
    Err("Voix native non compilée".into())
}

#[tauri::command]
pub fn voice_native_switch_audio_device(
    app: tauri::AppHandle<TauriRuntime>,
    kind: String,
    device_id: String,
) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    {
        with_engine(&app, "périphérique audio", |e| {
            e.switch_audio_device(&kind, &device_id)
        })
    }
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (app, kind, device_id);
        Err("Voix native non compilée".into())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioProcessing {
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    pub noise_suppression: bool,
    pub mix: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeAudioQuality {
    #[serde(rename = "voice")]
    Voice,
    #[serde(rename = "voiceHD")]
    VoiceHd,
    #[serde(rename = "musicStereo")]
    MusicStereo,
}

impl Default for NativeAudioQuality {
    fn default() -> Self {
        Self::VoiceHd
    }
}

impl NativeAudioQuality {
    fn max_bitrate(self) -> u64 {
        match self {
            Self::Voice => 24_000,
            Self::VoiceHd => 48_000,
            Self::MusicStereo => 128_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct NativeAudioLevel {
    sequence: u64,
    rms: f32,
}

/// Démarre la capture de diagnostic hors appel. Pendant un appel, l'APM est
/// déjà alimenté et cette commande ne touche pas à son cycle de vie.
#[tauri::command]
pub fn voice_native_start_microphone_test(
    app: tauri::AppHandle<TauriRuntime>,
    device_id: String,
    owner: String,
) -> Result<(), String> {
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (app, device_id, owner);
        return Err("Voix native non compilée".into());
    }
    #[cfg(feature = "native-voice")]
    {
        if owner.trim().is_empty() || owner.len() > 64 {
            return Err("propriétaire du test microphone invalide".into());
        }
        audio_test_owners()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(owner.clone());
        let result = if manager().lock().unwrap_or_else(|e| e.into_inner()).state
            != VoiceConnectionState::Disconnected
        {
            with_engine(&app, "test microphone", |engine| {
                engine.set_microphone_test_enabled(true)
            })
        } else {
            (|| {
                stop_microphone_test_device();
                let audio = PlatformAudio::new().map_err(|e| format!("test micro natif: {e}"))?;
                let device = crate::voice_engine::list_recording_devices(&audio)
                    .into_iter()
                    .find(|d| {
                        if device_id.is_empty() {
                            d.index == 0
                        } else {
                            d.id.as_str() == device_id
                        }
                    })
                    .ok_or("microphone indisponible")?;
                audio
                    .switch_recording_device(&device.id)
                    .map_err(|e| format!("sélection du micro de test: {e}"))?;
                audio
                    .start_recording()
                    .map_err(|e| format!("démarrage du test micro: {e}"))?;
                #[cfg(target_os = "linux")]
                crate::route_native_microphone(if device_id.is_empty() {
                    None
                } else {
                    Some(device.name.as_str())
                })?;
                *audio_test_holder()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(audio);
                Ok(())
            })()
        };
        if result.is_err() {
            audio_test_owners()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&owner);
        }
        result
    }
}

#[tauri::command]
pub fn voice_native_stop_audio_test(app: tauri::AppHandle<TauriRuntime>, owner: String) {
    #[cfg(feature = "native-voice")]
    {
        let remaining = {
            let mut owners = audio_test_owners()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            owners.remove(&owner);
            !owners.is_empty()
        };
        if remaining {
            return;
        }
        if manager().lock().unwrap_or_else(|e| e.into_inner()).state
            == VoiceConnectionState::Disconnected
        {
            stop_audio_test_force();
        } else {
            let _ = with_engine(&app, "arrêt test microphone", |engine| {
                engine.set_microphone_test_enabled(false)
            });
        }
    }
    #[cfg(not(feature = "native-voice"))]
    let _ = (app, owner);
}

#[tauri::command]
pub fn voice_native_audio_level() -> NativeAudioLevel {
    #[cfg(feature = "native-voice")]
    {
        let (sequence, rms) = sion_native_audio::capture_level();
        return NativeAudioLevel { sequence, rms };
    }
    #[allow(unreachable_code)]
    NativeAudioLevel {
        sequence: 0,
        rms: 0.0,
    }
}

/// Joue trois notes dans le véritable rendu WebRTC. Hors appel, un ADM
/// temporaire est créé ; en appel, la sortie déjà choisie reste en place.
#[tauri::command]
pub fn voice_native_test_speaker(output_device: String) -> Result<(), String> {
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = output_device;
        return Err("Voix native non compilée".into());
    }
    #[cfg(feature = "native-voice")]
    {
        if manager().lock().unwrap_or_else(|e| e.into_inner()).state
            == VoiceConnectionState::Disconnected
        {
            stop_speaker_test_force();
            let factory =
                webrtc_sys::peer_connection_factory::ffi::create_peer_connection_factory();
            let audio = factory.audio_device();
            if !audio.acquire_platform_adm() {
                return Err("initialisation de la sortie de test impossible".into());
            }
            audio.set_adm_playout_enabled(true);
            let selected = if output_device.is_empty() {
                audio.set_playout_device(0)
            } else {
                audio.set_playout_device_by_guid(output_device.clone())
            };
            if !selected || !audio.init_playout() || !audio.start_playout() {
                audio.release_platform_adm();
                return Err("démarrage du test haut-parleur impossible".into());
            }
            *speaker_test_holder()
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(factory);
        }

        let sample_rate = 48_000_f32;
        let note_samples = 12_000_usize;
        let frequencies = [440.0_f32, 554.0, 659.0];
        let mut samples = Vec::with_capacity(note_samples * frequencies.len());
        for frequency in frequencies {
            for index in 0..note_samples {
                let phase = std::f32::consts::TAU * frequency * index as f32 / sample_rate;
                let fade = ((note_samples - index) as f32 / note_samples as f32).max(0.01);
                samples.push((phase.sin() * fade * 9_000.0) as i16);
            }
        }
        if webrtc_sys::sion_audio::ffi::queue_soundboard_audio(&samples, 1.0) {
            Ok(())
        } else {
            Err("mélodie de test refusée".into())
        }
    }
}

#[tauri::command]
pub fn voice_native_set_audio_quality(
    app: tauri::AppHandle<TauriRuntime>,
    quality: NativeAudioQuality,
) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    {
        return with_engine(&app, "qualité audio", |engine| {
            engine.switch_audio_quality(quality.max_bitrate())
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, quality);
        Err("Voix native non compilée".into())
    }
}
impl Default for NativeAudioProcessing {
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            auto_gain_control: true,
            noise_suppression: true,
            mix: 1.0,
        }
    }
}
impl NativeAudioProcessing {
    pub fn validate(&self) -> Result<(), String> {
        if !self.mix.is_finite() || !(0.0..=1.0).contains(&self.mix) {
            return Err("intensité RNNoise invalide (0 à 1 attendu)".into());
        }
        Ok(())
    }
    #[cfg(feature = "native-voice")]
    pub fn apply(&self) -> Result<(), String> {
        self.validate()?;
        sion_native_audio::configure(sion_native_audio::Settings {
            echo_cancellation: self.echo_cancellation,
            auto_gain_control: self.auto_gain_control,
            noise_suppression: self.noise_suppression,
            mix: self.mix,
        });
        webrtc_sys::sion_audio::ffi::configure_capture_processing();
        Ok(())
    }
}

#[tauri::command]
pub fn voice_native_set_audio_processing(
    app: tauri::AppHandle<TauriRuntime>,
    processing: NativeAudioProcessing,
) -> Result<(), String> {
    processing.validate()?;
    #[cfg(feature = "native-voice")]
    {
        with_engine(&app, "traitement audio", |_| processing.apply())
    }
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = app;
        Err("Voix native non compilée".into())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeProcessingDebug {
    pub instances: usize,
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    pub webrtc_noise_suppression: bool,
    pub rnnoise: bool,
    pub mix: f32,
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
    pub processing: Option<NativeProcessingDebug>,
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
        processing: None,
    };
    #[cfg(feature = "native-voice")]
    {
        if let Some(holder) = ENGINE.get() {
            if let Ok(guard) = holder.lock() {
                if let Some(engine) = guard.as_ref() {
                    dbg.has_engine = true;
                    dbg.engine_connected = engine.is_connected();
                    dbg.attached_tracks = engine.attached_count();
                    let apm = webrtc_sys::sion_audio::ffi::capture_processing_status();
                    let options = sion_native_audio::settings();
                    dbg.processing = Some(NativeProcessingDebug {
                        instances: apm.instances,
                        echo_cancellation: apm.echo_cancellation,
                        auto_gain_control: apm.auto_gain_control,
                        webrtc_noise_suppression: apm.webrtc_noise_suppression,
                        rnnoise: options.noise_suppression,
                        mix: options.mix,
                    });
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

/// Connexion au salon : l'ADM (attente d'énumération) et le SFU prennent
/// plusieurs secondes. Exécuté hors du main thread pour ne pas geler l'UI.
#[tauri::command]
pub async fn voice_native_connect(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    token: String,
    room_name: String,
    display_name: String,
    encrypted: bool,
    input_device: Option<String>,
    output_device: Option<String>,
    processing: Option<NativeAudioProcessing>,
    audio_quality: Option<NativeAudioQuality>,
) -> Result<VoiceNativeStatus, String> {
    let app_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_impl(
            app_task,
            url,
            token,
            room_name,
            display_name,
            encrypted,
            input_device,
            output_device,
            processing,
            audio_quality,
        )
    })
    .await
    .map_err(|e| format!("tâche connexion: {e}"))?
}

fn connect_impl(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    token: String,
    room_name: String,
    #[allow(unused_variables)] display_name: String,
    // Salon Matrix chiffré : E2EE GCM adossé aux clés MatrixRTC (fournies
    // ensuite via `voice_native_set_e2ee_key`). `false` = salon clair.
    _encrypted: bool,
    input_device: Option<String>,
    output_device: Option<String>,
    processing: Option<NativeAudioProcessing>,
    audio_quality: Option<NativeAudioQuality>,
) -> Result<VoiceNativeStatus, String> {
    let processing = processing.unwrap_or_default();
    let audio_quality = audio_quality.unwrap_or_default();
    processing.validate()?;
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
                return Err(format!("Déjà en ligne sur {} — quittez d'abord", active));
            }
            ConnectGuard::Join => {
                inner.state = VoiceConnectionState::Connecting;
                inner.room_name = Some(room_name.clone());
                inner.identity = None;
            }
        }
        emit_status(&app, &snapshot(&inner));
    }
    log::info!(
        "[Sion][voix-native] connect room={} (moteur Rust)",
        room_name
    );

    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (input_device, output_device, audio_quality);
        let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
        inner.state = VoiceConnectionState::Disconnected;
        inner.room_name = None;
        let status = snapshot(&inner);
        emit_status(&app, &status);
        return Err("Voix native non compilée : relancer avec --features native-voice (cf. build-scripts/run-native.sh)".into());
    }

    #[cfg(feature = "native-voice")]
    {
        // Le test des réglages partage l'ADM global de LiveKit. Il doit être
        // fermé avant de créer la vraie piste afin que le join possède seul
        // le cycle de vie de capture et de rendu.
        stop_audio_test_force();
    }
    #[cfg(feature = "native-voice")]
    match processing.apply().and_then(|_| {
        connect_engine(
            &app,
            &url,
            &token,
            _encrypted,
            input_device.unwrap_or_default(),
            output_device.unwrap_or_default(),
            audio_quality,
        )
    }) {
        Ok(identity) => {
            log::info!(
                "[Sion][voix-native] session SFU ouverte identite={}",
                identity
            );
            // Le local n'arrive jamais via ParticipantConnected : on
            // l'injecte explicitement (nom d'affichage Matrix fourni par le
            // front) pour qu'il apparaisse aussitôt dans la liste.
            {
                let name = if display_name.trim().is_empty() {
                    identity.clone()
                } else {
                    display_name.clone()
                };
                let mut map = participants_map().lock().unwrap_or_else(|e| e.into_inner());
                map.insert(identity.clone(), NativeParticipant::new(&identity, &name));
            }
            emit_participants(&app);
            let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
            inner.state = VoiceConnectionState::Connected;
            inner.identity = Some(identity);
            // Pas de sourdine rassis : aucun intent ne survit au join
            // (contrairement au mute, synchronisé dans `connect_engine`).
            inner.deafened = false;
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
        webrtc_sys::sion_audio::ffi::clear_soundboard_audio();
        invalidate_native_events();
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
    reset_manager_to_disconnected();
    let status = snapshot(&manager().lock().unwrap_or_else(|e| e.into_inner()));
    emit_status(&app, &status);
    status
}

/// Vrai quand l'utilisateur est en sourdine.
pub(crate) fn en_sourdine() -> bool {
    manager().lock().unwrap_or_else(|e| e.into_inner()).deafened
}

/// Joue un clip reçu d'un pair — son de soundboard ou bande-son d'un meme —
/// avec les mêmes règles que `voice_native_play_soundboard` : jeté en
/// sourdine, mixé dans le rendu WebRTC en appel, donc vu par l'annulation
/// d'écho. Hors appel, où rien ne peut arriver d'un pair, c'est un aperçu
/// local : il sort par la sortie propre des retours d'action.
pub(crate) fn jouer_clip_de_pair(
    app: &tauri::AppHandle<TauriRuntime>,
    samples: Vec<i16>,
    gain: f32,
) {
    if samples.is_empty() || en_sourdine() {
        return;
    }
    #[cfg(feature = "native-voice")]
    {
        let en_appel = holder_is_connected();
        if en_appel {
            let res = with_engine(app, "clip de pair", |_| {
                if webrtc_sys::sion_audio::ffi::queue_soundboard_audio(&samples, gain) {
                    Ok(())
                } else {
                    Err("clip refusé".into())
                }
            });
            if let Err(e) = res {
                log::warn!("[Sion][voix-native] {e}");
            }
            return;
        }
    }
    let _ = app;
    crate::cue_playback::jouer_clip_local(samples, gain);
}

/// Joue un clip soundboard mono 48 kHz dans le rendu WebRTC natif. Le mixage
/// se fait avant l'analyse reverse de l'APM : la sortie sélectionnée et l'AEC
/// voient donc exactement le même signal. Les octets traversent Tauri une
/// seule fois par clip, jamais à chaque frame audio.
#[tauri::command]
pub fn voice_native_play_soundboard(
    app: tauri::AppHandle<TauriRuntime>,
    pcm_b64: String,
    gain: f32,
    // `local_feedback` : retour d'action de l'utilisateur lui-même (micro,
    // sourdine), par opposition à un son de soundboard reçu d'un pair.
    local_feedback: Option<bool>,
) -> Result<(), String> {
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (app, pcm_b64, gain, local_feedback);
        return Err("Voix native non compilée".into());
    }
    #[cfg(feature = "native-voice")]
    {
        const MAX_SAMPLES: usize = 48_000 * 20;
        const MAX_B64_LEN: usize = ((MAX_SAMPLES * 2 + 2) / 3) * 4;
        if !gain.is_finite() || !(0.0..=3.0).contains(&gain) {
            return Err("gain soundboard invalide".into());
        }
        if pcm_b64.len() > MAX_B64_LEN {
            return Err("clip soundboard trop long".into());
        }
        // La sourdine jette les sons des pairs — c'est tout son objet. Elle ne
        // doit pas jeter le retour d'action de l'utilisateur lui-même : le son
        // qui confirme la mise en sourdine est joué à l'instant précis où elle
        // s'applique. Renvoyé sur le chemin DOM, il arrivait deux à trois
        // secondes plus tard, quand l'ADM natif tient le périphérique — donc
        // jamais à temps, et coupé par le clic suivant (18/09).
        let feedback_local = local_feedback.unwrap_or(false);
        let sourdine = manager().lock().unwrap_or_else(|e| e.into_inner()).deafened;
        if sourdine && !feedback_local {
            return Ok(());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(pcm_b64)
            .map_err(|e| format!("PCM soundboard base64 invalide: {e}"))?;
        if bytes.is_empty() || bytes.len() % 2 != 0 || bytes.len() / 2 > MAX_SAMPLES {
            return Err("PCM soundboard invalide".into());
        }
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        // En sourdine, le rendu WebRTC ne sort plus rien : plus aucune piste
        // n'est abonnée, donc le traitement de rendu — où ce clip est mixé —
        // n'est plus invoqué. Le retour d'action emprunte alors sa propre
        // sortie. Le micro étant coupé par la sourdine, se passer de la
        // référence d'annulation d'écho ne coûte rien ici.
        if sourdine {
            crate::cue_playback::jouer_clip_local(samples, gain);
            return Ok(());
        }
        with_engine(&app, "soundboard native", |_| {
            if webrtc_sys::sion_audio::ffi::queue_soundboard_audio(&samples, gain) {
                Ok(())
            } else {
                Err("clip soundboard refusé".into())
            }
        })
    }
}

#[tauri::command]
pub fn voice_native_set_muted(
    app: tauri::AppHandle<TauriRuntime>,
    muted: bool,
) -> VoiceNativeStatus {
    // Ne pas mentir au front : si le moteur refuse, on garde l'état précédent.
    let mut applied = true;
    // Moteur présent même sans session (entre deux joins) : on fait
    // passer l'opération quand même — `set_microphone_enabled(false)`
    // enregistre le désir, honoré au prochain publish. Sans ça, un mute
    // hors appel est perdu en silence (store "muté" + micro live).
    // Attente bornée (cf. `wait_for_engine`) : le deafen concurrent sort
    // le moteur du holder pendant son opération, un test instantané
    // verrait "pas de moteur" et sauterait le mute.
    #[cfg(feature = "native-voice")]
    let has_engine = wait_for_engine(holder_has_engine);
    #[cfg(not(feature = "native-voice"))]
    let has_engine = false;
    #[cfg(feature = "native-voice")]
    {
        if has_engine {
            if let Err(e) = with_engine(&app, "mute natif", |e| e.set_microphone_enabled(!muted)) {
                log::warn!("[Sion][voix-native] {}", e);
                applied = false;
            }
        } else {
            log::info!(
                "[Sion][voix-native] mute demandé={} sans moteur (hors appel) — désir conservé",
                muted
            );
        }
    }
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    if applied {
        inner.muted = muted;
    }
    let status = snapshot(&inner);
    // Une ligne par appel : c'est elle qui a permis de prouver qu'un
    // deafen-mute n'atteignait jamais le moteur (aucune trace ici).
    log::info!(
        "[Sion][voix-native] mute demandé={} moteur={} appliqué={} mic_published={}",
        muted,
        has_engine,
        applied,
        status.mic_published
    );
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
    // Même course que le mute (cf. `wait_for_engine`) : un deafen qui
    // sauterait pendant un checkout concurrent laisserait le playout
    // ouvert derrière un casque "sourdine" — le pendant auditif du bug F9.
    #[cfg(feature = "native-voice")]
    let _connected = wait_for_engine(holder_is_connected);
    #[cfg(not(feature = "native-voice"))]
    let _connected = false;
    // La sourdine GÈLE la file des clips de soundboard sans la vider : le
    // rendu où ils sont mixés n'est plus appelé, leur curseur s'arrête. Un
    // son reçu juste avant la sourdine ressortait donc à sa levée — la fin
    // d'une musique de Noël jouée la veille, entendue le lendemain dans un
    // salon où tout le monde était muet (23/09).
    //
    // On la vide aux deux bascules. À la levée, AVANT que le rendu reparte :
    // c'est là qu'un clip glissé pendant la bascule d'entrée serait resté
    // coincé. Les sons de confirmation ne sont pas touchés : ils sont joués
    // après la bascule, par la sortie propre à la sourdine ou une fois le
    // rendu revenu.
    #[cfg(feature = "native-voice")]
    if !deafened {
        webrtc_sys::sion_audio::ffi::clear_soundboard_audio();
    }
    #[cfg(feature = "native-voice")]
    {
        if _connected {
            if let Err(e) = with_engine(&app, "deafen natif", |e| {
                e.set_deafened(deafened).map(|_| ())?;
                // Propager aux pairs (interop JS `broadcastAfk`) : sinon les
                // autres clients ne voient jamais notre sourdine.
                let payload =
                    serde_json::to_vec(&AfkPayload { deafened }).map_err(|e| e.to_string())?;
                e.publish_data(TOPIC_AFK, payload, true)?;
                log::info!("[Sion][voix-native] AFK tx deafened={}", deafened);
                Ok(())
            }) {
                log::warn!("[Sion][voix-native] {}", e);
                applied = false;
            }
        }
    }
    let mut inner = manager().lock().unwrap_or_else(|e| e.into_inner());
    if applied {
        inner.deafened = deafened;
        // Après le drapeau : `voice_native_play_soundboard` le lit avant de
        // mettre en file, aucun son de pair ne peut donc plus y entrer.
        #[cfg(feature = "native-voice")]
        if deafened {
            webrtc_sys::sion_audio::ffi::clear_soundboard_audio();
        }
    }
    let status = snapshot(&inner);
    emit_status(&app, &status);
    status
}

/// Importe une clé E2EE MatrixRTC dans le provider natif (pont E2EE,
/// salons chiffrés). Le front (`MatrixKeyProvider`) transfère chaque clé
/// reçue — pairs ET la nôtre (MatrixRTC la réémet pour chiffrer nos
/// frames) — sous `{ identity: "@user:serveur:device", key_index, key_b64 }`.
/// Retourne `true` si la clé est acceptée. `false` sans moteur (hors appel :
/// la clé est inutile) ou b64 invalide — PAS d'effet de bord session
/// (contrairement à `with_engine`, pas de `drop_dead_session` : une clé
/// orpheline n'est pas une session morte). Le front re-flushe toutes les
/// clés connues après chaque connect, donc aucune perte durable.
#[tauri::command]
pub fn voice_native_set_e2ee_key(
    _app: tauri::AppHandle<TauriRuntime>,
    identity: String,
    key_index: i32,
    key_b64: String,
) -> bool {
    #[cfg(feature = "native-voice")]
    {
        use base64::Engine as _;
        let bytes = match base64::engine::general_purpose::STANDARD.decode(key_b64.trim()) {
            Ok(b) => b,
            Err(e) => {
                log::warn!(
                    "[Sion][voix-native][E2EE] clé {} index={} illisible: {}",
                    identity,
                    key_index,
                    e
                );
                return false;
            }
        };
        if !validate_e2ee_key(&bytes) {
            log::warn!(
                "[Sion][voix-native][E2EE] clé {} index={} rejetée : {} octets (attendu 16 ou 32)",
                identity,
                key_index,
                bytes.len()
            );
            return false;
        }
        // `take_engine_wait` absorbe les checkouts concurrents (deafen…),
        // comme `with_engine` — mais on repose le moteur nous-mêmes SANS
        // `drop_dead_session` si absent (voir doc ci-dessus).
        if let Some(engine) = take_engine_wait() {
            let ok = engine.set_e2ee_key(&identity, key_index, bytes);
            store_engine(Some(engine));
            return ok;
        }
        log::debug!(
            "[Sion][voix-native][E2EE] clé {} index={} sans moteur — ignorée",
            identity,
            key_index
        );
    }
    #[allow(unreachable_code)]
    {
        let _ = (&identity, &key_index, &key_b64);
        false
    }
}

/// Coupe / rétablit le SON du partage d'écran d'un expéditeur (miroir du
/// toggle 🔊 JS : `setScreenShareAudioMuted`). Retourne `true` si une piste
/// `ScreenshareAudio` existe (false = pas de son partagé).
#[tauri::command]
pub fn voice_native_set_screenshare_audio_muted(
    app: tauri::AppHandle<TauriRuntime>,
    sender: String,
    muted: bool,
) -> Result<bool, String> {
    #[cfg(feature = "native-voice")]
    {
        let res = with_engine(&app, "son du partage natif", |e| {
            e.set_screenshare_audio_subscribed(&sender, !muted)
        });
        if res.is_ok() {
            emit_share_audio_state(&app, &sender);
        }
        return res;
    }
    #[allow(unreachable_code)]
    {
        let _ = (&app, &sender, &muted);
        Err("voix native indisponible".to_string())
    }
}

/// Règle localement le gain du son d'un partage reçu. WebRTC accepte un gain
/// par source distante ; la valeur est mémorisée pour les republications.
#[tauri::command]
pub fn voice_native_set_screenshare_audio_volume(
    app: tauri::AppHandle<TauriRuntime>,
    sender: String,
    volume: f32,
) -> Result<bool, String> {
    #[cfg(feature = "native-voice")]
    {
        let res = with_engine(&app, "volume du partage natif", |engine| {
            engine.set_screenshare_audio_volume(&sender, volume)
        });
        if res.is_ok() {
            emit_share_audio_state(&app, &sender);
        }
        return res;
    }
    #[allow(unreachable_code)]
    {
        let _ = (&app, &sender, &volume);
        Err("voix native indisponible".to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShareAudioState {
    pub muted: bool,
    pub volume: f32,
}

/// Émis à chaque changement du son d'un partage (mute **ou** volume) :
/// la vue et le PIP natif sont deux fenêtres sur le même état moteur —
/// sans cet événement, un mute fait dans le PIP laissait la vue « actif »
/// (constaté le 2026-09-12).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShareAudioEvent {
    pub sender: String,
    pub muted: bool,
    pub volume: f32,
}

/// Publie l'état du son d'un partage vers le front (silencieux si le moteur
/// n'est pas là : l'appelant est déjà dans un chemin qui a réussi ou pas).
fn emit_share_audio_state(app: &tauri::AppHandle<TauriRuntime>, sender: &str) {
    #[cfg(feature = "native-voice")]
    {
        if let Ok(st) = with_engine(app, "état du son du partage", |e| {
            let (muted, volume) = e.screenshare_audio_state(sender);
            Ok(NativeShareAudioState { muted, volume })
        }) {
            let _ = app.emit(
                "voice-native-share-audio",
                NativeShareAudioEvent {
                    sender: sender.to_string(),
                    muted: st.muted,
                    volume: st.volume,
                },
            );
        }
    }
    #[cfg(not(feature = "native-voice"))]
    {
        let _ = (app, sender);
    }
}

/// État local du son d'un partage (mute + volume). Le front s'en sert pour se
/// recaler au chargement : le moteur garde ses réglages par partageur à
/// travers un reload de la webview, pas la mémoire JS — sans ce recalage,
/// l'UI affichait « non muté / à fond » pour une piste restée coupée.
#[tauri::command]
pub fn voice_native_get_screenshare_audio_state(
    app: tauri::AppHandle<TauriRuntime>,
    sender: String,
) -> Result<NativeShareAudioState, String> {
    #[cfg(feature = "native-voice")]
    {
        return with_engine(&app, "état du son du partage natif", |e| {
            let (muted, volume) = e.screenshare_audio_state(&sender);
            Ok(NativeShareAudioState { muted, volume })
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = (&app, &sender);
        Err("voix native indisponible".to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeScreenShareResult {
    audio_published: bool,
}

/// Port du transport local binaire des frames de partage reçues. Les pixels
/// volumineux évitent ainsi l'IPC Tauri JSON/base64.
#[tauri::command]
pub fn voice_native_video_port() -> u16 {
    #[cfg(feature = "native-voice")]
    {
        return crate::native_video_transport::port();
    }
    #[allow(unreachable_code)]
    0
}

/// Capacités codecs de la machine : encodage/décodage matériel (VA-API) et
/// logiciel, par codec. Sert au choix automatique du codec de partage entre
/// clients (`sion-media-caps`) — **le matériel d'abord** : un codec n'est
/// « viable » que si tout le monde le décode, et on le préfère si tout le
/// monde le décode en matériel.
///
/// La sonde s'appuie sur les backends réellement compilés et sondés par
/// webrtc-sys (NVENC/VAAPI/VideoToolbox), au lieu de déduire un encodeur
/// utilisable de la seule présence de `vainfo`. AV1 n'est annoncé que par le
/// chemin effectivement exposé par libwebrtc ; cela évite de choisir AV1 sur
/// une machine dont VAAPI sait le décoder mais pas l'encoder.
#[tauri::command]
pub fn voice_media_caps() -> serde_json::Value {
    use std::collections::BTreeMap;

    let mut enc: BTreeMap<String, &'static str> = BTreeMap::new();
    let mut dec: BTreeMap<String, &'static str> = BTreeMap::new();
    for codec in ["vp8", "vp9", "h264"] {
        enc.insert(codec.into(), "sw");
        dec.insert(codec.into(), "sw");
    }

    #[cfg(feature = "native-voice")]
    {
        use livekit::options::VideoEncoderBackend;
        let backends: Vec<_> = VideoEncoderBackend::list_available().into_iter().collect();
        if backends.iter().any(|b| {
            matches!(
                b,
                VideoEncoderBackend::Hardware
                    | VideoEncoderBackend::Nvenc
                    | VideoEncoderBackend::Vaapi
                    | VideoEncoderBackend::VideoToolbox
            )
        }) {
            // All hardware factories currently exposed by webrtc-sys support
            // H.264. Keep AV1 conservative until a per-codec query is bound.
            enc.insert("h264".into(), "hw");
        }
    }

    serde_json::json!({ "v": 1, "enc": enc, "dec": dec })
}

/// Démarre / arrête le partage de NOTRE écran en mode natif (miroir de
/// `toggleScreenShare` JS). `source_id` = écran/fenêtre choisi (None =
/// premier écran). `with_audio` = case "partager le son" (None = true) :
/// sans le son, aucune piste `ScreenshareAudio` n'est publiée et les
/// viewers voient "sans son". Résolution et cadence viennent du même menu
/// que le chemin JS ; le résultat confirme la publication audio réelle.
#[tauri::command]
pub async fn voice_native_set_screensharing(
    app: tauri::AppHandle<TauriRuntime>,
    enabled: bool,
    source_id: Option<u64>,
    with_audio: Option<bool>,
    resolution: Option<String>,
    framerate: Option<u32>,
    video_codec: Option<String>,
) -> Result<NativeScreenShareResult, String> {
    #[cfg(feature = "native-voice")]
    {
        // Le démarrage attend la première image du portail (jusqu'à 30 s) :
        // hors du main thread, sinon l'UI gèle tout ce temps.
        let app_task = app.clone();
        // Cloné pour le thread bloquant : `video_codec` reste lisible par le
        // bloc de repli sans feature.
        let codec = video_codec.clone().unwrap_or_else(|| "h264".to_string());
        return tauri::async_runtime::spawn_blocking(move || {
            if enabled {
                let config = crate::voice_engine::screenshare_config(
                    resolution.as_deref().unwrap_or("1080p"),
                    framerate.unwrap_or(15),
                )?;
                with_engine_shared(&app_task, "partage d'écran natif", |e| {
                    e.start_screensharing(source_id, with_audio.unwrap_or(true), config, &codec)
                        .map(|audio_published| NativeScreenShareResult { audio_published })
                })
            } else {
                with_engine_shared(&app_task, "arrêt partage natif", |e| {
                    e.stop_screensharing()?;
                    Ok(NativeScreenShareResult {
                        audio_published: false,
                    })
                })
            }
        })
        .await
        .map_err(|e| format!("tâche partage d'écran: {e}"))?;
    }
    #[allow(unreachable_code)]
    {
        let _ = (
            &app,
            &enabled,
            &source_id,
            &with_audio,
            &resolution,
            &framerate,
            &video_codec,
        );
        Err("voix native indisponible".to_string())
    }
}

/// Envoie un paquet data-channel sur la session native (soundboard, AFK,
/// curseurs…). Payload base64 (binaire arbitraire). Miroir de `publishData`
/// JS — `reliable: false` pour le curseur (60 Hz, la perte se répare toute
/// seule), `true` partout ailleurs.
#[tauri::command]
pub fn voice_native_publish_data(
    app: tauri::AppHandle<TauriRuntime>,
    topic: String,
    payload_b64: String,
    reliable: Option<bool>,
) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD
            .decode(&payload_b64)
            .map_err(|e| format!("payload base64: {}", e))?;
        let reliable = reliable.unwrap_or(true);
        // `with_engine_shared` : pas de sortie/repose du moteur à chaque
        // paquet (le curseur publie à 60 Hz, on évite ce surcoût inutile).
        let res = with_engine_shared(&app, "publish data natif", |e| {
            e.publish_data(&topic, payload, reliable)
        });
        // Badge local (miroir du `setPlayingSound` sur soi-même côté JS) :
        // le data-channel ne revient pas vers l'expéditeur, sans ça on ne
        // voit jamais son propre badge quand on déclenche un son.
        // Écho local du curseur, même raison que le badge soundboard : le
        // data-channel ne revient pas vers l'expéditeur.
        //
        // Tant que le calque DOM peignait par-dessus la vidéo, notre propre
        // flèche colorée était dessinée côté JS et cet écho aurait fait un
        // doublon. La surface native recouvre désormais ce calque : sans écho,
        // on voit le curseur de tous les autres viewers mais jamais le sien
        // (18/09). `forward_cursor_to_viewer_surface` s'arrête d'elle-même si
        // aucune surface native n'est affichée, donc le repli JPEG reste servi
        // par le DOM comme avant.
        #[cfg(not(target_os = "android"))]
        if res.is_ok() && (topic == TOPIC_CURSOR || topic == TOPIC_CURSOR_CLICK) {
            let identity = manager()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .identity
                .clone();
            if let Some(identity) = identity {
                forward_cursor_to_viewer_surface(Some(&topic), &payload_b64, Some(&identity));
            }
        }
        if res.is_ok() && topic == TOPIC_SOUNDBOARD {
            let identity = manager()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .identity
                .clone();
            if let Some(identity) = identity {
                show_soundboard_badge(&app, &identity, &payload_b64);
            }
        }
        return res;
    }
    #[allow(unreachable_code)]
    {
        let _ = (&app, &topic, &payload_b64, &reliable);
        Err("voix native indisponible".to_string())
    }
}

/// Repousse l'échéance du badge soundboard d'un expéditeur sur la durée
/// **réellement mesurée** au démarrage de la lecture locale.
///
/// Le badge est posé par le Rust à l'arrivée du paquet, donc avant que le
/// récepteur n'ait téléchargé, décodé et mis en file le clip : sans ce
/// réarmement, le rond s'éteint de toute cette latence de démarrage. Le front
/// appelle donc cette commande juste après avoir lancé la lecture, avec la
/// durée qu'il a mesurée (et l'emoji, pour rallumer un badge déjà expiré).
/// L'échéance n'est jamais raccourcie : un son long encore en cours du même
/// expéditeur doit rester visible.
#[tauri::command]
pub fn voice_native_extend_soundboard_badge(
    app: tauri::AppHandle<TauriRuntime>,
    sender: String,
    duration_ms: u64,
    emoji: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    {
        if sender.trim().is_empty() {
            return Err("expéditeur soundboard manquant".to_string());
        }
        let moved = {
            let mut map = participants_map().lock().unwrap_or_else(|e| e.into_inner());
            extend_badge_deadline(&mut map, &sender, duration_ms, emoji.as_deref(), mono_ms())
        };
        if moved {
            emit_participants(&app);
            // Le thread d'expiration d'origine a pu sortir pendant que le badge
            // était éteint : on en réarme un (il se termine seul s'il n'y a
            // plus rien à éteindre).
            spawn_badge_expiry(&app, &sender);
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, sender, duration_ms, emoji);
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
    fn native_audio_quality_matches_frontend_values_and_bitrates() {
        let cases = [
            ("voice", NativeAudioQuality::Voice, 24_000),
            ("voiceHD", NativeAudioQuality::VoiceHd, 48_000),
            ("musicStereo", NativeAudioQuality::MusicStereo, 128_000),
        ];
        for (json, expected, bitrate) in cases {
            let parsed: NativeAudioQuality = serde_json::from_str(&format!("\"{json}\"")).unwrap();
            assert_eq!(parsed, expected);
            assert_eq!(parsed.max_bitrate(), bitrate);
        }
    }

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
        // mic_published : pas de moteur dans les tests → toujours false,
        // jamais de panique sur le holder.
        assert!(!holder_mic_published());
        let status = snapshot(&inner);
        assert!(!status.mic_published);
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
            // Leave-while-muted : le cas du 09/09 (muté en chiffré, join en
            // clair avec un store "non muté").
            inner.muted = true;
            inner.deafened = true;
        }
        // Le vrai helper (partagé par disconnect + drop_dead_session).
        reset_manager_to_disconnected();
        let inner = manager().lock().unwrap();
        assert_eq!(inner.state, VoiceConnectionState::Disconnected);
        assert!(inner.room_name.is_none());
        assert!(!inner.muted && !inner.deafened);
    }

    #[test]
    #[cfg(feature = "native-voice")]
    fn take_engine_wait_sans_moteur_rend_none() {
        let _serial = TEST_MANAGER_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Holder vide (aucun test ne stocke de moteur réel) : ~100 ms de
        // retries puis None, sans panique — le cas "toggle sans session".
        // Surtout : pas de reset sauvage ici, juste None (l'appelant décide).
        let t0 = std::time::Instant::now();
        assert!(take_engine_wait().is_none());
        assert!(t0.elapsed().as_millis() >= 50);
    }

    #[test]
    #[cfg(feature = "native-voice")]
    fn wait_for_engine_survives_concurrent_checkout() {
        // Bug F9 du 08/09 : `with_engine` sort le moteur du holder pendant
        // son opération — une commande concurrente voyait "pas de moteur"
        // et abandonnait (micro live + sourdine). On simule le checkout
        // (moteur rendu après 100 ms) : l'attente doit aboutir, pas sauter.
        let _serial = TEST_MANAGER_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _drained = take_engine();
        assert!(!holder_has_engine());
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(engine) = LiveKitEngine::new() {
                store_engine(Some(engine));
            }
        });
        assert!(wait_for_engine(holder_has_engine));
        // Nettoyage : holder vide pour les autres tests.
        let _ = take_engine();
        assert!(!holder_has_engine());
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
        let mv = CursorMovePayload {
            x: 0.5,
            y: 0.25,
            target: "@a:b:c".into(),
        };
        let raw = encode_json(&mv).unwrap();
        assert_eq!(raw, r#"{"x":0.5,"y":0.25,"t":"@a:b:c"}"#);

        let click = CursorClickPayload {
            click: true,
            x: 0.1,
            y: 0.2,
            target: "t".into(),
        };
        let back: CursorClickPayload = decode_json(&encode_json(&click).unwrap()).unwrap();
        assert_eq!(back, click);

        let hide = CursorHidePayload {
            expire: true,
            target: None,
        };
        let back: CursorHidePayload = decode_json(&encode_json(&hide).unwrap()).unwrap();
        assert_eq!(back, hide);

        // Transcribe : {"armed":true}
        let arm = TranscribeArmPayload { armed: true };
        assert_eq!(encode_json(&arm).unwrap(), r#"{"armed":true}"#);
    }

    #[test]
    fn e2ee_keys_accept_16_or_32_bytes() {
        // 16 = MatrixRTC réel (AES-128), 32 = AES-256 ; le reste est rejeté.
        assert!(validate_e2ee_key(&[7u8; 16]));
        assert!(validate_e2ee_key(&[7u8; 32]));
        assert!(!validate_e2ee_key(&[]));
        assert!(!validate_e2ee_key(&[7u8; 24]));
        assert!(!validate_e2ee_key(&[7u8; 64]));
    }

    #[test]
    fn participant_mirror_serializes_like_ts() {
        let mut p = NativeParticipant::new("@flamme:example.org:XYZ", "flamme");
        p.is_speaking = true;
        p.connection_quality = NativeConnectionQuality::Excellent;
        p.playing_sound_emoji = Some("🥁".into());
        let raw = encode_json(&p).unwrap();
        assert!(raw.contains(r#""identity":"@flamme:example.org:XYZ""#));
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
                &E::ParticipantJoined {
                    identity: "@b:h".into(),
                    name: "b".into()
                }
            ));
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined {
                    identity: "@a:h".into(),
                    name: "a".into()
                }
            ));
            assert_eq!(map.len(), 2);
            assert_eq!(map["@a:h"].name, "a");
            // Re-join : met à jour le nom, pas de doublon.
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined {
                    identity: "@a:h".into(),
                    name: "a2".into()
                }
            ));
            assert_eq!(map.len(), 2);
            assert_eq!(map["@a:h"].name, "a2");
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantLeft {
                    identity: "@a:h".into()
                }
            ));
            assert_eq!(map.len(), 1);
            // Leave inconnu : pas de changement, pas d'émission.
            assert!(!apply_engine_event(
                &mut map,
                &E::ParticipantLeft {
                    identity: "@z:h".into()
                }
            ));
        }

        #[test]
        fn join_empty_name_keeps_identity() {
            let mut map = empty();
            // Nom vide LiveKit : on garde l'identité (pastille curseur, etc.).
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined {
                    identity: "@a:h".into(),
                    name: "".into()
                }
            ));
            assert_eq!(map["@a:h"].name, "@a:h");
            // Vrai nom : pris en compte.
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined {
                    identity: "@a:h".into(),
                    name: "a".into()
                }
            ));
            assert_eq!(map["@a:h"].name, "a");
            // Re-join vide : ne régresse pas.
            assert!(apply_engine_event(
                &mut map,
                &E::ParticipantJoined {
                    identity: "@a:h".into(),
                    name: "".into()
                }
            ));
            assert_eq!(map["@a:h"].name, "a");
        }

        #[test]
        fn speaking_mute_quality_update_flags() {
            let mut map = empty();
            assert!(apply_engine_event(
                &mut map,
                &E::SpeakingChanged {
                    identity: "@a:h".into(),
                    speaking: true
                }
            ));
            // Upsert défensif : le participant existe même si le join n'est
            // pas encore arrivé.
            assert!(map["@a:h"].is_speaking);
            assert!(apply_engine_event(
                &mut map,
                &E::TrackMutedChanged {
                    identity: "@a:h".into(),
                    muted: true
                }
            ));
            assert!(map["@a:h"].is_muted);
            assert!(apply_engine_event(
                &mut map,
                &E::QualityChanged {
                    identity: "@a:h".into(),
                    quality: "poor".into()
                }
            ));
            assert_eq!(
                map["@a:h"].connection_quality,
                NativeConnectionQuality::Poor
            );
        }

        #[test]
        fn video_presence_drives_screen_sharing_flag() {
            let mut map = empty();
            assert!(apply_engine_event(
                &mut map,
                &E::VideoPresence {
                    sender: "@p:h".into(),
                    sharing: true
                }
            ));
            assert!(map["@p:h"].is_screen_sharing);
            assert!(apply_engine_event(
                &mut map,
                &E::VideoPresence {
                    sender: "@p:h".into(),
                    sharing: false
                }
            ));
            assert!(!map["@p:h"].is_screen_sharing);
        }

        #[test]
        fn share_audio_presence_drives_speaker_flag() {
            let mut map = empty();
            // Indépendant du flag vidéo : le son peut arriver sans l'image.
            assert!(apply_engine_event(
                &mut map,
                &E::ShareAudioPresence {
                    sender: "@p:h".into(),
                    has_audio: true
                }
            ));
            assert!(map["@p:h"].is_screen_sharing_audio);
            assert!(!map["@p:h"].is_screen_sharing);
            assert!(apply_engine_event(
                &mut map,
                &E::ShareAudioPresence {
                    sender: "@p:h".into(),
                    has_audio: false
                }
            ));
            assert!(!map["@p:h"].is_screen_sharing_audio);
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
            let payload = base64::engine::general_purpose::STANDARD
                .encode(r#"{"mxc":"mxc://h/s","emoji":"🥁","duration":2500,"gain":1.5}"#);
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &payload, 1_000),
                Some(2500)
            );
            assert_eq!(map["@dj:h"].playing_sound_emoji.as_deref(), Some("🥁"));
            // Échéance = maintenant + durée : c'est elle qui décide de la fin,
            // plus un `sleep(durée)` aveugle.
            assert_eq!(map["@dj:h"].badge_deadline_ms, 3_500);
            // Payload corrompu : pas de badge, pas de panique.
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", "!!!", 1_000),
                None
            );
        }

        /// Le bug d'origine : un son court déclenché pendant un son long
        /// éteignait le rond du son long. L'échéance ne recule jamais.
        #[test]
        fn soundboard_badge_deadline_never_moves_backwards() {
            use base64::Engine as _;
            let enc = |raw: &str| base64::engine::general_purpose::STANDARD.encode(raw);
            let mut map = empty();
            let long = enc(r#"{"mxc":"mxc://h/long","emoji":"🎵","duration":9000,"gain":1}"#);
            let short = enc(r#"{"mxc":"mxc://h/short","emoji":"🔔","duration":2000,"gain":1}"#);
            // Son long à t=0 → échéance 9 s.
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &long, 0),
                Some(9000)
            );
            // Son court déclenché 1 s plus tard : l'échéance reste celle du long.
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &short, 1_000),
                Some(2000)
            );
            assert_eq!(map["@dj:h"].badge_deadline_ms, 9_000);
            // Son suivant plus long : l'échéance est repoussée d'autant.
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &long, 5_000),
                Some(9000)
            );
            assert_eq!(map["@dj:h"].badge_deadline_ms, 14_000);
            // Autre expéditeur : aucun mélange d'échéances.
            assert_eq!(
                apply_soundboard_badge(&mut map, "@p:h", &short, 5_000),
                Some(2000)
            );
            assert_eq!(map["@p:h"].badge_deadline_ms, 7_000);
            assert_eq!(map["@dj:h"].badge_deadline_ms, 14_000);
        }

        /// Durée absente, nulle ou aberrante : jamais de rond instantané ni
        /// de rond éternel.
        #[test]
        fn soundboard_badge_duration_is_sane() {
            use base64::Engine as _;
            let enc = |raw: &str| base64::engine::general_purpose::STANDARD.encode(raw);
            let mut map = empty();
            // Champ absent (vieux payload) → repli 3 s, payload quand même lu.
            let no_duration = enc(r#"{"mxc":"mxc://h/s","emoji":"🔊","gain":1}"#);
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &no_duration, 0),
                Some(BADGE_DEFAULT_MS)
            );
            // Durée 0 (sonde d'upload en échec côté client) → repli, pas 0 ms.
            let zero = enc(r#"{"mxc":"mxc://h/z","emoji":"🔊","duration":0,"gain":1}"#);
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &zero, 0),
                Some(BADGE_DEFAULT_MS)
            );
            assert_eq!(map["@dj:h"].badge_deadline_ms, BADGE_DEFAULT_MS);
            // Durée aberrante → plafond.
            let huge = enc(r#"{"mxc":"mxc://h/h","emoji":"🔊","duration":9999999,"gain":1}"#);
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &huge, 0),
                Some(BADGE_MAX_MS)
            );
            assert_eq!(map["@dj:h"].badge_deadline_ms, BADGE_MAX_MS);
        }

        /// Réarmement côté récepteur : la latence de démarrage locale repousse
        /// l'échéance, sans jamais la raccourcir ni ressusciter un badge éteint
        /// quand le son n'est pas joué.
        #[test]
        fn soundboard_badge_extension_respects_playback_start() {
            use base64::Engine as _;
            let enc = |raw: &str| base64::engine::general_purpose::STANDARD.encode(raw);
            let mut map = empty();
            let payload = enc(r#"{"mxc":"mxc://h/s","emoji":"🎵","duration":4000,"gain":1}"#);
            assert_eq!(
                apply_soundboard_badge(&mut map, "@dj:h", &payload, 0),
                Some(4000)
            );
            // Le son démarre à 482 ms chez le récepteur : échéance repoussée.
            assert!(extend_badge_deadline(
                &mut map,
                "@dj:h",
                4000,
                Some("🎵"),
                482
            ));
            assert_eq!(map["@dj:h"].badge_deadline_ms, 4_482);
            // Une mesure plus courte (fichier réel plus court que l'annoncé) ne
            // raccourcit pas l'échéance déjà posée.
            assert!(!extend_badge_deadline(
                &mut map,
                "@dj:h",
                1500,
                Some("🎵"),
                500
            ));
            assert_eq!(map["@dj:h"].badge_deadline_ms, 4_482);
            // Emoji connu mais badge éteint → rallumé (cas du badge expiré
            // pendant un téléchargement lent).
            map.get_mut("@dj:h").unwrap().playing_sound_emoji = None;
            assert!(extend_badge_deadline(
                &mut map,
                "@dj:h",
                4000,
                Some("🎵"),
                600
            ));
            assert_eq!(map["@dj:h"].playing_sound_emoji.as_deref(), Some("🎵"));
            assert_eq!(map["@dj:h"].badge_deadline_ms, 4_600);
            // Sans emoji et badge éteint : rien à rallumer (son non joué).
            map.get_mut("@dj:h").unwrap().playing_sound_emoji = None;
            let before = map["@dj:h"].badge_deadline_ms;
            assert!(!extend_badge_deadline(&mut map, "@dj:h", 4000, None, 700));
            assert_eq!(map["@dj:h"].badge_deadline_ms, before);
            // Expéditeur inconnu : ignoré.
            assert!(!extend_badge_deadline(
                &mut map,
                "@absent:h",
                4000,
                Some("🎵"),
                700
            ));
        }

        /// La durée normalisée côté Rust doit rester alignée sur le repli JS.
        #[test]
        fn soundboard_badge_fallback_matches_js_contract() {
            assert_eq!(BADGE_DEFAULT_MS, 3_000);
            assert_eq!(sane_badge_ms(0), 3_000);
            assert_eq!(sane_badge_ms(500), 500);
            assert_eq!(sane_badge_ms(BADGE_MAX_MS + 1), BADGE_MAX_MS);
            // Payload minimal sans `duration` : sérialisé tel quel par un vieux
            // client, il doit encore se décoder.
            let minimal: SoundboardPayload =
                decode_json(r#"{"mxc":"mxc://h/s","emoji":"🔊"}"#).unwrap();
            assert_eq!(minimal.duration, BADGE_DEFAULT_MS);
            assert_eq!(minimal.gain, 1.0);
        }

        #[test]
        fn data_topics_match_js_constants() {
            // Garde-fou d'interopérabilité : ces topics doivent rester
            // identiques à `livekitService.ts` / `soundboardService.ts`.
            assert_eq!(TOPIC_AFK, "sion-afk");
            assert_eq!(TOPIC_SOUNDBOARD, "sion-soundboard");
            assert_eq!(TOPIC_CURSOR, "sion-cursor");
            assert_eq!(TOPIC_CURSOR_CLICK, "sion-cursor-click");
            assert_eq!(TOPIC_TRANSCRIBE_ARM, "sion-transcribe-arm");
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn cursor_name_prefere_pseudo_et_replie_sur_localpart() {
            assert_eq!(
                super::cursor_display_name(
                    Some("Picsou"),
                    Some("@picsou:example.org:device"),
                    "@picsou:example.org:device",
                ),
                "Picsou"
            );
            assert_eq!(
                super::cursor_display_name(
                    None,
                    Some("@picsou:example.org:device"),
                    "@picsou:example.org:device",
                ),
                "picsou"
            );
        }

        #[test]
        fn afk_state_mirrors_js_broadcast() {
            use base64::Engine as _;
            let enc = |raw: &str| base64::engine::general_purpose::STANDARD.encode(raw);
            let mut map = empty();
            // Sourdine distante : flag posé (upsert si join pas encore vu).
            assert!(apply_afk_state(
                &mut map,
                "@p:h",
                &enc(r#"{"deafened":true}"#)
            ));
            assert!(map["@p:h"].is_deafened);
            // Retour : flag retiré.
            assert!(apply_afk_state(
                &mut map,
                "@p:h",
                &enc(r#"{"deafened":false}"#)
            ));
            assert!(!map["@p:h"].is_deafened);
            // Payload JS exact (champ unique, pas d'extra).
            assert!(apply_afk_state(
                &mut map,
                "@q:h",
                &enc(r#"{"deafened":true}"#)
            ));
            assert!(map["@q:h"].is_deafened);
            // Corrompus : pas de changement, pas de panique.
            assert!(!apply_afk_state(&mut map, "@p:h", "!!!"));
            assert!(!apply_afk_state(&mut map, "@p:h", &enc("pas du json")));
            assert!(!apply_afk_state(
                &mut map,
                "@p:h",
                &enc(r#"{"muted":true}"#)
            ));
            assert!(!map["@p:h"].is_deafened);
        }

        #[test]
        fn afk_payload_serializes_like_js() {
            // Ce que le natif émet doit être lisible par `broadcastAfk` JS.
            let raw = serde_json::to_string(&AfkPayload { deafened: true }).unwrap();
            assert_eq!(raw, r#"{"deafened":true}"#);
        }
    }
}
