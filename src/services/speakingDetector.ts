/**
 * Client-side speaking detector using Web Audio API.
 *
 * Bypasses LiveKit SFU's server-side smoothing (~1.6s by default) to detect
 * speaking state with sub-100ms latency. Computes RMS over the audio buffer
 * at a fixed interval and applies hysteresis to avoid flickering.
 */

const POLL_INTERVAL_MS = 50;
const FFT_SIZE = 512;

// RMS thresholds with hysteresis. Calibrated for LiveKit-processed audio
// (noise suppression + AGC), which compresses voice samples to ~0.001-0.01
// even at normal speaking volume. Empirical from production logs.
const RMS_START = 0.003;
const RMS_SILENCE = 0.0015;

// Require N consecutive ticks above/below threshold before flipping state.
// 1 tick + hysteresis is enough to filter clicks while staying snappy.
const STATE_FLIP_TICKS = 1;

export class SpeakingDetector {
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private silentGain: GainNode | null = null;
  // tsconfig has erasableSyntaxOnly enabled, so we can't use parameter
  // properties — declare the fields explicitly. The Float32Array is also
  // explicitly typed against ArrayBuffer (not ArrayBufferLike) to keep
  // strict TS happy when calling getFloatTimeDomainData.
  private buffer: Float32Array<ArrayBuffer>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentSpeaking = false;
  private flipCounter = 0;
  private readonly stream: MediaStream;
  private readonly onChange: (isSpeaking: boolean) => void;

  constructor(stream: MediaStream, onChange: (isSpeaking: boolean) => void) {
    this.stream = stream;
    this.onChange = onChange;
    this.buffer = new Float32Array(new ArrayBuffer(FFT_SIZE * 4));
  }

  start(): void {
    if (this.intervalId !== null) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx();
      // CEF / Chromium often spawn the context in "suspended" state when not
      // created from a direct user gesture. Force resume so samples flow.
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume().catch(() => { /* ignore */ });
      }
      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.2;

      // Chromium quirk: a MediaStreamAudioSourceNode built from a REMOTE track
      // (RTCPeerConnection) won't pump samples into the graph unless the chain
      // terminates at audioCtx.destination. We route through a 0-gain node so
      // the engine pulls data without doubling the playback.
      this.silentGain = this.audioCtx.createGain();
      this.silentGain.gain.value = 0;
      this.source.connect(this.analyser);
      this.analyser.connect(this.silentGain);
      this.silentGain.connect(this.audioCtx.destination);

      this.intervalId = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    } catch (err) {
      console.warn("[Sion] SpeakingDetector failed to start:", err);
      this.stop();
    }
  }

  private tick(): void {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buffer);

    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = this.buffer[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);

    // Hysteresis: which threshold applies depends on the current state
    const threshold = this.currentSpeaking ? RMS_SILENCE : RMS_START;
    const wantSpeaking = rms > threshold;

    if (wantSpeaking !== this.currentSpeaking) {
      this.flipCounter++;
      if (this.flipCounter >= STATE_FLIP_TICKS) {
        this.currentSpeaking = wantSpeaking;
        this.flipCounter = 0;
        this.onChange(wantSpeaking);
      }
    } else {
      this.flipCounter = 0;
    }
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    try {
      this.source?.disconnect();
    } catch { /* ignore */ }
    try {
      this.analyser?.disconnect();
    } catch { /* ignore */ }
    try {
      this.silentGain?.disconnect();
    } catch { /* ignore */ }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      this.audioCtx.close().catch(() => { /* ignore */ });
    }
    this.source = null;
    this.analyser = null;
    this.silentGain = null;
    this.audioCtx = null;
    if (this.currentSpeaking) {
      this.currentSpeaking = false;
      this.onChange(false);
    }
  }
}
