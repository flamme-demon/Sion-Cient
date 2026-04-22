import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onScreenShareChange, onCursorsChange, onCursorClick, broadcastCursor, broadcastCursorHide, broadcastCursorClick, type ScreenShareInfo, type RemoteCursor, type RemoteCursorClick } from "../../services/livekitService";
import { useTranslation } from "react-i18next";

// 60 Hz to match the overlay's redraw cadence — at 30 Hz the cursor
// jumped every other frame, which the lerp helps but doesn't fully hide.
const CURSOR_BROADCAST_HZ = 60;
const CURSOR_BROADCAST_INTERVAL = Math.floor(1000 / CURSOR_BROADCAST_HZ);

/** Rect of the video *content* (after `object-contain` letterbox/pillarbox)
 *  in viewport coordinates. When the element's aspect doesn't match the
 *  stream's (common when the sharer's screen is ultrawide and we render in
 *  a ~16:9 slot), the rect of the element itself includes black bars; using
 *  it for coordinate math puts the cursor in those bars, and broadcasts
 *  coords that fall outside what the sharer's native overlay can honour.
 *  Derived from `videoWidth`/`videoHeight`, which carry the stream's
 *  intrinsic dimensions. Falls back to the element rect when metadata
 *  hasn't loaded yet. */
function getVideoContentRect(video: HTMLVideoElement) {
  const elRect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
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

export function ScreenShareView() {
  const { t } = useTranslation();
  const [screenShare, setScreenShare] = useState<ScreenShareInfo | null>(null);
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  const [clicks, setClicks] = useState<RemoteCursorClick[]>([]);
  // Content-area box (inside the video element, after object-contain) in
  // coordinates relative to `containerRef`. Used to position the cursor +
  // ripple overlays so they track the actual pixels of the shared screen,
  // not the letterbox bars. Null until the first measurement.
  const [contentBox, setContentBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = onScreenShareChange(setScreenShare);
    return unsub;
  }, []);

  useEffect(() => {
    if (!screenShare || !videoRef.current) return;
    const el = screenShare.track.attach(videoRef.current);
    return () => {
      screenShare.track.detach(el);
    };
  }, [screenShare]);

  // Subscribe to remote cursors only while a share is visible.
  useEffect(() => {
    if (!screenShare) { setCursors([]); return; }
    const unsub = onCursorsChange(setCursors);
    return () => { unsub(); setCursors([]); };
  }, [screenShare]);

  // Subscribe to click ripples — ephemeral, auto-swept after CLICK_TTL_MS.
  useEffect(() => {
    if (!screenShare) { setClicks([]); return; }
    const unsub = onCursorClick((click) => {
      setClicks((prev) => [...prev, click]);
    });
    const sweep = setInterval(() => {
      const now = Date.now();
      setClicks((prev) => prev.filter((c) => c.expiresAt > now));
    }, 300);
    return () => { unsub(); clearInterval(sweep); setClicks([]); };
  }, [screenShare]);

  // Capture local cursor and broadcast normalised coords. Throttled to
  // CURSOR_BROADCAST_HZ so the data channel stays light.
  useEffect(() => {
    if (!screenShare) return;
    const video = videoRef.current;
    if (!video) return;

    let lastBroadcast = 0;
    let insideVideo = false;

    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      if (now - lastBroadcast < CURSOR_BROADCAST_INTERVAL) return;
      const rect = getVideoContentRect(video);
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        if (insideVideo) { broadcastCursorHide(); insideVideo = false; }
        return;
      }
      insideVideo = true;
      lastBroadcast = now;
      broadcastCursor(x, y);
    };

    const onLeave = () => {
      if (insideVideo) { broadcastCursorHide(); insideVideo = false; }
    };

    // Single-click = "point here" ripple (broadcast to sharer + peers).
    // Double-click = toggle fullscreen (YouTube-style). We DON'T send a
    // ripple on dblclick — the browser fires both click and dblclick, but
    // we swallow the 2nd click inside the 300 ms dblclick window.
    let lastClickAt = 0;
    const DBLCLICK_WINDOW = 300;
    const onClick = (e: MouseEvent) => {
      const rect = getVideoContentRect(video);
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
        broadcastCursorClick(x, y);
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

    video.addEventListener("mousemove", onMove);
    video.addEventListener("mouseleave", onLeave);
    video.addEventListener("click", onClick);
    video.addEventListener("dblclick", onDblClick);
    window.addEventListener("blur", onLeave);
    return () => {
      video.removeEventListener("mousemove", onMove);
      video.removeEventListener("mouseleave", onLeave);
      video.removeEventListener("click", onClick);
      video.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("blur", onLeave);
      if (insideVideo) broadcastCursorHide();
    };
  }, [screenShare]);

  // Track the content-area box so the absolute-positioned overlays (cursors,
  // click ripples) sit exactly over the pixels the sharer captured, not over
  // the letterbox bars. Re-measures on window resize, video element resize,
  // and when the stream's intrinsic dimensions change (`loadedmetadata` +
  // `resize` fire on HTMLMediaElement). useLayoutEffect to avoid a
  // single-frame flash of overlays positioned against stale measurements.
  useLayoutEffect(() => {
    if (!screenShare) { setContentBox(null); return; }
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const measure = () => {
      const v = videoRef.current;
      const c = containerRef.current;
      if (!v || !c) return;
      const rect = getVideoContentRect(v);
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
    ro.observe(video);
    ro.observe(container);
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
    };
  }, [screenShare]);

  if (!screenShare) return null;

  return (
    <div className="bg-black flex flex-col items-center border-b border-[var(--color-border)]">
      <div ref={containerRef} style={{ position: 'relative', width: '100%', maxHeight: '50vh', display: 'flex', justifyContent: 'center' }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // `controls` removed: the native play/pause hijacked every click
          // on the video and the viewer's "point here" gesture kept
          // pausing the stream. Screen shares are live, pause/seek has no
          // meaning anyway.
          disablePictureInPicture
          className="w-full max-h-[50vh] object-contain"
        />
        {/* Keyframes for click ripples — 3 concentric rings cascade outward. */}
        <style>{`
          @keyframes sion-ripple-viewer {
            0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.85; }
            100% { transform: translate(-50%, -50%) scale(3);   opacity: 0; }
          }
        `}</style>
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
          {clicks.map((c, idx) => (
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
            pointer-events: none so overlays never steal the video controls. */}
        <div style={{
          position: 'absolute',
          left: contentBox?.left ?? 0,
          top: contentBox?.top ?? 0,
          width: contentBox?.width ?? '100%',
          height: contentBox?.height ?? '100%',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}>
          {cursors.map((c) => (
            <div
              key={c.identity}
              style={{
                position: 'absolute',
                left: `${c.x * 100}%`,
                top: `${c.y * 100}%`,
                transform: 'translate(-2px, -2px)',
                transition: 'left 60ms linear, top 60ms linear',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
              }}
            >
              <svg width="16" height="22" viewBox="0 0 16 22" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))' }}>
                <path
                  d="M0 0 L0 16 L4.5 12 L7 18 L9.5 17 L7 11 L12.5 11 Z"
                  fill={colorForIdentity(c.identity)}
                  stroke="white"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              <span style={{
                background: colorForIdentity(c.identity),
                color: 'white',
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
                boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
              }}>
                {c.name}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="text-xs text-[var(--color-text-secondary)] py-1 flex items-center gap-1">
        {t("screenShare.sharedBy", { name: screenShare.participantName, defaultValue: "{{name}} partage son écran" })}
        {screenShare.hasAudio && (
          <span
            title={t("screenShare.audioIncluded", { defaultValue: "Son du partage inclus" })}
            aria-label={t("screenShare.audioIncluded", { defaultValue: "Son du partage inclus" })}
          >🔊</span>
        )}
      </div>
    </div>
  );
}
