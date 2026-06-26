import { useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioFile, computePeaks, computePeaksRange, playSlice } from "../../services/audioTrim";

const CANVAS_W = 600;

interface Props {
  file: File;
  maxSec: number;
  /** Reports the current selection + decoded buffer to the parent. */
  onChange: (startSec: number, endSec: number, buffer: AudioBuffer) => void;
  /** Gain applied to the built-in preview so it matches the saved volume. */
  gain?: number;
}

type DragMode = "body" | "left" | "right";

const HEIGHT = 80;
const MIN_WIN = 0.3; // seconds
// Padding shown on each side of the selection in the zoom lane.
const ZOOM_PAD = 10; // seconds

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** mm:ss.d — readable on long tracks (a 1h track in raw seconds is unreadable). */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

interface LaneProps {
  peaks: { min: number; max: number }[];
  winStart: number;
  winEnd: number;
  region: { start: number; end: number };
  /** Playback/scrub cursor (persists when paused so a bound can be fixed on it). */
  cursor: number | null;
  /** Whether the selection body can be dragged in this lane. */
  bodyDraggable: boolean;
  onHandleDown: (e: React.PointerEvent, mode: DragMode, secPerPx: number) => void;
  /** Click on the waveform background (anywhere but the handles). */
  onBackground?: (e: React.PointerEvent, clickSec: number, secPerPx: number) => void;
}

/** One waveform strip displaying the time window [winStart, winEnd], with the
 *  selection region overlaid. Both the overview (full track) and the zoom
 *  (selection ±10s) lanes are instances of this. The canvas and dim overlays
 *  are pointer-transparent so a click anywhere but the handles (and the body,
 *  when not draggable) reaches the background handler. */
function WaveLane({ peaks, winStart, winEnd, region, cursor, bodyDraggable, onHandleDown, onBackground }: LaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const span = Math.max(0.001, winEnd - winStart);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width, h = canvas.height;
    const c = canvas.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, w, h);
    const mid = h / 2;
    c.fillStyle = "rgba(255,255,255,0.35)";
    for (let x = 0; x < peaks.length; x++) {
      const { min, max } = peaks[x];
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    if (cursor !== null && cursor >= winStart && cursor <= winEnd) {
      const px = ((cursor - winStart) / span) * w;
      c.fillStyle = "#fbbf24"; // amber: the "fix here" cursor, distinct from the selection edges
      c.fillRect(px, 0, 2, h);
    }
  }, [peaks, cursor, winStart, winEnd, span]);

  const toPct = (t: number) => clamp(((t - winStart) / span) * 100, 0, 100);
  const leftPct = toPct(region.start);
  const rightPct = toPct(region.end);
  // Keep a sliver visible even when the selection is sub-pixel on the overview.
  const widthPct = Math.max(rightPct - leftPct, 0.4);

  const handleDown = (e: React.PointerEvent, mode: DragMode) => {
    const el = wrapRef.current;
    onHandleDown(e, mode, el ? span / el.clientWidth : span / CANVAS_W);
  };

  const bgDown = (e: React.PointerEvent) => {
    if (!onBackground) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spp = span / rect.width;
    onBackground(e, winStart + (e.clientX - rect.left) * spp, spp);
  };

  return (
    <div
      ref={wrapRef}
      onPointerDown={bgDown}
      style={{ position: "relative", height: HEIGHT, width: "100%", background: "var(--color-surface-container-high)", borderRadius: 8, overflow: "hidden", touchAction: "none", userSelect: "none", cursor: onBackground ? "pointer" : "default" }}
    >
      <canvas ref={canvasRef} width={CANVAS_W} height={HEIGHT} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
      {/* dim the unselected parts (pointer-transparent) */}
      <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${leftPct}%`, background: "rgba(0,0,0,0.45)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct + widthPct}%`, right: 0, background: "rgba(0,0,0,0.45)", pointerEvents: "none" }} />
      {/* selection region — draggable body only where allowed; otherwise it lets
          clicks fall through to the background (click-to-play in the zoom lane) */}
      <div
        onPointerDown={bodyDraggable ? (e) => handleDown(e, "body") : undefined}
        style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: `${widthPct}%`, border: "2px solid var(--color-primary)", background: "rgba(125,211,252,0.12)", cursor: bodyDraggable ? "grab" : "inherit", boxSizing: "border-box", pointerEvents: bodyDraggable ? "auto" : "none" }}
      />
      {/* handles */}
      <div onPointerDown={(e) => handleDown(e, "left")} style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: 10, marginLeft: -5, cursor: "ew-resize", background: "var(--color-primary)", opacity: 0.85, borderRadius: 3 }} />
      <div onPointerDown={(e) => handleDown(e, "right")} style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct + widthPct}%`, width: 10, marginLeft: -5, cursor: "ew-resize", background: "var(--color-primary)", opacity: 0.85, borderRadius: 3 }} />
    </div>
  );
}

export function AudioTrimmer({ file, maxSec, onChange, gain = 1 }: Props) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  // The scrub/playback cursor. Persists when paused so "Fixer le début/la fin"
  // can snap a bound onto it. Ref mirror for synchronous reads in the buttons.
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorRef = useRef<number | null>(null);
  const setCur = (v: number | null) => { cursorRef.current = v; setCursor(v); };
  const [isPlaying, setIsPlaying] = useState(false);

  const playerRef = useRef<{ stop: () => void } | null>(null);
  const dragRef = useRef<{ mode: DragMode; x0: number; s0: number; e0: number; w: number; secPerPx: number } | null>(null);
  const regionRef = useRef(region);
  useEffect(() => { regionRef.current = region; });
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

  const dur = buffer?.duration ?? 0;

  // Overview peaks: O(samples), computed once per decoded buffer.
  const overviewPeaks = useMemo(() => (buffer ? computePeaks(buffer, CANVAS_W) : []), [buffer]);

  // Zoom window = selection ±10s, snapped to whole seconds so the bounds stay
  // stable during a sub-second drag (avoids re-scanning the buffer every frame).
  const zoomStart = Math.max(0, Math.floor(region.start - ZOOM_PAD));
  const zoomEnd = Math.min(dur, Math.ceil(region.end + ZOOM_PAD));
  const showZoom = dur > 0 && zoomEnd - zoomStart < dur - 0.5;
  const zoomPeaks = useMemo(
    () => (buffer && showZoom ? computePeaksRange(buffer, CANVAS_W, zoomStart, zoomEnd) : []),
    [buffer, showZoom, zoomStart, zoomEnd],
  );

  // ── playback ──
  const stopPlayback = () => { playerRef.current?.stop(); playerRef.current = null; setIsPlaying(false); };

  // Play an arbitrary [a, b] slice, moving the cursor with playback. The cursor
  // is left where playback stops so a bound can be fixed onto it.
  const play = (a: number, b: number) => {
    stopPlayback();
    if (!buffer) return;
    const start = clamp(a, 0, buffer.duration);
    const end = clamp(b, start + 0.05, buffer.duration);
    setCur(start);
    setIsPlaying(true);
    playerRef.current = playSlice(
      buffer, start, end,
      (t) => setCur(t),
      () => { playerRef.current = null; setIsPlaying(false); },
      gain,
    );
  };

  // Play/pause from the cursor (▶ Lire / ⏸ Pause). Pausing leaves the cursor
  // frozen where playback was, so a bound can be fixed exactly on it.
  const togglePlay = () => {
    if (isPlaying) { stopPlayback(); return; }
    const from = cursorRef.current ?? region.start;
    play(from, showZoom ? zoomEnd : dur);
  };

  // Audition the whole current selection (restarts from its start).
  const playSelection = () => play(region.start, region.end);

  // ── fix a bound onto the current cursor ──
  const commit = (next: { start: number; end: number }) => {
    setRegion(next);
    regionRef.current = next;
    onChangeRef.current(next.start, next.end, buffer!);
  };

  const fixStart = () => {
    const c = cursorRef.current;
    if (c === null || !buffer) return;
    const start = clamp(c, 0, dur - MIN_WIN);
    let end = regionRef.current.end;
    if (end < start + MIN_WIN) end = Math.min(dur, start + maxSec);
    if (end - start > maxSec) end = start + maxSec;
    commit({ start, end });
  };

  const fixEnd = () => {
    const c = cursorRef.current;
    if (c === null || !buffer) return;
    const end = clamp(c, MIN_WIN, dur);
    let start = regionRef.current.start;
    if (start > end - MIN_WIN) start = Math.max(0, end - maxSec);
    if (end - start > maxSec) start = end - maxSec;
    commit({ start, end });
  };

  // ── selection editing (drag) ──
  const beginDrag = (e: React.PointerEvent, mode: DragMode, secPerPx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const r = regionRef.current;
    dragRef.current = { mode, x0: e.clientX, s0: r.start, e0: r.end, w: r.end - r.start, secPerPx };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // Overview background click: recenter the selection on the clicked time, then
  // start dragging the body so the user can nudge from there.
  const beginSeek = (e: React.PointerEvent, clickSec: number, secPerPx: number) => {
    if (!buffer) return;
    e.preventDefault();
    const len = regionRef.current.end - regionRef.current.start;
    const start = clamp(clickSec - len / 2, 0, Math.max(0, buffer.duration - len));
    const next = { start, end: start + len };
    commit(next);
    dragRef.current = { mode: "body", x0: e.clientX, s0: next.start, e0: next.end, w: len, secPerPx };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // Zoom background click: just place the (frozen) cursor — no auto-play, so the
  // user can aim precisely. They press ▶ Lire to hear, ⏸ Pause to freeze, then
  // fix a bound on the cursor.
  const setCursorAt = (_e: React.PointerEvent, clickSec: number) => {
    stopPlayback();
    setCur(clamp(clickSec, 0, dur));
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !buffer) return;
      const dSec = (e.clientX - d.x0) * d.secPerPx;
      let start = d.s0, end = d.e0;
      if (d.mode === "body") {
        let ns = d.s0 + dSec;
        ns = clamp(ns, 0, buffer.duration - d.w);
        start = ns; end = ns + d.w;
      } else if (d.mode === "left") {
        start = Math.max(0, Math.min(d.s0 + dSec, d.e0 - MIN_WIN));
        if (end - start > maxSec) start = end - maxSec;
      } else {
        end = Math.min(buffer.duration, Math.max(d.e0 + dSec, d.s0 + MIN_WIN));
        if (end - start > maxSec) end = start + maxSec;
      }
      const next = { start, end };
      setRegion(next);
      regionRef.current = next;
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

  if (error) return <div style={{ fontSize: 12, color: "var(--color-error)" }}>{error}</div>;
  if (!buffer) return <div style={{ fontSize: 12, color: "var(--color-outline)" }}>Décodage de l'audio…</div>;

  const selLen = region.end - region.start;
  const overLimit = selLen > maxSec + 0.01;
  const hasCursor = cursor !== null;
  const fixBtn = (enabled: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 16, border: "none", fontSize: 12, fontFamily: "inherit",
    cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.4,
    background: "var(--color-surface-container-highest)", color: "var(--color-on-surface)",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {showZoom && (
          <span style={{ fontSize: 10, color: "var(--color-outline)" }}>
            Vue d'ensemble — clique pour positionner, glisse la zone
          </span>
        )}
        <WaveLane
          peaks={overviewPeaks}
          winStart={0}
          winEnd={dur}
          region={region}
          cursor={cursor}
          bodyDraggable
          onHandleDown={beginDrag}
          onBackground={showZoom ? beginSeek : undefined}
        />
      </div>

      {showZoom && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-outline)" }}>
            Zoom ({fmt(zoomStart)}–{fmt(zoomEnd)}) — clique pour placer le curseur (●), ▶ Lire / ⏸ Pause pour le caler à l'oreille, puis fixe le début/la fin · ou glisse les bords
          </span>
          <WaveLane
            peaks={zoomPeaks}
            winStart={zoomStart}
            winEnd={zoomEnd}
            region={region}
            cursor={cursor}
            bodyDraggable={false}
            onHandleDown={beginDrag}
            onBackground={setCursorAt}
          />
        </div>
      )}

      {/* Row 1: playback transport. Row 2: fix the bounds. Each row is a clean
          two-up grid so the buttons line up instead of wrapping arbitrarily. */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={togglePlay}
          style={{ flex: 1, padding: "6px 12px", borderRadius: 16, border: "none", cursor: "pointer", fontSize: 12, fontFamily: "inherit", background: isPlaying ? "var(--color-error-container)" : "var(--color-primary)", color: isPlaying ? "var(--color-error)" : "var(--color-on-primary)" }}
        >
          {isPlaying ? "⏸ Pause" : "▶ Lire (curseur)"}
        </button>
        <button type="button" onClick={playSelection} style={{ flex: 1, padding: "6px 12px", borderRadius: 16, border: "none", cursor: "pointer", fontSize: 12, fontFamily: "inherit", background: "var(--color-surface-container-highest)", color: "var(--color-on-surface)" }}>
          ▶ Sélection
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={fixStart} disabled={!hasCursor} title={hasCursor ? "Caler le début sur le curseur" : "Clique dans la waveform d'abord"} style={{ ...fixBtn(hasCursor), flex: 1 }}>
          ⇤ Fixer le début
        </button>
        <button type="button" onClick={fixEnd} disabled={!hasCursor} title={hasCursor ? "Caler la fin sur le curseur" : "Clique dans la waveform d'abord"} style={{ ...fixBtn(hasCursor), flex: 1 }}>
          Fixer la fin ⇥
        </button>
      </div>
      <span style={{ fontSize: 12, color: overLimit ? "var(--color-error)" : "var(--color-outline)", textAlign: "center" }}>
        {fmt(region.start)}–{fmt(region.end)} · {selLen.toFixed(1)} s / {maxSec} s max
        {hasCursor && <span style={{ color: "#fbbf24" }}> · ● {fmt(cursor!)}</span>}
      </span>
    </div>
  );
}
