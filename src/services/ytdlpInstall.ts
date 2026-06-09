// yt-dlp lifecycle helpers (desktop only). Mirrors ffmpegInstall.ts: install
// downloads the latest self-contained binary into <app-data>/bin and reports
// progress; detect/pick mirror the ffmpeg equivalents.

export async function installYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<number>("ytdlp-install-progress", (e) => onProgress(e.payload))
    : null;
  try {
    return await invoke<string>("download_ytdlp");
  } finally {
    unlisten?.();
  }
}

/** Resolved yt-dlp path if it runs, else null. */
export async function detectYtdlp(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("detect_ytdlp")) ?? null;
}

/** Native picker for a custom yt-dlp binary; null if cancelled. */
export async function pickYtdlpPath(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_ytdlp_path")) ?? null;
}
