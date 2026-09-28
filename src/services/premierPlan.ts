/**
 * Quelqu'un est-il devant Sion ? Une seule notion de présence, pour les
 * non-lus (MessageList) comme pour les notifications système. Chargé dès le
 * démarrage (`main.tsx`) : un suivi installé plus tard ne saurait pas que la
 * fenêtre a déjà été quittée.
 *
 * Absent = fenêtre quittée (vers une autre application), cachée, ou sans
 * souris ni clavier depuis une minute — Sion resté au premier plan pendant
 * qu'on est devant un autre écran compte comme une absence (28/09 : mention
 * sans notification, l'utilisateur étant sur l'autre PC).
 *
 * `document.hasFocus()` ne convient pas : sous WebKitGTK il peut rester faux
 * alors qu'on est dans la fenêtre (focus sur la surface native du partage
 * d'écran).
 */

/** Sans souris ni clavier depuis ce délai, l'utilisateur est absent. */
export const DELAI_ABSENCE_MS = 60_000;

/** Évènements qui prouvent qu'on est là. */
export const EVENEMENTS_ACTIVITE = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

let fenetreQuittee = false;
let derniereActivite = Date.now();

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => { fenetreQuittee = true; });
  for (const e of EVENEMENTS_ACTIVITE) {
    window.addEventListener(e, () => {
      fenetreQuittee = false;
      derniereActivite = Date.now();
    }, { passive: true });
  }
}

export interface EtatPresence {
  present: boolean;
  visible: boolean;
  quittee: boolean;
  /** Secondes depuis la dernière action. */
  inactifS: number;
}

export function etatPresence(): EtatPresence {
  const visible = document.visibilityState === "visible";
  const inactif = Date.now() - derniereActivite;
  return {
    present: visible && !fenetreQuittee && inactif < DELAI_ABSENCE_MS,
    visible,
    quittee: fenetreQuittee,
    inactifS: Math.round(inactif / 1000),
  };
}

/** Quelqu'un est devant Sion : inutile de notifier, et ce qui arrive est lu. */
export function utilisateurPresent(): boolean {
  return etatPresence().present;
}

/** Tests : repart d'un utilisateur présent, à l'instant. */
export function reinitialiserPresence(): void {
  fenetreQuittee = false;
  derniereActivite = Date.now();
}
