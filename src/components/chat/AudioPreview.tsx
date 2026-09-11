import { useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioFile, computePeaks, playSlice } from "../../services/audioTrim";
import { themeColor } from "../../utils/themeColor";

const CANVAS_W = 600;
const HEIGHT = 56;

interface Props {
  file: File;
  /** Remonte le buffer décodé au parent (encodage WAV, durée…). */
  onDecoded?: (buffer: AudioBuffer) => void;
}

/**
 * Écoute d'un clip : forme d'onde + bouton lecture, sans sélection.
 *
 * `AudioTrimmer` fait le même rendu mais avec poignées, zoom et région
 * déplaçable — inutile quand on veut seulement vérifier ce qu'on entend.
 * Le `<audio controls>` natif, lui, détonne avec le reste de l'app.
 *
 * Réutilise le décodage, les pics et la lecture d'`audioTrim` pour rester
 * cohérent avec le trimmer.
 */
export function AudioPreview({ file, onDecoded }: Props) {
  // Le buffer est stocké AVEC son fichier d'origine plutôt que remis à null au
  // changement : ça évite un setState synchrone dans le corps de l'effet, et un
  // buffer périmé ne peut pas s'afficher sous un nouveau fichier.
  const [decoded, setDecoded] = useState<{ file: File; buffer: AudioBuffer } | null>(null);
  const [failed, setFailed] = useState<File | null>(null);
  const [cursor, setCursor] = useState(0);
  const buffer = decoded?.file === file ? decoded.buffer : null;
  const error = failed === file;
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<{ stop: () => void } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDecodedRef = useRef(onDecoded);

  useEffect(() => { onDecodedRef.current = onDecoded; }, [onDecoded]);

  useEffect(() => {
    let alive = true;
    decodeAudioFile(file)
      .then((b) => {
        if (!alive) return;
        setDecoded({ file, buffer: b });
        onDecodedRef.current?.(b);
      })
      .catch(() => { if (alive) setFailed(file); });
    return () => {
      alive = false;
      playerRef.current?.stop();
      playerRef.current = null;
      setCursor(0);
    };
  }, [file]);

  const peaks = useMemo(() => (buffer ? computePeaks(buffer, CANVAS_W) : []), [buffer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const c = canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = canvas;
    c.clearRect(0, 0, w, h);
    const mid = h / 2;
    c.fillStyle = "rgba(255,255,255,0.35)";
    for (let x = 0; x < peaks.length; x++) {
      const { min, max } = peaks[x];
      const y1 = mid - max * mid;
      c.fillRect(x, y1, 1, Math.max(1, mid - min * mid - y1));
    }
    if (buffer && cursor > 0) {
      // Même ambre que le curseur du trimmer, pour la cohérence visuelle.
      c.fillStyle = themeColor("--color-amber", "#fbbf24");
      c.fillRect((cursor / buffer.duration) * w, 0, 2, h);
    }
  }, [peaks, cursor, buffer]);

  const toggle = () => {
    if (!buffer) return;
    if (playing) {
      playerRef.current?.stop();
      playerRef.current = null;
      setPlaying(false);
      return;
    }
    setPlaying(true);
    playerRef.current = playSlice(
      buffer,
      0,
      buffer.duration,
      setCursor,
      () => { setPlaying(false); setCursor(0); },
    );
  };

  /** Clic dans la forme d'onde : lecture depuis ce point. */
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!buffer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - rect.left) / rect.width) * buffer.duration;
    playerRef.current?.stop();
    setPlaying(true);
    setCursor(at);
    playerRef.current = playSlice(
      buffer,
      at,
      buffer.duration,
      setCursor,
      () => { setPlaying(false); setCursor(0); },
    );
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        type="button"
        onClick={toggle}
        disabled={!buffer}
        style={{
          width: 36, height: 36, flexShrink: 0, borderRadius: "50%", border: "none",
          cursor: buffer ? "pointer" : "default",
          background: "var(--color-primary)", color: "var(--color-on-primary)",
          fontSize: 14, lineHeight: 1, opacity: buffer ? 1 : 0.5,
        }}
      >
        {playing ? "⏸" : "▶"}
      </button>
      <div
        onPointerDown={seek}
        style={{
          position: "relative", flex: 1, height: HEIGHT, minWidth: 0,
          background: "var(--color-surface-container-high)", borderRadius: 8,
          overflow: "hidden", cursor: buffer ? "pointer" : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={HEIGHT}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
        {!buffer && (
          <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--color-on-surface-variant)" }}>
            {error ? "✗" : "…"}
          </span>
        )}
      </div>
      {buffer && (
        <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {fmt(cursor)} / {fmt(buffer.duration)}
        </span>
      )}
    </div>
  );
}
