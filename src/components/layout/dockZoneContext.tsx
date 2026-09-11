import { createContext, useContext } from "react";
import type { DockZoneId } from "../../stores/useLayoutStore";

/**
 * Zone dans laquelle un panneau est rendu — permet aux panneaux d'adapter
 * leur densité : le bandeau **bas** est large et court, il lui faut un châssis
 * compact (une seule ligne de contrôles, cartes en pastilles), là où la
 * colonne **droite** garde la mise en page verticale.
 *
 * `null` = rendu hors zone (carte flottante, mobile…) : mise en page standard.
 */
export const DockZoneContext = createContext<DockZoneId | null>(null);

export function useDockZone(): DockZoneId | null {
  return useContext(DockZoneContext);
}
