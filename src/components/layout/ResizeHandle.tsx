import { useCallback, useEffect, useRef } from "react";

/**
 * Poignée de redimensionnement d'un panneau (brique partagée : sidebar, dock
 * droite, zone de partage d'écran).
 *
 * - Drag au pointeur avec capture : les événements continuent d'arriver même
 *   au-dessus d'un canvas/vidéo voisin (partage d'écran).
 * - Clavier accessible : `role="separator"` + flèches (pas de 8 px),
 *   Origine/Fin pour les bornes, double-clic pour réinitialiser.
 * - Pendant le drag, `body.layout-resizing` coupe la sélection de texte, fixe
 *   le curseur global et neutralise `pointer-events` sur canvas/vidéo —
 *   WebKitGTK avale sinon les pointermove au-dessus d'eux.
 * - `side` désigne le BORD du panneau porté par la poignée et en déduit l'axe :
 *   `left`/`right` = poignée verticale (largeurs) ; `top`/`bottom` = poignée
 *   horizontale (hauteurs). Tirer vers l'extérieur du panneau l'agrandit.
 */
export interface ResizeHandleProps {
  /** Bord du panneau : "right" (grandit en tirant à droite), "left" (à
   *  gauche), "bottom" (vers le bas), "top" (vers le haut). */
  side: "left" | "right" | "top" | "bottom";
  /** Taille actuelle du panneau — affichée en aria, sert d'ancrage de drag
   *  par défaut. */
  value: number;
  /**
   * Ancre de drag explicite (défaut : `value`). La sidebar s'en sert pour
   * ancrer un drag démarré depuis le rail au seuil de redéploiement : sans
   * ça, sortir du rail demanderait un geste de ~120 px avant le premier
   * pixel de croissance.
   */
  startValue?: number;
  min: number;
  max: number;
  /** Taille demandée (peut sortir de [min, max] : le store arbitre). */
  onChange: (size: number) => void;
  onReset: () => void;
  /** Libellé accessible + infobulle. */
  label: string;
  /** Pas des flèches clavier, en px. */
  step?: number;
}

const DRAG_CLASS = "layout-resizing";

export function ResizeHandle({
  side,
  value,
  startValue,
  min,
  max,
  onChange,
  onReset,
  label,
  step = 8,
}: ResizeHandleProps) {
  const horizontal = side === "top" || side === "bottom";
  // Une poignée de bord droit/bas grandit quand on tire vers le bas/la droite.
  const growsOutward = side === "right" || side === "bottom";
  const dragRef = useRef<{ pointerId: number; start: number; base: number } | null>(null);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.classList.remove(DRAG_CLASS);
  }, []);

  // Filet de sécurité : démontage en plein drag (changement de vue, hot
  // reload) — la classe body ne doit pas rester collée.
  useEffect(() => {
    return () => document.body.classList.remove(DRAG_CLASS);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      start: horizontal ? e.clientY : e.clientX,
      base: startValue ?? value,
    };
    document.body.classList.add(DRAG_CLASS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const delta = (horizontal ? e.clientY : e.clientX) - drag.start;
    onChange(drag.base + (growsOutward ? delta : -delta));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    endDrag();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const growKey = side === "right" ? "ArrowRight" : side === "left" ? "ArrowLeft" : side === "bottom" ? "ArrowDown" : "ArrowUp";
    const shrinkKey = side === "right" ? "ArrowLeft" : side === "left" ? "ArrowRight" : side === "bottom" ? "ArrowUp" : "ArrowDown";
    // En mode rail, `startValue` porte l'ancre de déploiement : les flèches
    // doivent partir de là pour que l'expansion fonctionne aussi au clavier.
    const base = startValue ?? value;
    if (e.key === growKey) {
      e.preventDefault();
      onChange(base + step);
    } else if (e.key === shrinkKey) {
      e.preventDefault();
      onChange(base - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      className={`panel-resize-handle${horizontal ? " panel-resize-handle--horizontal" : ""}`}
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={label}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
