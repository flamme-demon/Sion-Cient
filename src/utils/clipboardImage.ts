/**
 * Image du presse-papiers lue côté Rust.
 *
 * WebKitGTK n'expose pas les images dans `ClipboardEvent.clipboardData.items`
 * (contrairement à Chromium/CEF) : le Ctrl+V d'une capture d'écran ou d'un
 * fichier image ne peut donc pas passer par le DOM. Le HTML5 `paste` reste
 * prioritaire ; ce fallback n'est appelé que lorsque l'événement ne contient
 * pas de fichier.
 *
 * Rust renvoie les octets d'origine (PNG/JPEG/WebP/GIF) via l'IPC binaire :
 * aucun décodage ni ré-encodage, donc taille réelle et latence minimale.
 */

function detectMime(bytes: Uint8Array): string {
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  return "image/png";
}

export async function readClipboardImageFile(): Promise<File | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const buffer = await invoke<ArrayBuffer>("read_clipboard_image");
    if (!buffer || buffer.byteLength === 0) return null;
    const bytes = new Uint8Array(buffer);
    const mime = detectMime(bytes);
    const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
    return new File([bytes], `presse-papiers-${Date.now()}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}
