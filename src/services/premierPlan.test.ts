import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Fenêtre Tauri simulée : `onFocusChanged` garde le rappel pour le déclencher.
const fenetre = vi.hoisted(() => ({
  rappel: null as ((e: { payload: boolean }) => void) | null,
  active: true,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (rappel: (e: { payload: boolean }) => void) => {
      fenetre.rappel = rappel;
      return () => {};
    },
    isFocused: async () => fenetre.active,
  }),
}));

/** Module neuf : son état (fenêtre quittée, dernière activité) vit au niveau
 *  du module et ses écouteurs sont posés à l'import. */
async function charger(tauri: boolean, userAgent = "Mozilla/5.0 (X11; Linux x86_64)") {
  vi.resetModules();
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => userAgent });
  if (tauri) window.__TAURI_INTERNALS__ = {};
  else delete window.__TAURI_INTERNALS__;
  const module = await import("./premierPlan");
  await module.suiviFenetre;
  return module;
}

function evenement(nom: string) {
  window.dispatchEvent(new Event(nom));
}

beforeEach(() => {
  fenetre.rappel = null;
  fenetre.active = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

it("sur une autre fenêtre, la souris qui passe au-dessus de Sion ne compte pas comme un retour", async () => {
  const { utilisateurPresent } = await charger(false);
  evenement("blur");
  expect(utilisateurPresent()).toBe(false);

  // 29/09 : Sion sur un écran, une autre application active sur l'autre ;
  // le pointeur traverse Sion → mentions lues, aucune notification.
  evenement("pointermove");
  evenement("wheel");
  expect(utilisateurPresent()).toBe(false);

  // Un clic dans Sion, lui, ramène.
  evenement("pointerdown");
  expect(utilisateurPresent()).toBe(true);
});

it("sous Tauri, la fenêtre active fait foi, pas le focus du WebView", async () => {
  const { utilisateurPresent } = await charger(true);
  expect(fenetre.rappel).not.toBeNull();
  expect(utilisateurPresent()).toBe(true);

  // Focus pris par la surface native du partage : le WebView perd le focus,
  // la fenêtre reste active — on est toujours là.
  evenement("blur");
  expect(utilisateurPresent()).toBe(true);

  // Une autre application prend la main.
  fenetre.rappel!({ payload: false });
  expect(utilisateurPresent()).toBe(false);
  evenement("pointermove");
  expect(utilisateurPresent()).toBe(false);

  // Retour dans Sion (Alt+Tab, clic sur la barre de titre…).
  fenetre.rappel!({ payload: true });
  expect(utilisateurPresent()).toBe(true);
});

it("sous Tauri, Sion lancé en arrière-plan part absent", async () => {
  fenetre.active = false;
  const { utilisateurPresent } = await charger(true);
  expect(utilisateurPresent()).toBe(false);
});

it("sur Android, ni suivi de la fenêtre ni délai d'inactivité : seule la visibilité compte", async () => {
  vi.useFakeTimers();
  try {
    const { utilisateurPresent } = await charger(true, "Mozilla/5.0 (Linux; Android 16; 2201123G) Mobile");
    // Tauri n'y suit pas le focus : rien n'est écouté.
    expect(fenetre.rappel).toBeNull();

    // Lire un long message sans toucher l'écran n'est pas une absence.
    vi.advanceTimersByTime(5 * 60_000);
    expect(utilisateurPresent()).toBe(true);

    // Appli passée en arrière-plan (ou écran éteint) : page cachée.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    expect(utilisateurPresent()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
