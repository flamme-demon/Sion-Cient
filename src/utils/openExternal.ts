/**
 * Open a URL in the user's default browser.
 * Uses Tauri invoke when running in the desktop app, falls back to window.open.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_url", { url });
      return;
    } catch (err) {
      console.warn("[Sion] Tauri open_url failed, falling back:", err);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
