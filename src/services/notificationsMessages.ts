/**
 * Notifications système des messages reçus, communes aux deux moteurs.
 *
 * Elles ne vivaient que dans le moteur JS (`useMatrixStore`) : depuis que le
 * cœur Rust est le moteur par défaut (2.0 beta 2), aucune mention, réponse ni
 * MP ne notifiait plus (28/09).
 */
import { useAppStore } from "../stores/useAppStore";
import type { NotificationMode } from "../stores/useSettingsStore";

/** Quelqu'un devant Sion : inutile de notifier. */
export { utilisateurPresent, etatPresence } from "./premierPlan";

// ── Faut-il notifier ? ───────────────────────────────────────────────────────

export interface NatureMessage {
  poke: boolean;
  mp: boolean;
  mention: boolean;
  reponseAMoi: boolean;
  /** Message du salon vocal où l'on est connecté. */
  salonVocal: boolean;
}

/**
 * Le réglage « Notifications » :
 * - poke : toujours ;
 * - « all » : MP, mentions, réponses, et le salon vocal où l'on est ;
 * - « mentions » : MP, mentions et réponses à mes messages ;
 * - « minimal » : MP seulement.
 */
export function doitNotifier(nature: NatureMessage, mode: NotificationMode): boolean {
  if (nature.poke) return true;
  if (mode === "all") return nature.salonVocal || nature.mp || nature.mention || nature.reponseAMoi;
  if (mode === "mentions") return nature.mp || nature.mention || nature.reponseAMoi;
  if (mode === "minimal") return nature.mp;
  return false;
}

/**
 * Le message me mentionne-t-il ? Sion insère `@<nom affiché>` ; on accepte
 * aussi `@<partie locale>` et un lien vers mon identifiant (autres clients).
 */
export function estMention(
  texte: string | undefined,
  html: string | undefined,
  moi: string | null | undefined,
  nomAffiche?: string | null,
): boolean {
  if (!moi) return false;
  const partieLocale = moi.slice(0, moi.indexOf(":") > 0 ? moi.indexOf(":") : undefined);
  const corps = texte ?? "";
  if (partieLocale && corps.includes(partieLocale)) return true;
  if (nomAffiche && nomAffiche !== moi && corps.includes(`@${nomAffiche}`)) return true;
  return !!html && html.includes(moi);
}

// ── Envoi ────────────────────────────────────────────────────────────────────

let actionsEnregistrees = false;
let ecouteBureau = false;

/** Retours des notifications du bureau Linux (`notifications_bureau.rs`) :
 *  clic ou « Ouvrir » ramène sur le message, la réponse intégrée de KDE part
 *  comme une réponse ordinaire. Installés une fois. */
async function ecouterNotificationsBureau(): Promise<void> {
  if (ecouteBureau) return;
  ecouteBureau = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ salon: string; evenement?: string | null }>("notification-ouvrir", (e) => {
    useAppStore.getState().setActiveChannel(e.payload.salon, false);
    if (e.payload.evenement) {
      const evenement = e.payload.evenement;
      // Laisse le salon s'afficher avant d'y chercher le message.
      setTimeout(() => void import("./allerAuMessage").then((m) => m.allerAuMessage(evenement)), 300);
    }
  });
  await listen<{ salon: string; evenement?: string | null; texte: string }>("notification-repondre", (e) => {
    const { salon, evenement, texte } = e.payload;
    if (!texte.trim()) return;
    void import("./matrixService").then((ms) =>
      (evenement ? ms.sendReply(salon, evenement, texte) : ms.sendTextMessage(salon, texte)).catch(console.error),
    );
  });
}

/** Notification système : « Répondre » (champ de saisie) et « Ouvrir ».
 *  Sous Linux, adressée directement au bureau (historique, boutons, réponse
 *  intégrée) ; ailleurs, par `tauri-plugin-notification`. */
export async function envoyerNotification(n: { titre: string; corps: string; salon: string; evenement?: string }): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await ecouterNotificationsBureau();
    await invoke("notification_message", { titre: n.titre, corps: n.corps, salon: n.salon, evenement: n.evenement ?? null });
    return;
  } catch {
    // Hors Linux (ou bus indisponible) : le module de Tauri, plus bas.
  }
  try {
    const { sendNotification, isPermissionGranted, requestPermission, registerActionTypes, onAction } =
      await import("@tauri-apps/plugin-notification");
    let autorise = await isPermissionGranted();
    if (!autorise) autorise = (await requestPermission()) === "granted";
    if (!autorise) return;

    if (!actionsEnregistrees) {
      actionsEnregistrees = true;
      await registerActionTypes([{
        id: "msg-reply",
        actions: [
          { id: "reply", title: "Répondre", input: true, inputButtonTitle: "Envoyer", inputPlaceholder: "Votre réponse..." },
          { id: "open", title: "Ouvrir", foreground: true },
        ],
      }]).catch(() => {});
      onAction((notification) => {
        const extra = notification.extra as Record<string, string> | undefined;
        if (!extra) return;
        const actionId = (notification as unknown as Record<string, string>).actionId;
        if (actionId === "open" || !actionId) {
          useAppStore.getState().setActiveChannel(extra.roomId, false);
          if (extra.eventId) useAppStore.getState().setScrollToMessageId(extra.eventId);
        }
        if (actionId === "reply") {
          const reponse = (notification as unknown as Record<string, string>).inputValue;
          if (reponse && extra.roomId) {
            void import("./matrixService").then((ms) => ms.sendReply(extra.roomId, extra.eventId, reponse).catch(console.error));
          }
        }
      }).catch(() => {});
    }

    sendNotification({
      title: n.titre,
      body: n.corps,
      icon: "icons/128x128.png",
      actionTypeId: "msg-reply",
      extra: { roomId: n.salon, eventId: n.evenement ?? "" },
    });
  } catch {
    // Hors Tauri : notification web, clic = ouvrir le salon.
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notif = new Notification(n.titre, { body: n.corps, icon: "/icons/128x128.png" });
      notif.onclick = () => {
        window.focus();
        useAppStore.getState().setActiveChannel(n.salon, false);
        if (n.evenement) useAppStore.getState().setScrollToMessageId(n.evenement);
      };
    }
  }
}
