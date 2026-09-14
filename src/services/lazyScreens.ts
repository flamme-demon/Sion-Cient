/**
 * Préchargement des écrans paresseux (Réglages, Admin, options de partage).
 *
 * Sans lui, le premier clic paie le chargement du chunk. En dev, Vite
 * transforme à la volée : le seul graphe des Réglages, c'est ~96 modules
 * (mesuré) — en release, un chunk d'une cinquantaine de Ko, mais qui se paie
 * encore sur un WebKit occupé (appel en cours, partage).
 *
 * Deux déclencheurs, parce qu'un seul ne suffit pas :
 *  1. `preloadHeavyScreens(délai)` après la connexion — le boot reste léger,
 *     le chunk part pendant un temps mort ;
 *  2. `preloadHeavyScreens(0)` au survol/pression du bouton qui ouvre l'écran :
 *     l'utilisateur rapide tirle chunk avant même de cliquer.
 *
 * Le repli `requestIdleCallback` a été retiré : WebKit ne l'implémente pas
 * (côté Safari c'est encore en *preview*, derrière un flag) — le code partait
 * donc sur un `setTimeout(…, 3000)` systématique, souvent plus tard que le
 * premier clic qu'il devait couvrir.
 */
let started = false;

function loadHeavyScreens() {
  if (started) return;
  started = true;
  void import("../components/layout/SettingsPanel");
  void import("../components/layout/AdminPanel");
  void import("../components/chat/ScreenShareOptionsModal");
}

/** Lance le préchargement (idempotent). `delayMs = 0` : tout de suite. */
export function preloadHeavyScreens(delayMs = 300) {
  if (started) return;
  if (delayMs <= 0) loadHeavyScreens();
  else window.setTimeout(loadHeavyScreens, delayMs);
}
