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

/**
 * Download a file and open it with the system default application.
 * In Tauri: downloads to temp dir, then opens with xdg-open / open / start.
 * Fallback: opens the URL in a new tab.
 */
export async function openFileWithDefaultApp(url: string, filename: string): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_default", { url, filename });
      return;
    } catch (err) {
      console.warn("[Sion] open_file_default failed, falling back:", err);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Download a file to the user's Downloads folder.
 * In Tauri: saves via Rust to ~/Downloads (with dedup naming).
 * Fallback: triggers a browser download via anchor click.
 */
export async function downloadFileToDownloads(url: string, filename: string): Promise<string | null> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("download_file", { url, filename });
    } catch (err) {
      console.warn("[Sion] download_file failed, falling back:", err);
    }
  }
  // Browser fallback
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  return null;
}

/**
 * Open a local file with the system default application.
 * In Tauri: invokes Rust open_local_file (xdg-open / open / start).
 * Fallback: no-op.
 */
export async function openLocalFile(path: string): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_local_file", { path });
      return;
    } catch (err) {
      console.warn("[Sion] open_local_file failed:", err);
    }
  }
}

/**
 * Open the folder containing a file in the system file manager.
 * In Tauri: invokes Rust show_in_folder command.
 * Fallback: no-op (browser can't open folders).
 */
export async function showInFolder(path: string): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("show_in_folder", { path });
      return;
    } catch (err) {
      console.warn("[Sion] show_in_folder failed:", err);
    }
  }
}
