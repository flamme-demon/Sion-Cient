//! RNNoise capture processor. Buffers use WebRTC's float-in-i16-range format.
//! The WebRTC post-processing callback owns each channel; the UI only updates
//! one atomic settings word, never transports PCM or locks the audio callback.
use nnnoiseless::DenoiseState;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

pub const FRAME_SIZE: usize = 480;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    pub noise_suppression: bool,
    pub mix: f32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            auto_gain_control: true,
            noise_suppression: true,
            mix: 1.0,
        }
    }
}
impl Settings {
    fn packed(self) -> u32 {
        let mix = if self.mix.is_finite() {
            self.mix.clamp(0.0, 1.0)
        } else {
            1.0
        };
        (self.echo_cancellation as u32)
            | ((self.auto_gain_control as u32) << 1)
            | ((self.noise_suppression as u32) << 2)
            | (((mix * 65535.0).round() as u32) << 3)
    }
    fn unpack(bits: u32) -> Self {
        Self {
            echo_cancellation: bits & 1 != 0,
            auto_gain_control: bits & 2 != 0,
            noise_suppression: bits & 4 != 0,
            mix: (bits >> 3) as f32 / 65535.0,
        }
    }
}
static SETTINGS: AtomicU32 = AtomicU32::new(7 | (65535 << 3));
static CAPTURE_RMS: AtomicU32 = AtomicU32::new(0);
static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const SOUNDBOARD_RATE: usize = 48_000;
const SOUNDBOARD_MAX_SAMPLES: usize = SOUNDBOARD_RATE * 20;

struct SoundboardClip {
    samples: Vec<i16>,
    cursor: usize,
    gain: f32,
}

static SOUNDBOARD_CLIPS: LazyLock<Mutex<Vec<SoundboardClip>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

/// Adds one decoded mono 48 kHz clip to the render mixer. Several clips may
/// overlap, matching the browser soundboard behaviour. The 20 second bound is
/// also enforced by the Matrix upload path, but is repeated at this boundary.
pub fn enqueue_soundboard_audio(samples: &[i16], gain: f32) -> bool {
    if samples.is_empty()
        || samples.len() > SOUNDBOARD_MAX_SAMPLES
        || !gain.is_finite()
        || !(0.0..=3.0).contains(&gain)
    {
        return false;
    }
    SOUNDBOARD_CLIPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(SoundboardClip {
            samples: samples.to_vec(),
            cursor: 0,
            gain,
        });
    true
}

pub fn clear_soundboard_audio() {
    SOUNDBOARD_CLIPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

/// Mixes the next mono frame into WebRTC's signed-16-bit-range float buffer.
/// Called from render pre-processing, before the frame becomes the AEC render
/// reference. The audio callback takes one short mutex and allocates nothing.
pub fn mix_soundboard_render(samples: &mut [f32]) {
    let mut clips = SOUNDBOARD_CLIPS.lock().unwrap_or_else(|e| e.into_inner());
    for out in samples.iter_mut() {
        let mut mixed = if out.is_finite() { *out } else { 0.0 };
        for clip in clips.iter_mut() {
            if let Some(sample) = clip.samples.get(clip.cursor) {
                mixed += *sample as f32 * clip.gain;
                clip.cursor += 1;
            }
        }
        *out = mixed.clamp(-32768.0, 32767.0);
    }
    clips.retain(|clip| clip.cursor < clip.samples.len());
}

pub fn configure(settings: Settings) {
    SETTINGS.store(settings.packed(), Ordering::Relaxed);
}
pub fn settings() -> Settings {
    Settings::unpack(SETTINGS.load(Ordering::Relaxed))
}
pub fn capture_level() -> (u64, f32) {
    (
        CAPTURE_SEQUENCE.load(Ordering::Relaxed),
        f32::from_bits(CAPTURE_RMS.load(Ordering::Relaxed)),
    )
}

pub struct ChannelProcessor {
    state: Box<DenoiseState<'static>>,
    wet: [f32; FRAME_SIZE],
    previous: [f32; FRAME_SIZE],
    enabled: bool,
    primed: bool,
}
impl Default for ChannelProcessor {
    fn default() -> Self {
        Self {
            state: DenoiseState::new(),
            wet: [0.0; FRAME_SIZE],
            previous: [0.0; FRAME_SIZE],
            enabled: true,
            primed: false,
        }
    }
}
impl ChannelProcessor {
    /// Returns false for an invalid frame, without modifying it.
    pub fn process(&mut self, samples: &mut [f32], options: Settings) -> bool {
        if samples.len() != FRAME_SIZE {
            return false;
        }
        for sample in samples.iter_mut() {
            *sample = if sample.is_finite() {
                sample.clamp(-32768.0, 32767.0)
            } else {
                0.0
            };
        }
        if !options.noise_suppression {
            self.enabled = false;
            self.primed = false;
            return true;
        }
        if !self.enabled {
            // A one-time reset on re-enable, not an allocation per audio frame.
            self.state = DenoiseState::new();
            self.enabled = true;
        }
        self.state.process_frame(&mut self.wet, samples);
        let mix = if options.mix.is_finite() {
            options.mix.clamp(0.0, 1.0)
        } else {
            1.0
        };
        for (i, sample) in samples.iter_mut().enumerate() {
            let input = *sample;
            // RNNoise has one frame of lookahead. Align dry and wet, including
            // the startup frame; mixing the current input causes comb filtering.
            *sample = if self.primed {
                (self.wet[i] * mix + self.previous[i] * (1.0 - mix)).clamp(-32768.0, 32767.0)
            } else {
                0.0
            };
            self.previous[i] = input;
        }
        self.primed = true;
        true
    }
}

/// Tap PCM post-APM pour la transcription locale.
///
/// Alimenté par le thread de capture APM (`CaptureProcessor::process_channel`
/// après AEC/NS/AGC), consommé par `transcribe.rs`. Le callback normalise en
/// -1..1 (l'APM travaille en f32 échelle i16) et rééchantillonne à 16 kHz par
/// décimation de blocs — 10 ms par trame, donc 160/320/480 échantillons pour
/// 16/32/48 kHz : la longueur suffit à déduire le taux, aucun état partagé.
pub mod transcription_tap {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
    use std::sync::{LazyLock, Mutex};

    /// 10 ms à 16 kHz.
    const TARGET_FRAME: usize = 160;

    static ENABLED: AtomicBool = AtomicBool::new(false);
    /// Micro non muet (mute/sourdine) : coupé dans le callback, sans attendre
    /// le prochain poll du worker.
    static MIC_ENABLED: AtomicBool = AtomicBool::new(true);
    static SENDER: LazyLock<Mutex<Option<SyncSender<Vec<f32>>>>> =
        LazyLock::new(|| Mutex::new(None));

    pub fn enable() {
        ENABLED.store(true, Ordering::Release);
    }

    pub fn disable() {
        ENABLED.store(false, Ordering::Release);
    }

    /// État micro : `false` bloque immédiatement le forward (mute/sourdine).
    pub fn set_mic_enabled(enabled: bool) {
        MIC_ENABLED.store(enabled, Ordering::Release);
    }

    /// Abonne le consommateur (un seul à la fois : le moteur ASR).
    pub fn subscribe() -> Receiver<Vec<f32>> {
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        *SENDER.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        rx
    }

    pub fn unsubscribe() {
        *SENDER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Trame 10 ms → 16 kHz mono, normalisée -1..1.
    fn resample_16k(samples: &[f32]) -> Vec<f32> {
        const SCALE: f32 = 1.0 / 32768.0;
        if samples.len() == TARGET_FRAME {
            return samples.iter().map(|s| s * SCALE).collect();
        }
        if samples.is_empty() {
            return Vec::new();
        }
        let ratio = samples.len() as f32 / TARGET_FRAME as f32;
        let mut out = Vec::with_capacity(TARGET_FRAME);
        let mut start = 0usize;
        for i in 0..TARGET_FRAME {
            let end = (((i + 1) as f32 * ratio).round() as usize)
                .min(samples.len())
                .max(start + 1);
            let mut acc = 0.0f32;
            for sample in &samples[start..end] {
                acc += *sample;
            }
            out.push(acc / (end - start) as f32 * SCALE);
            start = end;
        }
        out
    }

    /// Appelé sur le thread de capture : ne bloque jamais (try_lock + canal
    /// borné ; une trame perdue vaut mieux qu'une glitch audio).
    pub fn forward(samples: &[f32]) {
        if !ENABLED.load(Ordering::Acquire) || !MIC_ENABLED.load(Ordering::Acquire) {
            return;
        }
        let Ok(guard) = SENDER.try_lock() else {
            return;
        };
        let Some(tx) = guard.as_ref() else {
            return;
        };
        match tx.try_send(resample_16k(samples)) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

pub struct CaptureProcessor {
    channels: Vec<ChannelProcessor>,
}
pub fn new_capture_processor() -> Box<CaptureProcessor> {
    Box::new(CaptureProcessor {
        channels: Vec::new(),
    })
}
impl CaptureProcessor {
    pub fn initialize(&mut self, channels: usize) {
        self.channels = (0..channels).map(|_| ChannelProcessor::default()).collect();
    }
    pub fn process_channel(&mut self, channel: usize, samples: &mut [f32]) {
        if let Some(processor) = self.channels.get_mut(channel) {
            let options = settings();
            if !options.noise_suppression {
                processor.enabled = false;
                processor.primed = false;
            } else {
                processor.process(samples, options);
            }
            let rms = (samples.iter().map(|x| (x / 32768.0).powi(2)).sum::<f32>()
                / samples.len().max(1) as f32)
                .sqrt();
            let rms = if rms.is_finite() {
                rms.clamp(0.0, 1.0)
            } else {
                0.0
            };
            if channel == 0 {
                CAPTURE_RMS.store(rms.to_bits(), Ordering::Relaxed);
                CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                transcription_tap::forward(samples);
            } else {
                CAPTURE_RMS.fetch_max(rms.to_bits(), Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_is_exact_passthrough_and_invalid_frames_are_untouched() {
        let mut processor = ChannelProcessor::default();
        let input: [f32; FRAME_SIZE] = std::array::from_fn(|i| (i as f32 - 240.0) * 100.0);
        let mut samples = input;
        assert!(processor.process(
            &mut samples,
            Settings {
                noise_suppression: false,
                ..Settings::default()
            }
        ));
        assert_eq!(samples, input);
        let mut short = [12.0; 160];
        assert!(!processor.process(&mut short, Settings::default()));
        assert_eq!(short, [12.0; 160]);
    }
    #[test]
    fn dry_signal_is_delayed_one_frame_and_startup_is_silent() {
        let mut processor = ChannelProcessor::default();
        let options = Settings {
            mix: 0.0,
            ..Settings::default()
        };
        let mut first = [1000.0; FRAME_SIZE];
        processor.process(&mut first, options);
        assert_eq!(first, [0.0; FRAME_SIZE]);
        let mut second = [2000.0; FRAME_SIZE];
        processor.process(&mut second, options);
        assert_eq!(second, [1000.0; FRAME_SIZE]);
    }
    #[test]
    fn partial_mix_uses_the_same_frame_as_the_wet_signal() {
        let mut wet_processor = ChannelProcessor::default();
        let mut mixed_processor = ChannelProcessor::default();
        let mut previous = [0.0; FRAME_SIZE];
        for frame in 0..8 {
            let input =
                std::array::from_fn(|i| ((frame * FRAME_SIZE + i) as f32 * 0.08).sin() * 2000.0);
            let mut wet = input;
            let mut mixed = input;
            wet_processor.process(&mut wet, Settings::default());
            mixed_processor.process(
                &mut mixed,
                Settings {
                    mix: 0.4,
                    ..Settings::default()
                },
            );
            for i in 0..FRAME_SIZE {
                let expected = if frame == 0 {
                    0.0
                } else {
                    wet[i] * 0.4 + previous[i] * 0.6
                };
                assert!((mixed[i] - expected).abs() < 0.01);
            }
            previous = input;
        }
    }
    #[test]
    fn suppresses_stationary_noise_without_nan_or_clipping() {
        let mut processor = ChannelProcessor::default();
        let mut seed = 42_u32;
        let mut input_energy = 0.0;
        let mut output_energy = 0.0;
        for frame in 0..200 {
            let mut samples = std::array::from_fn::<_, FRAME_SIZE, _>(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 16) as f32 / 65535.0 - 0.5) * 2000.0
            });
            if frame > 100 {
                input_energy += samples.iter().map(|x| x * x).sum::<f32>();
            }
            processor.process(&mut samples, Settings::default());
            assert!(samples.iter().all(|x| x.is_finite() && x.abs() <= 32768.0));
            if frame > 100 {
                output_energy += samples.iter().map(|x| x * x).sum::<f32>();
            }
        }
        assert!(
            output_energy < input_energy * 0.7,
            "noise reduction: {output_energy}/{input_energy}"
        );
    }
    #[test]
    fn settings_pack_coherently_and_clamp_invalid_mix() {
        for aec in [false, true] {
            for agc in [false, true] {
                for ns in [false, true] {
                    let options = Settings {
                        echo_cancellation: aec,
                        auto_gain_control: agc,
                        noise_suppression: ns,
                        mix: 0.4,
                    };
                    let decoded = Settings::unpack(options.packed());
                    assert_eq!(
                        (
                            decoded.echo_cancellation,
                            decoded.auto_gain_control,
                            decoded.noise_suppression
                        ),
                        (aec, agc, ns)
                    );
                    assert!((decoded.mix - 0.4).abs() < 0.0001);
                }
            }
        }
        assert_eq!(
            Settings::unpack(
                Settings {
                    mix: f32::NAN,
                    ..Settings::default()
                }
                .packed()
            )
            .mix,
            1.0
        );
    }

    #[test]
    fn soundboard_mixes_overlapping_clips_and_clears_finished_audio() {
        clear_soundboard_audio();
        assert!(!enqueue_soundboard_audio(&[], 0.5));
        assert!(!enqueue_soundboard_audio(&[1], f32::NAN));
        assert!(!enqueue_soundboard_audio(&[1], 3.01));
        assert!(enqueue_soundboard_audio(&[1000, 2000, 3000], 0.5));
        assert!(enqueue_soundboard_audio(&[500, -500], 1.0));

        let mut first = [100.0; 2];
        mix_soundboard_render(&mut first);
        assert_eq!(first, [1100.0, 600.0]);

        let mut second = [0.0; 2];
        mix_soundboard_render(&mut second);
        assert_eq!(second, [1500.0, 0.0]);
        clear_soundboard_audio();
    }

    #[test]
    fn transcription_tap_resamples_normalizes_and_gates() {
        use crate::transcription_tap as tap;
        use std::time::Duration;
        let rx = tap::subscribe();
        // Désactivé : rien ne passe.
        tap::forward(&[0.0; 480]);
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());

        tap::enable();
        // 48 kHz (480 éch.) → 16 kHz (160 éch.), échelle i16 → -1..1.
        tap::forward(&[32768.0; 480]);
        let frame = rx.recv_timeout(Duration::from_secs(1)).expect("trame 48 kHz");
        assert_eq!(frame.len(), 160);
        assert!((frame[0] - 1.0).abs() < 1e-3);

        // 16 kHz passe tel quel.
        tap::forward(&[16384.0; 160]);
        let frame = rx.recv_timeout(Duration::from_secs(1)).expect("trame 16 kHz");
        assert_eq!(frame.len(), 160);
        assert!((frame[0] - 0.5).abs() < 1e-3);

        // Micro muet : le tap se tait sans désactiver la session.
        tap::set_mic_enabled(false);
        tap::forward(&[32768.0; 480]);
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        tap::set_mic_enabled(true);
        tap::forward(&[32768.0; 480]);
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok());

        tap::disable();
        tap::forward(&[32768.0; 480]);
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        tap::unsubscribe();
    }
}
