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
 * d'écran). Pour la même raison, sous Tauri, la fenêtre quittée se lit sur la
 * fenêtre elle-même (`onFocusChanged`), pas sur le `blur` du WebView.
 *
 * Passer la souris au-dessus de Sion ne ramène pas : avec plusieurs écrans,
 * le pointeur traverse Sion pendant qu'on travaille ailleurs (29/09 : trois
 * mentions lues d'office, aucune notification). Seuls un clic, une touche ou
 * le retour du focus sur la fenêtre ramènent.
 */

/** Sans souris ni clavier depuis ce délai, l'utilisateur est absent. */
export const DELAI_ABSENCE_MS = 60_000;

/** Évènements qui prouvent qu'on est là. */
export const EVENEMENTS_ACTIVITE = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

/** Gestes qui ne se font que dans la fenêtre active : ils prouvent qu'on y
 *  est revenu. Le survol et la molette, possibles sur une fenêtre inactive,
 *  ne font que repousser l'inactivité. */
const GESTES_DE_RETOUR: ReadonlySet<string> = new Set(["pointerdown", "keydown", "touchstart", "focus"]);

/** Émis sur `window` quand la fenêtre Tauri gagne ou perd le focus : les
 *  suivis de la présence se réévaluent aussitôt. */
export const EVENEMENT_PRESENCE = "sion:presence";

let fenetreQuittee = false;
let derniereActivite = Date.now();
/** La fenêtre Tauri dit elle-même si elle est active : le `blur` du WebView
 *  est alors ignoré. */
let focusParTauri = false;

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    if (!focusParTauri) fenetreQuittee = true;
  });
  for (const e of EVENEMENTS_ACTIVITE) {
    window.addEventListener(e, () => {
      derniereActivite = Date.now();
      if (GESTES_DE_RETOUR.has(e)) fenetreQuittee = false;
    }, { passive: true });
  }
}

async function suivreFenetreTauri(): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const fenetre = getCurrentWindow();
  const signaler = (active: boolean) => {
    fenetreQuittee = !active;
    if (active) derniereActivite = Date.now();
    window.dispatchEvent(new Event(EVENEMENT_PRESENCE));
  };
  await fenetre.onFocusChanged(({ payload }) => signaler(payload));
  focusParTauri = true;
  signaler(await fenetre.isFocused());
}

/** Suivi du focus de la fenêtre Tauri, installé au chargement (attendu par
 *  les tests). En cas d'échec, le `blur` du WebView reste la référence. */
export const suiviFenetre: Promise<void> = suivreFenetreTauri().catch((e) => {
  console.warn("[Sion][présence] focus de la fenêtre non suivi :", e);
});

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
