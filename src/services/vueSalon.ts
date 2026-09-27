/**
 * Petites lectures synchrones sur un salon, pour les deux moteurs. Sur le
 * moteur JS, exactement les expressions qu'employaient les composants ; sur
 * le moteur Rust, le cache (`cacheRust`), rafraîchi en arrière-plan.
 */
import { getMatrixClient } from "./matrixService";
import * as cacheRust from "./cacheRust";
import { moteurRust } from "./moteur";
import { useMatrixStore } from "../stores/useMatrixStore";

/** Règle d'accès (« public », « invite »…). */
export function regleAcces(salon: string): string | undefined {
  if (moteurRust()) return cacheRust.detailsSalon(salon)?.regleAcces ?? undefined;
  const room = getMatrixClient()?.getRoom(salon);
  return room?.currentState.getStateEvents("m.room.join_rules", "")?.getContent?.()?.join_rule;
}

/** Identifiant de l'utilisateur connecté. */
export function monId(): string {
  if (moteurRust()) return useMatrixStore.getState().currentUserId ?? "";
  return getMatrixClient()?.getUserId() || "";
}

/** L'utilisateur est-il membre (rejoint) du salon ? */
export function estMembre(salon: string, utilisateur: string): boolean {
  if (moteurRust()) return cacheRust.detailsSalon(salon)?.membres.some((m) => m.userId === utilisateur) ?? false;
  const room = getMatrixClient()?.getRoom(salon);
  return room?.getJoinedMembers().some((m) => m.userId === utilisateur) ?? false;
}
