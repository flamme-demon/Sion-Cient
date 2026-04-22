// System-audio capture bridge — Linux screen-share-audio workaround.
//
// Linux/Chromium can't capture system audio via getDisplayMedia (the KDE
// portal doesn't offer it, and PulseAudio monitor sources are filtered out
// of enumerateDevices). So we ask the Rust side to spawn `parec` on a sink's
// monitor, stream float32 stereo 48 kHz samples over a local WebSocket, and
// reassemble a MediaStreamTrack here that LiveKit publishes as
// ScreenShareAudio. See src-tauri/src/system_audio.rs for the capture side.
//
// On non-Linux the Tauri commands return an error; callers should branch
// before invoking and fall back to the portal path.

import { invoke } from "@tauri-apps/api/core";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// Inline AudioWorklet: ring buffers the interleaved f32 samples shipped over
// WS and hands them out at the 128-sample quantum cadence. Underruns emit
// silence (quietly — no log spam) rather than stuttering.
//
// We cap the buffer at ~500 ms of audio (24_000 stereo samples per channel =
// 48_000 interleaved). If packets burst in faster than real-time for any
// reason (reconnect backlog, GC pause on the main thread), we drop the oldest
// samples to catch up. That's preferable to ever-growing latency.
const WORKLET_SRC = `
class SionSystemAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    // Interleaved ring buffer, float32 LR LR LR…
    this.buf = new Float32Array(48000); // 0.5 s stereo interleaved
    this.readIdx = 0;
    this.writeIdx = 0;
    this.size = 0;
    this.cap = this.buf.length;
    this.dropped = 0;
    this.port.onmessage = (e) => {
      const payload = e.data;
      if (!(payload instanceof Float32Array)) return;
      const n = payload.length;
      if (n === 0) return;
      // If incoming would overflow, advance readIdx to keep the most recent.
      if (this.size + n > this.cap) {
        const overflow = this.size + n - this.cap;
        this.readIdx = (this.readIdx + overflow) % this.cap;
        this.size -= overflow;
        this.dropped += overflow;
      }
      // Copy in, wrapping at the end.
      const tailSpace = this.cap - this.writeIdx;
      if (n <= tailSpace) {
        this.buf.set(payload, this.writeIdx);
        this.writeIdx = (this.writeIdx + n) % this.cap;
      } else {
        this.buf.set(payload.subarray(0, tailSpace), this.writeIdx);
        this.buf.set(payload.subarray(tailSpace), 0);
        this.writeIdx = n - tailSpace;
      }
      this.size += n;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    // Expect stereo. Browsers pass [Float32Array(128), Float32Array(128)].
    const qL = out[0];
    const qR = out.length > 1 ? out[1] : out[0];
    const quantum = qL.length;
    const needed = quantum * 2; // interleaved samples to produce 128 frames
    if (this.size < needed) {
      // Underrun: emit silence. Keep processing so the node stays alive.
      qL.fill(0);
      qR.fill(0);
      return true;
    }
    for (let i = 0; i < quantum; i++) {
      qL[i] = this.buf[this.readIdx];
      qR[i] = this.buf[(this.readIdx + 1) % this.cap];
      this.readIdx = (this.readIdx + 2) % this.cap;
    }
    this.size -= needed;
    return true;
  }
}
registerProcessor('sion-system-audio', SionSystemAudio);
`;

interface Capture {
  track: MediaStreamTrack;
  stop: () => Promise<void>;
}

let current: Capture | null = null;

export async function listMonitorSinks(): Promise<Array<{ id: string; label: string }>> {
  try {
    const sinks = await invoke<[string, string][]>("system_audio_list_sinks");
    return sinks.map(([id, label]) => ({ id, label }));
  } catch (e) {
    console.warn("[Sion][sysaudio] list_sinks failed:", e);
    return [];
  }
}

/**
 * Start capturing the given sink's monitor (or the default sink's when
 * `sinkMonitor` is undefined) and return a MediaStreamTrack fed by those
 * samples. If a capture is already active, it is stopped first.
 */
export async function startSystemAudioCapture(sinkMonitor?: string): Promise<MediaStreamTrack> {
  if (current) {
    await current.stop();
    current = null;
  }

  const port = await invoke<number>("system_audio_start", { sinkMonitor: sinkMonitor ?? null });
  if (!port) throw new Error("system_audio_start returned port 0");

  // Explicit sampleRate matches parec's output so we never need to resample
  // in the audio graph — MediaStreamAudioDestinationNode runs at the context
  // rate, which matters for Opus encoding downstream.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });

  // The browser requires user gesture for some contexts to auto-resume; it's
  // a no-op for one already running. Screen share is triggered by a click so
  // the context can resume without issue.
  if (ctx.state === "suspended") await ctx.resume();

  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const workletNode = new AudioWorkletNode(ctx, "sion-system-audio", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [CHANNELS],
  });

  // Destination node produces a MediaStream with one stereo track. LiveKit's
  // LocalAudioTrack wraps the track directly; no need for a separate stream.
  const dest = ctx.createMediaStreamDestination();
  workletNode.connect(dest);

  const wsUrl = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const connected = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("WS error")); }, { once: true });
  });
  await connected;

  ws.addEventListener("message", (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const samples = new Float32Array(ev.data);
    // Transfer to the worklet — no structured-clone cost, just pointer.
    workletNode.port.postMessage(samples, [samples.buffer]);
  });

  ws.addEventListener("close", () => {
    console.info("[Sion][sysaudio] WS closed");
  });

  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    ws.close();
    try { await ctx.close(); } catch { /* best-effort */ }
    await invoke("system_audio_stop");
    throw new Error("no audio track from destination node");
  }
  // Label the track so DevTools/logs show something meaningful.
  try {
    Object.defineProperty(track, "label", { value: "Sion system audio", configurable: true });
  } catch { /* read-only on some browsers */ }

  const stop = async () => {
    try { ws.close(); } catch { /* already closed */ }
    try { workletNode.disconnect(); } catch { /* unconnected */ }
    try { await ctx.close(); } catch { /* already closed */ }
    try { track.stop(); } catch { /* already stopped */ }
    try { await invoke("system_audio_stop"); } catch (e) {
      console.warn("[Sion][sysaudio] stop invoke failed:", e);
    }
  };

  current = { track, stop };
  console.info("[Sion][sysaudio] capture running on WS port", port);
  return track;
}

export async function stopSystemAudioCapture(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.stop();
}

export function isSystemAudioSupported(): boolean {
  // Linux-only — the commands are stubbed on other platforms.
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Linux");
}
