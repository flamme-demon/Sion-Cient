//! Optional Sion extension: post-process ADM capture inside WebRTC's APM.
//! This avoids a second capture, render-reference reconstruction and PCM IPC.
pub struct CaptureProcessor {
    inner: Box<sion_native_audio::CaptureProcessor>,
}
pub fn new_capture_processor() -> Box<CaptureProcessor> {
    Box::new(CaptureProcessor {
        inner: sion_native_audio::new_capture_processor(),
    })
}
impl CaptureProcessor {
    pub fn initialize(&mut self, channels: usize) {
        self.inner.initialize(channels);
    }
    pub fn process_channel(&mut self, channel: usize, samples: &mut [f32]) {
        self.inner.process_channel(channel, samples);
    }
}

#[cxx::bridge(namespace = "livekit_ffi")]
pub mod ffi {
    struct CaptureSettings {
        echo_cancellation: bool,
        auto_gain_control: bool,
        noise_suppression: bool,
    }
    struct CaptureProcessingStatus {
        instances: usize,
        echo_cancellation: bool,
        auto_gain_control: bool,
        webrtc_noise_suppression: bool,
    }
    extern "Rust" {
        type CaptureProcessor;
        fn new_capture_processor() -> Box<CaptureProcessor>;
        fn initialize(self: &mut CaptureProcessor, channels: usize);
        fn process_channel(self: &mut CaptureProcessor, channel: usize, samples: &mut [f32]);
        fn capture_settings() -> CaptureSettings;
        fn mix_soundboard_render(samples: &mut [f32]);
        fn enqueue_soundboard_audio_rs(samples: &[i16], gain: f32) -> bool;
        fn clear_soundboard_audio_rs();
    }
    unsafe extern "C++" {
        include!("livekit/sion_audio.h");
        fn configure_capture_processing();
        fn capture_processing_status() -> CaptureProcessingStatus;
        fn queue_soundboard_audio(samples: &[i16], gain: f32) -> bool;
        fn clear_soundboard_audio();
        // Offline diagnostic: run the same APM as the ADM without opening devices.
        fn process_capture_audio(input: &[f32], render: &[f32], sample_rate: u32) -> Vec<f32>;
    }
}

fn mix_soundboard_render(samples: &mut [f32]) {
    sion_native_audio::mix_soundboard_render(samples);
}
fn enqueue_soundboard_audio_rs(samples: &[i16], gain: f32) -> bool {
    sion_native_audio::enqueue_soundboard_audio(samples, gain)
}
fn clear_soundboard_audio_rs() {
    sion_native_audio::clear_soundboard_audio();
}
fn capture_settings() -> ffi::CaptureSettings {
    let options = sion_native_audio::settings();
    ffi::CaptureSettings {
        echo_cancellation: options.echo_cancellation,
        auto_gain_control: options.auto_gain_control,
        noise_suppression: options.noise_suppression,
    }
}
