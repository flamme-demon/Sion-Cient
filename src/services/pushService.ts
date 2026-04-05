/**
 * Push notification service using ntfy + Matrix pushers.
 *
 * Flow:
 * 1. Generate a unique topic for this device
 * 2. Register a Matrix HTTP pusher pointing to ntfy topic URL
 * 3. Subscribe to ntfy topic via EventSource (SSE)
 * 4. Parse incoming Matrix push notifications and display them
 */

import { getMatrixClient } from "./matrixService";
import { PushRuleKind } from "matrix-js-sdk";
import type { NotificationMode } from "../stores/useSettingsStore";

const NTFY_BASE_URL = "https://push.sionchat.fr";
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
  } catch {}
  return;
}

// Note: server-side push rules for E2EE rooms are unreliable with Continuwuity.
// Notification filtering is handled client-side in NtfyListenerService (Android).

/** Generate a deterministic topic name for this device */
function getTopicId(): string {
  const client = getMatrixClient();
  if (!client) return "";
  const userId = client.getUserId() || "";
  const deviceId = client.getDeviceId() || "";
  // Simple hash to create a short topic name
  let hash = 0;
  const str = `${userId}:${deviceId}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `sion_${Math.abs(hash).toString(36)}`;
}

/** Register a Matrix HTTP pusher that sends notifications to our ntfy topic */
export async function registerPusher(): Promise<void> {
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
    console.log("[Sion] Push registered:", topicUrl, "via", NTFY_BASE_URL);

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

/** Subscribe to ntfy topic and handle incoming notifications */
let eventSource: EventSource | null = null;

export function subscribeToPush(
  onNotification: (data: { roomId?: string; eventId?: string; sender?: string; body?: string }) => void,
): () => void {
  const topicId = getTopicId();
  if (!topicId) return () => {};

  // Close existing subscription
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const url = `${NTFY_BASE_URL}/${topicId}/sse`;
  console.log("[Sion] Subscribing to push:", url);

  eventSource = new EventSource(url);

  eventSource.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      // ntfy wraps the message in its own format
      const message = data.message || "";

      // Try to parse the Matrix push notification payload
      let pushData: Record<string, unknown> = {};
      try {
        pushData = JSON.parse(message);
      } catch {
        // Not JSON — might be a plain text notification from ntfy
        if (message) {
          onNotification({ body: message });
        }
        return;
      }

      // Extract Matrix notification fields
      const notification = (pushData as { notification?: Record<string, unknown> }).notification;
      if (notification) {
        onNotification({
          roomId: notification.room_id as string,
          eventId: notification.event_id as string,
          sender: notification.sender as string,
          body: (notification.content as Record<string, string>)?.body,
        });
      }
    } catch (err) {
      console.warn("[Sion] Push parse error:", err);
    }
  });

  eventSource.onerror = () => {
    console.warn("[Sion] Push SSE connection error, will reconnect");
  };

  return () => {
    eventSource?.close();
    eventSource = null;
  };
}
