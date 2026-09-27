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
      set({ channels: [], messages: {}, roomHasMore: {}, roomLoadingHistory: {} });
    }
  };

  const appliquerSalons = (liste: Channel[], premier: boolean) => {
    cache.definirSalons(liste);
    set({ channels: liste });
    if (premier || liste.length > 0) selectionnerSalonParDefaut(liste);
  };

  const appliquerFil = (fil: FilSalon, initial: boolean) => {
    const avant = get().messages[fil.salon] ?? [];
    if (!initial) sonnerNouveaux(fil, avant, get, APP_SESSION_START_TS);
    const epinglesChanges = cache.definirEpingles(fil.salon, fil.epingles);
    set((s) => {
      const messages = { ...s.messages, [fil.salon]: fil.messages };
      return {
        messages,
        roomHasMore: { ...s.roomHasMore, [fil.salon]: fil.aPlus },
        hasUndecryptableMessages: Object.values(messages).some((m) => m.some((x) => x.msgtype === "m.encrypted")),
        ...(epinglesChanges ? { pinnedVersion: s.pinnedVersion + 1 } : {}),
      };
    });
  };

  const appliquerVerification = (v: EtatVerification) => {
    set({
      verificationStep: v.etape,
      verificationEmojis: v.emojis,
      verificationError: v.erreur ?? null,
      ...(v.etape === "done" ? { needsVerification: false } : {}),
    });
  };

  await core.surEtat(appliquerEtat);
  await core.surSalons((l) => appliquerSalons(l, false));
  await core.surMessages((f) => appliquerFil(f, false));
  await core.surVerification(appliquerVerification);

  // État présent au moment de l'abonnement.
  appliquerEtat(await core.etatConnexion());
  appliquerSalons(await core.salons().catch(() => []), true);
  for (const fil of await core.fils().catch(() => [])) appliquerFil(fil, true);
  appliquerVerification(await core.verification().catch(() => ({ etape: "idle" as const, emojis: [] })));
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
    // La voix n'existe pas encore sur ce moteur (étape 3) : pas d'entrée
    // automatique dans un salon vocal.
    void autoJoinVoice;
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
  void service.ouvrirDroitAnnonceVersion().finally(() => void service.publishClientVersion());

  // Le nom local (emojis compris) fait foi sur celui du serveur.
  const { useAuthStore, getCachedLoginPassword, clearCachedLoginPassword } = await import("./useAuthStore");
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
  } else {
    await service.tryAutoRestoreKeyBackup().catch(() => 0);
  }
}
