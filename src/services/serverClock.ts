// Écart entre l'horloge locale et celle du serveur.
//
// Les appartenances vocales portent une durée de validité relative à
// `origin_server_ts`, horodatage posé par le SERVEUR. Les comparer à
// `Date.now()` revient à supposer les deux horloges alignées : sur une machine
// qui avançait de dix heures, toutes les appartenances des autres paraissaient
// expirées depuis neuf heures et disparaissaient — sans le moindre message,
// l'utilisateur se retrouvant seul dans un salon peuplé.
//
// Le cas réel — Windows 11 — cumulait trois pannes : fuseau corrompu (`Id:
// Local`, décalage nul, libellé vide, signature d'une clé de registre abîmée),
// service de temps arrêté (0x80070426, donc rien ne recale jamais), et horloge
// en avance de dix heures. Aucune n'est visible depuis le navigateur ; seule la
// troisième se mesure, et c'est celle qui casse la voix.
//
// Ce module ne sauve que l'affichage des participants de Sion. Le SDK juge
// l'expiration avec son propre `Date.now()` (CallMembership.getMsUntilExpiry,
// sans horloge injectable, l'ajustement d'écart ayant été RETIRÉ en amont) : la
// session RTC et l'échange de clés restent cassés tant que l'horloge l'est.
// La seule vraie réparation est côté machine, d'où le bandeau.

/** Au-delà, on cesse de faire confiance à l'horloge locale et on prévient. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Au-delà, la mesure est refaite : une horloge peut être réparée en cours de route. */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** Écart mesuré sur l'en-tête `Date` d'une réponse du serveur. */
let measured: { skewMs: number; at: number } | null = null;
/** Borne inférieure déduite d'un événement daté dans le futur. */
let provenBehindMs = 0;
/** Sonde en vol, pour n'en garder qu'une seule à la fois. */
let inFlight: Promise<number | null> | null = null;

/**
 * Mesure l'écart sur l'en-tête `Date` de la réponse du serveur.
 *
 * C'est la seule source fiable. Un horodatage d'événement ne dit rien de
 * l'heure courante — il dit quand l'événement a été créé, ce qui peut remonter
 * à des heures. L'en-tête `Date`, lui, est produit à l'instant de la réponse.
 *
 * L'aller-retour est encadré par deux lectures de l'horloge locale et on retient
 * leur milieu : l'imprécision se limite à la moitié du temps de trajet, plus la
 * seconde de granularité de l'en-tête. Négligeable face à une tolérance de cinq
 * minutes.
 *
 * `/_matrix/client/versions` est choisi pour ne demander aucune authentification :
 * la sonde doit pouvoir tourner avant même que la session soit prête.
 */
export async function probeServerClock(baseUrl: string): Promise<number | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/_matrix/client/versions`;
      const before = Date.now();
      const resp = await fetch(url, { method: "GET", cache: "no-store" });
      const after = Date.now();
      const header = resp.headers.get("date");
      if (!header) return null;
      const serverMs = Date.parse(header); // toujours interprété en UTC
      if (!Number.isFinite(serverMs)) return null;
      const skewMs = (before + after) / 2 - serverMs;
      measured = { skewMs, at: after };
      return skewMs;
    } catch {
      return null; // hors ligne : on garde ce qu'on avait
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Enregistre un horodatage serveur vu au fil de la synchro.
 *
 * Signal volontairement à SENS UNIQUE. Un événement daté dans le futur prouve
 * que l'horloge locale est en retard : rien ne peut avoir été créé après
 * maintenant. Un événement ancien, lui, ne prouve rien du tout — il peut l'être
 * légitimement. Estimer l'écart par `maintenant - dernier horodatage` ferait
 * donc crier au décalage dans tout salon resté calme quelques minutes.
 */
export function noteServerTimestamp(ts: number): void {
  if (!Number.isFinite(ts) || ts <= 0) return;
  const behind = Date.now() - ts;
  if (behind < -CLOCK_SKEW_TOLERANCE_MS && behind < provenBehindMs) {
    provenBehindMs = behind;
  }
}

/**
 * Écart connu, en millisecondes : positif si l'horloge locale AVANCE sur le
 * serveur. Zéro tant que rien n'est établi.
 */
export function getClockSkewMs(): number {
  if (measured) return measured.skewMs;
  return provenBehindMs;
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
 * Remonte la dérive à l'interface, en rafraîchissant la mesure si elle a vieilli.
 *
 * `baseUrl` absent, on se contente de ce qui est déjà connu : la sonde ne doit
 * jamais bloquer un chemin de synchro.
 */
export async function publishClockSkew(baseUrl?: string): Promise<void> {
  if (baseUrl && (!measured || Date.now() - measured.at > PROBE_TTL_MS)) {
    await probeServerClock(baseUrl);
  }
  const skew = getClockSkewMs();
  const minutes = Math.abs(skew) > CLOCK_SKEW_TOLERANCE_MS ? Math.round(skew / 60000) : 0;
  // Appelé sans être attendu depuis le parcours des salons : une exception ici
  // remonterait en rejet non capturé et ferait tomber ce que ce module se
  // contente d'observer. Un écart d'horloge non signalé est un moindre mal
  // qu'une liste de participants qui ne se construit plus.
  try {
    const { useAppStore } = await import("../stores/useAppStore");
    const state = useAppStore.getState();
    if (state.clockSkewMin === minutes) return;
    if (minutes !== 0) {
      console.warn(`[Sion][Clock] horloge locale décalée de ${minutes} min par rapport au serveur`);
    }
    state.setClockSkewMin(minutes);
  } catch (e) {
    console.warn("[Sion][Clock] remontée de l'écart impossible", e);
  }
}

/** Remet le module à zéro — tests, et changement de compte. */
export function resetServerClock(): void {
  measured = null;
  provenBehindMs = 0;
  inFlight = null;
}
