/**
 * Moteur Matrix Rust : ce que `initSync` fait pour matrix-js-sdk, alimenté
 * par le cœur `sion-matrix` (façade `matrixCore`). L'état du store garde la
 * même forme — salons, messages par salon, pagination, vérification — pour
 * que l'interface n'ait rien à changer.
 *
 * Les fils arrivent ENTIERS à chaque changement (le cœur les republie) : les
 * nouveaux messages se déduisent en comparant avec le fil précédent.
 */
import type { MatrixState } from "./useMatrixStore";
import type { Channel } from "../types/matrix";
import type { EtatConnexion, EtatVerification, FilSalon } from "../services/matrixCore";

type Set = (partiel: Partial<MatrixState> | ((s: MatrixState) => Partial<MatrixState>)) => void;
type Get = () => MatrixState;

let demarre = false;

/** Diagnostic (dev) : mises à jour poussées par le cœur et temps passé à les
 *  appliquer au store, relevés par memoryDiagnostics toutes les 30 s. */
export const mesuresRust = { fils: 0, messagesFils: 0, filsMs: 0, salons: 0, salonsMs: 0 };
/** Utilisateur de la session dont les tâches de démarrage ont été faites. */
let sessionPreparee: string | null = null;

function statut(etat: EtatConnexion): MatrixState["connectionStatus"] {
  switch (etat.etat) {
    case "connecte":
      return "connected";
    case "connexion":
      return "connecting";
    case "erreur":
      return "reconnecting";
    default:
      return "disconnected";
  }
}

/** Abonne le store au cœur Rust ; sans effet s'il l'est déjà. */
export async function demarrerMoteurRust(set: Set, get: Get): Promise<void> {
  if (demarre) return;
  demarre = true;
  set({ connectionStatus: "connecting" });
  const core = await import("../services/matrixCore");
  const cache = await import("../services/cacheRust");
  const { APP_SESSION_START_TS } = await import("./useAppStore");
  const { useEntreMembresStore } = await import("./useEntreMembresStore");
  const entreMembres = useEntreMembresStore.getState();

  // Une réponse arrivée dans le cache synchrone fait redessiner.
  cache.surChangement(() => set((s) => ({ pinnedVersion: s.pinnedVersion + 1 })));

  const appliquerEtat = (etat: EtatConnexion) => {
    set({
      connectionStatus: statut(etat),
      ...(etat.etat === "connecte" ? { currentUserId: etat.utilisateur } : {}),
    });
    if (etat.etat === "connecte" && sessionPreparee !== etat.utilisateur) {
      sessionPreparee = etat.utilisateur;
      void preparerSession(set, get);
    }
    if (etat.etat === "deconnecte") {
      sessionPreparee = null;
      cache.vider();
      entreMembres.vider();
      set({ channels: [], messages: {}, roomHasMore: {}, roomLoadingHistory: {} });
    }
  };

  const appliquerSalons = (liste: Channel[], premier: boolean) => {
    const t0 = performance.now();
    cache.definirSalons(liste);
    set({ channels: liste });
    if (premier || liste.length > 0) selectionnerSalonParDefaut(liste);
    mesuresRust.salons += 1;
    mesuresRust.salonsMs += performance.now() - t0;
  };

  const appliquerFil = (fil: FilSalon, initial: boolean) => {
    const t0 = performance.now();
    mesuresRust.fils += 1;
    mesuresRust.messagesFils += fil.messages.length;
    const avant = get().messages[fil.salon] ?? [];
    if (!initial) {
      sonnerNouveaux(fil, avant, get, APP_SESSION_START_TS);
      notifierNouveaux(fil, avant, get, APP_SESSION_START_TS);
    }
    const epinglesChanges = cache.definirEpingles(fil.salon, fil.epingles);
    const fusionne = conserverInchanges(avant, fil.messages);
    set((s) => {
      const messages = { ...s.messages, [fil.salon]: fusionne };
      return {
        messages,
        roomHasMore: { ...s.roomHasMore, [fil.salon]: fil.aPlus },
        hasUndecryptableMessages: Object.values(messages).some((m) => m.some((x) => x.msgtype === "m.encrypted")),
        ...(epinglesChanges ? { pinnedVersion: s.pinnedVersion + 1 } : {}),
      };
    });
    mesuresRust.filsMs += performance.now() - t0;
  };

  const appliquerVerification = (v: EtatVerification) => {
    set({
      verificationStep: v.etape,
      verificationEmojis: v.emojis,
      verificationError: v.erreur ?? null,
      verificationQr: v.qr ?? null,
      verificationScanner: v.scanner ?? false,
      ...(v.etape === "done" ? { needsVerification: false } : {}),
    });
  };

  await core.surEtat(appliquerEtat);
  await core.surSalons((l) => appliquerSalons(l, false));
  await core.surMessages((f) => appliquerFil(f, false));
  await core.surVerification(appliquerVerification);
  await core.surFrappes(entreMembres.definirFrappe);
  await core.surLectures(entreMembres.definirLectures);

  // État présent au moment de l'abonnement.
  appliquerEtat(await core.etatConnexion());
  appliquerSalons(await core.salons().catch(() => []), true);
  for (const fil of await core.fils().catch(() => [])) appliquerFil(fil, true);
  appliquerVerification(await core.verification().catch(() => ({ etape: "idle" as const, emojis: [] })));
  for (const l of await core.lectures().catch(() => [])) entreMembres.definirLectures(l);
}

/** Le cœur republie le fil ENTIER à chaque changement, en objets neufs :
 *  chaque message aurait été redessiné (`Message` est mémoïsé par identité),
 *  soit 400 à 600 ms de gel à l'arrivée d'un seul message (mesuré le 27/09).
 *  Un message identique au précédent garde donc son objet, et un fil
 *  identique garde son tableau. */
export function conserverInchanges<T extends { id: number | string }>(avant: T[], apres: T[]): T[] {
  if (avant.length === 0) return apres;
  const parId = new Map(avant.map((m) => [m.id, m]));
  let identique = avant.length === apres.length;
  const fusion = apres.map((m, i) => {
    const ancien = parId.get(m.id);
    const garde = ancien !== undefined && JSON.stringify(ancien) === JSON.stringify(m) ? ancien : m;
    if (garde !== avant[i]) identique = false;
    return garde;
  });
  return identique ? avant : fusion;
}

/** Choisit le salon d'ouverture, une fois (même règle que le moteur JS). */
function selectionnerSalonParDefaut(channels: Channel[]): void {
  if (channels.length === 0) return;
  void Promise.all([import("./useAppStore"), import("./useSettingsStore")]).then(([{ useAppStore }, { useSettingsStore }]) => {
    const app = useAppStore.getState();
    if (app.activeChannel) return;
    const { defaultChannel, autoJoinVoice } = useSettingsStore.getState();
    const choisi = channels.find((c) => c.id === defaultChannel) || channels.find((c) => !c.hasVoice) || channels[0];
    const vue = app.mobileView;
    app.setActiveChannel(choisi.id, choisi.hasVoice);
    app.setMobileView(vue);
    // Entrée automatique en vocal : même marqueur que le moteur JS, le join
    // réel reste à App.tsx.
    if (autoJoinVoice && choisi.hasVoice && !app.connectedVoiceChannel) app.setPendingAutoJoinVoice(choisi.id);
  });
}

/** Au-delà, une rafale (retour de connexion) ne notifie que ses derniers
 *  messages : pas trente bulles d'un coup. */
const NOTIFICATIONS_PAR_FIL = 3;

/** Notifications système des nouveaux messages d'autrui, selon le réglage
 *  (MP, mentions, réponses…) et seulement si Sion n'est pas au premier plan.
 *  Le moteur JS le faisait dans `useMatrixStore` ; le cœur Rust n'en
 *  envoyait aucune (28/09). */
function notifierNouveaux(fil: FilSalon, avant: { id: number | string }[], get: Get, debutSession: number): void {
  const connus = new Set(avant.map((m) => m.id));
  const moi = get().currentUserId;
  const nouveaux = fil.messages.filter(
    (m) => !connus.has(m.id) && (m.ts ?? 0) > debutSession && m.senderId && m.senderId !== moi,
  );
  if (nouveaux.length === 0) return;
  void Promise.all([
    import("../services/notificationsMessages"),
    import("../services/adminCommandService"),
    import("./useAppStore"),
    import("./useSettingsStore"),
    import("./useAuthStore"),
  ]).then(([notif, { findAdminRoom }, { useAppStore }, { useSettingsStore }, { useAuthStore }]) => {
    // Salon d'administration et robot : des réponses de commandes, jamais
    // des messages à notifier.
    if (fil.salon === findAdminRoom()) return;
    const robot = moi ? `@conduit:${moi.split(":")[1] ?? ""}` : "";
    const salon = get().channels.find((c) => c.id === fil.salon);
    const mode = useSettingsStore.getState().notificationMode;
    const salonVocal = useAppStore.getState().connectedVoiceChannel === fil.salon;
    const nomAffiche = useAuthStore.getState().credentials?.displayName;
    for (const m of nouveaux.slice(-NOTIFICATIONS_PAR_FIL)) {
      if (m.senderId === robot) continue;
      const poke = m.msgtype === "m.poke";
      const nature = {
        poke,
        mp: !!salon?.isDM,
        mention: notif.estMention(m.text, m.formattedBody, moi, nomAffiche),
        reponseAMoi: !!moi && m.replyTo?.senderId === moi,
        salonVocal,
      };
      if (!notif.doitNotifier(nature, mode)) continue;
      // Quelqu'un devant Sion : il le voit déjà. Journalisé dans les deux
      // cas, pour savoir pourquoi une notification est partie ou non.
      const presence = notif.etatPresence();
      void import("@tauri-apps/plugin-log")
        .then(({ info }) => info(
          `[Sion][notif] ${presence.present ? "non envoyée (utilisateur présent)" : "envoyée"} : ${m.eventId} de ${m.senderId} (mp=${nature.mp}, mention=${nature.mention}, réponse=${nature.reponseAMoi}, poke=${poke}) ; fenêtre quittée=${presence.quittee}, inactif ${presence.inactifS} s`,
        ))
        .catch(() => {});
      if (presence.present) continue;
      void notif.envoyerNotification({
        titre: poke ? `👉 ${m.user}` : m.user,
        corps: poke ? "Poke!" : m.text || "📎",
        salon: fil.salon,
        evenement: m.eventId,
      });
    }
  });
}

/** Son de réception pour les nouveaux messages d'autrui (poke : fanfare),
 *  dans le salon ouvert, le salon vocal ou un MP — règle du moteur JS. */
function sonnerNouveaux(fil: FilSalon, avant: { id: number | string }[], get: Get, debutSession: number): void {
  const connus = new Set(avant.map((m) => m.id));
  const moi = get().currentUserId;
  const nouveaux = fil.messages.filter(
    (m) => !connus.has(m.id) && (m.ts ?? 0) > debutSession && m.senderId && m.senderId !== moi && !m.senderId.includes("conduit"),
  );
  if (nouveaux.length === 0) return;
  void Promise.all([import("./useAppStore"), import("../services/soundService"), import("../services/voiceChannelSounds")]).then(
    ([{ useAppStore }, { playMessageReceived }, { playPokeCue }]) => {
      const app = useAppStore.getState();
      const salon = get().channels.find((c) => c.id === fil.salon);
      if (app.activeChannel !== fil.salon && app.connectedVoiceChannel !== fil.salon && !salon?.isDM) return;
      if (nouveaux.some((m) => m.msgtype === "m.poke")) playPokeCue();
      else playMessageReceived();
    },
  );
}

/** Tâches de début de session (le « PREPARED » du moteur JS). */
async function preparerSession(set: Set, get: Get): Promise<void> {
  const service = await import("../services/matrixService");
  // Version de ce client, nom d'appareil (annoncés aux administrateurs).
  void service.refreshDeviceVersionLabel();
  void import("./useEntreMembresStore").then((m) => m.rafraichirIgnores()).catch(() => {});
  void service.ouvrirDroitAnnonceVersion().finally(() => void service.publishClientVersion());

  // Le nom local (emojis compris) fait foi sur celui du serveur.
  const { useAuthStore, getCachedLoginPassword, clearCachedLoginPassword, consommerVerificationApresConnexion } = await import("./useAuthStore");
  const creds = useAuthStore.getState().credentials;
  // Seulement pour le compte connecté : jamais le nom d'une autre session.
  if (creds?.displayName && creds.displayName !== creds.userId && creds.userId === get().currentUserId) {
    const surServeur = await service.fetchDisplayName(creds.userId).catch(() => null);
    if (surServeur !== creds.displayName) service.setDisplayName(creds.displayName).catch(() => {});
  }

  // Chiffrement : un compte NEUF est amorcé (le cœur refuse d'office si le
  // compte a déjà une identité) ; sinon, cet appareil doit être vérifié.
  if (await service.checkNeedsBootstrap()) {
    const motDePasse = getCachedLoginPassword() || undefined;
    clearCachedLoginPassword();
    await get().bootstrapE2EE(motDePasse);
    return;
  }
  clearCachedLoginPassword();
  if (!(await service.checkDeviceVerified())) {
    set({ needsVerification: true });
    if (consommerVerificationApresConnexion()) void get().startCrossDeviceVerification();
  } else {
    await service.tryAutoRestoreKeyBackup().catch(() => 0);
  }
}
