import type { CSSProperties, MouseEvent, TouchEvent } from "react";

/**
 * Menu contextuel au clic droit (PC) et à l'appui long (téléphone).
 *
 * Sur Android, le WebView ne fait rien d'utile d'un appui long sur une
 * ligne : il sélectionne son texte, et le toucher suivant ne sert qu'à
 * effacer la sélection — le menu d'un participant semblait mort (01/10).
 * L'appui long est donc détecté ici (500 ms sans bouger), le texte de la
 * ligne n'est plus sélectionnable, et le doigt relevé ne vaut pas toucher.
 */
const DUREE_APPUI_MS = 500;
const TOLERANCE_PX = 10;

/** Dernier menu ouvert par appui long : le `contextmenu` que le WebView
 *  émet parfois juste après ne doit pas le rouvrir, ni le doigt relevé
 *  valoir toucher. Hors de toute ligne : un rendu peut tomber entre-temps. */
let dernierAppuiLong = 0;
const vientDUnAppuiLong = () => performance.now() - dernierAppuiLong < 800;

let minuteur: ReturnType<typeof setTimeout> | undefined;
let depart: { x: number; y: number } | null = null;

function annuler(): void {
  clearTimeout(minuteur);
  minuteur = undefined;
  depart = null;
}

/** Ni sélection de texte ni menu natif du WebView sur la ligne. */
export const STYLE_SANS_SELECTION: CSSProperties = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
};

export function gestesMenuContextuel(ouvrir: (x: number, y: number) => void) {
  return {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (vientDUnAppuiLong()) return;
      ouvrir(e.clientX, e.clientY);
    },
    onTouchStart: (e: TouchEvent) => {
      annuler();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      depart = { x: t.clientX, y: t.clientY };
      minuteur = setTimeout(() => {
        const point = depart;
        annuler();
        if (!point) return;
        dernierAppuiLong = performance.now();
        navigator.vibrate?.(15);
        ouvrir(point.x, point.y);
      }, DUREE_APPUI_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (depart && t && Math.hypot(t.clientX - depart.x, t.clientY - depart.y) > TOLERANCE_PX) annuler();
    },
    onTouchEnd: (e: TouchEvent) => {
      annuler();
      // Le doigt relevé après un appui long n'est pas un toucher : sans ça,
      // la ligne (un MP, par exemple) s'ouvrait sous le menu.
      if (vientDUnAppuiLong()) e.preventDefault();
    },
    onTouchCancel: annuler,
  };
}

/** Le menu vient-il d'être ouvert par un appui long ? Le relâcher du doigt
 *  peut produire un `mousedown` hors du menu, qui le refermait aussitôt. */
export function ouvertALInstant(): boolean {
  return vientDUnAppuiLong();
}
