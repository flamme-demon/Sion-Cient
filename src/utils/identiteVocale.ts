/**
 * Identités LiveKit des participants : `@utilisateur:serveur:APPAREIL`.
 *
 * Un même compte peut être en appel depuis plusieurs appareils (PC et
 * téléphone) : « c'est moi » veut dire « c'est CET appareil », sinon l'état
 * local (micro, sourdine) s'affichait sur les deux lignes (29/09).
 */

/** Appareil d'une identité (`@alice:hs:APPAREIL` → `APPAREIL`). */
export function appareilDeIdentite(identite: string): string | null {
  const m = identite.match(/^@[^:]+:[^:]+:(.+)$/);
  return m ? m[1] : null;
}

/** L'identité est-elle celle de cet appareil ? Sans appareil connu (ancienne
 *  session), repli sur le compte. */
export function estCetAppareil(
  identite: string,
  moi: string | null | undefined,
  appareil: string | null | undefined,
): boolean {
  if (!moi) return false;
  if (identite === moi) return true;
  if (!appareil) return identite.startsWith(moi + ":");
  return identite === `${moi}:${appareil}`;
}
