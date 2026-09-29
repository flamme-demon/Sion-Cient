/**
 * Système de cet appareil, publié dans son appartenance à un appel
 * (`sion_platform` du call.member) : la liste des participants distingue
 * ainsi téléphone et ordinateur, par exemple quand on est connecté des deux
 * (29/09). Le cœur Rust publie la même valeur (`rtc::PLATEFORME`).
 */
export type Plateforme = "android" | "ios" | "windows" | "macos" | "linux";

export function plateformeLocale(): Plateforme {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return "linux";
}

export function plateformeMobile(plateforme: unknown): boolean {
  return plateforme === "android" || plateforme === "ios";
}

/** Android (téléphone) : ni PIP, ni ffmpeg, ni yt-dlp, ni modèles locaux. */
export const SUR_ANDROID = plateformeLocale() === "android";
