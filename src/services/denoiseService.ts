/**
 * RNNoise audio denoise — Web Audio + AudioWorklet (WASM) implementation.
 *
 * Takes a raw mic MediaStreamTrack and returns a new track whose samples have
 * been routed through RNNoise running entirely inside an AudioWorklet (the
 * real-time audio thread). When the platform lacks AudioWorklet the source
 * track is returned unchanged — callers don't need to branch.
 *
 * Pipeline (OFF the main thread, NO IPC):
 *   mic track → MediaStreamAudioSourceNode
 *             → RnnoiseWorkletNode (WASM RNNoise, audio render thread)  ─┐ wet
 *             → DelayNode (≈frame latency) ───────────────────────────── ┘ dry
 *             → wet/dry gains → MediaStreamAudioDestinationNode → LiveKit
 *
 * This replaces the previous design (MediaStreamTrackProcessor read loop on the
 * MAIN thread + a per-frame Tauri IPC round-trip to a Rust RNNoise worker).
 * That burned 2-3 cores on the main thread and competed with WebRTC's event
 * loop, which could stall ICE keepalives and drop the peer connection. The
 * worklet runs on the dedicated audio thread with no IPC, so the main thread —
 * and ICE — stay free. Same RNNoise model, same quality.
 *
 * Powered by @sapphi-red/web-noise-suppressor (RNNoise WASM + worklet, MIT).
 */

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { useSettingsStore } from "../stores/useSettingsStore";

const SAMPLE_RATE = 48000;
// RNNoise works on 480-sample (10 ms) frames; the worklet buffers to that
// boundary, so the denoised (wet) path lags the input by ~one frame. Delay the
// dry path by the same amount so a partial mix doesn't comb-filter.
const FRAME_LATENCY_S = 480 / SAMPLE_RATE;

function audioWorkletSupported(): boolean {
  return typeof AudioContext !== "undefined"
    && typeof AudioWorkletNode !== "undefined"
    && "audioWorklet" in AudioContext.prototype;
}

// Shared across captures: one 48 kHz context + one wasm binary + one registered
// worklet module. Creating an AudioContext per capture is expensive and CEF
// caps the number of live contexts.
let sharedCtx: AudioContext | null = null;
let wasmBinary: ArrayBuffer | null = null;
let workletModuleAdded = false;

async function ensureGraph(): Promise<AudioContext> {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (sharedCtx.state === "suspended") {
    try { await sharedCtx.resume(); } catch { /* ignore */ }
  }
  if (!wasmBinary) {
    wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  if (!workletModuleAdded) {
    await sharedCtx.audioWorklet.addModule(rnnoiseWorkletUrl);
    workletModuleAdded = true;
  }
  return sharedCtx;
}

interface ActiveWrap {
  rnnoise: RnnoiseWorkletNode;
  wetGain: GainNode;
  dryGain: GainNode;
  teardown: () => void;
}
let active: ActiveWrap | null = null;

function applyMix(wrap: ActiveWrap, mix: number) {
  const m = Math.max(0, Math.min(1, mix));
  const t = sharedCtx ? sharedCtx.currentTime : 0;
  wrap.wetGain.gain.setValueAtTime(m, t);
  wrap.dryGain.gain.setValueAtTime(1 - m, t);
}

/** Live-update the wet/dry balance of the active wrap (no mic re-capture). */
export function setDenoiseMix(mix: number) {
  if (active) applyMix(active, mix);
}

/** No-op kept for API compatibility (the graph is built lazily per capture). */
export async function enableDenoise(): Promise<void> { /* nothing to prime */ }

/** Tear down the active wrap. Called when the user turns AI-NS off; the mic is
 *  re-captured in parallel (refreshMicrophoneForDenoise) so the published track
 *  becomes the raw passthrough. */
export async function disableDenoise(): Promise<void> {
  if (active) {
    try { active.teardown(); } catch { /* ignore */ }
    active = null;
  }
}

/** Wrap a mic track with RNNoise. Returns the input track unchanged when the
 *  platform lacks AudioWorklet (e.g. very old WebView). */
export async function wrapMicTrackWithDenoise(source: MediaStreamTrack): Promise<MediaStreamTrack> {
  if (!audioWorkletSupported()) {
    console.warn("[Sion][denoise] AudioWorklet unavailable — passthrough");
    return source;
  }
  try {
    const ctx = await ensureGraph();

    // Only one wrap at a time — tear down any previous graph (a mic re-capture
    // leaves the old one otherwise).
    await disableDenoise();

    const srcNode = ctx.createMediaStreamSource(new MediaStream([source]));
    // maxChannels: 2 so a stereo capture (musicStereo preset) keeps its stereo
    // image — RNNoise runs once per channel. A mono mic (the voice presets)
    // only ever feeds one channel, so this costs nothing in the common case.
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 2, wasmBinary: wasmBinary! });
    const dryDelay = ctx.createDelay(1);
    dryDelay.delayTime.value = FRAME_LATENCY_S;
    const wetGain = ctx.createGain();
    const dryGain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();

    // wet: src → rnnoise → wetGain → dest
    srcNode.connect(rnnoise);
    rnnoise.connect(wetGain);
    wetGain.connect(dest);
    // dry: src → delay → dryGain → dest (latency-matched, for partial mixes)
    srcNode.connect(dryDelay);
    dryDelay.connect(dryGain);
    dryGain.connect(dest);

    const outTrack = dest.stream.getAudioTracks()[0];

    const teardown = () => {
      try { srcNode.disconnect(); } catch { /* ignore */ }
      try { rnnoise.disconnect(); } catch { /* ignore */ }
      try { rnnoise.destroy(); } catch { /* ignore */ }
      try { dryDelay.disconnect(); } catch { /* ignore */ }
      try { wetGain.disconnect(); } catch { /* ignore */ }
      try { dryGain.disconnect(); } catch { /* ignore */ }
      try { dest.disconnect(); } catch { /* ignore */ }
      // Stop the raw source so the underlying mic track doesn't linger.
      try { source.stop(); } catch { /* ignore */ }
    };

    const wrap: ActiveWrap = { rnnoise, wetGain, dryGain, teardown };
    applyMix(wrap, useSettingsStore.getState().aiNoiseSuppressionMix);
    active = wrap;

    // LiveKit stops the generated track on unpublish (mute/disable/device
    // switch) → "ended" fires → cascade teardown. The source's own "ended"
    // (mic stopped) covers the other direction.
    outTrack.addEventListener("ended", () => { if (active?.rnnoise === rnnoise) disableDenoise(); }, { once: true });
    source.addEventListener("ended", () => { if (active?.rnnoise === rnnoise) disableDenoise(); }, { once: true });

    console.log("[Sion][denoise] RNNoise worklet active (AudioWorklet, off main thread, no IPC)");
    return outTrack;
  } catch (err) {
    console.warn("[Sion][denoise] worklet wrap failed, passthrough:", err);
    return source;
  }
}
