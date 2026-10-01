/**
 * Push notification service using ntfy + Matrix pushers.
 *
 * Marche à suivre :
 * 1. fabriquer un sujet unique pour cet appareil ;
 * 2. déclarer auprès de Matrix un pusher HTTP pointant vers l'URL de ce sujet.
 *
 * L'application ne reçoit pas les notifications elle-même : c'est ntfy qui les
 * livre au système. L'abonnement SSE qui vivait ici était mort — plus personne
 * ne l'appelait depuis le passage au pusher serveur.
 */

import { getMatrixClient } from "./matrixService";
import * as core from "./matrixCore";
import { moteurRust } from "./moteur";
import { PushRuleKind } from "matrix-js-sdk";
import type { NotificationMode } from "../stores/useSettingsStore";

// Serveur ntfy de Sion : public (il figure dans chaque pousseur déclaré au
// serveur Matrix) ; `VITE_NTFY_BASE_URL` le remplace pour un autre serveur.
// Il n'était défini que par un `.env` local, absent de la CI : le module
// levait une erreur au chargement et l'APK construit par la CI n'aurait
// enregistré aucun push (30/09).
export const NTFY_BASE_URL: string = import.meta.env.VITE_NTFY_BASE_URL || "https://push.sionchat.fr";
const PUSH_APP_ID = "fr.sionchat.client";

/**
 * Configure Matrix push rules based on notification mode.
 * This controls what the SERVER sends as push, not client-side filtering.
 *
 * - "all": default rules (notify for all messages in joined rooms)
 * - "mentions": only mentions, replies to me, and DMs
 * - "minimal": only DMs
 */
export async function syncPushRules(_mode: NotificationMode): Promise<void> {
  // Disabled — push rule filtering is handled in NtfyListenerService (Android)
  // Server-side push rules for E2EE rooms are unreliable
  // Clean up any previously created rules
  const client = getMatrixClient();
  if (!client) return;
  try {
    await client.deletePushRule("global", PushRuleKind.Override, "fr.sionchat.suppress_messages").catch(() => {});
    await client.deletePushRule("global", PushRuleKind.Override, "fr.sionchat.suppress_mentions").catch(() => {});
  } catch { /* rules may simply not exist yet */ }
  return;
}

// Note: server-side push rules for E2EE rooms are unreliable with Continuwuity.
// Notification filtering is handled client-side in NtfyListenerService (Android).

/**
 * Sujet ntfy de cet appareil : 128 bits tirés au hasard à sa première
 * déclaration, puis gardés tant que le compte et l'appareil restent les
 * mêmes. Le nom du sujet est le seul secret qui protège l'écoute : dérivé du
 * compte et de l'appareil (jusqu'à la 2.0 beta 5), il se devinait, et
 * n'importe qui pouvait lire les avis de messages (salon, événement) ou en
 * publier de faux. Perdu (données effacées), un nouveau est tiré : le cœur
 * retire alors le pusher de l'ancien.
 */
const CLE_SUJET = "sion-push-sujet";
const FORME_SUJET = /^sion_[0-9a-f]{32}$/;

export function sujetAppareil(userId: string, deviceId: string): string {
  const compte = `${userId}|${deviceId}`;
  try {
    const garde = JSON.parse(localStorage.getItem(CLE_SUJET) ?? "null") as { compte?: string; sujet?: string } | null;
    if (garde?.compte === compte && garde.sujet && FORME_SUJET.test(garde.sujet)) return garde.sujet;
  } catch { /* illisible : on en tire un autre */ }
  const octets = crypto.getRandomValues(new Uint8Array(16));
  const sujet = `sion_${Array.from(octets, (o) => o.toString(16).padStart(2, "0")).join("")}`;
  try {
    localStorage.setItem(CLE_SUJET, JSON.stringify({ compte, sujet }));
  } catch { /* stockage indisponible : sujet de cette session seulement */ }
  return sujet;
}

/** Déconnexion : le prochain compte (ou appareil) aura son propre sujet. */
function oublierSujet(): void {
  try {
    localStorage.removeItem(CLE_SUJET);
  } catch { /* rien à oublier */ }
}

/** Pour les journaux : l'adresse sans le secret. */
export function sujetMasque(topicUrl: string): string {
  return topicUrl.replace(/(sion_[0-9a-z]{4})[0-9a-z]+/, "$1…");
}

/** Moteur JS : sujet de cet appareil, d'après le client. */
function getTopicId(): string {
  const client = getMatrixClient();
  const userId = client?.getUserId();
  const deviceId = client?.getDeviceId();
  if (!userId || !deviceId) return "";
  return sujetAppareil(userId, deviceId);
}

/** Passerelle Matrix de ntfy (spec « push gateway ») : le serveur y poste,
 *  ntfy publie sur le sujet donné comme clé du pusher. */
const PASSERELLE = `${NTFY_BASE_URL}/_matrix/push/v1/notify`;

/** Moteur Rust : sujet de cet appareil, d'après la session. */
async function sujetRust(): Promise<{ topicUrl: string; appareil: string } | null> {
  const { useAuthStore } = await import("../stores/useAuthStore");
  const c = useAuthStore.getState().credentials;
  if (!c?.userId || !c.deviceId) return null;
  return { topicUrl: `${NTFY_BASE_URL}/${sujetAppareil(c.userId, c.deviceId)}`, appareil: c.deviceId };
}

const SUR_ANDROID = /Android/i.test(navigator.userAgent);

/** Register a Matrix HTTP pusher that sends notifications to our ntfy topic */
export async function registerPusher(): Promise<void> {
  if (moteurRust()) {
    // Le cœur déclare le pusher — sur téléphone seulement : sur PC, personne
    // n'écoute le sujet ntfy (les notifications viennent de la synchro).
    // Avant : `getMatrixClient()` rendait null avec le moteur Rust, et aucun
    // pusher n'était déclaré — plus aucun push sur Android (29/09).
    if (!SUR_ANDROID) return;
    const s = await sujetRust();
    if (!s) return;
    try {
      await core.enregistrerPusher(PASSERELLE, s.topicUrl, PUSH_APP_ID, s.appareil);
      console.info(`[Sion][push] pusher déclaré (${sujetMasque(s.topicUrl)})`);
      const { startPushListener } = await import("./androidVoiceService");
      startPushListener(s.topicUrl);
    } catch (err) {
      console.warn("[Sion][push] pusher non déclaré :", err);
    }
    return;
  }
  const client = getMatrixClient();
  if (!client) return;

  const topicId = getTopicId();
  if (!topicId) return;

  const topicUrl = `${NTFY_BASE_URL}/${topicId}`;

  try {
    await client.setPusher({
      app_display_name: "Sion Client",
      app_id: PUSH_APP_ID,
      data: {
        url: PASSERELLE,
        format: "event_id_only",
      },
      device_display_name: client.getDeviceId() || "Sion Device",
      kind: "http",
      lang: "fr",
      pushkey: topicUrl,
      append: false,
    });

    // Start Android background push listener service
    import("./androidVoiceService").then(({ startPushListener }) => {
      startPushListener(topicUrl);
    }).catch(() => {});
  } catch (err) {
    console.warn("[Sion] Failed to register pusher:", err);
  }
}

/** Unregister the pusher (on logout) */
export async function unregisterPusher(): Promise<void> {
  if (moteurRust()) {
    if (!SUR_ANDROID) return;
    // L'écoute s'arrête quoi qu'il arrive au retrait côté serveur.
    const { stopPushListener } = await import("./androidVoiceService");
    stopPushListener();
    const s = await sujetRust();
    if (!s) return;
    await core.retirerPusher(s.topicUrl, PUSH_APP_ID).catch(() => {});
    oublierSujet();
    return;
  }
  const client = getMatrixClient();
  if (!client) return;

  const topicId = getTopicId();
  if (!topicId) return;

  const topicUrl = `${NTFY_BASE_URL}/${topicId}`;

  try {
    await client.setPusher({
      app_display_name: "Sion Client",
      app_id: PUSH_APP_ID,
      data: { url: NTFY_BASE_URL },
      device_display_name: client.getDeviceId() || "Sion Device",
      kind: null as unknown as string,
      lang: "fr",
      pushkey: topicUrl,
    });
  } catch { /* ignore */ }
  oublierSujet();
}
