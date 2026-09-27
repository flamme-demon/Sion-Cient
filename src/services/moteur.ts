/**
 * Moteur Matrix de ce lancement, fixé UNE fois au démarrage (`main.tsx`) :
 * les services s'y aiguillent de façon synchrone, sans aller-retour IPC.
 *
 * « js » (par défaut) : matrix-js-sdk, rien ne change. « rust » : le cœur
 * `sion-matrix` (docs/plan-matrix-rust-sdk.md), par la façade `matrixCore`.
 */
let courant: "js" | "rust" = "js";

export function definirMoteur(moteur: "js" | "rust"): void {
  courant = moteur;
}

export const moteurRust = (): boolean => courant === "rust";
