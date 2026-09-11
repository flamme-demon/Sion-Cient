/**
 * Curseurs de partage d'écran — session LiveKit native uniquement.
 *
 * Ce module est l'extraction de l'ancien chemin `livekitService` (moteur JS)
 * après passage au moteur Rust : plus de `Room` ni de `publishData` dans la
 * webview. Les positions partent et arrivent par le data-channel du moteur
 * natif (`voice_native_publish_data` / `voice-native-data`), tandis que la
 * peinture sur l'overlay du partageur est faite directement par Rust.
 */

import { voiceNativePublishData, bytesToB64 } from "./voiceNativeService";

export const CURSOR_TOPIC = "sion-cursor";
export const CURSOR_CLICK_TOPIC = "sion-cursor-click";

/** Durée de vie d'un curseur distant sans nouvelles : 5 s. Passé ce délai,
 *  un pointeur immobile — ou dont le viewer a changé de fenêtre sans
 *  déclencher de `leave` — disparaît au lieu de rester figé (le viewer
 *  envoie aussi un masquage explicite après 5 s d'immobilité ; ce TTL est le
 *  filet de sécurité). Un flux vivant ré-arme le TTL à chaque position. */
const CURSOR_TTL_MS = 5000;

/** Expiry for click ripples — the effect itself animates for ~600 ms, so
 *  beyond 800 ms the stored entry is just stale state. */
const CLICK_TTL_MS = 800;

export interface RemoteCursor {
  identity: string;
  name: string;
  x: number; // 0..1 relative to video rect
  y: number; // 0..1
  // Identity of the SHARE this cursor is pointing at. With several concurrent
  // shares, coords in [0,1] are only meaningful relative to one of them, so
  // every receiver filters to the share it owns / is viewing.
  target: string;
  expiresAt: number;
}

/** One-shot click ripple broadcast by a viewer. */
export interface RemoteCursorClick {
  id: string; // unique per emission so React keys stay stable
  identity: string;
  name: string;
  x: number;
  y: number;
  target: string; // identity of the share being pointed at (see RemoteCursor)
  expiresAt: number;
}

const remoteCursors = new Map<string, RemoteCursor>();
let cursorCallback: ((cursors: RemoteCursor[]) => void) | null = null;
let cursorClickCallback: ((click: RemoteCursorClick) => void) | null = null;
let cursorSweepTimer: ReturnType<typeof setInterval> | null = null;

const decoder = new TextDecoder();

// Posé au join natif avec le pseudo déjà résolu par Matrix. Le payload le
// transporte jusqu'au viewer ET à l'overlay Rust du sharer ; ce dernier ne
// dépend ainsi plus du `participant.name()` LiveKit, parfois égal au MXID.
let nativeCursorDisplayName = "";

export function setNativeCursorDisplayName(name: string | null): void {
  nativeCursorDisplayName = name?.trim() ?? "";
}

// Envoi curseur via la session native. Best-effort : silencieux si le moteur
// natif n'est pas actif.
let cursorPublishInflight = false;
let cursorTxCount = 0;
let cursorTxWindowStart = 0;

function publishNativeCursor(topic: string, body: unknown, reliable: boolean) {
  // Latest-wins : à 60 Hz, si le publish précédent n'a pas fini, on jette
  // cette position (la suivante arrive dans 16 ms). Sans ça les promises
  // s'empilent et la latence croît sans borne → curseur lent + saccadé.
  // Jamais sur du reliable (clic/expire/masquage doivent arriver).
  if (!reliable && cursorPublishInflight) return;
  const payload = new TextEncoder().encode(
    JSON.stringify({
      ...(body as Record<string, unknown>),
      ...(nativeCursorDisplayName ? { n: nativeCursorDisplayName } : {}),
      ts: Date.now(),
    }),
  );
  cursorTxCount++;
  const now = Date.now();
  if (now - cursorTxWindowStart > 5000) {
    if (cursorTxCount > 0) {
      console.info(`[Sion][Cursor] tx ~${(cursorTxCount / ((now - cursorTxWindowStart) / 1000)).toFixed(0)}/s (natif)`);
    }
    cursorTxCount = 0;
    cursorTxWindowStart = now;
  }
  if (!reliable) cursorPublishInflight = true;
  // Best-effort : hors session, Rust refuse la commande, on l'ignore.
  voiceNativePublishData(topic, bytesToB64(payload), reliable)
    .catch(() => { /* best-effort */ })
    .finally(() => { if (!reliable) cursorPublishInflight = false; });
}

/** Broadcast our cursor position over the screen share. `target` is the
 *  identity of the share we're pointing at, so the right sharer (and only the
 *  right sharer) renders it — coords are only meaningful for that one share.
 *  Unreliable delivery is fine — cursor is throttled to ~30Hz so the next
 *  update makes up for any dropped packet. The caller throttles. */
export function broadcastCursor(x: number, y: number, target: string) {
  if (!target) {
    // An untargeted cursor is ambiguous with several concurrent shares —
    // never send one. Every ≥1.4.8 caller passes the share's identity.
    return;
  }
  publishNativeCursor(CURSOR_TOPIC, { x, y, t: target }, false);
}

/** Broadcast a click from the viewer at normalised coords. The sharer (and
 *  all other viewers of the same share) render an expanding ripple at that
 *  position. `target` scopes it to the pointed-at share. Reliable delivery:
 *  drops would miss the single visual cue, unlike the continuous cursor
 *  stream which is idempotent. */
export function broadcastCursorClick(x: number, y: number, target: string) {
  if (!target) {
    console.warn("[Sion][Cursor] tx click SKIPPED — empty target");
    return;
  }
  publishNativeCursor(CURSOR_CLICK_TOPIC, { click: true, x, y, t: target }, true);
}

/** Signal to viewers that our cursor is no longer over the share. Sending
 *  `{expire: true}` lets peers remove our cursor immediately instead of
 *  waiting for the TTL to fire. `target` is optional — omit to clear from
 *  every share we might have been pointing at (e.g. on teardown). */
export function broadcastCursorHide(target?: string) {
  publishNativeCursor(CURSOR_TOPIC, { expire: true, t: target }, true);
}

/** Subscribe to the live list of remote cursors (excludes our own). Fires
 *  whenever a remote cursor moves, appears, or expires. */
export function onCursorsChange(callback: (cursors: RemoteCursor[]) => void): () => void {
  cursorCallback = callback;
  // Periodic sweep to expire stale cursors even when no new data arrives.
  if (!cursorSweepTimer) {
    cursorSweepTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, c] of remoteCursors) {
        if (c.expiresAt <= now) { remoteCursors.delete(id); changed = true; }
      }
      if (changed) cursorCallback?.(Array.from(remoteCursors.values()));
    }, 250);
  }
  callback(Array.from(remoteCursors.values()));
  return () => {
    if (cursorCallback === callback) {
      cursorCallback = null;
      if (cursorSweepTimer) {
        clearInterval(cursorSweepTimer);
        cursorSweepTimer = null;
      }
    }
  };
}

/** Subscribe to one-shot cursor-click events from viewers — the UI renders
 *  an expanding ripple at (x, y) for each emission, then the entry can be
 *  discarded. No retention map here; clicks are ephemeral. */
export function onCursorClick(callback: (click: RemoteCursorClick) => void): () => void {
  cursorClickCallback = callback;
  return () => {
    if (cursorClickCallback === callback) cursorClickCallback = null;
  };
}

// Dernier callback curseur émis (throttle ~30 Hz : la map garde toujours la
// position la plus fraîche, seule la notification React est ralentie — à
// 60 Hz le re-render ne suit plus et saccade).
let lastNativeCursorEmit = 0;
let cursorRxCount = 0;
let cursorRxWindowStart = 0;

// Stats d'arrivée PAR EXPÉDITEUR (diagnostic) : moyenne + trou-max sur des
// fenêtres de 10 s. Permet d'attribuer un flux en rafales à son émetteur
// (machine/liaison du pair) plutôt qu'au transport ou à l'affichage.
const cursorRxBySender = new Map<string, { count: number; last: number; maxGap: number; windowStart: number }>();
function noteCursorArrival(senderIdentity: string) {
  const now = Date.now();
  let st = cursorRxBySender.get(senderIdentity);
  if (!st) {
    st = { count: 0, last: 0, maxGap: 0, windowStart: now };
    cursorRxBySender.set(senderIdentity, st);
  }
  if (st.last !== 0) {
    const gap = now - st.last;
    if (gap > st.maxGap) st.maxGap = gap;
  }
  st.last = now;
  st.count++;
  if (now - st.windowStart > 10000 && st.count > 0) {
    console.info(
      `[Sion][Cursor] rx ${senderIdentity}: ~${(st.count / ((now - st.windowStart) / 1000)).toFixed(0)}/s trou-max ${st.maxGap}ms`,
    );
    cursorRxBySender.set(senderIdentity, { count: 0, last: 0, maxGap: 0, windowStart: now });
  }
}

let cursorDelayMin = Infinity;
let cursorDelayMax = -Infinity;
let cursorDelayCount = 0;
let cursorDelayWindowStart = 0;

function cursorPayloadName(payloadName: string | undefined, resolvedName: string, identity: string): string {
  for (const candidate of [payloadName, resolvedName]) {
    const clean = candidate?.trim();
    if (clean && !/^@[^:]+:[^:]+(?::.+)?$/.test(clean)) return clean;
  }
  return identity.match(/^@([^:]+):/)?.[1] ?? identity;
}

function noteCursorDelay(sentTs: number | undefined) {
  if (typeof sentTs !== "number") return;
  const d = Date.now() - sentTs;
  if (d < cursorDelayMin) cursorDelayMin = d;
  if (d > cursorDelayMax) cursorDelayMax = d;
  cursorDelayCount++;
  const now = Date.now();
  if (now - cursorDelayWindowStart > 5000 && cursorDelayCount > 0) {
    console.info(
      `[Sion][Cursor] transit min~${cursorDelayMin.toFixed(0)}ms gigue~${(cursorDelayMax - cursorDelayMin).toFixed(0)}ms (${cursorDelayCount} pkts)`,
    );
    cursorDelayMin = Infinity;
    cursorDelayMax = -Infinity;
    cursorDelayCount = 0;
    cursorDelayWindowStart = now;
  }
}

/** Ingère un paquet curseur reçu sur la session native (`voice-native-data`).
 *  Le renvoi vers l'overlay Tauri (quand ON partage) est fait par Rust, qui
 *  reçoit les mêmes paquets et connaît notre identité.
 *  `senderName` vient de la liste des participants natifs (repli identité).
 *  Les curseurs orphelins (leave) expirent via le TTL. */
export function handleNativeCursorData(
  topic: string,
  senderIdentity: string,
  senderName: string,
  payload: Uint8Array,
): void {
  if (topic === CURSOR_CLICK_TOPIC) {
    try {
      const parsed = JSON.parse(decoder.decode(payload)) as { click?: boolean; x?: number; y?: number; t?: string; n?: string };
      const name = cursorPayloadName(parsed.n, senderName, senderIdentity);
      if (parsed.click && typeof parsed.x === "number" && typeof parsed.y === "number") {
        cursorClickCallback?.({
          id: `${senderIdentity}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          identity: senderIdentity,
          name,
          x: parsed.x,
          y: parsed.y,
          target: parsed.t ?? "",
          expiresAt: Date.now() + CLICK_TTL_MS,
        });
      }
    } catch { /* ignore malformed */ }
    return;
  }
  if (topic === CURSOR_TOPIC) {
    try {
      const parsed = JSON.parse(decoder.decode(payload)) as { x?: number; y?: number; expire?: boolean; t?: string; ts?: number; n?: string };
      if (parsed.expire) {
        if (remoteCursors.delete(senderIdentity)) {
          cursorCallback?.(Array.from(remoteCursors.values()));
        }
      } else if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        noteCursorDelay(parsed.ts);
        noteCursorArrival(senderIdentity);
        remoteCursors.set(senderIdentity, {
          identity: senderIdentity,
          name: cursorPayloadName(parsed.n, senderName, senderIdentity),
          x: parsed.x,
          y: parsed.y,
          target: parsed.t ?? "",
          expiresAt: Date.now() + CURSOR_TTL_MS,
        });
        // La map garde toujours la position la plus fraîche ; seule la
        // notification React est ralentie (~30 Hz) — à 60 Hz le re-render
        // ne suit plus et saccade. Compteur diagnostique (stutter prod).
        cursorRxCount++;
        const nowRx = Date.now();
        if (nowRx - cursorRxWindowStart > 5000) {
          if (cursorRxCount > 0) {
            console.info(`[Sion][Cursor] rx ~${(cursorRxCount / ((nowRx - cursorRxWindowStart) / 1000)).toFixed(0)}/s (natif)`);
          }
          cursorRxCount = 0;
          cursorRxWindowStart = nowRx;
        }
        if (nowRx - lastNativeCursorEmit >= 33) {
          lastNativeCursorEmit = nowRx;
          cursorCallback?.(Array.from(remoteCursors.values()));
        }
      }
    } catch { /* ignore malformed */ }
  }
}
