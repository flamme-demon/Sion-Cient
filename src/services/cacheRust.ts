/**
 * Moteur Matrix Rust : ce que l'interface lit de façon SYNCHRONE, pendant le
 * rendu (`getRoomMembers`, `getUserPowerLevel`, `getPinnedEventIds`…), alors
 * que le cœur ne répond que par IPC. Chaque lecture rend la dernière valeur
 * connue et, si elle manque ou date, relance une demande en arrière-plan ;
 * l'arrivée d'une réponse prévient le store (`surChangement`), qui fait
 * redessiner.
 */
import type { DetailsSalon } from "./matrixCore";
import type { Channel } from "../types/matrix";
import type { SionMemberVersion } from "./matrixService";

/** Au-delà, une valeur est redemandée à la prochaine lecture. */
const FRAICHEUR_MS = 30_000;

type Entree<T> = { valeur: T; date: number };

const details = new Map<string, Entree<DetailsSalon>>();
const versions = new Map<string, Entree<SionMemberVersion[]>>();
const epingles = new Map<string, string[]>();
let salons = new Map<string, Channel>();
let admins: Entree<string[]> | null = null;
let salonAdminConnu: Entree<string | null> | null = null;
const enCours = new Set<string>();

let prevenir: () => void = () => {};

/** Le store s'y abonne pour redessiner quand une valeur arrive. */
export function surChangement(rappel: () => void): void {
  prevenir = rappel;
}

export function vider(): void {
  details.clear();
  versions.clear();
  epingles.clear();
  salons = new Map();
  admins = null;
  salonAdminConnu = null;
}

function perimee<T>(e: Entree<T> | null | undefined): boolean {
  return !e || Date.now() - e.date > FRAICHEUR_MS;
}

/** Lance une demande une seule fois à la fois par clé. `requete` rend vrai si
 *  la valeur a changé : c'est seulement alors que l'interface est prévenue.
 *  Chaque prévenance redessine TOUS les messages (compteur `pinnedVersion`,
 *  lu par chacun) ; la relecture périodique des membres, des versions ou des
 *  admins, presque toujours identique, gelait l'interface 200 à 400 ms
 *  toutes les 30 s (mesuré le 27/09). */
function demander(cle: string, requete: () => Promise<boolean>): void {
  if (enCours.has(cle)) return;
  enCours.add(cle);
  requete()
    .then((change) => {
      if (change) prevenir();
    })
    .catch((e) => console.warn(`[Sion][rust] ${cle} :`, e))
    .finally(() => enCours.delete(cle));
}

/** Range une valeur ; vrai si elle diffère de la précédente. */
function ranger<T>(carte: Map<string, Entree<T>>, cle: string, valeur: T): boolean {
  const avant = carte.get(cle);
  carte.set(cle, { valeur, date: Date.now() });
  return !avant || JSON.stringify(avant.valeur) !== JSON.stringify(valeur);
}

/** Membres et niveaux d'un salon, dernière valeur connue. */
export function detailsSalon(salon: string): DetailsSalon | undefined {
  const e = details.get(salon);
  if (perimee(e)) {
    demander(`details:${salon}`, async () => {
      const { detailsSalon: lire } = await import("./matrixCore");
      return ranger(details, salon, await lire(salon));
    });
  }
  return e?.valeur;
}

/** À appeler après une action qui change les membres ou les niveaux. */
export function oublierDetails(salon: string): void {
  details.delete(salon);
  detailsSalon(salon);
}

export function versionsSalon(salon: string): SionMemberVersion[] {
  const e = versions.get(salon);
  if (perimee(e)) {
    demander(`versions:${salon}`, async () => {
      const { versionsSalon: lire } = await import("./matrixCore");
      return ranger(versions, salon, await lire(salon));
    });
  }
  return e?.valeur ?? [];
}

export function adminsServeur(): string[] {
  if (perimee(admins)) {
    demander("admins", async () => {
      const { adminsServeur: lire } = await import("./matrixCore");
      const valeur = await lire();
      const change = !admins || JSON.stringify(admins.valeur) !== JSON.stringify(valeur);
      admins = { valeur, date: Date.now() };
      return change;
    });
  }
  return admins?.valeur ?? [];
}

/** Épinglés, tenus à jour par les fils publiés par le cœur. */
export function definirEpingles(salon: string, ids: string[]): boolean {
  const avant = epingles.get(salon);
  if (avant && avant.length === ids.length && avant.every((id, i) => id === ids[i])) return false;
  epingles.set(salon, ids);
  return true;
}

export function epinglesSalon(salon: string): string[] {
  return epingles.get(salon) ?? [];
}

/** Liste des salons publiée par le cœur. */
export function definirSalons(liste: Channel[]): void {
  salons = new Map(liste.map((c) => [c.id, c]));
}

/** Le salon est-il un MP (`isDMRoom`) ? */
export function estMp(salon: string): boolean {
  return salons.get(salon)?.isDM ?? false;
}

/** Salon d'administration (`findAdminRoom`), dernière valeur connue. */
export function salonAdmin(): string | null {
  if (perimee(salonAdminConnu)) {
    demander("salon-admin", async () => {
      const { salonAdmin: lire } = await import("./matrixCore");
      const valeur = await lire();
      const change = !salonAdminConnu || salonAdminConnu.valeur !== valeur;
      salonAdminConnu = { valeur, date: Date.now() };
      return change;
    });
  }
  return salonAdminConnu?.valeur ?? null;
}

/** Salons rejoints connus (id → salon). */
export function salonsConnus(): Channel[] {
  return [...salons.values()];
}

/** Membres et niveaux d'un salon, FRAIS (attend la réponse du cœur). */
export async function detailsFrais(salon: string): Promise<DetailsSalon> {
  const { detailsSalon: lire } = await import("./matrixCore");
  const valeur = await lire(salon);
  details.set(salon, { valeur, date: Date.now() });
  return valeur;
}
