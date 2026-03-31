import * as jose from "jose";
import type { MatrixClient } from "matrix-js-sdk";

export async function generateLiveKitToken(
  apiKey: string,
  apiSecret: string,
  roomName: string,
  participantName: string,
): Promise<string> {
  const secret = new TextEncoder().encode(apiSecret);
  // Extraire le localpart si c'est un Matrix ID (@user:server.com)
  const identity = participantName.startsWith("@")
    ? participantName.match(/^@([^:]+):/)?.[1] || participantName
    : participantName;

  const jwt = await new jose.SignJWT({
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    },
    sub: identity,
    name: participantName.startsWith("@") ? identity : participantName,
    iss: apiKey,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("6h")
    .setNotBefore("0s")
    .sign(secret);
  return jwt;
}

/**
 * Obtient un token LiveKit via le flux MatrixRTC (org.matrix.msc3401.call.member).
 *
 * Flux :
 * 1. Lit les events `org.matrix.msc3401.call.member` pour trouver le `livekit_service_url`
 *    dans `memberships[].foci_active[]` (nouveau format per-device) ou `foci_preferred[]` (ancien).
 * 2. Récupère un OpenID token Matrix auprès du homeserver.
 * 3. Envoie ce token au service LiveKit (POST /get_token) pour obtenir un JWT LiveKit.
 */
export async function getMatrixRTCToken(
  client: MatrixClient,
  roomId: string,
): Promise<{ url: string; token: string; serviceUrl: string; livekitAlias: string } | null> {
  const room = client.getRoom(roomId);
  if (!room) return null;

  type LivKitFocus = { type: string; livekit_service_url?: string; livekit_alias?: string };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extractFocus(evt: any): LivKitFocus | null {
    const content: Record<string, unknown> = evt.getContent?.() || {};

    // Nouveau format MSC3401 per-device : content.memberships[].foci_active[]
    const memberships = content.memberships as Array<{ foci_active?: LivKitFocus[] }> | undefined;
    if (Array.isArray(memberships)) {
      for (const m of memberships) {
        const focus = (m.foci_active || []).find((f) => f.type === "livekit" && f.livekit_service_url);
        if (focus) return focus;
      }
    }

    // Ancien format MSC3401 : content.foci_preferred[]
    const foci = (content.foci_preferred as LivKitFocus[] | undefined) || [];
    return foci.find((f) => f.type === "livekit" && f.livekit_service_url) ?? null;
  }

  let livekitFocus: LivKitFocus | null = null;

  // 1a. Chercher d'abord dans currentState (membres actuellement dans l'appel)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMemberEvents = (room.currentState as any)?.getStateEvents?.("org.matrix.msc3401.call.member");
  const currentStateEvents: unknown[] = Array.isArray(rawMemberEvents)
    ? rawMemberEvents
    : rawMemberEvents ? [rawMemberEvents] : [];
  for (const evt of currentStateEvents) {
    const focus = extractFocus(evt);
    if (focus) { livekitFocus = focus; break; }
  }

  // 1b. Si currentState ne contient que des états vides ({}, membres partis),
  //     chercher dans la timeline historique du plus récent au plus ancien
  if (!livekitFocus) {
    const timeline = room.getLiveTimeline().getEvents();
    for (let i = timeline.length - 1; i >= 0; i--) {
      const evt = timeline[i];
      if (evt.getType?.() !== "org.matrix.msc3401.call.member") continue;
      const focus = extractFocus(evt);
      if (focus) { livekitFocus = focus; break; }
    }
  }

  // 1c. Si toujours rien, chercher le service_url dans les autres rooms du serveur
  //     On ne récupère QUE le service_url, pas le livekit_alias (qui est propre à chaque room)
  let fallbackServiceUrl: string | null = null;
  if (!livekitFocus) {
    const allRooms = client.getRooms();
    for (const otherRoom of allRooms) {
      if (otherRoom.roomId === roomId) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const otherEvents = (otherRoom.currentState as any)?.getStateEvents?.("org.matrix.msc3401.call.member");
      const otherList: unknown[] = Array.isArray(otherEvents) ? otherEvents : otherEvents ? [otherEvents] : [];
      for (const evt of otherList) {
        const focus = extractFocus(evt);
        if (focus?.livekit_service_url) {
          fallbackServiceUrl = focus.livekit_service_url;
          break;
        }
      }
      if (fallbackServiceUrl) break;
    }
  }

  let rawServiceUrl = livekitFocus?.livekit_service_url || fallbackServiceUrl;

  // 1d. Fallback : lire le livekit_service_url depuis /.well-known/matrix/client
  if (!rawServiceUrl) {
    try {
      const homeserverUrl = client.getHomeserverUrl().replace(/\/$/, "");
      const wkResponse = await fetch(`${homeserverUrl}/.well-known/matrix/client`);
      if (wkResponse.ok) {
        const wkData = await wkResponse.json();
        const foci = wkData?.["org.matrix.msc4143.rtc_foci"];
        if (Array.isArray(foci)) {
          const lkFocus = foci.find((f: { type: string; livekit_service_url?: string }) =>
            f.type === "livekit" && f.livekit_service_url
          );
          if (lkFocus) {
            rawServiceUrl = lkFocus.livekit_service_url;
          }
        }
      }
    } catch (err) {
      console.warn("[Sion] Impossible de lire le well-known pour LiveKit:", err);
    }
  }

  if (!rawServiceUrl) {
    return null;
  }

  // Le livekit_service_url peut être "livekit:https://..." ou directement "https://..."
  let serviceUrl = rawServiceUrl;
  if (serviceUrl.startsWith("livekit:")) {
    serviceUrl = serviceUrl.slice("livekit:".length);
  }
  // livekit_alias uniquement depuis la room courante, fallback = roomId Matrix
  const livekitRoomAlias = livekitFocus?.livekit_alias || roomId;
  // 2. Récupérer un OpenID token Matrix
  const userId = client.getUserId();
  if (!userId) return null;
  const deviceId = client.getDeviceId() || "";

  let openidToken: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openidToken = await (client as any).getOpenIdToken() as Record<string, unknown>;
  } catch (err) {
    console.error("[Sion] Impossible d'obtenir un OpenID token Matrix:", err);
    return null;
  }

  // 3. Appeler le service LiveKit pour échanger le token
  //    Endpoint exact confirmé via HAR : POST /sfu/get avec "room" + openid_token complet + device_id
  const endpoints = [
    { path: "/sfu/get", body: { room: livekitRoomAlias, openid_token: openidToken, device_id: deviceId } },
    { path: "/get_token", body: { room: livekitRoomAlias, openid_token: openidToken, device_id: deviceId } },
  ];

  for (const { path, body } of endpoints) {
    try {
      const response = await fetch(`${serviceUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();

      if (!response.ok) continue;

      const data = JSON.parse(responseText) as { url?: string; jwt?: string };
      if (!data.jwt) {
        console.error("[Sion] Réponse invalide du service LiveKit:", data);
        continue;
      }

      // Construire l'URL WSS publique depuis le serviceUrl (well-known)
      // au lieu d'utiliser data.url qui peut être une URL interne (ws://127.0.0.1:7880)
      const publicWssUrl = serviceUrl.replace(/^https?:\/\//, "wss://");

      return { url: publicWssUrl, token: data.jwt, serviceUrl, livekitAlias: livekitRoomAlias };
    } catch (err) {
      console.error(`[Sion] Erreur lors de l'appel à ${path}:`, err);
    }
  }

  console.error("[Sion] Tous les endpoints LiveKit ont échoué");
  return null;
}
