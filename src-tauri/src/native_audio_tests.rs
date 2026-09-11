//! End-to-end DSP tests across the same C++/Rust APM bridge used by capture.
//! No audio device or SFU is required.
use crate::voice_native::NativeAudioProcessing;
use webrtc_sys::sion_audio::ffi::{
    clear_soundboard_audio, process_capture_audio, queue_soundboard_audio,
};

#[test]
fn native_audio_bridge_filters_noise_and_honors_disabled_processing() {
    for rate in [16000, 32000, 48000] {
        let mut seed = 42_u32;
        let input: Vec<f32> = (0..rate * 2)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 16) as f32 / 65535.0 - 0.5) * 0.1
            })
            .collect();
        let mut options = NativeAudioProcessing {
            echo_cancellation: false,
            auto_gain_control: false,
            noise_suppression: false,
            mix: 1.0,
        };
        options.apply().unwrap();
        let dry = process_capture_audio(&input, &[], rate);
        assert_eq!(
            dry.len(),
            input.len(),
            "APM configuration / frame processing failed at {rate} Hz"
        );
        let max_error = input
            .iter()
            .zip(&dry)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_error < 0.0001,
            "processing OFF changes audio at {rate} Hz: {max_error}"
        );
        options.noise_suppression = true;
        options.apply().unwrap();
        let wet = process_capture_audio(&input, &[], rate);
        assert_eq!(wet.len(), input.len());
        assert!(wet.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
        let input_energy: f32 = input[rate as usize..].iter().map(|x| x * x).sum();
        let output_energy: f32 = wet[rate as usize..].iter().map(|x| x * x).sum();
        assert!(
            output_energy < input_energy * 0.7,
            "RNNoise did not suppress noise at {rate} Hz: {output_energy}/{input_energy}"
        );
        // The offline harness deliberately reapplies contradictory SDK defaults.
        // A nonempty result means both AEC and AGC remained at the requested values.
        options.echo_cancellation = true;
        options.auto_gain_control = true;
        options.apply().unwrap();
        assert_eq!(
            process_capture_audio(&input[..rate as usize / 10], &[], rate).len(),
            rate as usize / 10
        );
    }
    // Pure echo: the microphone hears only the render reference at reduced gain.
    // Verify that the proxy still forwards the reference to WebRTC's canceller.
    let rate = 48000;
    let mut seed = 123_u32;
    let render: Vec<f32> = (0..rate * 3)
        .map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 16) as f32 / 65535.0 - 0.5) * 0.2
        })
        .collect();
    let microphone: Vec<f32> = render.iter().map(|x| x * 0.6).collect();
    NativeAudioProcessing {
        echo_cancellation: true,
        auto_gain_control: false,
        noise_suppression: false,
        mix: 1.0,
    }
    .apply()
    .unwrap();
    let cancelled = process_capture_audio(&microphone, &render, rate);
    assert_eq!(cancelled.len(), microphone.len());
    let from = (rate * 2) as usize;
    let input_energy: f32 = microphone[from..].iter().map(|x| x * x).sum();
    let output_energy: f32 = cancelled[from..].iter().map(|x| x * x).sum();
    assert!(
        output_energy < input_energy * 0.3,
        "render reference no longer cancels echo: {output_energy}/{input_energy}"
    );

    // Same echo test with no explicit render input: the soundboard render
    // pre-processor supplies both speaker audio and the AEC reference.
    clear_soundboard_audio();
    let soundboard_pcm: Vec<i16> = render
        .iter()
        .map(|sample| (sample * 32767.0).round() as i16)
        .collect();
    assert!(queue_soundboard_audio(&soundboard_pcm, 1.0));
    let soundboard_cancelled = process_capture_audio(&microphone, &[], rate);
    assert_eq!(soundboard_cancelled.len(), microphone.len());
    let soundboard_energy: f32 = soundboard_cancelled[from..].iter().map(|x| x * x).sum();
    assert!(
        soundboard_energy < input_energy * 0.3,
        "soundboard was not included in AEC reference: {soundboard_energy}/{input_energy}"
    );
    clear_soundboard_audio();
    NativeAudioProcessing::default().apply().unwrap();
}

#[test]
fn native_audio_processing_rejects_invalid_mix_and_accepts_frontend_shape() {
    let options: NativeAudioProcessing = serde_json::from_value(serde_json::json!({
        "echoCancellation": false, "autoGainControl": true, "noiseSuppression": true, "mix": 0.4,
    }))
    .unwrap();
    assert!(!options.echo_cancellation);
    assert!(options.auto_gain_control);
    assert!(options.validate().is_ok());
    for mix in [f32::NAN, f32::INFINITY, -0.01, 1.01] {
        assert!(NativeAudioProcessing { mix, ..options }.validate().is_err());
    }
}

#[test]
fn liste_des_encodeurs_video_disponibles() {
    use livekit::options::VideoEncoderBackend;
    let backends: Vec<VideoEncoderBackend> = VideoEncoderBackend::list_available().into_iter().collect();
    eprintln!("[test] encodeurs vidéo disponibles: {backends:?}");
}
