/**
 * Reconnexion vocale après une coupure longue.
 *
 * Le SDK LiveKit reprend seul une session coupée, mais renonce après dix
 * essais (~1 min 40). Au-delà — serveur redémarré : mise à jour de la
 * machine Debian le 01/10 —, Sion sortait de l'appel sans rien retenter, et
 * chacun devait revenir à la main. Ici, Sion rejoint le même salon, de plus
 * en plus espacé, pendant 30 minutes au plus, tant qu'on n'abandonne pas
 * (bouton), ne raccroche pas, ou ne rejoint pas un autre salon.
 */
import { useAppStore } from "../stores/useAppStore";

const PAUSES_S = [3, 5, 10, 20, 30];
const DUREE_MAX_MS = 30 * 60_000;

/** Rejoindre un salon vocal : la fonction des boutons de l'interface,
 *  enregistrée par App (même chemin qu'un clic). */
let rejoindre: ((salon: string) => Promise<void>) | null = null;
export function enregistrerRejoindre(fn: (salon: string) => Promise<void>): void {
  rejoindre = fn;
}

interface Reprise {
  salon: string;
  essai: number;
  debut: number;
  /** État du micro et de la sourdine au moment de la perte. */
  muet: boolean;
  sourd: boolean;
  minuteur?: ReturnType<typeof setTimeout>;
}
let enCours: Reprise | null = null;

function journal(message: string): void {
  console.info(`[Sion][voix] reconnexion : ${message}`);
  void import("@tauri-apps/plugin-log").then(({ info }) => info(`[Sion][voix] reconnexion : ${message}`)).catch(() => {});
}

/** Session subie perdue : à appeler AVANT que l'état du micro et de la
 *  sourdine ne soit remis à zéro. */
export function demarrerReconnexion(salon: string, muet: boolean, sourd: boolean): void {
  arreterReconnexion();
  enCours = { salon, essai: 0, debut: Date.now(), muet, sourd };
  useAppStore.getState().setReconnexionVocale({ salon, essai: 0 });
  journal(`session perdue, reprise de ${salon}`);
  planifier(enCours);
}

/** Abandon (bouton), raccrochage, autre salon, déconnexion du compte. */
export function arreterReconnexion(): void {
  if (!enCours) return;
  clearTimeout(enCours.minuteur);
  enCours = null;
  useAppStore.getState().setReconnexionVocale(null);
}

/** Un salon rejoint à la main : la reprise d'un AUTRE salon s'arrête. */
export function salonRejointALaMain(salon: string): void {
  if (enCours && enCours.salon !== salon) arreterReconnexion();
}

function planifier(r: Reprise): void {
  const pause = PAUSES_S[Math.min(r.essai, PAUSES_S.length - 1)] * 1000;
  r.minuteur = setTimeout(() => void essayer(r), pause);
}

async function essayer(r: Reprise): Promise<void> {
  if (enCours !== r || !rejoindre) return;
  const app = useAppStore.getState();
  if (app.connectedVoiceChannel || app.connectingVoiceChannel) {
    // Rejoint entre-temps (à la main, ou ailleurs) : plus rien à reprendre.
    if (app.connectedVoiceChannel) arreterReconnexion();
    else planifier(r);
    return;
  }
  r.essai += 1;
  app.setReconnexionVocale({ salon: r.salon, essai: r.essai });
  // Micro coupé AVANT de rejoindre : on ne revient pas micro ouvert.
  if (useAppStore.getState().isMuted !== r.muet) await useAppStore.getState().toggleMute(true);
  try {
    await rejoindre(r.salon);
  } catch (err) {
    journal(`essai ${r.essai} échoué (${String(err)})`);
  }
  if (enCours !== r) return;
  if (useAppStore.getState().connectedVoiceChannel === r.salon) {
    journal(`salon rejoint à l'essai ${r.essai}`);
    arreterReconnexion();
    if (r.sourd && !useAppStore.getState().isDeafened) await useAppStore.getState().toggleDeafen();
    return;
  }
  if (Date.now() - r.debut > DUREE_MAX_MS) {
    journal("abandon après 30 minutes");
    arreterReconnexion();
    return;
  }
  planifier(r);
}
