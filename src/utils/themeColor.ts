/**
 * Résolution des couleurs de thème pour les usages qui n'acceptent pas
 * `var()` — typiquement les canvas 2D (`ctx.fillStyle`), qui exigent une
 * couleur concrète. Le repli garde le rendu correct si le token disparaît
 * (web sans thème chargé, test).
 */
export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
