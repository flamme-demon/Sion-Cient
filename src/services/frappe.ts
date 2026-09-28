/**
 * « En train d'écrire » : ce que la zone de saisie signale au serveur.
 *
 * Un appel par frappe serait inutile : on ne répète « j'écris » qu'au plus
 * toutes les 3 s (le serveur garde l'indication ~4 s de plus, et matrix-sdk
 * filtre encore derrière), et on dit « j'ai fini » après 5 s sans frappe, à
 * l'envoi, en vidant le champ ou en changeant de salon.
 */
import { moteurRust } from "./moteur";

const RAPPEL_MS = 3_000;
const SILENCE_MS = 5_000;

let salonEnCours: string | null = null;
let dernierRappel = 0;
let minuterie: ReturnType<typeof setTimeout> | null = null;

async function envoyer(salon: string, actif: boolean): Promise<void> {
  const core = await import("./matrixCore");
  await core.ecrire(salon, actif).catch(() => {});
}

/** Une frappe dans le champ du salon. */
export function jEcris(salon: string): void {
  if (!moteurRust() || !salon) return;
  if (salonEnCours && salonEnCours !== salon) jArrete();
  const maintenant = Date.now();
  if (salonEnCours !== salon || maintenant - dernierRappel >= RAPPEL_MS) {
    salonEnCours = salon;
    dernierRappel = maintenant;
    void envoyer(salon, true);
  }
  if (minuterie) clearTimeout(minuterie);
  minuterie = setTimeout(jArrete, SILENCE_MS);
}

/** Fin de frappe : message envoyé, champ vidé, salon quitté, silence. */
export function jArrete(): void {
  if (minuterie) {
    clearTimeout(minuterie);
    minuterie = null;
  }
  const salon = salonEnCours;
  salonEnCours = null;
  dernierRappel = 0;
  if (salon) void envoyer(salon, false);
}
