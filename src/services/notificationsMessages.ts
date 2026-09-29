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

/** Ouvre le salon d'une notification, puis son message (même hors du fil
 *  chargé). Sur téléphone, bascule aussi de la liste au chat. */
export function ouvrirMessage(salon: string, evenement?: string | null): void {
  const app = useAppStore.getState();
  app.setActiveChannel(salon, false);
  app.setMobileView("chat");
  if (evenement) {
    // Laisse le salon s'afficher avant d'y chercher le message.
    setTimeout(() => void import("./allerAuMessage").then((m) => m.allerAuMessage(evenement)), 300);
  }
}

/** Retours des notifications du bureau Linux (`notifications_bureau.rs`) :
 *  clic ou « Ouvrir » ramène sur le message, la réponse intégrée de KDE part
 *  comme une réponse ordinaire. Installés une fois. */
async function ecouterNotificationsBureau(): Promise<void> {
  if (ecouteBureau) return;
  ecouteBureau = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ salon: string; evenement?: string | null }>("notification-ouvrir", (e) => {
    ouvrirMessage(e.payload.salon, e.payload.evenement);
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
      onAction((retour) => {
        // Android : { actionId, inputValue, notification: { extra } } ;
        // ailleurs, la notification elle-même porte `extra`. Lire `extra` à
        // la racine laissait le toucher et « Répondre » sans effet sur le
        // téléphone (29/09).
        const r = retour as unknown as {
          actionId?: string;
          inputValue?: string | null;
          extra?: Record<string, string>;
          notification?: { extra?: Record<string, string> } | null;
        };
        const extra = r.notification?.extra ?? r.extra;
        if (!extra?.roomId) return;
        if (r.actionId === "reply") {
          const reponse = r.inputValue?.trim();
          if (reponse) {
            void import("./matrixService").then((ms) =>
              (extra.eventId ? ms.sendReply(extra.roomId, extra.eventId, reponse) : ms.sendTextMessage(extra.roomId, reponse))
                .catch(console.error),
            );
          }
          return;
        }
        // « tap » (Android), « open », ou clic sans action.
        ouvrirMessage(extra.roomId, extra.eventId || null);
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
        ouvrirMessage(n.salon, n.evenement);
      };
    }
  }
}
