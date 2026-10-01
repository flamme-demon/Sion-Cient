/**
 * Volume d'écoute de chaque personne en vocal, réglé pour soi seul (menu du
 * participant) : coupée, ou de 0 à 200 %. Gardé dans les réglages et par le
 * moteur vocal, qui l'applique à toutes les pistes de la personne, appareils
 * et appels suivants compris.
 *
 * Disparus avec l'ancien moteur vocal JS (1.x : « Couper le son »), revenus
 * avec le moteur Rust (01/10).
 */
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type ReglageEcoute } from "../stores/useSettingsStore";

/** Volume envoyé au moteur : 0 quand la personne est coupée. */
export function volumeEffectif(reglage: ReglageEcoute | undefined): number {
  if (!reglage) return 1;
  return reglage.coupe ? 0 : Math.min(2, Math.max(0, reglage.volume));
}

export async function appliquerVolume(utilisateur: string, reglage: ReglageEcoute | undefined): Promise<void> {
  try {
    await invoke("voice_native_set_participant_volume", { utilisateur, volume: volumeEffectif(reglage) });
  } catch (e) {
    console.warn("[Sion][voix] volume non appliqué :", utilisateur, e);
  }
}

/** Au démarrage : le moteur ne garde les réglages que le temps du
 *  processus, les réglages de Sion les gardent d'un lancement à l'autre. */
export function appliquerTousLesVolumes(): void {
  const volumes = useSettingsStore.getState().volumesParticipants;
  for (const [utilisateur, reglage] of Object.entries(volumes)) void appliquerVolume(utilisateur, reglage);
}
