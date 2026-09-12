/**
 * Diagnostic mémoire — DEV uniquement.
 *
 * But : corréler la courbe RSS du processus WebKit (mesurée côté OS, elle ne
 * redescend jamais) avec ce que l'app **retient réellement** côté JS. Sans ça
 * on ne peut pas distinguer « fuite » de « plafond WebKit qui reste haut ».
 *
 * Deux mesures, toutes les 30 s, dans la console (donc dans le fichier de log
 * de l'app, que l'agent peut relire) :
 *  - messages gardés : total, nombre de salons, plus gros salon ;
 *  - object URLs (`blob:`) : créés, révoqués, vivants — un écart qui grimpe
 *    en flèche = des blobs retenus (médias, fonds de panneaux…).
 *
 * Aucun coût en production : le module sort immédiatement si `!DEV`.
 */
export function installMemoryDiagnostics(): void {
  if (!import.meta.env.DEV) return;

  // 1. Compteurs d'object URLs.
  let created = 0;
  let revoked = 0;
  const realCreate = URL.createObjectURL.bind(URL);
  const realRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    created += 1;
    return realCreate(obj);
  };
  URL.revokeObjectURL = (url: string) => {
    revoked += 1;
    return realRevoke(url);
  };

  // 2. Échantillon périodique.
  setInterval(() => {
    void import("../stores/useMatrixStore").then(({ useMatrixStore }) => {
      const messages = useMatrixStore.getState().messages;
      let total = 0;
      let rooms = 0;
      let biggest = 0;
      for (const list of Object.values(messages)) {
        total += list.length;
        rooms += 1;
        biggest = Math.max(biggest, list.length);
      }
      // Le plugin de log écrit dans le FICHIER de l'app (relisible côté
      // agent) ; console.info reste pour la console DevTools du webview.
      // `console.info` seul ne va pas dans le fichier — seul le plugin y va.
      // Sondes structurelles : un canvas oublié (ou une fuite de nœuds DOM)
      // est le suspect classique des gigaoctets — un canvas 1080p = 8 Mo.
      const canvases = Array.from(document.querySelectorAll("canvas"));
      const canvasMb = Math.round(
        canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0) / (1024 * 1024),
      );
      const nodes = document.getElementsByTagName("*").length;
      const line = `[Sion][mémoire] messages=${total} (salons=${rooms}, max=${biggest}) · blobs créés=${created} révoqués=${revoked} vivants=${created - revoked} · canvas=${canvases.length} (~${canvasMb} Mo) · nœuds=${nodes}`;
      console.info(line);
      void import("@tauri-apps/plugin-log")
        .then(({ info }) => info(line))
        .catch(() => { /* hors Tauri */ });
    }).catch(() => { /* store pas encore prêt */ });
  }, 30_000);
}
