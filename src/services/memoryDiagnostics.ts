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

  // wasm-bindgen (Rust) ne passe PAS par `new WebAssembly.Memory` : le module
  // déclare sa mémoire EN INTERNE. Il faut donc lire la mémoire dans les
  // exports de l'instance, en interceptant `instantiate` / `instantiateStreaming`.
  const wasmMemories: WebAssembly.Memory[] = [];
  const collectMemories = (result: unknown) => {
    const instance = (result as { instance?: WebAssembly.Instance })?.instance ?? (result as WebAssembly.Instance);
    const mem = (instance?.exports as Record<string, unknown> | undefined)?.memory;
    if (mem instanceof WebAssembly.Memory) wasmMemories.push(mem);
  };
  const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly) as unknown as (
    source: unknown,
    imports?: unknown,
  ) => Promise<{ instance: WebAssembly.Instance }> | { instance: WebAssembly.Instance };
  const originalStreaming = WebAssembly.instantiateStreaming?.bind(WebAssembly) as unknown as
    | ((source: unknown, imports?: unknown) => Promise<{ instance: WebAssembly.Instance }>)
    | undefined;
  WebAssembly.instantiate = ((source: unknown, imports?: unknown) => {
    const result = originalInstantiate(source, imports);
    if (result instanceof Promise) return result.then((r) => { collectMemories(r); return r; });
    collectMemories(result);
    return result;
  }) as unknown as typeof WebAssembly.instantiate;
  if (originalStreaming) {
    WebAssembly.instantiateStreaming = ((source: unknown, imports?: unknown) => {
      return originalStreaming(source, imports).then((r) => {
        collectMemories(r);
        return r;
      });
    }) as unknown as typeof WebAssembly.instantiateStreaming;
  }
  const wasmTotalMb = () =>
    Math.round(wasmMemories.reduce((sum, m) => sum + m.buffer.byteLength, 0) / (1024 * 1024));

  // 0. Gels du fil principal : un minuteur de 50 ms mesure son propre
  // retard. Tout ce qui occupe le fil (déchiffrement wasm, rendu, gros
  // traitement de /sync) le repousse d'autant — c'est ce que l'utilisateur
  // ressent comme un gel. Comparaison des moteurs Matrix JS et Rust, 27/09.
  const PAS_MS = 50;
  let attendu = performance.now() + PAS_MS;
  let gelMax = 0;
  let gels100 = 0;
  let gels250 = 0;
  let bloqueMs = 0;
  let pasMasques = 0;
  setInterval(() => {
    const maintenant = performance.now();
    const retard = maintenant - attendu;
    // Page masquée (fenêtre réduite) : WebKit bride les minuteurs à 1 Hz,
    // le retard mesuré serait ce bridage et non un gel.
    if (document.hidden) {
      pasMasques += 1;
    } else if (retard > 0) {
      gelMax = Math.max(gelMax, retard);
      if (retard > 100) gels100 += 1;
      if (retard > 250) gels250 += 1;
      if (retard > 16) bloqueMs += retard;
    }
    attendu = maintenant + PAS_MS;
  }, PAS_MS);
  const resumeGels = () => {
    const r = `gel(max=${Math.round(gelMax)} ms, >100 ms=${gels100}, >250 ms=${gels250}, bloqué=${Math.round(bloqueMs)} ms/30 s${pasMasques ? `, page masquée ${pasMasques} pas` : ""})`;
    pasMasques = 0;
    gelMax = 0;
    gels100 = 0;
    gels250 = 0;
    bloqueMs = 0;
    return r;
  };

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
    void import("../stores/useMatrixStore").then(async ({ useMatrixStore }) => {
      // Ce diagnostic occupe lui-même le fil principal (parcours du DOM,
      // sérialisation des messages) : chronométré, pour le retrancher des gels.
      const debutDiag = performance.now();
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
      // Participants vocaux : l'app reçoit des mises à jour plusieurs fois par
      // seconde quand on est en vocal — un suspect de premier plan pour une
      // croissance continue sans messages.
      let voice = "?";
      try {
        const { useLiveKitStore } = await import("../stores/useLiveKitStore");
        const p = useLiveKitStore.getState().participants;
        voice = `${p.length} (parlent=${p.filter((x) => x.isSpeaking).length})`;
      } catch { /* store pas prêt */ }
      // Écouteurs du client Matrix : ce projet a DÉJÀ eu une fuite de ce type
      // (les handlers empilés à chaque reconnexion — 6,7 Go après 31 h).
      // Un compteur qui monte ici = même classe de bug, autre chemin.
      let listeners = "?";
      let sdkRooms = "?";
      try {
        const { getMatrixClient } = await import("./matrixService");
        const client = getMatrixClient() as unknown as {
          getRooms?: () => unknown[];
          listenerCount?: (ev: string) => number;
        } | null;
        if (client) {
          sdkRooms = String(client.getRooms?.().length ?? "?");
          if (typeof client.listenerCount === "function") {
            const events = ["Room.timeline", "RoomState.events", "RoomMember.membership", "sync", "Event.decrypted", "Room"];
            listeners = events.map((ev) => `${ev}:${client.listenerCount!(ev)}`).join(" ");
          }
        }
      } catch { /* client pas prêt */ }
      // Images DÉCODÉES : le poste le plus lourd et le moins visible.
      //
      // Un fichier de 200 Ko occupe sa surface en mémoire une fois décodé —
      // quatre octets par pixel. Le compteur de nœuds ne le montre pas, la
      // taille du fichier non plus. Mesuré le 20/09, en cherchant d'où
      // venaient les 276 Mo que l'application ajoute au moteur de rendu.
      const images = Array.from(document.images);
      const imagesMb = Math.round(
        images.reduce((sum, i) => sum + (i.naturalWidth || 0) * (i.naturalHeight || 0) * 4, 0)
          / (1024 * 1024),
      );
      // Poids SÉRIALISÉ des données Matrix retenues par l'application. Ce
      // n'est pas leur empreinte réelle — un objet JavaScript coûte plusieurs
      // fois sa forme JSON — mais l'ordre de grandeur répond à la question
      // « les données pèsent-elles des mégaoctets ou des centaines ? ».
      let donneesMo = "?";
      const debutJson = performance.now();
      try {
        donneesMo = String(Math.round(JSON.stringify(messages).length / (1024 * 1024)));
      } catch { /* structure cyclique ou trop grosse */ }
      const jsonMs = Math.round(performance.now() - debutJson);
      // Moteur Rust : ce que le cœur a poussé depuis le dernier relevé.
      let rust = "";
      try {
        const { moteurRust } = await import("./moteur");
        if (moteurRust()) {
          const { mesuresRust: m } = await import("../stores/moteurRustStore");
          rust = ` · cœur(fils=${m.fils} [${m.messagesFils} msg] ${Math.round(m.filsMs)} ms, salons=${m.salons} ${Math.round(m.salonsMs)} ms)`;
          Object.assign(m, { fils: 0, messagesFils: 0, filsMs: 0, salons: 0, salonsMs: 0 });
        }
      } catch { /* moteur JS */ }
      const diagMs = Math.round(performance.now() - debutDiag);

      const line = `[Sion][mémoire] ${resumeGels()} · diag=${diagMs} ms (json ${jsonMs} ms)${rust} · messages=${total} (salons=${rooms}, max=${biggest}) · blobs vivants=${created - revoked} · canvas=${canvases.length} (~${canvasMb} Mo) · nœuds=${nodes} · images=${images.length} (~${imagesMb} Mo décodés) · données=${donneesMo} Mo · voix=${voice} · wasm=${wasmMemories.length} module(s) ${wasmTotalMb()} Mo · sdk(salons=${sdkRooms}) ${listeners}`;
      console.info(line);
      void import("@tauri-apps/plugin-log")
        .then(({ info }) => info(line))
        .catch(() => { /* hors Tauri */ });
    }).catch(() => { /* store pas encore prêt */ });
  }, 30_000);
}
