/**
 * Sion est-il au premier plan ? Chargé dès le démarrage (`main.tsx`) : un
 * suivi installé plus tard ne saurait pas que la fenêtre a déjà été quittée.
 *
 * `document.hasFocus()` ne convient pas : sous WebKitGTK il peut rester faux
 * alors qu'on est dans la fenêtre (focus sur la surface native du partage
 * d'écran) — voir la présence dans MessageList. On suit plutôt la fenêtre :
 * quittée au `blur`, retrouvée à la moindre action.
 */
let fenetreQuittee = false;

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => { fenetreQuittee = true; });
  for (const e of ["focus", "pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(e, () => { fenetreQuittee = false; }, { passive: true });
  }
}

/** Sion est affiché et c'est la fenêtre active. */
export function sionAuPremierPlan(): boolean {
  return !fenetreQuittee && document.visibilityState === "visible";
}
