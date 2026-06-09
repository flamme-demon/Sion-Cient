// Import audio from external-media URLs (YouTube, etc.) via yt-dlp. The Rust
// side downloads to a temp file and returns its bytes; we wrap them in a File
// the existing AudioTrimmer can decode. Only the trimmed clip is ever uploaded.
import { useSettingsStore } from "../stores/useSettingsStore";

export interface UrlMediaInfo {
  /** Duration in seconds (0 if unknown / live). */
  duration: number;
  title: string;
}

/** Probe a URL for duration + title without downloading the media stream. */
export async function probeUrlMedia(url: string): Promise<UrlMediaInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("probe_url_media", {
    url,
    ytdlpPath: useSettingsStore.getState().ytdlpPath || undefined,
  });
  const j = JSON.parse(raw);
  return { duration: Number(j.duration) || 0, title: String(j.title || "") };
}

const EXT_MIME: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
};

/** Download the audio (optionally only a [start,end] section in seconds for
 *  long videos) and return it as a File ready for the trimmer. */
export async function importUrlAudio(
  url: string,
  range?: { start: number; end: number },
): Promise<File> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("import_url_audio", {
    url,
    ytdlpPath: useSettingsStore.getState().ytdlpPath || undefined,
    ffmpegPath: useSettingsStore.getState().ffmpegPath || undefined,
    startSec: range?.start,
    endSec: range?.end,
  });
  const j = JSON.parse(raw);
  const ext: string = j.ext || "webm";
  const bin = atob(j.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `import.${ext}`, { type: EXT_MIME[ext] || "audio/*" });
}
