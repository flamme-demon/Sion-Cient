// Estimation de l'écart entre l'horloge locale et celle du serveur.
//
// Les appartenances vocales portent une durée de validité relative à
// `origin_server_ts`, horodatage posé par le SERVEUR. Les comparer à
// `Date.now()` revient à supposer les deux horloges alignées : sur une machine
// qui avançait de dix heures, toutes les appartenances des autres paraissaient
// expirées depuis neuf heures et disparaissaient — sans le moindre message,
// l'utilisateur se retrouvant seul dans un salon peuplé.
//
// `Date.now()` étant en UTC, on pourrait croire les fuseaux hors de cause. Le
// cas réel montre le contraire, par un détour : la machine était réglée sur
// UTC-8 alors qu'elle se trouvait en UTC+2, et son heure avait été posée à la
// main pour que l'AFFICHAGE tombe juste. L'écran indiquait 15 h 52, exact, pour
// un epoch de 23 h 52 — dix heures d'avance en UTC, invisibles à l'œil.
//
// D'où le libellé du bandeau, qui parle de fuseau avant de parler d'heure :
// celui qui subit la panne voit une horloge correcte et n'a aucune raison de la
// soupçonner.
//
// Ce module ne sauve que l'affichage des participants de Sion. Le SDK juge
// l'expiration avec son propre `Date.now()` (CallMembership.getMsUntilExpiry,
// sans horloge injectable, l'ajustement d'écart ayant été RETIRÉ en amont) : la
// session RTC et l'échange de clés restent cassés tant que l'horloge l'est.
// La seule vraie réparation est côté machine.

/** Au-delà, on cesse de faire confiance à l'horloge locale et on prévient. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Horodatage serveur le plus récent observé, tous salons confondus. */
let newestServerTs = 0;
/** `Date.now()` au moment où on l'a observé. */
let observedAt = 0;

/**
 * Enregistre un horodatage serveur. Les événements arrivant par la synchro en
 * quasi-temps réel, le plus récent d'entre eux approche l'heure du serveur.
 */
export function noteServerTimestamp(ts: number): void {
  if (!Number.isFinite(ts) || ts <= newestServerTs) return;
  newestServerTs = ts;
  observedAt = Date.now();
}

/**
 * Écart estimé, en millisecondes : positif si l'horloge locale AVANCE sur le
 * serveur. Zéro tant qu'aucun horodatage n'a été observé.
 */
export function getClockSkewMs(): number {
  if (!newestServerTs) return 0;
  return observedAt - newestServerTs;
}

/**
 * Instant courant à utiliser face à des horodatages serveur.
 *
 * L'horloge locale reste la référence tant qu'elle est plausible : elle est la
 * seule à avancer entre deux événements. On ne la corrige qu'au-delà de la
 * tolérance, là où elle est manifestement fausse.
 *
 * Contrepartie assumée : sur une horloge fausse, un client qui aurait cessé
 * d'émettre resterait affiché un moment. Montrer quelqu'un de trop est bien
 * moins gênant que de n'afficher personne.
 */
export function serverNow(): number {
  const skew = getClockSkewMs();
  if (Math.abs(skew) <= CLOCK_SKEW_TOLERANCE_MS) return Date.now();
  return Date.now() - skew;
}

/**
 * Remonte la dérive à l'interface quand elle dépasse la tolérance.
 *
 * Appelé au fil des synchros : c'est le seul endroit qui dispose à la fois de
 * l'heure serveur et de l'heure locale.
 */
export async function publishClockSkew(): Promise<void> {
  const skew = getClockSkewMs();
  const minutes = Math.abs(skew) > CLOCK_SKEW_TOLERANCE_MS ? Math.round(skew / 60000) : 0;
  const { useAppStore } = await import("../stores/useAppStore");
  if (useAppStore.getState().clockSkewMin !== minutes) {
    if (minutes !== 0) {
      console.warn(`[Sion][Clock] horloge locale décalée de ${minutes} min par rapport au serveur`);
    }
    useAppStore.getState().setClockSkewMin(minutes);
  }
}
