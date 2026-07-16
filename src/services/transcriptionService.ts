/**
 * Meeting transcription — JS side (desktop/Tauri only).
 *
 * Taps the LiveKit microphone track (the SAME track the call publishes, so
 * we inherit echo cancellation/noise suppression and never open the device
 * twice), resamples to 16 kHz mono via a dedicated AudioContext, and streams
 * f32 PCM over a local WebSocket to the Rust whisper engine
 * (`src-tauri/src/transcribe.rs`). Incoming `segment` messages are published
 * to the voice channel's Matrix room as `com.sion.transcript` events — every
 * participant (transcribing or not) renders them live in the panel.
 *
 * MUTE CONTRACT: the tap stops forwarding audio the instant `isMuted` or
 * `isDeafened` flips on (a `flush` control closes the in-flight segment so
 * the words spoken right before the mute are still transcribed). Muted audio
 * therefore never reaches the model — nothing to display, nothing published.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranscriptStore } from "../stores/useTranscriptStore";
import { getLocalMicMediaStreamTrack } from "./livekitService";
import * as matrixService from "./matrixService";

/** ~200 ms of 16 kHz audio per WS frame — small enough for low latency,
 *  large enough to keep message overhead negligible. */
const BATCH_SAMPLES = 3200;

function isTauri(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Minimal inline AudioWorklet: forwards each 128-sample render quantum of
 *  channel 0 to the main thread. Inlined as a Blob so we don't need a
 *  separate asset served next to the bundle. */
const TAP_WORKLET = `
class SionTranscribeTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("sion-transcribe-tap", SionTranscribeTap);
`;

interface Session {
  roomId: string;
  ws: WebSocket | null;
  audioCtx: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  tappedTrack: MediaStreamTrack | null;
  /** Pending samples until a full batch is ready. */
  batch: Float32Array;
  batchLen: number;
  muted: boolean;
  unsubMute: (() => void) | null;
  /** Re-tap watchdog: LiveKit replaces the mic track on device switch /
   *  denoise refresh; we follow it. */
  retapTimer: ReturnType<typeof setInterval> | null;
}

let session: Session | null = null;

function sendFlush() {
  try {
    session?.ws?.send(JSON.stringify({ type: "flush" }));
  } catch { /* ws closing */ }
}

/** (Re)connect the audio graph to the current LiveKit mic track. */
async function tapMic(s: Session): Promise<void> {
  const track = getLocalMicMediaStreamTrack();
  if (!track || track === s.tappedTrack) return;
  // Tear down the previous graph (device switch / republish).
  try { s.sourceNode?.disconnect(); } catch { /* already gone */ }
  if (!s.audioCtx) {
    // 16 kHz context: Chromium resamples the 48 kHz mic internally, so the
    // worklet already receives model-rate samples.
    s.audioCtx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
    try {
      await s.audioCtx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    s.workletNode = new AudioWorkletNode(s.audioCtx, "sion-transcribe-tap");
    s.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!session || session !== s || s.muted || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
      const data = e.data;
      let offset = 0;
      while (offset < data.length) {
        const room = BATCH_SAMPLES - s.batchLen;
        const take = Math.min(room, data.length - offset);
        s.batch.set(data.subarray(offset, offset + take), s.batchLen);
        s.batchLen += take;
        offset += take;
        if (s.batchLen === BATCH_SAMPLES) {
          s.ws.send(s.batch.buffer.slice(0, BATCH_SAMPLES * 4));
          s.batchLen = 0;
        }
      }
    };
    // Keep the graph pulled without feeding speakers: a zero-gain sink.
    const silent = s.audioCtx.createGain();
    silent.gain.value = 0;
    s.workletNode.connect(silent);
    silent.connect(s.audioCtx.destination);
  }
  s.sourceNode = s.audioCtx.createMediaStreamSource(new MediaStream([track]));
  s.sourceNode.connect(s.workletNode!);
  s.tappedTrack = track;
  console.log("[Sion][transcribe] mic tapped (16 kHz worklet)");
}

/** Start transcribing into `roomId`. Resolves once the engine is starting;
 *  the store's state flips to "on" when the model reports ready. Throws with
 *  a user-displayable message when the model is missing or load fails. */
export async function startTranscription(roomId: string): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  if (session) await stopTranscription();

  const store = useTranscriptStore.getState();
  const { transcribeModel, transcribeLang } = useSettingsStore.getState();
  store.setState("starting");

  // Model must be downloaded first (Settings → Réunion, or the panel's CTA).
  const modelPath = await ensureModelDownloaded(transcribeModel);

  const port = await invoke<number>("transcribe_start", { modelPath, lang: transcribeLang });

  const s: Session = {
    roomId,
    ws: null,
    audioCtx: null,
    workletNode: null,
    sourceNode: null,
    tappedTrack: null,
    batch: new Float32Array(BATCH_SAMPLES),
    batchLen: 0,
    muted: useAppStore.getState().isMuted || useAppStore.getState().isDeafened,
    unsubMute: null,
    retapTimer: null,
  };
  session = s;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as { type: string; text?: string; t0?: number; t1?: number; message?: string };
      if (msg.type === "ready") {
        useTranscriptStore.getState().setState("on");
      } else if (msg.type === "error") {
        console.error("[Sion][transcribe] engine error:", msg.message);
        useTranscriptStore.getState().setState("error", msg.message || "engine error");
      } else if (msg.type === "segment" && msg.text) {
        const t0 = msg.t0 ?? Date.now();
        const t1 = msg.t1 ?? t0;
        // Publish to the room — our own entry lands in the store via the
        // local echo / timeline path, same as everyone else's.
        matrixService.sendTranscriptSegment(s.roomId, msg.text, t0, t1).catch((err) => {
          console.warn("[Sion][transcribe] segment publish failed:", err);
        });
      }
    } catch { /* malformed */ }
  };
  ws.onclose = () => {
    if (session === s && useTranscriptStore.getState().state !== "error") {
      useTranscriptStore.getState().setState("off");
    }
  };

  // Mute gating: stop feeding at the source and flush the open segment.
  // Also auto-stop when we leave (or get kicked from) the voice channel —
  // a transcript must never outlive the meeting it belongs to.
  s.unsubMute = useAppStore.subscribe((state) => {
    if (state.connectedVoiceChannel !== s.roomId) {
      console.log("[Sion][transcribe] left voice channel → stopping");
      stopTranscription();
      return;
    }
    const muted = state.isMuted || state.isDeafened;
    if (muted !== s.muted) {
      s.muted = muted;
      if (muted) {
        s.batchLen = 0; // drop the partial batch — muted tail must not leak
        sendFlush();
      }
      console.log(`[Sion][transcribe] mic ${muted ? "muted → tap paused" : "unmuted → tap resumed"}`);
    }
  });

  await tapMic(s);
  // Follow mic republish (device switch, denoise toggle) every 2 s.
  s.retapTimer = setInterval(() => { tapMic(s).catch(() => {}); }, 2000);
}

/** Stop transcribing: flush the open segment, tear the graph down, unload
 *  the model. Remote transcripts keep flowing (they come over Matrix). */
export async function stopTranscription(): Promise<void> {
  const s = session;
  session = null;
  if (!s) return;
  try { sendFlushFor(s); } catch { /* best effort */ }
  if (s.retapTimer) clearInterval(s.retapTimer);
  s.unsubMute?.();
  try { s.sourceNode?.disconnect(); } catch { /* ignore */ }
  try { s.workletNode?.disconnect(); } catch { /* ignore */ }
  try { await s.audioCtx?.close(); } catch { /* ignore */ }
  // Give the flush→last-segment round-trip a moment before killing the WS,
  // then stop the engine (unloads the model RAM).
  const wsRef = s.ws;
  setTimeout(() => { try { wsRef?.close(); } catch { /* ignore */ } }, 1500);
  try { await invoke("transcribe_stop"); } catch { /* not running */ }
  if (useTranscriptStore.getState().state !== "error") {
    useTranscriptStore.getState().setState("off");
  }
}

function sendFlushFor(s: Session) {
  try {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "flush" }));
  } catch { /* closing */ }
}

/** True while WE are transcribing (someone else may be regardless). */
export function isTranscribing(): boolean {
  return session !== null;
}

/** Path of the requested whisper model, downloading it on first use
 *  (~60–540 MB). Progress is surfaced through the transcript store so the
 *  panel and the settings section both render it. */
export async function ensureModelDownloaded(model: string): Promise<string> {
  const existing = await invoke<string | null>("detect_whisper_model", { model });
  if (existing) return existing;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<number>("whisper-model-progress", (e) => {
    useTranscriptStore.getState().setDownloadPct(Number(e.payload));
  });
  try {
    return await invoke<string>("download_whisper_model", { model });
  } finally {
    unlisten();
    useTranscriptStore.getState().setDownloadPct(null);
  }
}

/** Whether the given model is already on disk (settings indicator). */
export async function isModelDownloaded(model: string): Promise<boolean> {
  if (!isTauri()) return false;
  return !!(await invoke<string | null>("detect_whisper_model", { model }));
}
