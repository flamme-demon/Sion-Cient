// Download a static ffmpeg build via the Rust `download_ffmpeg` command and
// report progress (the backend emits `ffmpeg-install-progress` percent events).
// Shared by Settings → Advanced and the inline video card so the user can grab
// ffmpeg on demand instead of bundling it. Returns the installed binary path.
export async function installFfmpeg(onProgress?: (pct: number) => void): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<number>("ffmpeg-install-progress", (e) => onProgress(e.payload))
    : null;
  try {
    return await invoke<string>("download_ffmpeg");
  } finally {
    unlisten?.();
  }
}
