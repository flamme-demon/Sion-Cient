/**
 * Connexion d'un téléphone par QR code (29/09).
 *
 * Le PC, déjà connecté, obtient du serveur un jeton de connexion à usage
 * unique (`m.login.token`, ~2 min, après confirmation du mot de passe) et
 * l'affiche en QR avec l'adresse du serveur ; le téléphone le scanne et se
 * connecte sans rien taper. La vérification de l'appareil suit, par le QR
 * de vérification Matrix standard (ou les emojis, ou la clé de récupération).
 *
 * Le jeton vaut un mot de passe le temps de sa courte vie : le QR ne se
 * montre qu'à soi-même.
 */

const PREFIXE = "sion://connexion?";

export interface ConnexionQr {
  /** Adresse du serveur Matrix (`https://…`). */
  serveur: string;
  /** Compte concerné, pour l'afficher avant de se connecter. */
  utilisateur: string;
  jeton: string;
}

export function texteConnexionQr({ serveur, utilisateur, jeton }: ConnexionQr): string {
  const p = new URLSearchParams({ v: "1", s: serveur, u: utilisateur, t: jeton });
  return PREFIXE + p.toString();
}

/** `null` si ce n'est pas un QR de connexion Sion (ou d'une version future). */
export function lireConnexionQr(texte: string): ConnexionQr | null {
  if (!texte.startsWith(PREFIXE)) return null;
  const p = new URLSearchParams(texte.slice(PREFIXE.length));
  const serveur = p.get("s") ?? "";
  const utilisateur = p.get("u") ?? "";
  const jeton = p.get("t") ?? "";
  if (p.get("v") !== "1" || !jeton || !/^https?:\/\/[^\s/]+/.test(serveur)) return null;
  return { serveur, utilisateur, jeton };
}
