//! Local meeting transcription (desktop only).
//!
//! Architecture: each participant transcribes their OWN microphone locally —
//! per-speaker attribution comes for free and no audio ever leaves the
//! machine (the JS side publishes only the resulting text into the Matrix
//! room, encrypted when the room is).
//!
//! Pipeline (moteur natif) : le tap post-APM de `sion-native-audio` pousse le
//! micro traité en 16 kHz mono f32 (`transcription_tap`) → [ici] VAD WebRTC
//! (earshot) segmente la parole (pre-roll + hangover) → whisper/parakeet
//! transcrit chaque segment fermé → `{"type":"segment",...}` JSON diffusé sur
//! le WebSocket local → le front publie un événement Matrix
//! `com.sion.transcript` dans le salon.
//!
//! Le WS reste aussi alimenté en PCM par le front pour `transcribeRef` (texte
//! de référence TTS d'un fichier) : ce mode crée un segmenter par connexion,
//! le mode natif utilise le segmenter global du tap.
//!
//! Mute : le tap est coupé dans le callback audio (`mic_enabled=false`) et le
//! segment en cours est fermé au prochain poll pour ne rien perdre avant la
//! coupure. Rien de muet n'atteint le modèle.
//!
//! The WS server boots once and lives for the process (same pattern as
//! `system_audio.rs`); the engine (model in RAM) starts/stops with
//! `transcribe_start`/`transcribe_stop` so the ~200 MB–1 GB model is only
//! resident during a meeting.

#![cfg(not(target_os = "android"))]

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use earshot::{VoiceActivityDetector, VoiceActivityProfile};
use transcribe_cpp::{
    Model, RunExtension, RunOptions, SessionOptions, TimestampKind, WhisperRunOptions,
};
use tungstenite::Message;

const SAMPLE_RATE: usize = 16_000;
/// 20 ms VAD frames (earshot accepts 10/20/30 ms at 16 kHz).
const VAD_FRAME: usize = SAMPLE_RATE / 50;
/// Speech kept before the trigger frame so word onsets aren't clipped.
const PRE_ROLL_MS: usize = 300;
/// Continuous non-speech that closes a segment.
const HANGOVER_MS: usize = 700;
/// Hard cap per segment — long monologues are split and transcribed in
/// slices so the transcript stays "live" instead of arriving at the end.
const MAX_SEGMENT_MS: usize = 12_000;
/// Segments with less accumulated speech than this are dropped: too short to
/// transcribe reliably, and the main source of hallucinated punctuation.
const MIN_SPEECH_MS: usize = 350;

static WS_PORT: AtomicU16 = AtomicU16::new(0);
static ENGINE_RUNNING: AtomicBool = AtomicBool::new(false);
/// Micro non muet pendant une session native (mis à jour par `voice_engine`).
static NATIVE_MIC_ENABLED: AtomicBool = AtomicBool::new(false);
/// Flag d'arrêt du thread d'ingestion natif (None = pas de session native).
static NATIVE_INGEST_STOP: Mutex<Option<std::sync::Arc<AtomicBool>>> = Mutex::new(None);
/// Jobs (closed speech segments) from the segmenter to the whisper worker.
static SEG_TX: Mutex<Option<SyncSender<SegJob>>> = Mutex::new(None);
/// Outgoing JSON lines, one sender per connected WS client (broadcast).
static OUT_SENDERS: Mutex<Vec<Sender<String>>> = Mutex::new(Vec::new());

struct SegJob {
    samples: Vec<f32>,
    t0_ms: u64,
    t1_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn broadcast_json(line: &str) {
    let mut senders = OUT_SENDERS.lock().unwrap();
    senders.retain(|tx| tx.send(line.to_string()).is_ok());
}

// ---------------------------------------------------------------------------
// Segmenter: VAD state machine turning a continuous 16 kHz stream into
// discrete speech segments. One instance per WS connection, fed on the WS
// reader thread (cheap — earshot is a few µs per 20 ms frame).
// ---------------------------------------------------------------------------

struct Segmenter {
    vad: VoiceActivityDetector,
    /// Samples not yet forming a full VAD frame.
    pending: Vec<f32>,
    /// Rolling pre-roll kept while idle.
    pre_roll: Vec<f32>,
    /// Current open segment (empty = idle).
    segment: Vec<f32>,
    /// Consecutive non-speech duration inside an open segment.
    silence_ms: usize,
    /// Accumulated speech duration inside the open segment.
    speech_ms: usize,
    /// Wall-clock at segment open.
    t0_ms: u64,
}

impl Segmenter {
    fn new() -> Self {
        Self {
            vad: VoiceActivityDetector::new(VoiceActivityProfile::VERY_AGGRESSIVE),
            pending: Vec::with_capacity(VAD_FRAME * 4),
            pre_roll: Vec::with_capacity(PRE_ROLL_MS * SAMPLE_RATE / 1000),
            segment: Vec::new(),
            silence_ms: 0,
            speech_ms: 0,
            t0_ms: 0,
        }
    }

    fn feed(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= VAD_FRAME {
            let frame: Vec<f32> = self.pending.drain(..VAD_FRAME).collect();
            self.process_frame(&frame);
        }
    }

    fn process_frame(&mut self, frame: &[f32]) {
        // earshot works on i16 PCM.
        let i16_frame: Vec<i16> = frame
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        let is_speech = self.vad.predict_16khz(&i16_frame).unwrap_or(false);
        let frame_ms = VAD_FRAME * 1000 / SAMPLE_RATE;

        if self.segment.is_empty() {
            if is_speech {
                // Open a segment starting with the pre-roll context.
                self.t0_ms =
                    now_ms().saturating_sub(self.pre_roll.len() as u64 * 1000 / SAMPLE_RATE as u64);
                self.segment = std::mem::take(&mut self.pre_roll);
                self.segment.extend_from_slice(frame);
                self.silence_ms = 0;
                self.speech_ms = frame_ms;
            } else {
                // Idle: maintain the rolling pre-roll window.
                self.pre_roll.extend_from_slice(frame);
                let max = PRE_ROLL_MS * SAMPLE_RATE / 1000;
                if self.pre_roll.len() > max {
                    let excess = self.pre_roll.len() - max;
                    self.pre_roll.drain(..excess);
                }
            }
            return;
        }

        // Segment open.
        self.segment.extend_from_slice(frame);
        if is_speech {
            self.silence_ms = 0;
            self.speech_ms += frame_ms;
        } else {
            self.silence_ms += frame_ms;
        }

        let seg_ms = self.segment.len() * 1000 / SAMPLE_RATE;
        if self.silence_ms >= HANGOVER_MS || seg_ms >= MAX_SEGMENT_MS {
            self.close_segment();
        }
    }

    /// Close and ship the current segment (no-op when idle). Also invoked by
    /// the JS `flush` control message on mute, so speech right before the
    /// mute still gets transcribed.
    fn close_segment(&mut self) {
        if self.segment.is_empty() {
            return;
        }
        let samples = std::mem::take(&mut self.segment);
        let speech_ms = self.speech_ms;
        self.speech_ms = 0;
        self.silence_ms = 0;
        self.pre_roll.clear();

        if speech_ms < MIN_SPEECH_MS {
            return; // breath / keyboard click — not worth an inference
        }
        let t1 = now_ms();
        let job = SegJob {
            samples,
            t0_ms: self.t0_ms,
            t1_ms: t1,
        };
        if let Some(tx) = SEG_TX.lock().unwrap().as_ref() {
            // Bounded queue: if whisper falls behind (undersized machine),
            // drop the oldest pressure by dropping THIS segment rather than
            // ballooning memory — the transcript loses a sentence instead of
            // the app dying. try_send keeps the audio thread non-blocking.
            match tx.try_send(job) {
                Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                Err(TrySendError::Full(_)) => {
                    log::warn!("[Sion][transcribe] worker backlog full — dropping a segment");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Whisper worker: owns the model, consumes segments, emits JSON.
// ---------------------------------------------------------------------------

/// Junk whisper reliably hallucinates on borderline audio. A segment whose
/// text contains one of these (case-insensitive) is discarded.
const HALLUCINATION_MARKERS: &[&str] = &[
    "amara.org",
    "sous-titres",
    "sous-titrage",
    "merci d'avoir regard",
    "abonnez-vous",
    "subtitles by",
    "thanks for watching",
    "[musique]",
    "[music]",
    "♪",
];

fn looks_hallucinated(text: &str) -> bool {
    let lower = text.to_lowercase();
    if !lower.chars().any(|c| c.is_alphanumeric()) {
        return true;
    }
    HALLUCINATION_MARKERS.iter().any(|m| lower.contains(m))
}

fn json_escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Enregistre les modules de calcul avant tout chargement de modèle.
///
/// La construction en `dynamic-backends` compile une variante du noyau CPU par
/// palier SIMD et les livre en bibliothèques séparées : sans cet appel, aucun
/// périphérique n'est enregistré et le chargement échoue sur « backend error
/// (status 8) ». `init_backends_default` résout lui-même le dossier de
/// libtranscribe, où le build les dépose.
///
/// L'appel est idempotent mais NON rejouable dans le même processus, d'où le
/// `Once` — et c'est un no-op en construction statique.
fn ensure_backends() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| match transcribe_cpp::init_backends_default() {
        Ok(()) => log::info!(
            "[Sion][transcribe] backends enregistrés ({} périphérique(s))",
            transcribe_cpp::device_count()
        ),
        Err(e) => log::error!("[Sion][transcribe] init_backends_default: {e}"),
    });
}

fn asr_worker(model_path: String, lang: String, rx: Receiver<SegJob>) {
    ensure_backends();
    let model = match Model::load(&model_path) {
        Ok(m) => m,
        Err(e) => {
            log::error!("[Sion][transcribe] model load failed: {e}");
            broadcast_json(&format!(
                "{{\"type\":\"error\",\"message\":{}}}",
                json_escape(&format!("model load failed: {e}"))
            ));
            ENGINE_RUNNING.store(false, Ordering::Relaxed);
            return;
        }
    };
    let threads = thread::available_parallelism()
        .map(|n| n.get().min(4))
        .unwrap_or(4) as i32;
    let mut session = match model.session_with(&SessionOptions {
        n_threads: threads,
        ..Default::default()
    }) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[Sion][transcribe] session init failed: {e}");
            ENGINE_RUNNING.store(false, Ordering::Relaxed);
            return;
        }
    };

    // Options shared by every run. Text-only output (timestamps come from
    // our own segmenter's wall clock). The language hint and the decode
    // knobs are whisper-family-specific — parakeet & friends are inherently
    // multilingual with their own defaults, so they get plain options.
    let is_whisper = model_path.to_lowercase().contains("whisper");
    let mut opts = RunOptions {
        timestamps: TimestampKind::None,
        ..Default::default()
    };
    if is_whisper {
        if lang != "auto" {
            opts.language = Some(lang.clone());
        }
        // Independent segments: conditioning on previous tokens makes one
        // hallucination snowball into the following segments.
        opts.family = Some(RunExtension::Whisper(WhisperRunOptions {
            condition_on_prev_tokens: Some(false),
            ..Default::default()
        }));
    }
    log::info!("[Sion][transcribe] model ready ({model_path}), lang={lang}, threads={threads}, whisper={is_whisper}");
    broadcast_json("{\"type\":\"ready\"}");

    loop {
        let job = match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(j) => j,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !ENGINE_RUNNING.load(Ordering::Relaxed) {
                    break;
                }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if !ENGINE_RUNNING.load(Ordering::Relaxed) {
            break;
        }

        let seg_secs = job.samples.len() as f32 / SAMPLE_RATE as f32;
        let started = std::time::Instant::now();
        let text = match session.run(&job.samples, &opts) {
            Ok(res) => res.text.trim().to_string(),
            Err(e) => {
                log::warn!("[Sion][transcribe] inference failed: {e}");
                continue;
            }
        };
        log::info!(
            "[Sion][transcribe] {:.1}s audio → {} chars in {} ms",
            seg_secs,
            text.len(),
            started.elapsed().as_millis()
        );
        if text.is_empty() || looks_hallucinated(&text) {
            continue;
        }
        broadcast_json(&format!(
            "{{\"type\":\"segment\",\"text\":{},\"t0\":{},\"t1\":{}}}",
            json_escape(&text),
            job.t0_ms,
            job.t1_ms
        ));
    }
    log::info!("[Sion][transcribe] worker stopped, model unloaded");
}

// ---------------------------------------------------------------------------
// WebSocket server (boot once, lives for the process).
// ---------------------------------------------------------------------------

fn ensure_ws_server() {
    if WS_PORT.load(Ordering::Relaxed) != 0 {
        return;
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            log::error!("[Sion][transcribe] WS bind failed: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    WS_PORT.store(port, Ordering::Relaxed);
    log::info!("[Sion][transcribe] WS server on 127.0.0.1:{port}");

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_nodelay(true);
            let Ok(mut ws) = tungstenite::accept(stream) else {
                continue;
            };
            let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
            OUT_SENDERS.lock().unwrap().push(out_tx);
            log::info!("[Sion][transcribe] WS client connected");

            thread::spawn(move || {
                let _ = ws
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_millis(20)));
                let mut segmenter = Segmenter::new();
                loop {
                    // Push whisper results queued for this client.
                    while let Ok(line) = out_rx.try_recv() {
                        if ws.send(Message::Text(line.into())).is_err() {
                            return;
                        }
                    }
                    match ws.read() {
                        Ok(Message::Binary(data)) => {
                            if !ENGINE_RUNNING.load(Ordering::Relaxed) {
                                continue;
                            }
                            // f32le mono 16 kHz PCM from the AudioWorklet.
                            let samples: Vec<f32> = data
                                .chunks_exact(4)
                                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                                .collect();
                            segmenter.feed(&samples);
                        }
                        Ok(Message::Text(t)) => {
                            // Control channel. `flush` = mic just muted;
                            // close the open segment so the tail is not lost.
                            if t.as_str().contains("flush") {
                                segmenter.close_segment();
                            }
                        }
                        Ok(Message::Ping(data)) => {
                            let _ = ws.send(Message::Pong(data));
                        }
                        Ok(Message::Close(_)) => return,
                        Err(tungstenite::Error::Io(ref e))
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => return,
                        _ => {}
                    }
                }
            });
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Démarre l'ingestion du tap micro natif : le post-APM de
/// `sion-native-audio` alimente le segmenter global, dont les résultats
/// partent sur le WS (sortie `ready`/`segment`). `mic_enabled` reflète l'état
/// au démarrage (armement muet = tap fermé jusqu'au prochain unmute).
#[tauri::command]
pub fn transcribe_start_native(
    model_path: String,
    lang: String,
    mic_enabled: bool,
) -> Result<u16, String> {
    let port = start_engine(model_path, lang)?;
    let rx = sion_native_audio::transcription_tap::subscribe();
    sion_native_audio::transcription_tap::enable();
    sion_native_audio::transcription_tap::set_mic_enabled(mic_enabled);
    NATIVE_MIC_ENABLED.store(mic_enabled, Ordering::Release);
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    *NATIVE_INGEST_STOP.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop.clone());
    thread::Builder::new()
        .name("sion-transcribe-native".into())
        .spawn(move || native_ingest_worker(rx, stop))
        .map_err(|e| format!("thread transcription: {e}"))?;
    log::info!(
        "[Sion][transcribe] ingestion native démarrée (micro={})",
        mic_enabled
    );
    Ok(port)
}

/// État micro pour le tap natif (appelé par `voice_engine` à chaque
/// mute/unmute/deafen). Le worker ferme le segment en cours au passage muet.
pub fn note_native_mic_enabled(enabled: bool) {
    // Coupe le forward immédiatement (callback audio) ET ferme le segment en
    // cours au prochain poll du worker.
    sion_native_audio::transcription_tap::set_mic_enabled(enabled);
    NATIVE_MIC_ENABLED.store(enabled, Ordering::Release);
}

/// Coupe le tap et arrête le thread d'ingestion natif (idempotent).
fn stop_native_ingest() {
    sion_native_audio::transcription_tap::disable();
    sion_native_audio::transcription_tap::set_mic_enabled(false);
    NATIVE_MIC_ENABLED.store(false, Ordering::Release);
    if let Some(stop) = NATIVE_INGEST_STOP
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        stop.store(true, Ordering::Release);
    }
    sion_native_audio::transcription_tap::unsubscribe();
}

/// Segmenter global du tap natif : rééchantillonné en 16 kHz par
/// `sion-native-audio`, il ferme le segment dès que le micro est coupé pour
/// transcrire la fin de phrase sans jamais voir l'audio muet.
fn native_ingest_worker(rx: Receiver<Vec<f32>>, stop: std::sync::Arc<AtomicBool>) {
    let mut segmenter = Segmenter::new();
    let mut mic_enabled = NATIVE_MIC_ENABLED.load(Ordering::Acquire);
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(samples) => segmenter.feed(&samples),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let now = NATIVE_MIC_ENABLED.load(Ordering::Acquire);
        if mic_enabled && !now {
            segmenter.close_segment();
        }
        mic_enabled = now;
    }
    segmenter.close_segment();
    sion_native_audio::transcription_tap::unsubscribe();
    log::info!("[Sion][transcribe] ingestion native arrêtée");
}

/// Start the transcription engine: boots the WS server if needed, loads the
/// model on a worker thread (a `ready` message is pushed over the WS when
/// loaded) and returns the WS port to stream audio to. Restarting with a
/// different model/lang stops the previous worker first.
#[tauri::command]
pub fn transcribe_start(model_path: String, lang: String) -> Result<u16, String> {
    start_engine(model_path, lang)
}

fn start_engine(model_path: String, lang: String) -> Result<u16, String> {
    // Un seul moteur à la fois : le mode natif et le mode fichier (transcribeRef)
    // partagent `SEG_TX`.
    stop_native_ingest();
    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("modèle introuvable: {model_path}"));
    }
    ensure_ws_server();
    let port = WS_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return Err("serveur WS indisponible".into());
    }

    // Stop a previous worker (drops its SEG_TX → recv disconnects).
    ENGINE_RUNNING.store(false, Ordering::Relaxed);
    *SEG_TX.lock().unwrap() = None;

    // Bounded to a handful of pending segments (~1 min of speech max) —
    // see the try_send comment in `close_segment`.
    let (tx, rx) = std::sync::mpsc::sync_channel::<SegJob>(6);
    *SEG_TX.lock().unwrap() = Some(tx);
    ENGINE_RUNNING.store(true, Ordering::Relaxed);
    thread::spawn(move || asr_worker(model_path, lang, rx));
    Ok(port)
}

/// Stop the engine and unload the model. The WS server stays up (cheap) so a
/// later start reuses the same port.
#[tauri::command]
pub fn transcribe_stop() {
    stop_native_ingest();
    ENGINE_RUNNING.store(false, Ordering::Relaxed);
    *SEG_TX.lock().unwrap() = None;
    log::info!("[Sion][transcribe] stop requested");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// E2E local : `SION_TEST_ASR_MODEL` = GGUF, `SION_TEST_ASR_PCM` = f32le
    /// mono 48 kHz (ex. `espeak-ng` + ffmpeg). Vérifie que le tap natif →
    /// segmenter → ASR produit un segment. Ignoré par défaut (modèle lourd).
    #[test]
    #[ignore = "nécessite SION_TEST_ASR_MODEL et SION_TEST_ASR_PCM"]
    fn native_tap_end_to_end() {
        let model = std::env::var("SION_TEST_ASR_MODEL").expect("SION_TEST_ASR_MODEL");
        let pcm_path = std::env::var("SION_TEST_ASR_PCM").expect("SION_TEST_ASR_PCM");
        let bytes = std::fs::read(&pcm_path).expect("lecture PCM");
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        assert!(samples.len() > 48_000, "PCM trop court");

        let port = transcribe_start_native(model, "fr".into(), true).expect("start");
        let (mut ws, _) =
            tungstenite::connect(format!("ws://127.0.0.1:{port}")).expect("connexion WS");
        if let tungstenite::stream::MaybeTlsStream::Plain(stream) = ws.get_ref() {
            stream
                .set_read_timeout(Some(Duration::from_secs(60)))
                .unwrap();
        }

        let mut ready = false;
        while !ready {
            match ws.read() {
                Ok(Message::Text(t)) => ready = t.contains("\"ready\""),
                Ok(_) => {}
                Err(e) => panic!("attente ready: {e}"),
            }
        }
        println!(
            "[test] moteur prêt, injection de {} éch. @48 kHz",
            samples.len()
        );

        for frame in samples.chunks(480) {
            if frame.len() == 480 {
                let scaled: Vec<f32> = frame.iter().map(|s| s * 32768.0).collect();
                sion_native_audio::transcription_tap::forward(&scaled);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        // Fin d'élocution : le worker ferme le segment (hangover simulé).
        note_native_mic_enabled(false);

        let mut segment: Option<String> = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        while std::time::Instant::now() < deadline && segment.is_none() {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    if t.contains("\"segment\"") {
                        segment = Some(t.to_string());
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(ref e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => panic!("lecture segment: {e}"),
            }
        }
        transcribe_stop();
        let segment = segment.expect("aucun segment transcrit");
        println!("[test] SEGMENT: {segment}");
    }
}
