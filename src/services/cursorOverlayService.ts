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
 * Implementation: the overlay is NOT a Tauri WebviewWindow. Une webview
 * transparente click-through est fragile selon le runtime (fenêtre noire
 * opaque sur certaines plateformes). On peint donc l'overlay en Rust avec
 * winit + tiny-skia + softbuffer
 * — transparent ARGB surface, cursor arrows + click ripples drawn per frame,
 * click-through via `window.set_cursor_hittest(false)`. See
 * `src-tauri/src/cursor_overlay.rs`.
 *
 * Known caveat: a viewer sees their physical pointer immediately and its
 * coloured representation later, after the sharer's capture/encode/network
 * round trip. A proper fix requires platform-specific
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

/** Close the overlay. Safe to call multiple times.
 *
 *  Toujours transmis à Rust (la fermeture y est idempotente) plutôt que
 *  retenu par l'état local : après un rechargement de la webview, `isOpen`
 *  repart à `false` alors que la fenêtre X11 est toujours là — elle restait
 *  alors mappée à la fin du partage (constaté le 13/09). */
export async function closeCursorOverlay(): Promise<void> {
  isOpen = false;
  if (!isTauri()) return;
  try {
    await invoke("cursor_overlay_close");
    console.log("[Sion][CursorOverlay] closed");
  } catch (err) {
    console.warn("[Sion][CursorOverlay] close failed:", err);
  }
}
