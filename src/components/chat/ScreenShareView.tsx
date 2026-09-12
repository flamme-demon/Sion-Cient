import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { onCursorsChange, onCursorClick, broadcastCursor, broadcastCursorHide, broadcastCursorClick, type RemoteCursor, type RemoteCursorClick } from "../../services/cursorService";
import { connectVoiceNativeVideoStream, getVoiceNativeShareAudioState, resolveNativeDisplayName, setVoiceNativeShareAudioMuted, setVoiceNativeShareAudioVolume, pipNativeOpen, pipNativeClose, pipNativeStatus, onVoiceNativeShareAudio, onVoiceNativePip, type VoiceNativeBinaryFrame } from "../../services/voiceNativeService";
import { useLiveKitStore } from "../../stores/useLiveKitStore";
import { useAppStore } from "../../stores/useAppStore";
import { useLayoutStore, SHARE_VIEW_MIN_VH, SHARE_VIEW_MAX_VH, SHARE_FLOATING_MIN_W, SHARE_FLOATING_MIN_H } from "../../stores/useLayoutStore";
import { ResizeHandle } from "../layout/ResizeHandle";
import { useTranslation } from "react-i18next";
import { SpeakerIcon, ScreenIcon } from "../icons";

/** Partage affichable : les pixels arrivent par le WebSocket binaire natif,
 *  il n'y a plus d'objet piste LiveKit dans la webview. */
interface ScreenShareInfo {
  participantIdentity: string;
  participantName: string;
  hasAudio: boolean;
}

/** État audio local par partageur (le moteur Rust mémorise le sien de son
 *  côté ; ici on garde la source de vérité des icônes, y compris pour les
 *  onglets de partages non actifs). */
const shareAudioState = new Map<string, { muted: boolean; volume: number }>();
function screenShareAudioState(identity: string): { muted: boolean; volume: number } {
  return shareAudioState.get(identity) ?? { muted: false, volume: 1 };
}

/** Letterbox du partage : le cadre noir autour de la vidéo (et sous la
 *  mosaïque) n'est pas une surface de l'app — les pixels média ne sont pas
 *  thémés. Marquée `theme-exempt` pour le garde anti-couleurs-en-dur. */
const LETTERBOX_BLACK = "#000"; // theme-exempt — letterbox média

/** Speaker with an X — the muted counterpart to the maison SpeakerIcon,
 *  matched in stroke/size so the toggle doesn't jump. */
function SpeakerMutedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

/** Maximize glyph (quatre coins) — bouton plein écran de la barre d'onglets. */
function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// 60 Hz keeps the native overlay close to the physical pointer. The Rust
// overlay paints each received position directly; there is no extra easing.
const CURSOR_BROADCAST_HZ = 60;
const CURSOR_BROADCAST_INTERVAL = Math.floor(1000 / CURSOR_BROADCAST_HZ);

/** Sans nouvelle position pendant ce délai, le viewer masque son curseur
 *  (immobilité, ou fenêtre quittée sans `leave` fiable) : l'overlay du
 *  partageur et les autres viewers ne gardent pas de flèche fantôme figée.
 *  Un simple mouvement la fait réapparaître. */
const CURSOR_HIDE_AFTER_MS = 5000;

// Compteur diagnostique (stutter curseurs constaté en prod) : re-rendus
// effectifs de l'overlay, loggés toutes les 5 s quand actifs.
let cursorRenderCount = 0;
let cursorRenderWindowStart = 0;

/** Couche curseurs en DOM direct (hors React) : à 30-60 positions/s, le
 *  re-render du composant entier saccade ; ici seules `left`/`top` bougent.
 *  Structure strictement identique au JSX remplacé (flèche SVG + pastille
 *  nom). `textContent` pour le nom (échappement comme React). */
function syncCursorLayer(
  container: HTMLDivElement | null,
  cache: Map<string, HTMLDivElement>,
  cursors: RemoteCursor[],
  activeIdentity: string | null,
) {
  if (!container) return;
  const visible = new Set<string>();
  for (const c of cursors) {
    if (!c.target || c.target !== activeIdentity) continue;
    visible.add(c.identity);
    let el = cache.get(c.identity);
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      const color = colorForIdentity(c.identity);
      el.dataset.identity = c.identity;
      el.style.cssText =
        "position:absolute;display:flex;flex-direction:column;align-items:flex-start;gap:2px;" +
        "transform:translate(-2px,-2px);transition:left 60ms linear,top 60ms linear;";
      el.innerHTML =
        `<svg width="16" height="22" viewBox="0 0 16 22" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.55))">` +
        `<path d="M0 0 L0 16 L4.5 12 L7 18 L9.5 17 L7 11 L12.5 11 Z" fill="${color}" ` +
        `stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
      const pill = document.createElement("span");
      pill.style.cssText =
        `background:${color};color:white;font-size:10px;font-weight:600;` +
        `padding:2px 6px;border-radius:4px;white-space:nowrap;` +
        `box-shadow:0 1px 3px rgba(0,0,0,0.35);`;
      el.appendChild(pill);
      container.appendChild(el);
      cache.set(c.identity, el);
    }
    el.style.left = `${c.x * 100}%`;
    el.style.top = `${c.y * 100}%`;
    const pill = el.querySelector("span");
    if (pill && pill.textContent !== c.name) pill.textContent = c.name;
  }
  for (const [id, el] of cache) {
    if (!visible.has(id)) {
      el.remove();
      cache.delete(id);
    }
  }
}

/** Rect of the media *content* (after `object-contain` letterbox/pillarbox)
 *  in viewport coordinates. When the element's aspect doesn't match the
 *  stream's (common when the sharer's screen is ultrawide and we render in
 *  a ~16:9 slot), the rect of the element itself includes black bars; using
 *  it for coordinate math puts the cursor in those bars, and broadcasts
 *  coords that fall outside what the sharer's native overlay can honour.
 *  Derived from the intrinsic dimensions (`videoWidth`/`videoHeight` for
 *  <video>, `width`/`height` for the native canvas), which
 *  carry the stream's intrinsic dimensions. Falls back to the element rect
 *  when metadata hasn't loaded yet. */
function getVideoContentRect(el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement) {
  const elRect = el.getBoundingClientRect();
  const vw = el instanceof HTMLVideoElement ? el.videoWidth : el instanceof HTMLImageElement ? el.naturalWidth : el.width;
  const vh = el instanceof HTMLVideoElement ? el.videoHeight : el instanceof HTMLImageElement ? el.naturalHeight : el.height;
  if (!vw || !vh || elRect.width === 0 || elRect.height === 0) {
    return { left: elRect.left, top: elRect.top, width: elRect.width, height: elRect.height };
  }
  const elAspect = elRect.width / elRect.height;
  const videoAspect = vw / vh;
  if (videoAspect > elAspect) {
    // Content wider than element → letterbox (bars top+bottom).
    const h = elRect.width / videoAspect;
    return { left: elRect.left, top: elRect.top + (elRect.height - h) / 2, width: elRect.width, height: h };
  }
  // Content taller than element → pillarbox (bars left+right).
  const w = elRect.height * videoAspect;
  return { left: elRect.left + (elRect.width - w) / 2, top: elRect.top, width: w, height: elRect.height };
}

/** Stable per-identity hue so each participant keeps the same cursor color
 *  across sessions. `hashCode` is the common string-to-int trick. */
function colorForIdentity(identity: string): string {
  let h = 0;
  for (let i = 0; i < identity.length; i++) {
    h = ((h << 5) - h + identity.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 75%, 55%)`;
}

async function decodeNativeJpeg(bytes: ArrayBuffer): Promise<{ source: CanvasImageSource; close: () => void }> {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, close: () => bitmap.close() };
  }
  // WebKitGTK ancien : décodage via Image + URL objet, toujours sans base64.
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("JPEG invalide"));
      image.src = url;
    });
    return { source: image, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** Peint une frame JPEG dans un canvas de tuile, en « contain » (bandes
 *  noires centrées) — l'équivalent d'`object-fit: contain` en 2D, avec la
 *  même astuce de netteté que la vue simple (surface au gabarit affiché). */
async function paintFrameToCanvas(canvas: HTMLCanvasElement, frame: VoiceNativeBinaryFrame): Promise<void> {
  const bytes = frame.jpeg.buffer.slice(
    frame.jpeg.byteOffset,
    frame.jpeg.byteOffset + frame.jpeg.byteLength,
  ) as ArrayBuffer;
  const decoded = await decodeNativeJpeg(bytes);
  try {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 160;
    const cssH = canvas.clientHeight || 90;
    const bw = Math.max(2, Math.round(cssW * dpr));
    const bh = Math.max(2, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = LETTERBOX_BLACK;
    ctx.fillRect(0, 0, bw, bh);
    const scale = Math.min(bw / frame.width, bh / frame.height);
    const dw = Math.max(1, frame.width * scale);
    const dh = Math.max(1, frame.height * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
  } finally {
    decoded.close();
  }
}

/** Icône « grille 2×2 » — bascule du mode mosaïque. */
function MosaicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

interface ShareTileProps {
  identity: string;
  name: string;
  hasAudio: boolean;
  muted: boolean;
  volume: number;
  subscribe: (cb: (frame: VoiceNativeBinaryFrame) => void) => () => void;
  getLatest: () => VoiceNativeBinaryFrame | undefined;
  onSelect: () => void;
  onToggleMute: (identity: string) => Promise<boolean>;
  onVolumeChange: (identity: string, v: number) => Promise<boolean>;
  /** Marque ce partage comme « pointé » (nettoyage global au blur/quit). */
  markPointed: (identity: string) => void;
  /** Carte flottante : le canvas remplit la hauteur restante (le lettrage
   *  reste géré par la peinture « contain »). */
  fill?: boolean;
  /** Carte flottante : démarre un drag par le bandeau (le parent écoute la
   *  fenêtre le temps du geste). */
  onHeaderDragStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Boutons supplémentaires en fin de bandeau (ex. « remettre en ligne »). */
  headerExtra?: React.ReactNode;
}

/** Zone image réellement peinte dans la tuile (« contain »), en coordonnées
 *  viewport — même géométrie que `getVideoContentRect` en vue simple. */
function tileContentRect(canvas: HTMLCanvasElement, frame: VoiceNativeBinaryFrame | null | undefined) {
  const rect = canvas.getBoundingClientRect();
  const fw = frame?.width ?? 0;
  const fh = frame?.height ?? 0;
  if (!fw || !fh || rect.width === 0 || rect.height === 0) return rect;
  const scale = Math.min(rect.width / fw, rect.height / fh);
  const w = fw * scale;
  const h = fh * scale;
  return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
}

/** Tuile du mode mosaïque : peint les frames de SON partageur dans sa propre
 *  zone (latest-wins, un décodage à la fois), porte SES contrôles son et le
 *  pointage (curseur vu par les autres viewers). Clic = vue simple sur ce
 *  partage ; double-clic sur l'image = plein écran. */
function ShareTile({ identity, name, hasAudio, muted, volume, subscribe, getLatest, onSelect, onToggleMute, onVolumeChange, markPointed, fill = false, onHeaderDragStart, headerExtra }: ShareTileProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastFrameRef = useRef<VoiceNativeBinaryFrame | null>(null);
  const drawingRef = useRef(false);
  const pendingRef = useRef<VoiceNativeBinaryFrame | null>(null);
  // Calque des curseurs distants, aligné sur la zone image (contain).
  const cursorBoxRef = useRef<HTMLDivElement>(null);
  const cursorLayerRef = useRef<HTMLDivElement>(null);
  const cursorElCache = useRef(new Map<string, HTMLDivElement>());
  // État audio local : les contrôles suivent le geste sans re-render du
  // parent (le store partagé reste la source des autres vues).
  const [mutedLocal, setMutedLocal] = useState(muted);
  const [volLocal, setVolLocal] = useState(volume);

  // Les valeurs externes peuvent bouger hors interaction (recalage moteur au
  // chargement, changement depuis un autre contrôle) : resynchronisation
  // pendant le rendu — le pattern React sanctionné, déjà utilisé pour
  // `audioCtl` plus bas (un effet déclenchait un warning set-state-in-effect).
  const [lastSyncedAudio, setLastSyncedAudio] = useState({ muted, volume });
  if (lastSyncedAudio.muted !== muted || lastSyncedAudio.volume !== volume) {
    setLastSyncedAudio({ muted, volume });
    setMutedLocal(muted);
    setVolLocal(volume);
  }

  useEffect(() => {
    // Positionne le calque curseurs sur la zone image (contenu letterboxé).
    const syncCursorBox = () => {
      const canvas = canvasRef.current;
      const box = cursorBoxRef.current;
      if (!canvas || !box) return;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const f = lastFrameRef.current;
      const fw = f?.width ?? 0;
      const fh = f?.height ?? 0;
      if (!fw || !fh || !cssW || !cssH) {
        box.style.left = "0"; box.style.top = "0";
        box.style.width = "100%"; box.style.height = "100%";
        return;
      }
      const scale = Math.min(cssW / fw, cssH / fh);
      const w = fw * scale;
      const h = fh * scale;
      box.style.left = `${(cssW - w) / 2}px`;
      box.style.top = `${(cssH - h) / 2}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    };

    const paint = (frame: VoiceNativeBinaryFrame) => {
      lastFrameRef.current = frame;
      if (drawingRef.current) {
        pendingRef.current = frame;
        return;
      }
      drawingRef.current = true;
      void (async () => {
        let next: VoiceNativeBinaryFrame | null = frame;
        while (next) {
          pendingRef.current = null;
          const canvas = canvasRef.current;
          if (canvas) {
            try {
              await paintFrameToCanvas(canvas, next);
              syncCursorBox();
            } catch { /* frame perdue — la suivante arrive (~70 ms) */ }
          }
          next = pendingRef.current;
        }
        drawingRef.current = false;
      })();
    };

    // Frame en cache dès le montage : pas de tuile noire en attendant la
    // prochaine image (~250 ms max, souvent déjà là).
    const initial = getLatest();
    if (initial) paint(initial);
    const unsubscribe = subscribe(paint);
    // Un changement de gabarit (bascule mosaïque, resize) repeint la dernière
    // frame : le canvas est dimensionné à l'affiché à chaque peinture.
    const observer = new ResizeObserver(() => {
      syncCursorBox();
      const f = lastFrameRef.current;
      if (f) paint(f);
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      unsubscribe();
      observer.disconnect();
    };
    // `getLatest`/`subscribe` s'appuient sur des refs du parent (stables).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Curseurs distants pointant CE partage — en mosaïque aussi, chacun voit
  // les curseurs des autres viewers sur la bonne tuile.
  useEffect(() => {
    const cache = cursorElCache.current;
    const layer = cursorLayerRef.current;
    const unsub = onCursorsChange((c) => {
      syncCursorLayer(layer, cache, c, identity);
    });
    return () => {
      unsub();
      cache.clear();
      if (layer) layer.innerHTML = "";
    };
  }, [identity]);

  // Pointage depuis cette tuile : nos positions partent pour CE partage
  // (watchdog 5 s d'immobilité, hide en sortant — mêmes règles que la vue
  // simple, cf. `CURSOR_HIDE_AFTER_MS`).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastBroadcast = 0;
    let inside = false;
    let hideTimer: number | null = null;
    const clearHide = () => {
      if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    };
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      const r = tileContentRect(canvas, lastFrameRef.current);
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        if (inside) { broadcastCursorHide(identity); inside = false; }
        clearHide();
        return;
      }
      if (now - lastBroadcast < CURSOR_BROADCAST_INTERVAL) return;
      lastBroadcast = now;
      inside = true;
      broadcastCursor(x, y, identity);
      markPointed(identity);
      clearHide();
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        if (inside) { broadcastCursorHide(identity); inside = false; }
      }, CURSOR_HIDE_AFTER_MS);
    };
    const onLeave = () => {
      clearHide();
      if (inside) { broadcastCursorHide(identity); inside = false; }
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      clearHide();
      if (inside) broadcastCursorHide(identity);
    };
    // `markPointed` s'appuie sur une ref du parent (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  return (
    <div
      onClick={onSelect}
      className="share-tile"
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0,
        background: 'var(--color-surface-container-low)',
        borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
        ...(fill ? { height: '100%' } : {}),
      }}
    >
      <div
        onPointerDown={onHeaderDragStart}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)',
          ...(onHeaderDragStart ? { cursor: 'move', touchAction: 'none' } : {}),
        }}
      >
        <ScreenIcon />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
        {hasAudio && (
          <>
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                const next = !mutedLocal;
                setMutedLocal(next);
                const ok = await onToggleMute(identity);
                if (!ok) setMutedLocal(!next);
              }}
              title={mutedLocal ? t("screenShare.unmuteAudio", { defaultValue: "Réactiver le son du partage" }) : t("screenShare.muteAudio", { defaultValue: "Couper le son du partage" })}
              aria-label={mutedLocal ? t("screenShare.unmuteAudio", { defaultValue: "Réactiver le son du partage" }) : t("screenShare.muteAudio", { defaultValue: "Couper le son du partage" })}
              className="flex items-center shrink-0"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: mutedLocal ? 'var(--color-error)' : 'var(--color-on-surface-variant)' }}
            >
              {mutedLocal ? <SpeakerMutedIcon /> : <SpeakerIcon />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((mutedLocal ? 0 : volLocal) * 100)}
              onClick={(e) => e.stopPropagation()}
              onChange={async (e) => {
                const v = Number(e.target.value) / 100;
                const prevVol = volLocal;
                const prevMuted = mutedLocal;
                setVolLocal(v);
                setMutedLocal(v === 0);
                const ok = await onVolumeChange(identity, v);
                if (!ok) { setVolLocal(prevVol); setMutedLocal(prevMuted); }
              }}
              title={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
              aria-label={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
              className="screenshare-volume-slider shrink-0"
              style={{ width: 64 }}
            />
          </>
        )}
        {headerExtra}
      </div>
      <div style={{ position: 'relative', width: '100%', ...(fill ? { flex: 1, minHeight: 0 } : {}) }}>
        <canvas
          ref={canvasRef}
          aria-label={name}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const c = canvasRef.current;
            if (!c) return;
            if (document.fullscreenElement === c) document.exitFullscreen().catch(() => { /* ignore */ });
            else c.requestFullscreen().catch(() => { /* ignore */ });
          }}
          style={fill
            ? { width: '100%', height: '100%', background: LETTERBOX_BLACK, display: 'block' }
            : { width: '100%', aspectRatio: '16 / 9', background: LETTERBOX_BLACK, display: 'block' }}
        />
        <div ref={cursorBoxRef} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' }}>
          <div ref={cursorLayerRef} style={{ position: 'absolute', inset: 0 }} />
        </div>
      </div>
    </div>
  );
}

/** Icône « détacher » (carte flottante) — cadre + flèche sortante. */
function FloatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="13" rx="2" />
      <path d="M21 3v6" />
      <path d="M15 9l6-6" />
    </svg>
  );
}

/** Icône « remettre en ligne » — coins vers l'intérieur. */
function DockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v4a2 2 0 0 1-2 2H3" />
      <path d="M15 3v4a2 2 0 0 0 2 2h4" />
      <path d="M9 21v-4a2 2 0 0 0-2-2H3" />
      <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

/** Icône « PIP natif » — écran + vignette posée dessus (fenêtre OS). */
function NativePipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <rect x="12" y="11" width="9" height="6" rx="1" />
      <path d="M8 21h8" />
    </svg>
  );
}

interface FloatingShareCardProps {
  identity: string;
  name: string;
  hasAudio: boolean;
  muted: boolean;
  volume: number;
  x: number;
  y: number;
  w: number;
  h: number;
  subscribe: (cb: (frame: VoiceNativeBinaryFrame) => void) => () => void;
  getLatest: () => VoiceNativeBinaryFrame | undefined;
  onToggleMute: (identity: string) => Promise<boolean>;
  onVolumeChange: (identity: string, v: number) => Promise<boolean>;
  markPointed: (identity: string) => void;
  onMove: (x: number, y: number) => void;
  onResizeW: (w: number) => void;
  onResizeH: (h: number) => void;
  onDockBack: () => void;
}

/** Carte PIP interne : un partage détaché en carte flottante au-dessus de
 *  l'app. Drag par le bandeau (snap aux quatre coins à la dépose), resize par
 *  les bords gauche/bas (le bord droit reste ancré), son/pointage/curseurs
 *  fournis par `ShareTile`. `position: fixed` — la carte survit aux
 *  changements de salon. */
function FloatingShareCard({ identity, name, hasAudio, muted, volume, x, y, w, h, subscribe, getLatest, onToggleMute, onVolumeChange, markPointed, onMove, onResizeW, onResizeH, onDockBack }: FloatingShareCardProps) {
  const { t } = useTranslation();

  // Drag par le bandeau : écouteurs fenêtre le temps du geste, snap aux coins
  // à la dépose (à moins de 48 px d'un bord → collage à 12 px).
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const x0 = x;
    const y0 = y;
    let lastX = x;
    let lastY = y;
    const onMoveWin = (ev: PointerEvent) => {
      lastX = Math.min(Math.max(x0 + ev.clientX - startX, 4), Math.max(4, window.innerWidth - w - 10));
      // Au plus bas, on garde le bandeau (≈ 28 px) entièrement visible :
      // sinon la carte lâchée en bas ne se voit « plus du tout » et le bouton
      // « remettre en ligne » devient inatteignable.
      lastY = Math.min(Math.max(y0 + ev.clientY - startY, 4), Math.max(4, window.innerHeight - 60));
      onMove(lastX, lastY);
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
      if (sx !== lastX || sy !== lastY) onMove(sx, sy);
    };
    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
  };

  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, width: w + 6, height: h + 6,
        zIndex: 400, display: 'flex',
      }}
    >
      <ResizeHandle
        side="left"
        value={w}
        min={SHARE_FLOATING_MIN_W}
        max={Math.max(SHARE_FLOATING_MIN_W, window.innerWidth - 40)}
        onChange={onResizeW}
        onReset={() => onResizeW(440)}
        label={t("screenShare.floatResize", { defaultValue: "Redimensionner la carte flottante — double-clic pour la taille par défaut" })}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.55)' }}>
          <ShareTile
            identity={identity}
            name={name}
            hasAudio={hasAudio}
            muted={muted}
            volume={volume}
            subscribe={subscribe}
            getLatest={getLatest}
            onSelect={() => { /* la carte flottante ne « sélectionne » rien */ }}
            onToggleMute={onToggleMute}
            onVolumeChange={onVolumeChange}
            markPointed={markPointed}
            fill
            onHeaderDragStart={startDrag}
            headerExtra={(
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDockBack(); }}
                title={t("screenShare.dockBack", { defaultValue: "Remettre en ligne (Ctrl+Maj+P)" })}
                aria-label={t("screenShare.dockBack", { defaultValue: "Remettre en ligne (Ctrl+Maj+P)" })}
                className="flex items-center shrink-0"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'var(--color-on-surface-variant)' }}
              >
                <DockIcon />
              </button>
            )}
          />
        </div>
        <ResizeHandle
          side="bottom"
          value={h}
          min={SHARE_FLOATING_MIN_H}
          max={Math.max(SHARE_FLOATING_MIN_H, window.innerHeight - 60)}
          onChange={onResizeH}
          onReset={() => onResizeH(300)}
          label={t("screenShare.floatResize", { defaultValue: "Redimensionner la carte flottante — double-clic pour la taille par défaut" })}
        />
      </div>
    </div>
  );
}

/** Styles partagés des deux modes (ripples, bouton plein écran, tuiles) —
 *  rendus dans les deux branches, la vue simple étant démontée en flottant. */
function ShareViewStyles() {
  return (
    <style>{`
      @keyframes sion-ripple-viewer {
        0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.85; }
        100% { transform: translate(-50%, -50%) scale(3);   opacity: 0; }
      }
      /* Bouton plein écran posé sur la vidéo : révélé au survol de la
         zone, toujours visible au clavier et sur tactile (pas de hover). */
      .ss-expand { opacity: 0; transition: opacity 160ms ease; }
      .screen-share-viewer:hover .ss-expand,
      .ss-expand:focus-visible { opacity: 1; }
      @media (hover: none) { .ss-expand { opacity: 1; } }
      /* Tuile mosaïque / carte flottante : bordure éclaircie au survol —
         indique qu'elle est cliquable (clic = vue simple sur ce partage). */
      .share-tile { border: 1px solid var(--color-outline-variant); transition: border-color 150ms ease; }
      .share-tile:hover { border-color: var(--color-outline); }
    `}</style>
  );
}

export function ScreenShareView() {
  const { t } = useTranslation();
  // Moteur unique : les partages viennent des participants natifs
  // (`isScreenSharing`) et les pixels des paquets WebSocket locaux (JPEG),
  // peints hors React dans un canvas.
  const nativeParticipants = useLiveKitStore((s) => s.participants);
  const connectedVoiceChannel = useAppStore((s) => s.connectedVoiceChannel);
  // Hauteur de la zone de partage : réglable à la poignée sous la vidéo,
  // persistée dans `sion-layout` (reprise au chargement de l'app).
  const shareViewMaxVh = useLayoutStore((s) => s.shareViewMaxVh);
  const setShareViewMaxVh = useLayoutStore((s) => s.setShareViewMaxVh);
  const resetShareViewMaxVh = useLayoutStore((s) => s.resetShareViewMaxVh);
  const shareDock = useLayoutStore((s) => s.shareDock);
  const shareFloating = useLayoutStore((s) => s.shareFloating);
  const setShareFloating = useLayoutStore((s) => s.setShareFloating);
  const toggleShareDock = useLayoutStore((s) => s.toggleShareDock);
  const nativeShares: ScreenShareInfo[] = useMemo(() => {
    return nativeParticipants
      .filter((p) => p.isScreenSharing)
      .map((p) => {
        const nativeName = p.name?.trim();
        const participantName = nativeName && !/^@[^:]+:[^:]+(?::.+)?$/.test(nativeName)
          ? nativeName
          : resolveNativeDisplayName(p.identity, connectedVoiceChannel);
        return {
          participantIdentity: p.identity,
          participantName,
          // Présence fournie par le moteur natif (piste ScreenshareAudio) ;
          // le mute passe par `voice_native_set_screenshare_audio_muted`.
          hasAudio: p.isScreenSharingAudio ?? false,
        };
      });
  }, [connectedVoiceChannel, nativeParticipants]);
  // All concurrent shares in the channel; `selectedId` is the viewer's pick.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mode mosaïque : toutes les tuiles de partage côte à côte (≥ 2 partages).
  const [mosaic, setMosaic] = useState(false);
  const activeShares = nativeShares;
  const [clicks, setClicks] = useState<RemoteCursorClick[]>([]);
  // Content-area box (inside the video element, after object-contain) in
  // coordinates relative to `containerRef`. Used to position the cursor +
  // ripple overlays so they track the actual pixels of the shared screen,
  // not the letterbox bars. Null until the first measurement.
  const [contentBox, setContentBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derive the active share from the viewer's pick, auto-falling back to the
  // first available one when their pick is gone — no effect needed.
  const activeShare = activeShares.find((s) => s.participantIdentity === selectedId) ?? activeShares[0] ?? null;
  const activeIdentity = activeShare?.participantIdentity ?? null;

  // PIP natif (fenêtre OS au-dessus des autres applis) : état reflété depuis
  // Rust — elle peut s'être fermée seule (fin de partage, clic droit).
  const [nativePipOpen, setNativePipOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void pipNativeStatus().then((open) => { if (alive) setNativePipOpen(open); });
    return () => { alive = false; };
  }, [activeIdentity]);

  // Cache des dernières frames natives (binaire par expéditeur) + miroir de
  // l'identité active pour le callback d'événement (abonnement unique).
  // Le canvas est peint hors React : aucune data-URL/base64 ni re-render à
  // chaque image.
  const framesRef = useRef(new Map<string, VoiceNativeBinaryFrame>());
  const activeRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Partages vers lesquels on a pointé dans cette session — permet de tout
  // nettoyer chez les partageurs (blur, minimisation, fermeture), y compris
  // leurs anciennes versions qui n'acceptent que les masquages CIBLÉS.
  const pointedTargetsRef = useRef<Set<string>>(new Set());
  // Abonnés par expéditeur (tuiles du mode mosaïque) : chaque frame reçue
  // est diffusée à la tuile concernée, en plus du cache `framesRef`.
  const frameSubscribersRef = useRef(new Map<string, Set<(f: VoiceNativeBinaryFrame) => void>>());
  const subscribeFrames = useCallback((sender: string, cb: (f: VoiceNativeBinaryFrame) => void) => {
    let set = frameSubscribersRef.current.get(sender);
    if (!set) {
      set = new Set();
      frameSubscribersRef.current.set(sender, set);
    }
    set.add(cb);
    return () => {
      const s = frameSubscribersRef.current.get(sender);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) frameSubscribersRef.current.delete(sender);
    };
  }, []);
  const paintLatestRef = useRef<() => void>(() => {});
  // Mesure de latence réception→pixels.
  // Tout en refs, log throttled toutes les 5 s, zéro re-render.
  const latRef = useRef({ count: 0, sum: 0, start: 0, lastLog: 0 });

  // Miroir de l'identité active pour le callback d'événement (abonnement
  // unique) — en effet, pas pendant le rendu.
  useEffect(() => {
    activeRef.current = activeIdentity;
  });

  // Saturation du thread principal (diagnostic) : tâches >50 ms sur 10 s.
  // Placé avant tout return précoce : mesure en viewer comme en sharer.
  // Si le main thread est saturé (décodage JPEG plein écran + React +
  // curseurs), TOUT y est saccadé des deux côtés.
  useEffect(() => {
    // Diagnostic de saturation — DEV uniquement : en production, un
    // PerformanceObserver + un intervalle de 10 s qui ne servent à rien sont
    // du bruit (et un timer de plus).
    if (!import.meta.env.DEV) return;
    let count = 0;
    let total = 0;
    let max = 0;
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          count++;
          total += e.duration;
          if (e.duration > max) max = e.duration;
        }
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch { /* non supporté */ }
    const timer = setInterval(() => {
      if (count > 0) {
        console.info(
          `[Sion][Perf] main-thread: ${count} longtasks/10s, total ${total.toFixed(0)}ms, max ${max.toFixed(0)}ms`,
        );
      }
      count = 0;
      total = 0;
      max = 0;
    }, 10000);
    return () => {
      po?.disconnect();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let closeVideo: (() => void) | null = null;
    let unsubStopped: (() => void) | null = null;
    let drawing = false;
    let requested = false;
    let lastPainted: VoiceNativeBinaryFrame | null = null;

    const paint = () => {
      requested = true;
      if (drawing) return;
      drawing = true;
      void (async () => {
        while (requested && !cancelled) {
          requested = false;
          const sender = activeRef.current;
          const frame = sender ? framesRef.current.get(sender) : undefined;
          if (!frame || frame === lastPainted) continue;
          const bytes = frame.jpeg.buffer.slice(
            frame.jpeg.byteOffset,
            frame.jpeg.byteOffset + frame.jpeg.byteLength,
          ) as ArrayBuffer;
          let decoded: Awaited<ReturnType<typeof decodeNativeJpeg>> | null = null;
          try {
            decoded = await decodeNativeJpeg(bytes);
            if (!cancelled && activeRef.current === sender && canvasRef.current) {
              const canvas = canvasRef.current;
              // WebKitGTK composite le canvas avec un filtrage plus mou que
              // Chromium quand il doit le réduire (partage 1440p+ affiché en
              // 1080p). On dimensionne donc la surface au gabarit AFFICHÉ (en
              // pixels physiques) et on fait la réduction nous-mêmes via
              // drawImage + imageSmoothingQuality — le compositeur reste en
              // 1:1 et le texte net.
              const dpr = window.devicePixelRatio || 1;
              const cssW = canvas.clientWidth || frame.width / dpr;
              const bw = Math.max(2, Math.round(cssW * dpr));
              const bh = Math.max(2, Math.round((bw * frame.height) / frame.width));
              if (canvas.width !== bw || canvas.height !== bh) {
                canvas.width = bw;
                canvas.height = bh;
              }
              const ctx = canvas.getContext("2d", { alpha: false });
              if (ctx) {
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(decoded.source, 0, 0, bw, bh);
              }
              lastPainted = frame;
              const now = performance.now();
              const lat = latRef.current;
              if (lat.start === 0) lat.start = now;
              lat.count += 1;
              lat.sum += now - frame.receivedAt;
              if (now - lat.lastLog > 5000) {
                console.info(
                  `[Sion][partage-natif] canvas: ${(lat.count / ((now - lat.start) / 1000)).toFixed(1)} im/s, ` +
                  `réception→pixels ${(lat.sum / lat.count).toFixed(0)} ms`,
                );
                latRef.current = { count: 0, sum: 0, start: now, lastLog: now };
              }
            }
          } catch (err) {
            console.warn("[Sion][partage-natif] décodage JPEG impossible:", err);
          } finally {
            decoded?.close();
          }
        }
      })().finally(() => {
        drawing = false;
        if (requested && !cancelled) paint();
      });
    };
    paintLatestRef.current = paint;
    import("../../services/voiceNativeService").then((native) => {
      if (cancelled) return;
      native.onVoiceNativeFrameStopped((s) => {
        framesRef.current.delete(s.sender);
        if (activeRef.current === s.sender && canvasRef.current) {
          canvasRef.current.getContext("2d")?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }).then((u) => { unsubStopped = u; }).catch(() => {});
    }).catch(() => {});
    connectVoiceNativeVideoStream((frame) => {
      framesRef.current.set(frame.sender, frame);
      // Diffuse aux tuiles abonnées (mode mosaïque) — un abonné défaillant
      // ne doit pas casser le flux des autres.
      const subs = frameSubscribersRef.current.get(frame.sender);
      if (subs) {
        for (const cb of subs) {
          try { cb(frame); } catch { /* tuile isolée */ }
        }
      }
      // Peinture de la vue simple uniquement si son canvas est monté — en
      // carte flottante, décoder ici ne servirait à rien (la carte a son
      // propre peintre via `subscribeFrames`).
      if (activeRef.current === frame.sender && canvasRef.current) paint();
    }).then((close) => { closeVideo = close; }).catch((err) => {
      console.warn("[Sion][partage-natif] connexion vidéo impossible:", err);
    });
    return () => {
      cancelled = true;
      paintLatestRef.current = () => {};
      closeVideo?.();
      unsubStopped?.();
    };
    // `mosaic` / `shareDock` : chaque bascule remonte/démonte le canvas de la
    // vue simple — on repart avec un `lastPainted` neuf, sinon la frame en
    // cache serait considérée « déjà peinte » et l'écran resterait noir en
    // revenant de la mosaïque ou de la carte flottante.
  }, [mosaic, shareDock]);

  // Changement de partage actif (mosaïque ou carte flottante comprise) :
  // appliquer la frame en cache immédiatement — sans ça, l'écran restait noir
  // le temps de la prochaine frame après un retour.
  useEffect(() => {
    if (!canvasRef.current) return;
    paintLatestRef.current();
  }, [activeIdentity, mosaic, shareDock]);

  // Plus aucun partage actif : purger les JPEG en cache (sinon ils restent
  // jusqu'à la prochaine session de partage) et effacer le canvas.
  useEffect(() => {
    if (nativeShares.length > 0) return;
    framesRef.current.clear();
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [nativeShares.length]);

  // Audio control widgets, re-synced from the local per-share state when the
  // active share changes (each sharer keeps their own mute/volume). Adjusting
  // state during render is React's sanctioned alternative to a
  // setState-in-effect.
  const [audioCtl, setAudioCtl] = useState<{ id: string | null; muted: boolean; volume: number }>({ id: null, muted: false, volume: 1 });
  // Bump de re-render après recalage audio depuis le moteur (cf. effet plus bas).
  const [, setAudioSeedTick] = useState(0);
  if (audioCtl.id !== activeIdentity) {
    const st = activeIdentity ? screenShareAudioState(activeIdentity) : { muted: false, volume: 1 };
    setAudioCtl({ id: activeIdentity, muted: st.muted, volume: st.volume });
  }
  const audioMuted = audioCtl.muted;
  const audioVolume = audioCtl.volume;

  // Subscribe to remote cursors only while a share is visible. Positions
  // synchronisées en DOM direct (pas de setState : voir `syncCursorLayer`).
  const cursorLayerRef = useRef<HTMLDivElement>(null);
  const cursorElCache = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    const cache = cursorElCache.current;
    const layer = cursorLayerRef.current;
    if (!activeIdentity) {
      cache.clear();
      if (layer) layer.innerHTML = "";
      return;
    }
    const unsub = onCursorsChange((c) => {
      cursorRenderCount++;
      const now = performance.now();
      if (now - cursorRenderWindowStart > 5000) {
        if (cursorRenderCount > 0) {
          console.info(`[Sion][Cursor] rendu ~${(cursorRenderCount / ((now - cursorRenderWindowStart) / 1000)).toFixed(0)}/s`);
        }
        cursorRenderCount = 0;
        cursorRenderWindowStart = now;
      }
      syncCursorLayer(layer, cache, c, activeIdentity);
    });
    return () => {
      unsub();
      cache.clear();
      if (layer) layer.innerHTML = "";
    };
  }, [activeIdentity]);

  // Subscribe to click ripples — ephemeral, auto-swept after CLICK_TTL_MS.
  useEffect(() => {
    if (!activeIdentity) { setClicks([]); return; }
    const unsub = onCursorClick((click) => {
      setClicks((prev) => [...prev, click]);
    });
    const sweep = setInterval(() => {
      const now = Date.now();
      setClicks((prev) => prev.filter((c) => c.expiresAt > now));
    }, 300);
    return () => { unsub(); clearInterval(sweep); setClicks([]); };
  }, [activeIdentity]);

  // Capture local cursor and broadcast normalised coords. Throttled to
  // CURSOR_BROADCAST_HZ so the data channel stays light. L'élément est le
  // canvas des frames JPEG (géométrie object-contain).
  useEffect(() => {
    if (!activeIdentity) return;
    const media = canvasRef.current;
    if (!media) return;
    const video = media;

    let lastBroadcast = 0;
    let insideVideo = false;

    // Watchdog d'immobilité : sans nouvelle position pendant 5 s — souris
    // arrêtée, ou fenêtre quittée sans `leave`/blur fiable (alt-tab) — on
    // envoie un masquage pour que la flèche ne reste pas figée sur l'écran
    // du partageur. Repoussé à chaque position émise.
    let hideTimer: number | null = null;
    const armHideTimer = () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        if (insideVideo) {
          broadcastCursorHide(activeIdentity);
          insideVideo = false;
        }
      }, CURSOR_HIDE_AFTER_MS);
    };
    const clearHideTimer = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    // Masquage « partout » : cible tous les partages vers lesquels on a
    // pointé dans la session (les partageurs en ancienne version ne
    // comprennent que les masquages ciblés), puis un masquage sans cible
    // pour les versions récentes. Utilisé au blur / minimisation / fermeture.
    const hideEverywhere = () => {
      if (pointedTargetsRef.current.size > 0) {
        for (const t of pointedTargetsRef.current) broadcastCursorHide(t);
        pointedTargetsRef.current.clear();
      }
      broadcastCursorHide();
    };
    // getBoundingClientRect() force un recalcul de layout synchrone : à
    // 60-120 Hz d'événements souris sur un arbre sali par les re-renders,
    // ça cale le thread (envoi saccadé à la source). Cache 50 ms — pendant
    // un resize, 50 ms de décalage sont imperceptibles.
    let cachedRect: ReturnType<typeof getVideoContentRect> | null = null;
    let cachedRectAt = 0;
    const getRect = () => {
      const now = performance.now();
      if (!cachedRect || now - cachedRectAt > 50) {
        cachedRect = getVideoContentRect(video);
        cachedRectAt = now;
      }
      return cachedRect;
    };

    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      const rect = getRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        // Sortie : TOUJOURS signalée immédiatement, jamais throttlée — une
        // sortie avalée par le throttle (souris rapide <16 ms) laissait un
        // curseur fantôme collé au bord jusqu'au TTL.
        if (insideVideo) {
          broadcastCursorHide(activeIdentity);
          insideVideo = false;
          lastBroadcast = now;
        }
        clearHideTimer();
        return;
      }
      if (now - lastBroadcast < CURSOR_BROADCAST_INTERVAL) return;
      insideVideo = true;
      lastBroadcast = now;
      broadcastCursor(x, y, activeIdentity);
      pointedTargetsRef.current.add(activeIdentity);
      // Tant que la souris bouge ici, on repousse le masquage automatique.
      armHideTimer();
    };

    const onLeave = () => {
      clearHideTimer();
      if (insideVideo) { broadcastCursorHide(activeIdentity); insideVideo = false; }
    };

    // Quitter l'app (alt-tab, minimisation, fermeture/redémarrage) : on ne
    // pointe plus rien — masquage immédiat de NOTRE curseur partout, sinon un
    // alt-tab ou un restart laissait une flèche fantôme sur l'écran du
    // partageur (son ancienne version n'a que le TTL 60 s comme filet).
    const onAppAway = () => {
      clearHideTimer();
      insideVideo = false;
      hideEverywhere();
    };

    // Single-click = "point here" ripple (broadcast to sharer + peers).
    // Double-click = toggle fullscreen (YouTube-style). We DON'T send a
    // ripple on dblclick — the browser fires both click and dblclick, but
    // we swallow the 2nd click inside the 300 ms dblclick window.
    let lastClickAt = 0;
    const DBLCLICK_WINDOW = 300;
    const onClick = (e: MouseEvent) => {
      const rect = getRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now - lastClickAt < DBLCLICK_WINDOW) {
        // Part of a double-click → let the dblclick handler take over.
        lastClickAt = 0;
        return;
      }
      lastClickAt = now;
      // Slight delay: if a 2nd click arrives within DBLCLICK_WINDOW, it's a
      // double-click and we skip the ripple. Otherwise fire it after the
      // window so we never ripple on an intended double-click.
      setTimeout(() => {
        if (performance.now() - lastClickAt < DBLCLICK_WINDOW / 2) {
          // A 2nd click arrived — dblclick will handle it, skip ripple.
          return;
        }
        broadcastCursorClick(x, y, activeIdentity);
      }, DBLCLICK_WINDOW);
    };

    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (document.fullscreenElement === video) {
        document.exitFullscreen().catch(() => { /* ignore */ });
      } else {
        video.requestFullscreen().catch((err) => {
          console.warn("[Sion] requestFullscreen failed:", err);
        });
      }
    };

    // Fenêtre minimisée / autre bureau virtuel : traité comme quitter l'app.
    const onVisibility = () => { if (document.hidden) onAppAway(); };

    video.addEventListener("mousemove", onMove as EventListener);
    video.addEventListener("mouseleave", onLeave);
    video.addEventListener("click", onClick as EventListener);
    video.addEventListener("dblclick", onDblClick as EventListener);
    window.addEventListener("blur", onAppAway);
    window.addEventListener("pagehide", onAppAway);
    // Sortie de la fenêtre par un autre chemin que la vidéo (ex. sortie
    // rapide sans mouseleave vidéo fiable) : le document la voit toujours.
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      video.removeEventListener("mousemove", onMove as EventListener);
      video.removeEventListener("mouseleave", onLeave);
      video.removeEventListener("click", onClick as EventListener);
      video.removeEventListener("dblclick", onDblClick as EventListener);
      window.removeEventListener("blur", onAppAway);
      window.removeEventListener("pagehide", onAppAway);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      clearHideTimer();
      // Démontage / changement de partage actif : notre curseur ne doit
      // rester chez personne.
      hideEverywhere();
    };
    // `mosaic` / `shareDock` : quand la vue simple n'est pas montée (mosaïque
    // ou carte flottante), l'effet se ré-exécute pour délier/lier les
    // écouteurs au bon élément, et le cleanup ci-dessus masque notre curseur
    // en entrant.
  }, [activeIdentity, mosaic, shareDock]);

  // Track the content-area box so the absolute-positioned overlays (cursors,
  // click ripples) sit exactly over the pixels the sharer captured, not over
  // the letterbox bars. Le canvas natif change ses dimensions à la première
  // frame ; les frames gardent ensuite le même ratio dans une publication.
  // useLayoutEffect to avoid a single-frame flash of overlays positioned
  // against stale measurements.
  useLayoutEffect(() => {
    if (!activeIdentity) { setContentBox(null); return; }
    const media = canvasRef.current;
    const container = containerRef.current;
    if (!media || !container) return;

    const measure = () => {
      const m = canvasRef.current;
      const c = containerRef.current;
      if (!m || !c) return;
      const rect = getVideoContentRect(m);
      const parent = c.getBoundingClientRect();
      setContentBox({
        left: rect.left - parent.left,
        top: rect.top - parent.top,
        width: rect.width,
        height: rect.height,
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(media);
    ro.observe(container);
    const timer = window.setInterval(measure, 500);
    return () => { ro.disconnect(); window.clearInterval(timer); };
  }, [activeIdentity]);

  /** Coupe/rétablit le son d'un partage — l'actif comme une tuile mosaïque.
   *  Retourne false si le moteur a refusé, pour que l'appelant annule son
   *  état optimiste. */
  const handleToggleAudioMute = async (identity: string): Promise<boolean> => {
    const st = screenShareAudioState(identity);
    const next = !st.muted;
    shareAudioState.set(identity, { ...st, muted: next });
    if (identity === activeIdentity) setAudioCtl((c) => ({ ...c, muted: next }));
    try {
      // La (dés)inscription de la piste ScreenshareAudio passe par le moteur
      // Rust ; l'état local reste la source de vérité des icônes.
      await setVoiceNativeShareAudioMuted(identity, next);
      return true;
    } catch {
      // Moteur injoignable : on ne ment pas à l'UI, on annule le toggle.
      shareAudioState.set(identity, st);
      if (identity === activeIdentity) setAudioCtl((c) => ({ ...c, muted: st.muted }));
      return false;
    }
  };

  /** Règle le volume local d'un partage (0 = coupe ; la remontée réactive),
   *  par identité — mêmes garanties que le mute ci-dessus. */
  const handleVolumeChange = async (identity: string, v: number): Promise<boolean> => {
    const st = screenShareAudioState(identity);
    const shouldMute = v === 0;
    const muteChanged = shouldMute !== st.muted;
    shareAudioState.set(identity, { ...st, volume: v, muted: shouldMute });
    if (identity === activeIdentity) setAudioCtl((c) => ({ ...c, volume: v, muted: shouldMute }));
    try {
      await setVoiceNativeShareAudioVolume(identity, v);
      // La souscription LiveKit ne change qu'aux transitions 0 ↔ volume.
      // Les mouvements intermédiaires du curseur ne pilotent que le gain.
      if (muteChanged) await setVoiceNativeShareAudioMuted(identity, shouldMute);
      return true;
    } catch {
      shareAudioState.set(identity, st);
      if (identity === activeIdentity) setAudioCtl((c) => ({ ...c, volume: st.volume, muted: st.muted }));
      return false;
    }
  };

  // Recalage du miroir JS sur l'état moteur réel. Le moteur garde ses
  // mutes/volumes PAR PARTAGE, pas la mémoire JS — qui peut les perdre au
  // reload complet comme aux hot-updates Vite (le module est ré-exécuté, la
  // map `shareAudioState` repart vide). Sans ce recalage, l'UI affichait
  // « non muté / à fond » pour une piste restée coupée côté moteur.
  // Exécuté à CHAQUE rendu, gardé par `has()` + « en vol » : no-op dès que
  // tout est connu, toute entrée manquante est relue (jamais au-dessus d'un
  // réglage utilisateur, qui crée l'entrée).
  const audioFetchInflightRef = useRef<Set<string>>(new Set());
  // Échecs cumulés par partage : hors session native (mode web), on arrête
  // après quelques tentatives au lieu de re-fetcher à chaque rendu.
  const audioFetchAttemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const s of nativeShares) {
      const id = s.participantIdentity;
      if (
        shareAudioState.has(id)
        || audioFetchInflightRef.current.has(id)
        || (audioFetchAttemptsRef.current.get(id) ?? 0) >= 3
      ) continue;
      audioFetchInflightRef.current.add(id);
      void getVoiceNativeShareAudioState(id).then((st) => {
        if (!shareAudioState.has(id)) {
          shareAudioState.set(id, { muted: st.muted, volume: st.volume });
        }
        const cur = shareAudioState.get(id);
        if (cur && activeRef.current === id) {
          setAudioCtl({ id, muted: cur.muted, volume: cur.volume });
        }
        setAudioSeedTick((n) => n + 1);
      }).catch(() => {
        audioFetchAttemptsRef.current.set(id, (audioFetchAttemptsRef.current.get(id) ?? 0) + 1);
      }).finally(() => {
        audioFetchInflightRef.current.delete(id);
      });
    }
  });

  // Le son du partage (mute/volume) peut être changé depuis le PIP natif :
  // la vue suit le moteur — sinon les deux affichages divergent (un mute
  // dans le PIP laissait la vue « actif », constaté le 2026-09-12).
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onVoiceNativeShareAudio((ev) => {
      if (!alive) return;
      shareAudioState.set(ev.sender, { muted: ev.muted, volume: ev.volume });
      if (activeRef.current === ev.sender) {
        setAudioCtl({ id: ev.sender, muted: ev.muted, volume: ev.volume });
      }
      setAudioSeedTick((n) => n + 1);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Le PIP natif peut se fermer tout seul (bouton maison, clic droit,
  // Échap) : l'état du bouton de la vue suit.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onVoiceNativePip((ev) => {
      if (alive) setNativePipOpen(ev.open);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  /** Plein écran depuis le bouton de la barre d'onglets (même logique que le
   *  double-clic sur la vidéo). */
  const handleToggleFullscreen = () => {
    const video = canvasRef.current;
    if (!video) return;
    if (document.fullscreenElement === video) {
      document.exitFullscreen().catch(() => { /* ignore */ });
    } else {
      video.requestFullscreen().catch((err) => {
        console.warn("[Sion] requestFullscreen failed:", err);
      });
    }
  };

  // Carousel navigation between concurrent shares (wraps around).
  const activeIndex = activeShares.findIndex((s) => s.participantIdentity === activeIdentity);
  const goToShare = (delta: number) => {
    if (activeShares.length < 2) return;
    const base = activeIndex < 0 ? 0 : activeIndex;
    const next = (base + delta + activeShares.length) % activeShares.length;
    setSelectedId(activeShares[next].participantIdentity);
  };

  if (!activeShare) return null;

  // Only show ripples EXPLICITLY pointing at the share we're currently
  // watching (les curseurs sont filtrés dans `syncCursorLayer`). Coords are
  // relative to one share; a viewer hovering another sharer's tab would
  // otherwise paint on top of this one. Untargeted events (pre-1.4.8
  // senders) are dropped — rendering them on every share at once is worse
  // than not rendering them at all.
  const visibleClicks = clicks.filter((c) => !!c.target && c.target === activeIdentity);

  // Carte PIP interne : le partage détaché vit en `position: fixed` au-dessus
  // de l'app. En vue simple elle REMPLACE le bloc en ligne (le chat respire) ;
  // en mosaïque elle se CUMULE avec la grille (mosaïque + PIP). Position/
  // taille persistées ; x/y négatifs = « coller en bas à droite » (calculé
  // ici, la fenêtre n'est pas connue du store).
  // Mosaïque + PIP : la grille n'affiche PAS le partage déjà dans la carte
  // flottante (sinon il apparaît en double) ; cliquer une tuile ou un onglet
  // échange la carte au lieu de quitter la mosaïque.
  const mosaicShares = shareDock === "floating"
    ? activeShares.filter((s) => s.participantIdentity !== activeIdentity)
    : activeShares;

  let floatingCard: React.ReactNode = null;
  if (shareDock === "floating") {
    const fw = Math.min(Math.max(shareFloating.w, SHARE_FLOATING_MIN_W), Math.max(SHARE_FLOATING_MIN_W, window.innerWidth - 24));
    const fh = Math.min(Math.max(shareFloating.h, SHARE_FLOATING_MIN_H), Math.max(SHARE_FLOATING_MIN_H, window.innerHeight - 60));
    const fx = shareFloating.x < 0
      ? Math.max(8, window.innerWidth - fw - 24)
      : Math.min(Math.max(shareFloating.x, 4), Math.max(4, window.innerWidth - fw - 10));
    const fy = shareFloating.y < 0
      ? Math.max(8, window.innerHeight - fh - 24)
      : Math.min(Math.max(shareFloating.y, 4), Math.max(4, window.innerHeight - 60));
    floatingCard = (
      <FloatingShareCard
        identity={activeShare.participantIdentity}
        name={activeShare.participantName}
        hasAudio={!!activeShare.hasAudio}
        muted={audioMuted}
        volume={audioVolume}
        x={fx}
        y={fy}
        w={fw}
        h={fh}
        subscribe={(cb) => subscribeFrames(activeShare.participantIdentity, cb)}
        getLatest={() => framesRef.current.get(activeShare.participantIdentity)}
        onToggleMute={handleToggleAudioMute}
        onVolumeChange={handleVolumeChange}
        markPointed={(id) => { pointedTargetsRef.current.add(id); }}
        onMove={(mx, my) => setShareFloating({ x: mx, y: my })}
        onResizeW={(nw) => setShareFloating({ x: Math.max(4, fx + (fw - nw)), w: nw })}
        onResizeH={(nh) => setShareFloating({ h: nh })}
        onDockBack={toggleShareDock}
      />
    );
  }

  if (floatingCard && (!mosaic || mosaicShares.length === 0)) {
    return (
      <>
        <ShareViewStyles />
        {floatingCard}
      </>
    );
  }

  return (
    <div className="bg-black flex flex-col items-center border-b border-[var(--color-border)]">
      {/* Styles des deux modes (ripples, bouton plein écran, tuiles) — au
          niveau racine : le conteneur de la vue simple est démonté en
          mosaïque, les règles `.share-tile` doivent rester montées. */}
      <ShareViewStyles />
      {/* Barre d'onglets type navigateur — toujours visible. L'onglet ACTIF
          porte ses propres contrôles (son + volume + plein écran) dans son
          cadre : avec plusieurs partages, rien ne flotte à droite où ça
          semblerait appartenir au dernier onglet. */}
      <div className="w-full flex items-center" style={{ background: 'var(--color-surface-container-low)' }}>
        {activeShares.map((s) => {
          const isActive = s.participantIdentity === activeIdentity;
          // En mosaïque, aucun onglet n'est « sélectionné » (la tuile active
          // porte l'indication) ; les contrôles son vivent dans les tuiles.
          const showActive = isActive && !mosaic;
          // Reflect this share's audio state: live for the active one,
          // stored for the others. Lets each tab show 🔊 vs 🔇.
          const tabMuted = isActive ? audioMuted : screenShareAudioState(s.participantIdentity).muted;
          return (
            <div
              key={s.participantIdentity}
              className="flex-1 min-w-0 flex items-center text-sm px-4 py-2 transition-colors"
              style={{
                background: showActive ? 'var(--color-surface-container-high)' : 'transparent',
                color: showActive ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
                fontWeight: showActive ? 600 : 400,
                borderBottom: showActive ? '2px solid var(--color-primary)' : '2px solid transparent',
                borderRight: '1px solid var(--color-outline-variant)',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  // Choisir un onglet = revenir en vue simple sur ce partage —
                  // sauf avec la carte flottante : on ÉCHANGE la carte sans
                  // quitter la mosaïque.
                  setSelectedId(s.participantIdentity);
                  if (shareDock !== "floating") setMosaic(false);
                }}
                title={s.participantName}
                className="flex-1 min-w-0 flex items-center gap-2"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left' }}
              >
                <ScreenIcon />
                <span className="truncate">{s.participantName}</span>
                {/* État son des onglets sans contrôles ; l'onglet actif en vue
                    simple porte les contrôles interactifs, pas de doublon. */}
                {s.hasAudio && !showActive && (
                  <span style={{ color: tabMuted ? 'var(--color-error)' : undefined, display: 'flex', flexShrink: 0 }}>
                    {tabMuted ? <SpeakerMutedIcon /> : <SpeakerIcon />}
                  </span>
                )}
              </button>
              {showActive && (
                <span className="flex items-center gap-2.5 pl-3 shrink-0">
                  {s.hasAudio && (
                    <>
                      <button
                        type="button"
                        onClick={() => { if (activeIdentity) void handleToggleAudioMute(activeIdentity); }}
                        title={audioMuted ? t("screenShare.unmuteAudio", { defaultValue: "Réactiver le son du partage" }) : t("screenShare.muteAudio", { defaultValue: "Couper le son du partage" })}
                        aria-label={audioMuted ? t("screenShare.unmuteAudio", { defaultValue: "Réactiver le son du partage" }) : t("screenShare.muteAudio", { defaultValue: "Couper le son du partage" })}
                        className="flex items-center transition-colors"
                        style={{
                          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                          color: audioMuted ? 'var(--color-error)' : 'var(--color-on-surface)',
                        }}
                      >
                        {audioMuted ? <SpeakerMutedIcon /> : <SpeakerIcon />}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((audioMuted ? 0 : audioVolume) * 100)}
                        onChange={(e) => { if (activeIdentity) void handleVolumeChange(activeIdentity, Number(e.target.value) / 100); }}
                        title={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
                        aria-label={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
                        className="screenshare-volume-slider"
                        style={{ width: 72 }}
                      />
                    </>
                  )}
                </span>
              )}
            </div>
          );
        })}
        {activeShares.length > 1 && (
          <button
            type="button"
            onClick={() => setMosaic((m) => !m)}
            title={t("screenShare.mosaic", { defaultValue: "Mode mosaïque" })}
            aria-label={t("screenShare.mosaic", { defaultValue: "Mode mosaïque" })}
            aria-pressed={mosaic}
            className="flex items-center transition-colors shrink-0"
            style={{
              marginLeft: 'auto', padding: '0 10px', alignSelf: 'stretch',
              border: 'none', borderLeft: '1px solid var(--color-outline-variant)',
              background: mosaic ? 'var(--color-secondary-container)' : 'transparent',
              color: mosaic ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
              cursor: 'pointer',
            }}
          >
            <MosaicIcon />
          </button>
        )}
        <button
          type="button"
          onClick={toggleShareDock}
          title={t("screenShare.floatView", { defaultValue: "Détacher en carte flottante (Ctrl+Maj+P)" })}
          aria-label={t("screenShare.floatView", { defaultValue: "Détacher en carte flottante (Ctrl+Maj+P)" })}
          className="flex items-center transition-colors shrink-0"
          style={{
            marginLeft: activeShares.length > 1 ? 0 : 'auto',
            padding: '0 10px', alignSelf: 'stretch',
            border: 'none', borderLeft: '1px solid var(--color-outline-variant)',
            background: 'transparent', color: 'var(--color-on-surface-variant)',
            cursor: 'pointer',
          }}
        >
          <FloatIcon />
        </button>
        {activeIdentity && (
          <button
            type="button"
            onClick={() => {
              if (nativePipOpen) {
                void pipNativeClose();
                setNativePipOpen(false);
                return;
              }
              void pipNativeOpen(activeIdentity).then((ok) => setNativePipOpen(ok));
            }}
            title={t("screenShare.nativePip", { defaultValue: "PIP natif — fenêtre au-dessus des autres applications (glisser pour déplacer, clic droit pour fermer)" })}
            aria-label={t("screenShare.nativePip", { defaultValue: "PIP natif — fenêtre au-dessus des autres applications (glisser pour déplacer, clic droit pour fermer)" })}
            aria-pressed={nativePipOpen}
            className="flex items-center transition-colors shrink-0"
            style={{
              padding: '0 10px', alignSelf: 'stretch',
              border: 'none', borderLeft: '1px solid var(--color-outline-variant)',
              background: nativePipOpen ? 'var(--color-secondary-container)' : 'transparent',
              color: nativePipOpen ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
              cursor: 'pointer',
            }}
          >
            <NativePipIcon />
          </button>
        )}
      </div>
      {mosaic && mosaicShares.length > 0 ? (
        /* Vue mosaïque : une tuile par partage, chacune peint ses propres
           frames (voir ShareTile). Clic sur une tuile = vue simple. */
        <div style={{
          width: '100%',
          maxHeight: `${shareViewMaxVh}vh`,
          overflowY: 'auto',
          padding: 8,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 8,
          background: LETTERBOX_BLACK,
        }}>
          {mosaicShares.map((s) => {
            const tileActive = s.participantIdentity === activeIdentity;
            const tileMuted = tileActive ? audioMuted : screenShareAudioState(s.participantIdentity).muted;
            return (
              <ShareTile
                key={s.participantIdentity}
                identity={s.participantIdentity}
                name={s.participantName}
                hasAudio={!!s.hasAudio}
                muted={tileMuted}
                volume={screenShareAudioState(s.participantIdentity).volume}
                subscribe={(cb) => subscribeFrames(s.participantIdentity, cb)}
                getLatest={() => framesRef.current.get(s.participantIdentity)}
                onSelect={() => {
                  // Avec la carte flottante : cliquer une tuile ÉCHANGE le
                  // partage de la carte (la mosaïque reste) — sans carte, on
                  // revient en vue simple sur ce partage, comme avant.
                  setSelectedId(s.participantIdentity);
                  if (shareDock !== "floating") setMosaic(false);
                }}
                onToggleMute={handleToggleAudioMute}
                onVolumeChange={handleVolumeChange}
                markPointed={(id) => { pointedTargetsRef.current.add(id); }}
              />
            );
          })}
        </div>
      ) : (
      <div ref={containerRef} className="screen-share-viewer" style={{ position: 'relative', width: '100%', maxHeight: `${shareViewMaxVh}vh`, display: 'flex', justifyContent: 'center' }}>
        <canvas
          ref={canvasRef}
          aria-label={activeShare.participantName}
          className="w-full object-contain"
          style={{ background: 'black', maxHeight: `${shareViewMaxVh}vh` }}
        />
        {/* Carousel chevrons — overlaid on the video edges, in addition to the
            top tab bar, for quick prev/next cycling. Only when >1 share. */}
        {activeShares.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => goToShare(-1)}
              title={t("screenShare.prevShare", { defaultValue: "Écran précédent" })}
              aria-label={t("screenShare.prevShare", { defaultValue: "Écran précédent" })}
              className="absolute left-2 top-1/2 flex items-center justify-center rounded-full transition-colors hover:!bg-black/75"
              style={{ width: 38, height: 38, transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', color: 'white', zIndex: 200 }}
            >
              <ChevronLeftIcon />
            </button>
            <button
              type="button"
              onClick={() => goToShare(1)}
              title={t("screenShare.nextShare", { defaultValue: "Écran suivant" })}
              aria-label={t("screenShare.nextShare", { defaultValue: "Écran suivant" })}
              className="absolute right-2 top-1/2 flex items-center justify-center rounded-full transition-colors hover:!bg-black/75"
              style={{ width: 38, height: 38, transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', color: 'white', zIndex: 200 }}
            >
              <ChevronRightIcon />
            </button>
            <div
              className="absolute top-2 left-1/2 text-xs px-2 py-0.5 rounded-full"
              style={{ transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.5)', color: 'white', zIndex: 200 }}
            >
              {activeIndex + 1}/{activeShares.length}
            </div>
          </>
        )}
        {/* Click ripples. Positioned against the video *content* rect (not
            the element rect) so ripples land on the sharer's actual pixels
            when the video is letterboxed. */}
        <div style={{
          position: 'absolute',
          left: contentBox?.left ?? 0,
          top: contentBox?.top ?? 0,
          width: contentBox?.width ?? '100%',
          height: contentBox?.height ?? '100%',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}>
          {visibleClicks.map((c, idx) => (
            <div key={c.id} style={{ position: 'absolute', left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>
              {[0, 120, 240].map((delay) => (
                <div key={delay} style={{
                  position: 'absolute',
                  left: 0, top: 0,
                  width: 28, height: 28,
                  borderRadius: '50%',
                  border: `2.5px solid ${colorForIdentity(c.identity)}`,
                  boxSizing: 'border-box',
                  animation: `sion-ripple-viewer 600ms ${delay}ms cubic-bezier(0.2, 0.6, 0.2, 1) forwards`,
                  opacity: 0,
                  zIndex: 100 + idx,
                  pointerEvents: 'none',
                }} />
              ))}
            </div>
          ))}
        </div>
        {/* Cursor overlay. Positioned against the video content rect (sized
            via contentBox) so percent-based placement stays aligned with the
            sharer's screen pixels when the video is letterboxed.
            pointer-events: none so overlays never steal the video controls.
            Enfants gérés en DOM direct (`syncCursorLayer`), pas en React. */}
        <div ref={cursorLayerRef} style={{
          position: 'absolute',
          left: contentBox?.left ?? 0,
          top: contentBox?.top ?? 0,
          width: contentBox?.width ?? '100%',
          height: contentBox?.height ?? '100%',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}>
        </div>
        {/* Bouton plein écran posé sur la vidéo (visibilité gérée par la
            règle `.ss-expand` du <style> ci-dessus : au survol, au clavier
            et sur tactile). Le double-clic sur la vidéo reste équivalent. */}
        <button
          type="button"
          onClick={handleToggleFullscreen}
          title={t("screenShare.fullscreen", { defaultValue: "Plein écran" })}
          aria-label={t("screenShare.fullscreen", { defaultValue: "Plein écran" })}
          className="ss-expand absolute flex items-center justify-center rounded-full"
          style={{
            right: 10, bottom: 10, width: 38, height: 38, padding: 0,
            background: 'rgba(0,0,0,0.5)', color: 'white', zIndex: 200,
            border: 'none', cursor: 'pointer',
          }}
        >
          <ExpandIcon />
        </button>
      </div>
      )}
      {/* Poignée de hauteur du partage : tire vers le haut pour réduire (le
          chat respire), vers le bas pour agrandir ; double-clic = 50 %. La
          valeur est persistée avec le layout (reprise au chargement). */}
      <ResizeHandle
        side="bottom"
        value={(shareViewMaxVh / 100) * (window.innerHeight || 800)}
        min={(SHARE_VIEW_MIN_VH / 100) * (window.innerHeight || 800)}
        max={(SHARE_VIEW_MAX_VH / 100) * (window.innerHeight || 800)}
        onChange={(px) => setShareViewMaxVh((px / (window.innerHeight || 800)) * 100)}
        onReset={resetShareViewMaxVh}
        label={t("layout.resizeShareView", { defaultValue: "Réduire ou agrandir la zone de partage — double-clic pour la taille par défaut" })}
      />
      {/* Mosaïque + PIP : la carte flottante se cumule avec la grille (elle
          est en `position: fixed`, hors flux — aucun impact sur la grille). */}
      {floatingCard}
    </div>
  );
}
