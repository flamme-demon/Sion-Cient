import { useEffect, useRef, useState } from "react";
import { decodeAudioFile, computePeaks, playSlice } from "../../services/audioTrim";

interface Props {
  file: File;
  maxSec: number;
  /** Reports the current selection + decoded buffer to the parent. */
  onChange: (startSec: number, endSec: number, buffer: AudioBuffer) => void;
}

type DragMode = "body" | "left" | "right";

const HEIGHT = 80;
const MIN_WIN = 0.3; // seconds

export function AudioTrimmer({ file, maxSec, onChange }: Props) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [playhead, setPlayhead] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ stop: () => void } | null>(null);
  const dragRef = useRef<{ mode: DragMode; x0: number; s0: number; e0: number; w: number } | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  // Decode on file change.
  useEffect(() => {
    // State resets via the `key` prop (parent remounts on file change), so no
    // synchronous setState reset is needed here — just decode.
    let cancelled = false;
    decodeAudioFile(file)
      .then((buf) => {
        if (cancelled) return;
        setBuffer(buf);
        const end = Math.min(maxSec, buf.duration);
        setRegion({ start: 0, end });
        onChangeRef.current(0, end, buf);
      })
      .catch(() => { if (!cancelled) setError("Impossible de décoder cet audio"); });
    return () => {
      cancelled = true;
      playerRef.current?.stop();
      playerRef.current = null;
    };
  }, [file, maxSec]);

  // Draw waveform + playhead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const w = canvas.width, h = canvas.height;
    const c = canvas.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, w, h);
    const peaks = computePeaks(buffer, w);
    const mid = h / 2;
    c.fillStyle = "rgba(255,255,255,0.35)";
    for (let x = 0; x < peaks.length; x++) {
      const { min, max } = peaks[x];
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    if (playhead !== null && buffer.duration > 0) {
      const px = (playhead / buffer.duration) * w;
      c.fillStyle = "var(--color-primary)";
      c.fillStyle = "#7dd3fc";
      c.fillRect(px, 0, 2, h);
    }
  }, [buffer, playhead, region]);

  const dur = buffer?.duration ?? 0;

  const startDrag = (e: React.PointerEvent, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, x0: e.clientX, s0: region.start, e0: region.end, w: region.end - region.start };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !buffer) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const dSec = ((e.clientX - d.x0) / wrap.clientWidth) * buffer.duration;
      let { start, end } = { start: d.s0, end: d.e0 };
      if (d.mode === "body") {
        let ns = d.s0 + dSec;
        ns = Math.max(0, Math.min(ns, buffer.duration - d.w));
        start = ns; end = ns + d.w;
      } else if (d.mode === "left") {
        start = Math.max(0, Math.min(d.s0 + dSec, d.e0 - MIN_WIN));
        if (end - start > maxSec) start = end - maxSec;
      } else {
        end = Math.min(buffer.duration, Math.max(d.e0 + dSec, d.s0 + MIN_WIN));
        if (end - start > maxSec) end = start + maxSec;
      }
      setRegion({ start, end });
      onChangeRef.current(start, end, buffer);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [buffer, maxSec]);

  const togglePlay = () => {
    if (playerRef.current) { playerRef.current.stop(); playerRef.current = null; return; }
    if (!buffer) return;
    playerRef.current = playSlice(
      buffer, region.start, region.end,
      (t) => setPlayhead(t),
      () => { playerRef.current = null; setPlayhead(null); },
    );
  };

  if (error) return <div style={{ fontSize: 12, color: "var(--color-error)" }}>{error}</div>;
  if (!buffer) return <div style={{ fontSize: 12, color: "var(--color-outline)" }}>Décodage de l'audio…</div>;

  const leftPct = (region.start / dur) * 100;
  const widthPct = ((region.end - region.start) / dur) * 100;
  const selLen = region.end - region.start;
  const playing = playhead !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        ref={wrapRef}
        style={{ position: "relative", height: HEIGHT, width: "100%", background: "var(--color-surface-container-high)", borderRadius: 8, overflow: "hidden", touchAction: "none", userSelect: "none" }}
      >
        <canvas ref={canvasRef} width={600} height={HEIGHT} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        {/* dim the unselected parts */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${leftPct}%`, background: "rgba(0,0,0,0.45)" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct + widthPct}%`, right: 0, background: "rgba(0,0,0,0.45)" }} />
        {/* selection region (draggable body) */}
        <div
          onPointerDown={(e) => startDrag(e, "body")}
          style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: `${widthPct}%`, border: "2px solid var(--color-primary)", background: "rgba(125,211,252,0.12)", cursor: "grab", boxSizing: "border-box" }}
        />
        {/* handles */}
        <div onPointerDown={(e) => startDrag(e, "left")} style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: 10, marginLeft: -5, cursor: "ew-resize", background: "var(--color-primary)", opacity: 0.85, borderRadius: 3 }} />
        <div onPointerDown={(e) => startDrag(e, "right")} style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct + widthPct}%`, width: 10, marginLeft: -5, cursor: "ew-resize", background: "var(--color-primary)", opacity: 0.85, borderRadius: 3 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={togglePlay}
          style={{ padding: "6px 14px", borderRadius: 16, border: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit", background: playing ? "var(--color-error-container)" : "var(--color-primary)", color: playing ? "var(--color-error)" : "var(--color-on-primary)" }}
        >
          {playing ? "⏹ Stop" : "▶ Écouter la sélection"}
        </button>
        <span style={{ fontSize: 12, color: selLen > maxSec + 0.01 ? "var(--color-error)" : "var(--color-outline)" }}>
          {selLen.toFixed(1)} s / {maxSec} s max · {region.start.toFixed(1)}–{region.end.toFixed(1)} s
        </span>
      </div>
    </div>
  );
}
