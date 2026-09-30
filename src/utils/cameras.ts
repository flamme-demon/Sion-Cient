/**
 * Ordre d'essai des caméras pour scanner un QR code : les caméras arrière
 * d'abord, la principale en tête.
 *
 * Avec la seule consigne « caméra arrière », Chromium a ouvert sur un Xiaomi
 * 12 la caméra n° 5, auxiliaire, qui ne délivre aucune image : aperçu figé
 * sur le bouton lecture, rien à scanner (30/09). Sous Android, Chromium
 * nomme les caméras « camera2 <numéro>, facing back|front » ; la principale
 * est d'ordinaire celle au plus petit numéro.
 */
export function ordreCameras(cameras: readonly { deviceId: string; label: string }[]): string[] {
  const numero = (libelle: string) => {
    const n = /camera\d?\s+(\d+)/i.exec(libelle)?.[1];
    return n === undefined ? Number.MAX_SAFE_INTEGER : Number(n);
  };
  const arriere = (libelle: string) => (/back|rear|environment|arrière/i.test(libelle) ? 0 : 1);
  return [...cameras]
    .sort((a, b) => arriere(a.label) - arriere(b.label) || numero(a.label) - numero(b.label))
    .map((c) => c.deviceId);
}
