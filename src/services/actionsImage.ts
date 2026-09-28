/**
 * « Copier l'image » et « Enregistrer l'image » pour les images du fil (menu
 * du clic droit, visionneuse).
 */
import { useAppStore } from "../stores/useAppStore";
import { downloadFileToDownloads } from "../utils/openExternal";

/** Copie l'image elle-même (et non son adresse `sion-media://`, inutile hors
 *  de Sion) : le cœur la lit, déchiffrée, et la pose dans le presse-papiers. */
export async function copierImage(url: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("copier_image", { url });
}

/** Enregistre l'image dans Téléchargements, comme le bouton des fichiers. */
export async function enregistrerImage(url: string, nom: string): Promise<void> {
  const chemin = await downloadFileToDownloads(url, nom);
  if (chemin) {
    useAppStore.getState().markAsDownloaded(url);
    useAppStore.getState().showDownloadNotification(nom, chemin);
  }
}
