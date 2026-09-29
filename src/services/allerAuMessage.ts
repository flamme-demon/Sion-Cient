/**
 * « Aller au message » (épinglés, citation d'une réponse).
 *
 * Déjà dans le fil chargé : on y défile. Sinon, avec le moteur Rust, on
 * l'affiche en entier dans une fenêtre : le cœur ne garde que les 300
 * derniers messages d'un salon, et un épinglé plus ancien restait
 * inatteignable — la liste remontait page après page, puis abandonnait
 * (vu le 28/09 : tous les épinglés de sionchat.fr étaient au-delà).
 */
import { useAppStore } from "../stores/useAppStore";
import { useMatrixStore } from "../stores/useMatrixStore";
import { moteurRust } from "./moteur";
import { useLayoutStore } from "../stores/useLayoutStore";

export function allerAuMessage(eventId: string): void {
  const app = useAppStore.getState();
  const salon = app.activeChannel;
  const charges = salon ? useMatrixStore.getState().messages[salon] ?? [] : [];
  const present = charges.some((m) => (m.eventId || String(m.id)) === eventId);
  if (present || !moteurRust()) app.setScrollToMessageId(eventId);
  else app.setApercuMessage(eventId);
  // Téléphone : la feuille des épinglés couvre le fil — on la referme pour
  // montrer le message.
  if (typeof window !== "undefined" && window.innerWidth < 768) {
    useLayoutStore.getState().closeDockPanel("pinned");
  }
}
