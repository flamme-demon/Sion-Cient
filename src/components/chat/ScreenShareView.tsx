import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RemoteTrack } from "livekit-client";
import { onScreenShareChange, onCursorsChange, onCursorClick, broadcastCursor, broadcastCursorHide, broadcastCursorClick, setScreenShareAudioMuted, setScreenShareAudioVolume, getScreenShareAudioState, type ScreenShareInfo, type RemoteCursor, type RemoteCursorClick } from "../../services/livekitService";
import { getActiveVoiceEngine } from "../../services/voiceNativeService";
import { useLiveKitStore } from "../../stores/useLiveKitStore";
import { useTranslation } from "react-i18next";
import { SpeakerIcon, ScreenIcon } from "../icons";

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

// 60 Hz to match the overlay's redraw cadence — at 30 Hz the cursor
// jumped every other frame, which the lerp helps but doesn't fully hide.
const CURSOR_BROADCAST_HZ = 60;
const CURSOR_BROADCAST_INTERVAL = Math.floor(1000 / CURSOR_BROADCAST_HZ);

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
 *  <video>, `naturalWidth`/`naturalHeight` for the native <img>), which
 *  carry the stream's intrinsic dimensions. Falls back to the element rect
 *  when metadata hasn't loaded yet. */
function getVideoContentRect(el: HTMLVideoElement | HTMLImageElement) {
  const elRect = el.getBoundingClientRect();
  const vw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const vh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
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
  // Moteur voix actif : en natif il n'y a pas de room JS — les partages
  // viennent des participants natifs (`isScreenSharing`) et les pixels des
  // events `voice-native-frame` (JPEG), rendus dans un <img>.
  const isNative = getActiveVoiceEngine() === "native";
  const nativeParticipants = useLiveKitStore((s) => s.participants);
  const nativeShares: ScreenShareInfo[] = useMemo(() => {
    if (!isNative) return [];
    return nativeParticipants
      .filter((p) => p.isScreenSharing)
      .map((p) => ({
        track: null as unknown as RemoteTrack,
        participantIdentity: p.identity,
        participantName: p.name,
        // Présence fournie par le moteur natif (piste ScreenshareAudio) ;
        // le mute passe par `voice_native_set_screenshare_audio_muted`.
        hasAudio: p.isScreenSharingAudio ?? false,
      }));
  }, [isNative, nativeParticipants]);
  // All concurrent shares in the channel; `selectedId` is the viewer's pick.
  const [shares, setShares] = useState<ScreenShareInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeShares = isNative ? nativeShares : shares;
  const [clicks, setClicks] = useState<RemoteCursorClick[]>([]);
  // Content-area box (inside the video element, after object-contain) in
  // coordinates relative to `containerRef`. Used to position the cursor +
  // ripple overlays so they track the actual pixels of the shared screen,
  // not the letterbox bars. Null until the first measurement.
  const [contentBox, setContentBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = onScreenShareChange(setShares);
    return unsub;
  }, []);

  // Derive the active share from the viewer's pick, auto-falling back to the
  // first available one when their pick is gone — no effect needed.
  const activeShare = activeShares.find((s) => s.participantIdentity === selectedId) ?? activeShares[0] ?? null;
  const activeTrack = activeShare?.track ?? null;
  const activeIdentity = activeShare?.participantIdentity ?? null;

  // Cache des dernières frames natives (data-URL par expéditeur) + miroir de
  // l'identité active pour le callback d'événement (abonnement unique).
  // Mutation directe de `img.src` : pas de re-render React à 12 im/s.
  const framesRef = useRef(new Map<string, string>());
  const activeRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Mesure de latence event→pixels (diagnostic : où partent les "2 s" ?).
  // Tout en refs, log throttled toutes les 5 s, zéro re-render.
  const rxRef = useRef(0);
  const latRef = useRef({ count: 0, sum: 0, start: 0, lastLog: 0 });

  // Miroir de l'identité active pour le callback d'événement (abonnement
  // unique) — en effet, pas pendant le rendu.
  useEffect(() => {
    activeRef.current = activeIdentity;
  });

  // `img.onload` → latence entre réception de l'event Tauri et pixels
  // affichés (décodage JPEG Chromium + rendu). Rattaché à chaque changement
  // de partage (l'élément peut être remonté).
  const attachLatProbe = () => {
    const img = imgRef.current;
    if (!img) return;
    img.onload = () => {
      const rx = rxRef.current;
      if (!rx) return;
      const now = performance.now();
      const lat = latRef.current;
      if (lat.start === 0) lat.start = now;
      lat.count += 1;
      lat.sum += now - rx;
      if (now - lat.lastLog > 5000 && lat.count > 0) {
        console.info(
          `[Sion][partage-natif] affichage: ${(lat.count / ((now - lat.start) / 1000)).toFixed(1)} im/s, ` +
          `latence event→pixels ${(lat.sum / lat.count).toFixed(0)} ms (moy sur ${lat.count} frames)`,
        );
        latRef.current = { count: 0, sum: 0, start: now, lastLog: now };
      }
    };
  };

  // Saturation du thread principal (diagnostic) : tâches >50 ms sur 10 s.
  // Placé avant tout return précoce : mesure en viewer comme en sharer.
  // Si le main thread est saturé (décodage JPEG plein écran + React +
  // curseurs), TOUT y est saccadé des deux côtés.
  useEffect(() => {
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
    if (!isNative) return;
    let cancelled = false;
    let unsubFrame: (() => void) | null = null;
    let unsubStopped: (() => void) | null = null;
    import("../../services/voiceNativeService").then((native) => {
      if (cancelled) return;
      native.onVoiceNativeFrame((f) => {
        rxRef.current = performance.now();
        framesRef.current.set(f.sender, `data:image/jpeg;base64,${f.jpeg_b64}`);
        if (activeRef.current === f.sender && imgRef.current) {
          imgRef.current.src = framesRef.current.get(f.sender) ?? "";
        }
      }).then((u) => { unsubFrame = u; }).catch(() => {});
      native.onVoiceNativeFrameStopped((s) => {
        framesRef.current.delete(s.sender);
        if (activeRef.current === s.sender && imgRef.current) {
          imgRef.current.removeAttribute("src");
        }
      }).then((u) => { unsubStopped = u; }).catch(() => {});
    }).catch(() => {});
    attachLatProbe();
    return () => {
      cancelled = true;
      unsubFrame?.();
      unsubStopped?.();
    };
  }, [isNative]);

  // Changement de partage actif : appliquer la frame en cache (ou vide en
  // attendant la prochaine, ~250 ms max).
  useEffect(() => {
    if (!isNative || !imgRef.current) return;
    attachLatProbe();
    const cached = activeIdentity ? framesRef.current.get(activeIdentity) : undefined;
    if (cached) {
      rxRef.current = performance.now();
      imgRef.current.src = cached;
    } else imgRef.current.removeAttribute("src");
  }, [isNative, activeIdentity]);

  // Audio control widgets, re-synced from the service when the active share
  // changes (each sharer keeps their own mute/volume). Adjusting state during
  // render is React's sanctioned alternative to a setState-in-effect.
  const [audioCtl, setAudioCtl] = useState<{ id: string | null; muted: boolean; volume: number }>({ id: null, muted: false, volume: 1 });
  if (audioCtl.id !== activeIdentity) {
    const st = activeIdentity ? getScreenShareAudioState(activeIdentity) : { muted: false, volume: 1 };
    setAudioCtl({ id: activeIdentity, muted: st.muted, volume: st.volume });
  }
  const audioMuted = audioCtl.muted;
  const audioVolume = audioCtl.volume;

  // Attach the *track instance* (stable across re-emits) so the video doesn't
  // re-attach/flash every time another share toggles or audio arrives.
  useEffect(() => {
    if (!activeTrack || !videoRef.current) return;
    const el = activeTrack.attach(videoRef.current);
    return () => {
      activeTrack.detach(el);
    };
  }, [activeTrack]);

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
  // CURSOR_BROADCAST_HZ so the data channel stays light. En natif, l'élément
  // est l'<img> des frames JPEG (même géométrie object-contain).
  useEffect(() => {
    if (!activeIdentity) return;
    const media: HTMLVideoElement | HTMLImageElement | null = videoRef.current ?? imgRef.current;
    if (!media) return;
    const video = media;

    let lastBroadcast = 0;
    let insideVideo = false;
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
        // curseur fantôme collé au bord jusqu'au TTL (60 s).
        if (insideVideo) {
          broadcastCursorHide(activeIdentity);
          insideVideo = false;
          lastBroadcast = now;
        }
        return;
      }
      if (now - lastBroadcast < CURSOR_BROADCAST_INTERVAL) return;
      insideVideo = true;
      lastBroadcast = now;
      broadcastCursor(x, y, activeIdentity);
    };

    const onLeave = () => {
      if (insideVideo) { broadcastCursorHide(activeIdentity); insideVideo = false; }
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

    video.addEventListener("mousemove", onMove as EventListener);
    video.addEventListener("mouseleave", onLeave);
    video.addEventListener("click", onClick as EventListener);
    video.addEventListener("dblclick", onDblClick as EventListener);
    window.addEventListener("blur", onLeave);
    // Sortie de la fenêtre par un autre chemin que la vidéo (ex. sortie
    // rapide sans mouseleave vidéo fiable) : le document la voit toujours.
    document.addEventListener("mouseleave", onLeave);
    return () => {
      video.removeEventListener("mousemove", onMove as EventListener);
      video.removeEventListener("mouseleave", onLeave);
      video.removeEventListener("click", onClick as EventListener);
      video.removeEventListener("dblclick", onDblClick as EventListener);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("mouseleave", onLeave);
      if (insideVideo) broadcastCursorHide(activeIdentity);
    };
  }, [activeIdentity, isNative]);

  // Track the content-area box so the absolute-positioned overlays (cursors,
  // click ripples) sit exactly over the pixels the sharer captured, not over
  // the letterbox bars. Re-measures on window resize, video element resize,
  // and when the stream's intrinsic dimensions change (`loadedmetadata` +
  // `resize` fire on HTMLMediaElement). useLayoutEffect to avoid a
  // single-frame flash of overlays positioned against stale measurements.
  useLayoutEffect(() => {
    if (!activeIdentity) { setContentBox(null); return; }
    const media: HTMLVideoElement | HTMLImageElement | null = videoRef.current ?? imgRef.current;
    const container = containerRef.current;
    if (!media || !container) return;

    const measure = () => {
      const m: HTMLVideoElement | HTMLImageElement | null = videoRef.current ?? imgRef.current;
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
    if (media instanceof HTMLVideoElement) {
      media.addEventListener("loadedmetadata", measure);
      media.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        media.removeEventListener("loadedmetadata", measure);
        media.removeEventListener("resize", measure);
      };
    }
    // <img> natif : les dimensions intrinsèques arrivent avec `load`.
    media.addEventListener("load", measure);
    return () => {
      ro.disconnect();
      media.removeEventListener("load", measure);
    };
  }, [activeIdentity, isNative]);

  const handleToggleAudioMute = () => {
    if (!activeIdentity) return;
    const next = !audioMuted;
    setAudioCtl((c) => ({ ...c, muted: next }));
    // Chemin natif : pas d'éléments <audio> JS — la (dés)inscription de la
    // piste ScreenshareAudio passe par le moteur Rust. L'état local
    // (`screenShareAudioMuted`) reste la source de vérité pour les icônes.
    if (isNative) {
      import("../../services/voiceNativeService").then(({ setVoiceNativeShareAudioMuted }) => {
        setVoiceNativeShareAudioMuted(activeIdentity, next).catch(() => {
          // Moteur injoignable : on ne ment pas à l'UI, on annule le toggle.
          setAudioCtl((c) => ({ ...c, muted: !next }));
        });
      }).catch(() => {
        setAudioCtl((c) => ({ ...c, muted: !next }));
      });
      return;
    }
    setScreenShareAudioMuted(activeIdentity, next);
  };

  const handleVolumeChange = (v: number) => {
    if (!activeIdentity) return;
    // Dragging to 0 mutes; dragging back up unmutes — keep the two in sync.
    const shouldMute = v === 0;
    setAudioCtl((c) => ({ ...c, volume: v, muted: shouldMute }));
    setScreenShareAudioVolume(activeIdentity, v);
    setScreenShareAudioMuted(activeIdentity, shouldMute);
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

  return (
    <div className="bg-black flex flex-col items-center border-b border-[var(--color-border)]">
      {/* Tab bar (browser-style) when several peers share at once — full width,
          active tab visually connected to the video below. */}
      {activeShares.length > 1 && (
        <div className="w-full flex" style={{ background: 'var(--color-surface-container-low)' }}>
          {activeShares.map((s, i) => {
            const isActive = s.participantIdentity === activeIdentity;
            // Reflect this share's audio state: live for the active one,
            // stored for the others. Lets each tab show 🔊 vs 🔇.
            const tabMuted = isActive ? audioMuted : getScreenShareAudioState(s.participantIdentity).muted;
            return (
              <button
                key={s.participantIdentity}
                type="button"
                onClick={() => setSelectedId(s.participantIdentity)}
                title={s.participantName}
                className="flex-1 min-w-0 flex items-center justify-center gap-2 text-sm px-4 py-3 transition-colors"
                style={{
                  background: isActive ? 'var(--color-surface-container-high)' : 'transparent',
                  color: isActive ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
                  fontWeight: isActive ? 600 : 400,
                  borderBottom: isActive ? '2px solid var(--color-primary)' : '2px solid transparent',
                  borderRight: i < activeShares.length - 1 ? '1px solid var(--color-outline-variant)' : 'none',
                }}
              >
                <ScreenIcon />
                <span className="truncate">{s.participantName}</span>
                {s.hasAudio && (
                  <span style={{ color: tabMuted ? 'var(--color-error)' : undefined, display: 'flex' }}>
                    {tabMuted ? <SpeakerMutedIcon /> : <SpeakerIcon />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div ref={containerRef} style={{ position: 'relative', width: '100%', maxHeight: '50vh', display: 'flex', justifyContent: 'center' }}>
        {isNative ? (
          <img
            ref={imgRef}
            alt={activeShare.participantName}
            className="w-full max-h-[50vh] object-contain"
            style={{ background: 'black' }}
            onDoubleClick={(e) => {
              const el = e.currentTarget;
              if (document.fullscreenElement === el) {
                document.exitFullscreen().catch(() => { /* ignore */ });
              } else {
                el.requestFullscreen().catch(() => { /* ignore */ });
              }
            }}
          />
        ) : (
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
        )}
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
      </div>
      <div className="text-xs text-[var(--color-text-secondary)] py-1.5 flex items-center gap-2.5 flex-wrap justify-center px-2">
        <span>{t("screenShare.sharedBy", { name: activeShare.participantName, defaultValue: "{{name}} partage son écran" })}</span>
        {activeShare.hasAudio && (
          <span
            className="flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-full"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <button
              type="button"
              onClick={handleToggleAudioMute}
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
            {/* Pas de volume par piste côté natif (pas de gain SFU) : le
                slider reste JS-only, le mute suffit. */}
            {!isNative && (
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((audioMuted ? 0 : audioVolume) * 100)}
              onChange={(e) => handleVolumeChange(Number(e.target.value) / 100)}
              title={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
              aria-label={t("screenShare.audioVolume", { defaultValue: "Volume du partage" })}
              className="screenshare-volume-slider"
              style={{ width: 72 }}
            />
            )}
          </span>
        )}
        <span style={{ opacity: 0.6 }}>
          · {t("screenShare.fullscreenHint", { defaultValue: "double-clic pour agrandir" })}
        </span>
      </div>
    </div>
  );
}
