/**
 * Denoise getUserMedia shim — intercepts every mic capture and optionally
 * wraps the audio track through RNNoise on the Rust side.
 *
 * Installed after cefAudioShim so we pick up its already-overridden
 * getUserMedia (which handles PulseAudio device switching) and add the
 * denoise step on top. Enabled/disabled at runtime by reading the setting
 * from useSettingsStore — flipping the setting affects subsequent captures,
 * and `refreshActiveMicrophone()` can be called to force the currently
 * published LiveKit track to re-capture with the new routing.
 */

import { wrapMicTrackWithDenoise } from "./denoiseService";
import { useSettingsStore } from "../stores/useSettingsStore";

let shimInstalled = false;

// getUserMedia before our denoise wrapping kicks in. cefAudioShim installs
// first, so this still goes through PulseAudio device routing — we only
// bypass the RNNoise pipeline. Exposed for the settings panel mic meter,
// which needs to analyse raw PCM samples; the denoise output is a
// MediaStreamTrackGenerator that Chromium doesn't reliably pump into a
// Web Audio AnalyserNode (the meter stays at 0).
let rawGetUserMedia:
  | ((constraints?: MediaStreamConstraints) => Promise<MediaStream>)
  | null = null;

export function getRawUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
  const fn =
    rawGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  return fn(constraints);
}

export function installDenoiseShim() {
  if (shimInstalled) return;
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  shimInstalled = true;

  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  rawGetUserMedia = original;

  navigator.mediaDevices.getUserMedia = async (
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    const stream = await original(constraints);
    if (!constraints?.audio) return stream;
    if (!useSettingsStore.getState().aiNoiseSuppression) return stream;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return stream;

    // Wrap only the first audio track. Multi-track captures are not a thing
    // in WebRTC mic flows — LiveKit always requests one.
    try {
      console.log("[Sion][denoise] shim intercepted mic getUserMedia, wrapping track…");
      const wrapped = await wrapMicTrackWithDenoise(audioTracks[0]);
      if (wrapped === audioTracks[0]) {
        console.warn("[Sion][denoise] wrap returned same track — platform unsupported, passthrough");
        return stream;
      }
      console.log("[Sion][denoise] mic wrapped successfully — RNNoise active");
      const out = new MediaStream();
      out.addTrack(wrapped);
      for (const v of stream.getVideoTracks()) out.addTrack(v);
      return out;
    } catch (err) {
      console.warn("[Sion][denoise] shim wrap failed, passthrough:", err);
      return stream;
    }
  };
}
