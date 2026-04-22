/**
 * Cursor overlay window manager (Tauri desktop only).
 *
 * When the local user starts sharing their screen, we ask the Rust backend
 * to open a separate native window that is:
 *  - fullscreen on the primary monitor
 *  - transparent (ARGB visual)
 *  - always on top
 *  - click-through at the OS/compositor level
 *  - not in the taskbar / never focused
 *
 * That window renders the remote viewers' cursors (and our own) at their
 * broadcast positions. Because the window sits on top of the sharer's real
 * screen, it is captured by `getDisplayMedia` and the cursors end up baked
 * into the outgoing video — so every viewer sees every other viewer's
 * pointer, which is the "real" mouse-sharing UX we want.
 *
 * Implementation: the overlay is NOT a Tauri WebviewWindow. The Tauri-CEF
 * fork (rev a9525cf) doesn't propagate `transparent: true` to CEF window
 * creation on Linux, which used to leave us with an opaque black square. We
 * now paint the overlay ourselves in Rust with winit + tiny-skia + softbuffer
 * — transparent ARGB surface, cursor arrows + click ripples drawn per frame,
 * click-through via `window.set_cursor_hittest(false)`. See
 * `src-tauri/src/cursor_overlay.rs`.
 *
 * Known caveat: the sharer's own viewers see a *second*, slightly-delayed
 * cursor echoed back in their video stream on top of the low-latency
 * client-side overlay they already have in `ScreenShareView`. We accept this
 * visual doubling for the MVP. A proper fix requires platform-specific
 * exclude-from-capture APIs (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
 * on Windows; no straightforward equivalent on Linux/PipeWire).
 */

import { invoke } from "@tauri-apps/api/core";

let isOpen = false;

function isTauri(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Opt-in feature toggle (persisted setting). Off by default: the overlay
 *  is captured back in the stream with ~200 ms echo latency, so we don't
 *  force it on. The user enables it in the screen-share options modal
 *  (or settings panel). */
async function overlayFeatureEnabled(): Promise<boolean> {
  try {
    const { useSettingsStore } = await import("../stores/useSettingsStore");
    return useSettingsStore.getState().screenShareCursorOverlay === true;
  } catch {
    return false;
  }
}

/** Open the overlay window on the primary monitor. No-op if already open,
 *  outside Tauri, or the opt-in flag is off. Returns true on success. */
export async function openCursorOverlay(): Promise<boolean> {
  if (isOpen) return true;
  if (!isTauri()) return false;
  if (!(await overlayFeatureEnabled())) {
    console.log("[Sion][CursorOverlay] disabled in settings");
    return false;
  }
  try {
    const ok = await invoke<boolean>("cursor_overlay_open");
    isOpen = !!ok;
    if (isOpen) {
      console.log("[Sion][CursorOverlay] opened (native)");
    } else {
      console.warn("[Sion][CursorOverlay] open returned false — backend declined");
    }
    return isOpen;
  } catch (err) {
    console.warn("[Sion][CursorOverlay] failed to open:", err);
    isOpen = false;
    return false;
  }
}

/** Close the overlay. Safe to call multiple times. */
export async function closeCursorOverlay(): Promise<void> {
  const wasOpen = isOpen;
  isOpen = false;
  if (!wasOpen) return;
  if (!isTauri()) return;
  try {
    await invoke("cursor_overlay_close");
    console.log("[Sion][CursorOverlay] closed");
  } catch (err) {
    console.warn("[Sion][CursorOverlay] close failed:", err);
  }
}

export interface CursorOverlayPayload {
  identity: string;
  name: string;
  x: number; // normalised [0, 1]
  y: number; // normalised [0, 1]
  expiresAt: number; // epoch ms, for TTL sweep inside the overlay
}

// Diagnostic counter for cursor pushes — logs first push and every 200th.
// Lets us verify in the log that the JS→Rust path is firing when a viewer
// hovers the share. Remove once the feature is confirmed working.
let pushCount = 0;

/** Push or update a cursor in the overlay. No-op when the overlay is closed. */
export async function pushCursorToOverlay(data: CursorOverlayPayload): Promise<void> {
  if (!isOpen) return;
  pushCount++;
  if (pushCount === 1 || pushCount % 200 === 0) {
    console.log(`[Sion][CursorOverlay] push #${pushCount} id=${data.identity} x=${data.x.toFixed(3)} y=${data.y.toFixed(3)}`);
  }
  try {
    await invoke("cursor_overlay_push", {
      identity: data.identity,
      name: data.name,
      x: data.x,
      y: data.y,
      expiresAtMs: data.expiresAt,
    });
  } catch (err) {
    console.warn("[Sion][CursorOverlay] push invoke failed:", err);
  }
}

/** Remove a cursor immediately (peer sent expire or disconnected). */
export async function clearCursorFromOverlay(identity: string): Promise<void> {
  if (!isOpen) return;
  try {
    await invoke("cursor_overlay_clear", { identity });
  } catch { /* overlay may be closing */ }
}

export interface CursorClickPayload {
  id: string;
  identity: string;
  name: string;
  x: number;
  y: number;
  expiresAt: number;
}

/** Fire a click ripple in the overlay. One-shot — the backend animates it
 *  and drops it after the TTL (no need to clear explicitly). */
export async function pushCursorClickToOverlay(data: CursorClickPayload): Promise<void> {
  if (!isOpen) return;
  try {
    await invoke("cursor_overlay_push_click", {
      id: data.id,
      identity: data.identity,
      x: data.x,
      y: data.y,
      expiresAtMs: data.expiresAt,
    });
  } catch { /* overlay may be closing */ }
}

/** True when the overlay is currently open — used by livekitService to skip
 *  the per-event IPC cost if we're not sharing. */
export function isCursorOverlayOpen(): boolean {
  return isOpen;
}
