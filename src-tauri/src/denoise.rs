//! RNNoise-based audio denoise — Rust-side pipeline.
//!
//! The JS AudioWorklet captures the microphone as 48 kHz mono f32 frames of
//! 480 samples (10 ms), ships each frame here via a Tauri command as raw
//! bytes (no JSON), and we return the denoised frame. A dedicated worker
//! thread owns the `DenoiseState` so inference never blocks Tauri's async
//! runtime; frames are routed through bounded SPSC channels so the audio
//! path never allocates during steady-state processing.
//!
//! RNNoise (via `nnnoiseless`, a pure-Rust port of Valin's model) is ~100×
//! lighter than the previous DFN3 pipeline, preserves voice better, and
//! needs no ONNX runtime.

use nnnoiseless::DenoiseState;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Runtime};

const FRAME_SAMPLES: usize = DenoiseState::FRAME_SIZE; // 480 @ 48 kHz
const INBOX_CAP: usize = 8;

// RNNoise expects samples in 16-bit signed PCM range (as f32). WebCodecs
// AudioData is in [-1, 1] float, so the worker scales in/out by this factor.
const I16_SCALE: f32 = 32768.0;

/// A single frame (or batch of frames) to denoise. The `reply` channel is
/// single-use — we allocate it per call rather than pre-allocating a response
/// queue because it keeps the Tauri command code straight-line
/// (send → recv → return).
struct Job {
    frame: Vec<f32>,
    reply: mpsc::SyncSender<Vec<f32>>,
}

struct Worker {
    inbox: mpsc::SyncSender<Job>,
}

static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
// Dry/wet mix as f32 bits — 1.0 = full RNNoise output, 0.0 = input passthrough.
// Read by the worker on every frame, written atomically by the JS slider.
static MIX: AtomicU32 = AtomicU32::new(f32::to_bits(1.0));

fn get_mix() -> f32 {
    f32::from_bits(MIX.load(Ordering::Relaxed))
}

fn worker_slot() -> &'static Mutex<Option<Worker>> {
    WORKER.get_or_init(|| Mutex::new(None))
}

/// Start the denoise worker. Returns immediately once the thread is
/// spawned; the `DenoiseState` is created inside the worker so model
/// initialisation cost doesn't block the Tauri command.
fn start_worker() -> Result<(), String> {
    let mut slot = worker_slot().lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Ok(());
    }

    log::info!("[Sion][denoise] starting RNNoise worker (nnnoiseless built-in model)");

    let (tx, rx) = mpsc::sync_channel::<Job>(INBOX_CAP);

    thread::Builder::new()
        .name("sion-denoise".into())
        .spawn(move || {
            let mut state = DenoiseState::new();
            // Preallocated scratch buffers — reused across every frame so
            // steady-state processing doesn't allocate.
            let mut scaled_in = vec![0.0f32; FRAME_SAMPLES];
            let mut denoised = vec![0.0f32; FRAME_SAMPLES];
            log::info!("[Sion][denoise] worker ready");

            while let Ok(job) = rx.recv() {
                let n = job.frame.len();
                if n == 0 || n % FRAME_SAMPLES != 0 {
                    let _ = job.reply.send(job.frame);
                    continue;
                }
                let mix = get_mix().clamp(0.0, 1.0);
                let inv_mix = 1.0 - mix;
                let frames = n / FRAME_SAMPLES;
                let mut out_batch = Vec::with_capacity(n);

                for i in 0..frames {
                    let start = i * FRAME_SAMPLES;
                    let end = start + FRAME_SAMPLES;
                    let input = &job.frame[start..end];

                    // Scale [-1, 1] → i16 range for RNNoise.
                    for k in 0..FRAME_SAMPLES {
                        scaled_in[k] = input[k] * I16_SCALE;
                    }
                    // `process_frame` returns VAD probability; we ignore it.
                    let _vad = state.process_frame(&mut denoised, &scaled_in);

                    // Scale back down and apply dry/wet mix per sample.
                    // Fast path for mix=1.0 (full denoise, the default).
                    if mix >= 0.9999 {
                        for k in 0..FRAME_SAMPLES {
                            out_batch.push(denoised[k] / I16_SCALE);
                        }
                    } else {
                        for k in 0..FRAME_SAMPLES {
                            let wet = denoised[k] / I16_SCALE;
                            out_batch.push(mix * wet + inv_mix * input[k]);
                        }
                    }
                }

                let _ = job.reply.send(out_batch);
            }
            log::info!("[Sion][denoise] worker stopped");
        })
        .map_err(|e| format!("spawn worker: {e}"))?;

    *slot = Some(Worker { inbox: tx });
    Ok(())
}

fn stop_worker() {
    if let Ok(mut slot) = worker_slot().lock() {
        *slot = None; // Dropping the sender closes the channel → worker exits.
    }
}

#[tauri::command]
pub fn denoise_enable<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    start_worker()?;
    ENABLED.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn denoise_disable() {
    ENABLED.store(false, Ordering::Release);
    stop_worker();
}

#[tauri::command]
pub fn denoise_set_mix(mix: f32) {
    let clamped = mix.clamp(0.0, 1.0);
    MIX.store(f32::to_bits(clamped), Ordering::Relaxed);
}

/// Binary IPC command. The JS side sends a `Float32Array` directly; Tauri's
/// `process-ipc-message-fn` sees the TypedArray and sets
/// `Content-Type: application/octet-stream`, skipping JSON entirely. We
/// reinterpret the raw bytes as `[f32]`, process, and return raw bytes as an
/// `ArrayBuffer` on the JS side.
#[tauri::command]
pub fn denoise_process_frame(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("denoise_process_frame: expected raw bytes (Float32Array)".into());
    };

    // Empty or non-aligned payload → passthrough.
    if bytes.is_empty() || bytes.len() % (FRAME_SAMPLES * 4) != 0 {
        return Ok(Response::new(bytes.clone()));
    }

    if !ENABLED.load(Ordering::Acquire) {
        return Ok(Response::new(bytes.clone()));
    }

    // `Vec<u8>` from Tauri is 1-byte aligned; `pod_collect_to_vec` does an
    // aligned bulk copy into a `Vec<f32>` — still much cheaper than parsing
    // a JSON array of 1920 numbers.
    let frame: Vec<f32> = bytemuck::pod_collect_to_vec(bytes);

    let sender = {
        let slot = worker_slot().lock().map_err(|e| e.to_string())?;
        slot.as_ref().map(|w| w.inbox.clone())
    };
    let Some(sender) = sender else {
        return Ok(Response::new(bytes.clone())); // Worker not started → passthrough
    };

    let (reply_tx, reply_rx) = mpsc::sync_channel::<Vec<f32>>(1);
    match sender.try_send(Job { frame, reply: reply_tx }) {
        Ok(()) => {}
        Err(mpsc::TrySendError::Full(_)) => return Ok(Response::new(bytes.clone())),
        Err(mpsc::TrySendError::Disconnected(_)) => return Ok(Response::new(bytes.clone())),
    }

    // RNNoise steady-state latency is sub-millisecond per frame; 100 ms is
    // large enough to absorb any kernel/IPC stall without letting the audio
    // pipeline build a backlog.
    let out = reply_rx
        .recv_timeout(Duration::from_millis(100))
        .map_err(|_| "denoise timeout".to_string())?;

    let out_bytes: Vec<u8> = bytemuck::cast_slice(&out).to_vec();
    Ok(Response::new(out_bytes))
}
