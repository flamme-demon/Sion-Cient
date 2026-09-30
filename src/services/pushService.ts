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

const NTFY_BASE_URL = import.meta.env.VITE_NTFY_BASE_URL;
if (!NTFY_BASE_URL) {
  throw new Error("[Sion] VITE_NTFY_BASE_URL is not defined in environment variables");
}
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

/** Sujet ntfy de cet appareil : court, stable, dérivé du compte et de
 *  l'appareil. */
function sujet(userId: string, deviceId: string): string {
  let hash = 0;
  const str = `${userId}:${deviceId}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `sion_${Math.abs(hash).toString(36)}`;
}

/** Generate a deterministic topic name for this device */
function getTopicId(): string {
  const client = getMatrixClient();
  if (!client) return "";
  return sujet(client.getUserId() || "", client.getDeviceId() || "");
}

/** Passerelle Matrix de ntfy (spec « push gateway ») : le serveur y poste,
 *  ntfy publie sur le sujet donné comme clé du pusher. */
const PASSERELLE = `${NTFY_BASE_URL}/_matrix/push/v1/notify`;

/** Moteur Rust : sujet de cet appareil, d'après la session. */
async function sujetRust(): Promise<{ topicUrl: string; appareil: string } | null> {
  const { useAuthStore } = await import("../stores/useAuthStore");
  const c = useAuthStore.getState().credentials;
  if (!c?.userId || !c.deviceId) return null;
  return { topicUrl: `${NTFY_BASE_URL}/${sujet(c.userId, c.deviceId)}`, appareil: c.deviceId };
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
      console.info(`[Sion][push] pusher déclaré (${s.topicUrl})`);
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
    // Clean up any old pushers with different URLs
    const oldUrls = ["https://sionchat.fr/push"];
    for (const oldUrl of oldUrls) {
      const oldPushkey = `${oldUrl}/${topicId}`;
      if (oldPushkey !== topicUrl) {
        await client.setPusher({
          app_display_name: "Sion Client",
          app_id: PUSH_APP_ID,
          data: { url: oldUrl },
          device_display_name: client.getDeviceId() || "Sion Device",
          kind: null as unknown as string,
          lang: "fr",
          pushkey: oldPushkey,
        }).catch(() => {});
      }
    }

    await client.setPusher({
      app_display_name: "Sion Client",
      app_id: PUSH_APP_ID,
      data: {
        url: NTFY_BASE_URL,
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
}
