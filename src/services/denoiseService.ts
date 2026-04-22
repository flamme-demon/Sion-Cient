/**
 * RNNoise audio denoise bridge.
 *
 * Takes a raw mic MediaStreamTrack captured at 48 kHz mono and returns a
 * new MediaStreamTrack whose samples have been routed through the Rust-side
 * RNNoise worker (via `nnnoiseless`). When the filter is off (or
 * unavailable) the source track is returned as-is — callers don't need to
 * branch.
 *
 * Pipeline (all main thread, no AudioWorklet):
 *   source track → MediaStreamTrackProcessor → async read loop
 *                                                 → accumulate 480 samples
 *                                                 → invoke('denoise_process_frame')
 *                                                 → write AudioData
 *   → MediaStreamTrackGenerator → filtered track → LiveKit.publish
 *
 * MediaStreamTrackProcessor / Generator are WebCodecs APIs. They are
 * available in Chromium 94+ (so in CEF and WebView modern Android). Safari
 * lacks them entirely — we fall back to passthrough on detection.
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/useSettingsStore";

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480; // 10 ms at 48 kHz

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MSTP = typeof globalThis extends { MediaStreamTrackProcessor: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MSTG = typeof globalThis extends { MediaStreamTrackGenerator: infer T } ? T : any;

function hasWebCodecsAudio(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  return typeof g.MediaStreamTrackProcessor === "function"
    && typeof g.MediaStreamTrackGenerator === "function"
    && typeof g.AudioData === "function";
}

function isTauri(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
}

let enabledOnRust = false;
// Only one mic pump should be active at a time. Each wrap call overwrites
// this, and the previous pump signals `stop()` → its loops exit within a
// few ms. Without this, a mic re-capture (LiveKit setMic false/true cycle)
// leaves the previous pump running in parallel, halving IPC throughput and
// causing chopped audio on the receiving side.
let activePumpCancel: (() => void) | null = null;

/** Prime the Rust-side worker. Idempotent. */
export async function enableDenoise(): Promise<void> {
  if (!isTauri()) throw new Error("denoise: Tauri not available");
  if (enabledOnRust) return;
  await invoke("denoise_enable");
  // Sync the persisted mix to Rust — otherwise the worker stays at its 1.0
  // default until the user touches the slider again.
  try {
    await invoke("denoise_set_mix", { mix: useSettingsStore.getState().aiNoiseSuppressionMix });
  } catch { /* not critical */ }
  enabledOnRust = true;
}

/** Tear down the Rust-side worker. Running tracks still flow through invoke
 *  but return passthrough (cheap), so there's no need to rebuild tracks on
 *  the fly when toggling off mid-call. The pump's teardown is driven by the
 *  generator's `ended` event (fired when LK stops it on unpublish), not from
 *  here — avoids racing refreshMicrophoneForDenoise. */
export async function disableDenoise(): Promise<void> {
  if (!isTauri() || !enabledOnRust) return;
  try {
    await invoke("denoise_disable");
  } catch { /* best-effort */ }
  enabledOnRust = false;
}

/** Wrap a mic track with RNNoise denoise. Returns the input track
 *  unchanged when the platform doesn't support WebCodecs audio or Tauri IPC
 *  is absent (browser preview). */
export async function wrapMicTrackWithDenoise(source: MediaStreamTrack): Promise<MediaStreamTrack> {
  if (!isTauri() || !hasWebCodecsAudio()) {
    console.warn("[Sion][denoise] platform does not support AI noise suppression — passthrough");
    return source;
  }
  try {
    await enableDenoise();
  } catch (err) {
    console.warn("[Sion][denoise] enable failed, passthrough:", err);
    return source;
  }

  // Cancel any previous pump still alive (old mic track not yet stopped by
  // the SDK). Without this, several pumps pipe into the same Rust worker
  // serially and divide throughput, which the peer perceives as chopped /
  // accelerated voice.
  if (activePumpCancel) {
    try { activePumpCancel(); } catch { /* ignore */ }
    activePumpCancel = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const processor = new (g.MediaStreamTrackProcessor as MSTP)({ track: source });
  const generator = new (g.MediaStreamTrackGenerator as MSTG)({ kind: "audio" });
  const reader = (processor as { readable: ReadableStream }).readable.getReader();
  const writer = (generator as { writable: WritableStream }).writable.getWriter();

  // Batch N frames of 480 samples per IPC call. The real cost isn't JSON
  // serialization — Tauri's CEF custom-protocol IPC has a fixed per-call
  // overhead on Chrome_IO threads (~10 ms observed under load). At 25 calls/s
  // (batch=4) that alone burns ~2-3 cores and starves the ORT worker. Bigger
  // batches amortize the per-call cost: batch=8 cuts IPC rate to 12.5/s and
  // frees the CPU for inference. Trade-off: 80 ms of end-to-end latency —
  // still well under the 100 ms voice threshold for natural conversation.
  const BATCH_FRAMES = 8;
  const BATCH_SIZE = FRAME_SIZE * BATCH_FRAMES;
  // Ring buffer sized for multiple batches so we can keep draining MSTP while
  // the previous IPC is in flight (otherwise MSTP's internal queue overflows
  // and Chromium silently drops audio → voice sounds chipmunky / accelerated).
  const buffer = new Float32Array(BATCH_SIZE * 8);
  let bufferFill = 0;
  let firstInputTimestamp: number | null = null;
  let sampleCursor = 0; // running sample count for output timestamps
  let stopped = false;

  let framesProcessed = 0;
  let framesBypassed = 0;
  let sampleRateLogged = false;
  const startedAt = performance.now();

  const flushBatch = async (batch: Float32Array, baseTimestampUs: number) => {
    // Binary IPC: pass the Float32Array directly. Tauri's
    // `process-ipc-message-fn` detects `ArrayBuffer.isView(batch)` and sets
    // Content-Type to `application/octet-stream` — no `Array.from`, no JSON
    // encoding, no numeric-array deserialization on the Rust side. Response
    // comes back as `ArrayBuffer` because the Rust handler returns
    // `Response::new(Vec<u8>)`.
    let outBuf: ArrayBuffer | null = null;
    try {
      // Tauri's InvokeArgs accepts Uint8Array but not Float32Array. Cast to
      // a Uint8Array VIEW over the same buffer — zero-copy, identical bytes
      // on the wire, Rust still receives the raw f32 samples it expects.
      const payload = new Uint8Array(batch.buffer, batch.byteOffset, batch.byteLength);
      outBuf = await invoke<ArrayBuffer>("denoise_process_frame", payload);
    } catch (err) {
      framesBypassed += BATCH_FRAMES;
      console.warn("[Sion][denoise] process error, passthrough:", err);
    }
    const okLen = outBuf !== null && outBuf.byteLength === batch.byteLength;
    const outArr = okLen ? new Float32Array(outBuf!) : batch;
    if (okLen) framesProcessed += BATCH_FRAMES;

    // Health log every ~5s (~500 frames / 250 batches).
    if ((framesProcessed + framesBypassed) % 500 === 0 && (framesProcessed + framesBypassed) > 0) {
      let rmsIn = 0, rmsOut = 0;
      for (let i = 0; i < batch.length; i++) rmsIn += batch[i] * batch[i];
      for (let i = 0; i < outArr.length; i++) rmsOut += outArr[i] * outArr[i];
      rmsIn = Math.sqrt(rmsIn / batch.length);
      rmsOut = Math.sqrt(rmsOut / outArr.length);
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      const fps = ((framesProcessed + framesBypassed) / (performance.now() - startedAt) * 1000).toFixed(1);
      const atten = rmsIn > 0.0001 ? (20 * Math.log10(rmsOut / rmsIn)).toFixed(1) : "n/a";
      console.log(`[Sion][denoise] ${elapsed}s ${fps}fps: ${framesProcessed} processed, ${framesBypassed} bypassed — in=${rmsIn.toFixed(4)} out=${rmsOut.toFixed(4)} Δ=${atten}dB`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AudioDataCtor = (globalThis as any).AudioData;
    // Emit each 480-sample frame with its own timestamp so the consumer's
    // jitter buffer sees smooth real-time pacing.
    for (let i = 0; i < BATCH_FRAMES; i++) {
      const start = i * FRAME_SIZE;
      const end = start + FRAME_SIZE;
      const frameData = outArr.subarray(start, end);
      const ts = baseTimestampUs + Math.round((i * FRAME_SIZE / SAMPLE_RATE) * 1_000_000);
      const audioData = new AudioDataCtor({
        format: "f32",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME_SIZE,
        numberOfChannels: 1,
        timestamp: ts,
        data: frameData,
      });
      try {
        await writer.write(audioData);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };

  // Producer-consumer decoupling: the reader loop drains MSTP into `buffer`
  // as fast as Chromium delivers it, the processor loop drains `buffer` via
  // IPC. They don't await each other, which is what lets us stay at 100+ fps
  // end-to-end even if one IPC call blocks for >10 ms.
  const readerLoop = async () => {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = value as any;
      if (!sampleRateLogged) {
        console.log(`[Sion][denoise] input rate=${data.sampleRate}Hz ch=${data.numberOfChannels} fmt=${data.format} chunk=${data.numberOfFrames}`);
        sampleRateLogged = true;
      }
      const numFrames: number = data.numberOfFrames;
      const channels: number = data.numberOfChannels;
      if (firstInputTimestamp === null) firstInputTimestamp = data.timestamp;
      const tmp = new Float32Array(numFrames);
      if (channels === 1) {
        data.copyTo(tmp, { planeIndex: 0, frameCount: numFrames });
      } else {
        const chA = new Float32Array(numFrames);
        const chB = new Float32Array(numFrames);
        data.copyTo(chA, { planeIndex: 0, frameCount: numFrames });
        data.copyTo(chB, { planeIndex: 1, frameCount: numFrames });
        for (let i = 0; i < numFrames; i++) tmp[i] = 0.5 * (chA[i] + chB[i]);
      }
      data.close?.();

      if (bufferFill + tmp.length > buffer.length) {
        // Overflow: drop oldest samples, shift to make room. Better than
        // dropping new samples (which breaks timing).
        const shift = bufferFill + tmp.length - buffer.length;
        buffer.copyWithin(0, shift, bufferFill);
        bufferFill -= shift;
      }
      buffer.set(tmp, bufferFill);
      bufferFill += tmp.length;
    }
  };

  const processorLoop = async () => {
    console.log(`[Sion][denoise] pump started (batch=${BATCH_FRAMES} frames)`);
    while (!stopped) {
      if (bufferFill < BATCH_SIZE) {
        // Starved — yield the event loop briefly for the reader to fill us.
        await new Promise((r) => setTimeout(r, 2));
        continue;
      }
      const batch = buffer.slice(0, BATCH_SIZE);
      buffer.copyWithin(0, BATCH_SIZE, bufferFill);
      bufferFill -= BATCH_SIZE;
      const timestampUs = Math.round((sampleCursor / SAMPLE_RATE) * 1_000_000)
        + (firstInputTimestamp ?? 0);
      sampleCursor += BATCH_SIZE;
      await flushBatch(batch, timestampUs);
    }
    try { await writer.close(); } catch { /* already closed */ }
  };

  Promise.all([readerLoop(), processorLoop()]).then(() => {
    console.log(`[Sion][denoise] pump finished (${framesProcessed} processed, ${framesBypassed} bypassed)`);
  }).catch((err) => {
    const msg = err?.message || String(err);
    if (msg.includes("Stream closed") || msg.includes("InvalidStateError")) {
      console.log(`[Sion][denoise] pump stopped on track close (${framesProcessed} processed)`);
    } else {
      console.warn("[Sion][denoise] pump error:", err);
    }
  });

  const cancel = () => {
    stopped = true;
    try { reader.cancel(); } catch { /* ignore */ }
    try { writer.close(); } catch { /* ignore */ }
    // Stop the raw source too. LiveKit only stops the generator it holds,
    // so without this the underlying mic track stays alive forever and the
    // next toggle off→on leaves both the old pump's dangling source and
    // the new wrap's source running in parallel — each pump fighting for
    // the same Rust IPC slot, halving throughput (observed as fps
    // dropping into the 60–80 range under back-to-back toggles).
    try { source.stop(); } catch { /* ignore */ }
  };
  source.addEventListener("ended", cancel);
  // LiveKit stops the generator when it unpublishes the mic (setMicrophoneEnabled(false)).
  // Piggyback on that signal to cascade cleanup: stopping the generator fires "ended",
  // our handler runs cancel, which stops the source and exits the loops. Works for
  // all off-paths (explicit disable, reconnect, device switch) without racing the
  // disableDenoise command. The "once" option makes this safe even if cancel also
  // closes the writer (which would fire "ended" a second time).
  (generator as MediaStreamTrack).addEventListener("ended", cancel, { once: true });
  activePumpCancel = cancel;

  return generator as MediaStreamTrack;
}
