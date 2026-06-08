// Web Audio helpers for the soundboard trimmer: decode a file to an
// AudioBuffer (for waveform + preview) and export a [start,end] slice as a
// compressed opus clip (so a long upload becomes a small ≤20s file rather than
// shipping the whole thing). Encoding uses MediaRecorder (CEF/Chromium has
// opus), which runs in real time — fine for a one-off upload of ≤20s.

let sharedCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!sharedCtx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === "suspended") sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

/** Decode an audio File into an AudioBuffer. decodeAudioData detaches the
 *  ArrayBuffer, so we pass it a fresh copy each call. */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arr = await file.arrayBuffer();
  return ctx().decodeAudioData(arr);
}

/** Pick a MediaRecorder mime type CEF/Chromium supports for opus. */
function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "audio/webm";
}

/**
 * Render the [startSec, endSec] slice of `buffer` to a compressed clip File.
 * Plays the slice through a MediaStreamAudioDestinationNode and records it with
 * MediaRecorder (real-time). The resulting File keeps the chosen window only.
 */
export async function trimToClip(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  baseName: string,
): Promise<File> {
  const c = ctx();
  const start = Math.max(0, Math.min(startSec, buffer.duration));
  const dur = Math.max(0.05, Math.min(endSec, buffer.duration) - start);

  const dest = c.createMediaStreamDestination();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);

  const mime = pickMime();
  const rec = new MediaRecorder(dest.stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const done = new Promise<Blob>((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime.split(";")[0] }));
    rec.onerror = () => reject(new Error("MediaRecorder error"));
  });

  rec.start();
  src.start(0, start, dur);
  // Stop a hair after the slice ends so the tail is captured.
  src.onended = () => { setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, 60); };
  // Safety: hard stop if onended never fires.
  const guard = setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, (dur + 1) * 1000);

  const blob = await done;
  clearTimeout(guard);
  try { src.disconnect(); dest.disconnect(); } catch { /* ignore */ }

  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  const name = baseName.replace(/\.[^.]+$/, "") + `.${ext}`;
  return new File([blob], name, { type: blob.type });
}

/** Compute min/max peaks per bucket for a canvas waveform. */
export function computePeaks(buffer: AudioBuffer, buckets: number): { min: number; max: number }[] {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / buckets));
  const peaks: { min: number; max: number }[] = [];
  for (let b = 0; b < buckets; b++) {
    let min = 1, max = -1;
    const s = b * per;
    const e = Math.min(s + per, data.length);
    for (let i = s; i < e; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push({ min: min === 1 ? 0 : min, max: max === -1 ? 0 : max });
  }
  return peaks;
}

/** A playable preview of a [start,end] slice with a playhead callback. */
export function playSlice(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  onTime: (sec: number) => void,
  onEnd: () => void,
): { stop: () => void } {
  const c = ctx();
  const start = Math.max(0, startSec);
  const dur = Math.max(0.05, Math.min(endSec, buffer.duration) - start);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  const t0 = c.currentTime;
  let raf = 0;
  const tick = () => {
    const elapsed = c.currentTime - t0;
    onTime(start + Math.min(elapsed, dur));
    if (elapsed < dur) raf = requestAnimationFrame(tick);
  };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try { src.stop(); src.disconnect(); } catch { /* ignore */ }
    onEnd();
  };
  src.onended = () => { cancelAnimationFrame(raf); if (!stopped) { stopped = true; onEnd(); } };
  src.start(0, start, dur);
  raf = requestAnimationFrame(tick);
  return { stop };
}
