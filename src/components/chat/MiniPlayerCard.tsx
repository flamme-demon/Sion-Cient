import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMiniPlayerStore, MINI_PLAYER_MIN_W, MINI_PLAYER_MIN_H } from "../../stores/useMiniPlayerStore";
import { ResizeHandle } from "../layout/ResizeHandle";

/** Letterbox des vidéos : ce fond est sous les pixels du média, jamais une
 *  surface de l'app — noir neutre, hors thème (marqué pour le garde). */
const MINI_LETTERBOX = "#000"; // theme-exempt — letterbox média

/**
 * Mini-lecteur flottant (roadmap §2.4) : la vidéo d'un message continue de se
 * lire dans une petite carte au-dessus de l'app, quoi qu'on fasse du chat.
 * Même comportement de carte que le PIP du partage (drag par le bandeau, snap
 * aux coins, resize par les poignées).
 */
export function MiniPlayerCard() {
  const { t } = useTranslation();
  const src = useMiniPlayerStore((s) => s.src);
  const title = useMiniPlayerStore((s) => s.title);
  const x = useMiniPlayerStore((s) => s.x);
  const y = useMiniPlayerStore((s) => s.y);
  const w = useMiniPlayerStore((s) => s.w);
  const h = useMiniPlayerStore((s) => s.h);
  const setRect = useMiniPlayerStore((s) => s.setRect);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Reprise à la position transmise par la carte du message, une seule fois :
  // la lecture démarre dès que la durée est connue (un blob local est
  // instantané, `seek` avant métadonnées serait ignoré).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    const resume = () => {
      const at = useMiniPlayerStore.getState().time;
      try { v.currentTime = at; } catch { /* hors bornes : on lira du début */ }
      void v.play().catch(() => { /* autoplay refusé : contrôles natifs */ });
    };
    v.addEventListener("loadedmetadata", resume, { once: true });
    return () => v.removeEventListener("loadedmetadata", resume);
  }, [src]);

  if (!src) return null;

  // x/y < 0 = bas-gauche ; recalculé au rendu (le store ne connaît pas la
  // fenêtre). Le PIP du partage est à droite : les deux peuvent cohabiter.
  const px = x >= 0 ? x : 24;
  const py = y >= 0 ? y : Math.max(12, window.innerHeight - h - 24);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = px;
    let lastY = py;
    const onMoveWin = (ev: PointerEvent) => {
      lastX = Math.min(Math.max(px + ev.clientX - startX, 4), Math.max(4, window.innerWidth - w - 10));
      lastY = Math.min(Math.max(py + ev.clientY - startY, 4), Math.max(4, window.innerHeight - 60));
      setRect({ x: lastX, y: lastY });
    };
    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      const SNAP = 48;
      const MARGIN = 12;
      let sx = lastX;
      let sy = lastY;
      if (lastX <= SNAP) sx = MARGIN;
      else if (window.innerWidth - (lastX + w) <= SNAP) sx = window.innerWidth - w - MARGIN;
      if (lastY <= SNAP) sy = MARGIN;
      else if (window.innerHeight - (lastY + h) <= SNAP) sy = window.innerHeight - h - MARGIN;
      if (sx !== lastX || sy !== lastY) setRect({ x: sx, y: sy });
    };
    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
  };

  return (
    <div
      style={{
        position: 'fixed', left: px, top: py, width: w, height: h,
        zIndex: 320, display: 'flex', flexDirection: 'column',
        background: 'var(--color-surface-container-low)',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      }}
    >
      <div
        onPointerDown={(e) => { if (e.button === 0) startDrag(e); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '6px 8px', cursor: 'grab', touchAction: 'none',
          background: 'var(--color-surface-container)',
          borderBottom: '1px solid var(--color-outline-variant)',
        }}
      >
        <span aria-hidden style={{ fontSize: 11, opacity: 0.7, color: 'var(--color-on-surface-variant)' }}>⠿</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || t("chat.miniPlayerTitle", { defaultValue: "Mini-lecteur" })}
        </span>
        <button
          type="button"
          onClick={() => useMiniPlayerStore.getState().close()}
          title={t("layout.closePanel", { defaultValue: "Fermer le panneau" })}
          aria-label={t("layout.closePanel", { defaultValue: "Fermer le panneau" })}
          style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}
        >×</button>
      </div>
      <video
        ref={videoRef}
        src={src}
        controls
        autoPlay
        playsInline
        onTimeUpdate={(e) => useMiniPlayerStore.getState().setTime(e.currentTarget.currentTime)}
        onPlay={() => useMiniPlayerStore.getState().setPlaying(true)}
        onPause={() => useMiniPlayerStore.getState().setPlaying(false)}
        style={{ flex: 1, minHeight: 0, width: '100%', display: 'block', background: MINI_LETTERBOX }}
      />
      <ResizeHandle
        side="right"
        value={w}
        min={MINI_PLAYER_MIN_W}
        max={Math.max(MINI_PLAYER_MIN_W, window.innerWidth - 40)}
        onChange={(next) => setRect({ w: next })}
        onReset={() => setRect({ w: 420 })}
        label={t("chat.miniPlayerResize", { defaultValue: "Redimensionner le mini-lecteur — double-clic pour la taille par défaut" })}
      />
      <ResizeHandle
        side="bottom"
        value={h}
        min={MINI_PLAYER_MIN_H}
        max={Math.max(MINI_PLAYER_MIN_H, window.innerHeight - 60)}
        onChange={(next) => setRect({ h: next })}
        onReset={() => setRect({ h: 260 })}
        label={t("chat.miniPlayerResize", { defaultValue: "Redimensionner le mini-lecteur — double-clic pour la taille par défaut" })}
      />
    </div>
  );
}
