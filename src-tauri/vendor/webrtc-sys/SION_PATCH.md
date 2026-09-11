# Sion capture-processing extension

Based on the published `webrtc-sys` **0.3.43** crate, used by LiveKit 0.8.4.
The original sources and notices are retained. Sion modifications:

- `Cargo.toml`: optional `sion-audio` feature and local processor dependency.
- `build.rs`, `src/lib.rs`: compile/export the extension only with that feature.
- `src/peer_connection_factory.cpp`: install the capture APM builder behind
  `SION_NATIVE_AUDIO`; upstream behavior is preserved without the feature.
- `include/livekit/sion_audio.h`, `src/sion_audio.{rs,cpp}`: capture callback,
  software processing configuration, native soundboard render mixer, effective
  APM diagnostic and offline harness.
- `src/audio_device_controller.cpp`: expose an opaque index-based device ID
  when the Linux ADM enumerates named endpoints with empty GUIDs, and resolve
  that ID back to the same ADM index when selecting a device.
- `audio_track.{h,cpp,rs}`: expose the existing WebRTC
  `AudioSourceInterface::SetVolume` operation for per-share local playback
  gain. The small safe Rust forwarding method lives in `vendor/libwebrtc`.

The proxy forwards WebRTC's APM interface unchanged except for `ApplyConfig`:
AEC and digital AGC follow the application settings and built-in noise
suppression stays disabled. This also applies when the voice engine reapplies
source options after publishing or reconnecting. The actual capture and render
paths remain owned by the same WebRTC APM, preserving its echo-reference timing.

The capture post-processor calls `sion-native-audio` directly through CXX.
Its per-channel RNNoise state is owned by the capture thread. No PCM goes
through Tauri, Web Audio, an application queue or a second microphone capture.
A weak registry lets settings reach existing APM instances without retaining
ended rooms. Application settings are atomically published; APM configuration
updates are serialized outside the capture callback.

RNNoise expects 480 samples of float PCM in the signed 16-bit range. Lower-rate
APM buffers use WebRTC's sinc resamplers, constructed during initialization.
When RNNoise is off, resampling and denoising are bypassed. When enabled, the dry
branch is delayed by one 10 ms frame to align with RNNoise's output.

The render pre-processor consumes decoded 48 kHz mono soundboard clips from a
bounded native queue and mixes them before WebRTC analyzes the reverse stream.
Consequently the clip follows the selected PlatformAudio output and is included
in the AEC reference. Concurrent clips overlap and saturate safely. Encoded
media remains downloaded and decoded by the web UI; a clip crosses Tauri once
as PCM, rather than sending realtime frames over IPC.

On an SDK update, review the entire `AudioProcessing` interface against the
pinned WebRTC headers, keep every forwarding method, and run both the Rust DSP
tests and the C++/Rust offline integration tests. Do not assume that changing
`PlatformAudio::configure_audio_processing` configures the desktop software APM.

The extension changes application processing only. It does not replace the
SDK's prebuilt libwebrtc, its media transport, desktop capture or device routing.

## Diagnostic capture d'écran (Linux/Wayland)

`src/desktop_capturer.cpp` journalise sur stderr les options effectives du
capturer (`allow_pipewire`, `allow_x11`) avant `CreateScreenCapturer`. Sous
WRY, la liste des sources ne contient qu'une entrée anonyme et la capture
renvoie des erreurs temporaires en boucle : ces logs permettent de confirmer
si le backend PipeWire (portail XDG) a bien été retenu ou si le binaire est
retombé sur X11, qui ne voit rien sous Wayland natif.
