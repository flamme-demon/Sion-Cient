/**
 * Moteur Matrix Rust : reprise des images servies par le cœur.
 *
 * WebKitGTK ne sait pas réutiliser une image `sion-media://` déjà chargée
 * dans la page : un second `<img>` à la même adresse échoue aussitôt, SANS
 * redemander le cœur (constaté le 27/09 : une seule requête servie pour un
 * avatar, puis une dizaine d'échecs immédiats pour les autres `<img>` du même
 * avatar ; `Cache-Control: no-store` n'y change rien). Or les mêmes adresses
 * reviennent partout — un avatar à chaque message, une image du fil démontée
 * puis remontée au défilement (`ImageDuFil`), tout après une reconnexion.
 *
 * Une image du cœur qui échoue est donc rechargée UNE fois sous une adresse
 * unique (le cœur ignore le paramètre ajouté et sert depuis son cache) ; si
 * la reprise échoue aussi, l'erreur suit son cours normal (`onError` du
 * composant).
 */
const PREFIXES = ["sion-media://", "http://sion-media.localhost/"];
const MARQUE = "reprise";

let installee = false;
let compteur = 0;

/** Adresse de reprise, unique, ou `null` si l'image n'est pas du cœur ou a
 *  déjà été reprise. Aussi pour une image détachée (`new Image()`), dont
 *  l'erreur ne passe pas par `window`. */
export function adresseDeReprise(src: string): string | null {
  if (!PREFIXES.some((p) => src.startsWith(p))) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.searchParams.has(MARQUE)) return null;
  url.searchParams.set(MARQUE, String(++compteur));
  return url.toString();
}

export function installerRepriseImages(): void {
  if (installee) return;
  installee = true;
  // Phase de capture sur `window` : passe avant le `onError` du composant,
  // qu'on arrête pendant la reprise (sinon une vignette basculerait
  // inutilement sur l'original, un avatar sur ses initiales…).
  window.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const reprise = adresseDeReprise(img.getAttribute("src") ?? "");
      if (!reprise) return;
      e.stopImmediatePropagation();
      img.src = reprise;
    },
    true,
  );
}
