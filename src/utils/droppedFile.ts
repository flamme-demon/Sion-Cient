/**
 * Fichiers déposés via le drag & drop natif Tauri.
 *
 * Sur Linux/WebKitGTK, les fichiers glissés depuis le gestionnaire de fichiers
 * n'atteignent jamais le DOM (Tauri intercepte le drop et n'expose que des
 * chemins). On lit donc les octets côté Rust (`read_dropped_file`, IPC binaire)
 * et on reconstruit un `File` pour le pipeline de pièces jointes existant.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

export async function readDroppedFile(path: string): Promise<File | null> {
  try {
    const [{ invoke }, { basename }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/path"),
    ]);
    const name = await basename(path);
    const data = await invoke<ArrayBuffer>("read_dropped_file", { path });
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return new File([data], name, {
      type: MIME_BY_EXT[ext] ?? "application/octet-stream",
    });
  } catch (err) {
    console.warn("[Sion] lecture du fichier déposé impossible:", err);
    return null;
  }
}
