import * as sdk from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";

let matrixClient: MatrixClient | null = null;

// Cached recovery key (decoded) for the getSecretStorageKey callback
let cachedSecretStorageKey: Uint8Array | null = null;

// Callback for the SDK to retrieve the secret storage key when needed
const cryptoCallbacks = {
  getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => {
    if (!cachedSecretStorageKey) {
      console.warn("[Sion] getSecretStorageKey called but no key cached");
      return null;
    }
    // Return the first requested key ID with our cached key
    const keyId = Object.keys(keys)[0];
    if (!keyId) return null;
    return [keyId, cachedSecretStorageKey] as [string, Uint8Array<ArrayBuffer>];
  },
  cacheSecretStorageKey: (_keyId: string, _keyInfo: unknown, key: Uint8Array) => {
    cachedSecretStorageKey = key;
  },
};

function getDeviceDisplayName(): string {
  let os = "Unknown";
  const ua = navigator.userAgent;
  if (ua.includes("Win")) os = "Windows";
  else if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  return `Sion Client (${os})`;
}

export interface MatrixConfig {
  homeserverUrl: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
}

export interface RegistrationFlow {
  stages: string[];
}

export interface RegistrationFlowInfo {
  flows: RegistrationFlow[];
  params: Record<string, unknown>;
  session: string;
  disabled?: boolean;
}

/** Detect registration flows supported by the homeserver */
export async function getRegistrationFlows(homeserver: string): Promise<RegistrationFlowInfo> {
  try {
    const resp = await fetch(`${homeserver}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "user" }),
    });

    if (resp.status === 403) {
      return { flows: [], params: {}, session: "", disabled: true };
    }

    const data = await resp.json();

    // 401 = UIA response with flows (expected)
    if (resp.status === 401 || data.flows) {
      return {
        flows: data.flows || [],
        params: data.params || {},
        session: data.session || "",
      };
    }

    // 200 = registration succeeded without auth (very open server)
    if (resp.ok) {
      return { flows: [{ stages: ["m.login.dummy"] }], params: {}, session: "" };
    }

    return { flows: [], params: {}, session: "", disabled: true };
  } catch {
    return { flows: [], params: {}, session: "", disabled: true };
  }
}

/** Register a user, handling UIA flows (dummy, token, recaptcha) */
export async function registerUser(
  homeserver: string,
  username: string,
  password: string,
  _displayName?: string,
  token?: string,
  captchaResponse?: string,
): Promise<void> {
  const client = sdk.createClient({ baseUrl: homeserver });

  // Step 1: initiate registration to get session
  let session = "";
  try {
    await client.registerRequest({
      username,
      password,
      initial_device_display_name: getDeviceDisplayName(),
    });
    // If this succeeds directly, we're done (very open server)
    return;
  } catch (err: unknown) {
    const e = err as { data?: { session?: string; flows?: RegistrationFlow[] } };
    if (e.data?.session) {
      session = e.data.session;
    } else {
      throw err;
    }
  }

  // Step 2: determine which stages to complete
  const stages: { type: string; [key: string]: unknown }[] = [];

  if (token) {
    // Complete token stage
    await client.registerRequest({
      username,
      password,
      initial_device_display_name: getDeviceDisplayName(),
      auth: { type: "m.login.registration_token", token, session },
    }).catch((err: unknown) => {
      const e = err as { data?: { session?: string; completed?: string[] }; httpStatus?: number };
      if (e.httpStatus === 401 && e.data?.session) {
        session = e.data.session;
      } else {
        throw err;
      }
    });
  }

  if (captchaResponse) {
    // Complete recaptcha stage
    await client.registerRequest({
      username,
      password,
      initial_device_display_name: getDeviceDisplayName(),
      auth: { type: "m.login.recaptcha", response: captchaResponse, session },
    }).catch((err: unknown) => {
      const e = err as { data?: { session?: string; completed?: string[] }; httpStatus?: number };
      if (e.httpStatus === 401 && e.data?.session) {
        session = e.data.session;
      } else {
        throw err;
      }
    });
  }

  // Final: complete with dummy if needed (or finalize)
  await client.registerRequest({
    username,
    password,
    initial_device_display_name: getDeviceDisplayName(),
    auth: { type: "m.login.dummy", session },
  });
}

export function mxcToHttp(mxcUrl: string): string | null {
  if (!matrixClient || !mxcUrl) return null;
  return matrixClient.mxcUrlToHttp(mxcUrl) || null;
}

export async function getAvatarUrl(userId: string): Promise<string | null> {
  if (!matrixClient) return null;
  try {
    const profile = await matrixClient.getProfileInfo(userId);
    if (!profile.avatar_url) return null;
    return mxcToHttp(profile.avatar_url);
  } catch {
    return null;
  }
}

// Guard against concurrent initMatrixClient calls (React Strict Mode double-invocation)
let initInProgress: Promise<MatrixClient> | null = null;

export async function initMatrixClient(config: MatrixConfig): Promise<MatrixClient> {
  if (initInProgress) {
    return initInProgress;
  }
  initInProgress = _initMatrixClientImpl(config);
  try {
    return await initInProgress;
  } finally {
    initInProgress = null;
  }
}

async function _initMatrixClientImpl(config: MatrixConfig): Promise<MatrixClient> {
  if (config.accessToken) {
    // If no deviceId, fetch it from the server via whoami
    let deviceId = config.deviceId;
    if (!deviceId) {
      try {
        const tempClient = sdk.createClient({ baseUrl: config.homeserverUrl, accessToken: config.accessToken, userId: config.userId });
        const whoami = await tempClient.whoami();
        deviceId = whoami.device_id;
      } catch (err) {
        console.warn("[Sion] Failed to fetch deviceId from whoami:", err);
      }
    }
    matrixClient = sdk.createClient({
      baseUrl: config.homeserverUrl,
      accessToken: config.accessToken,
      userId: config.userId,
      deviceId,
      cryptoCallbacks,
    });
  } else if (config.password) {
    const tempClient = sdk.createClient({ baseUrl: config.homeserverUrl });
    const loginResponse = await tempClient.login("m.login.password", {
      user: config.userId,
      password: config.password,
      initial_device_display_name: getDeviceDisplayName(),
    });
    matrixClient = sdk.createClient({
      baseUrl: config.homeserverUrl,
      accessToken: loginResponse.access_token,
      userId: loginResponse.user_id,
      deviceId: loginResponse.device_id,
      cryptoCallbacks,
    });
  } else {
    throw new Error("Either accessToken or password must be provided");
  }

  // Initialize E2EE (Rust crypto with IndexedDB persistence)
  const currentDeviceId = matrixClient.getDeviceId();
  const currentUserId = matrixClient.getUserId();

  async function tryInitCrypto(attempt: number): Promise<boolean> {
    try {
      // Check if we need to clear the crypto store due to device mismatch
      const storedDeviceId = localStorage.getItem("sion_device_id");
      const storedUserId = localStorage.getItem("sion_user_id");

      if (storedDeviceId && storedUserId && (storedDeviceId !== currentDeviceId || storedUserId !== currentUserId)) {
        await clearCryptoStores();
      }

      // initRustCrypto can hang if IndexedDB is in a bad state — add a timeout
      await Promise.race([
        matrixClient!.initRustCrypto(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("initRustCrypto timed out after 30s")), 30000)
        ),
      ]);
      // Clear any previous failure flag (e.g. from React Strict Mode double-call)
      delete (matrixClient as unknown as Record<string, unknown>).__sionCryptoFailed;
      delete (matrixClient as unknown as Record<string, unknown>).__sionCryptoError;

      // Store current device/user ID for future checks
      if (currentDeviceId) localStorage.setItem("sion_device_id", currentDeviceId);
      if (currentUserId) localStorage.setItem("sion_user_id", currentUserId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Sion] Failed to initialize crypto (attempt ${attempt}):`, msg);

      // Only clear crypto store on actual account mismatch (different user/device logged in)
      // Do NOT clear on getMigrationState or timeout — this destroys device keys
      // and breaks cross-device verification
      if (attempt === 1 && msg.includes("doesn't match the account in the constructor")) {
        await clearCryptoStores();
        await new Promise((r) => setTimeout(r, 500));
        return tryInitCrypto(2);
      }

      // For timeout or transient errors — retry without clearing the store
      if (attempt === 1 && (msg.includes("getMigrationState") || msg.includes("timed out"))) {
        await new Promise((r) => setTimeout(r, 1000));
        return tryInitCrypto(2);
      }

      // Permanent failure
      (matrixClient as unknown as Record<string, boolean>).__sionCryptoFailed = true;
      (matrixClient as unknown as Record<string, string>).__sionCryptoError = msg;
      return false;
    }
  }

  await tryInitCrypto(1);

  return matrixClient;
}

export function getMatrixClient(): MatrixClient | null {
  return matrixClient;
}

export async function startSync() {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.startClient({ initialSyncLimit: 20 });
}

export async function checkDeviceVerified(): Promise<boolean> {
  if (!matrixClient) {
    return false;
  }

  // If crypto init failed, device is definitely not verified
  if ((matrixClient as unknown as Record<string, boolean>).__sionCryptoFailed) {
    return false;
  }

  const crypto = matrixClient.getCrypto();
  if (!crypto) {
    return false;
  }

  try {
    const userId = matrixClient.getUserId();
    const deviceId = matrixClient.getDeviceId();
    if (!userId || !deviceId) {
      return false;
    }

    const deviceStatus = await crypto.getUserVerificationStatus(userId);
    const isVerified = deviceStatus.isVerified();
    return isVerified;
  } catch (err) {
    console.error("[Sion] checkDeviceVerified error:", err);
    return false;
  }
}

export async function hasUndecryptableMessages(): Promise<boolean> {
  if (!matrixClient) return false;

  const crypto = matrixClient.getCrypto();
  if (!crypto) return false;

  try {
    const rooms = matrixClient.getRooms();
    for (const room of rooms) {
      const events = room.getLiveTimeline().getEvents();
      for (const evt of events) {
        if (evt.isDecryptionFailure?.() || evt.getContent?.()?.msgtype === "m.bad.encrypted") {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Clear all crypto-related IndexedDB stores
 * This is needed when switching accounts or devices to avoid conflicts
 */
async function clearCryptoStores(): Promise<void> {
  try {
    const databases = await indexedDB.databases();
    const deletions: Promise<void>[] = [];
    for (const db of databases) {
      if (db.name && (db.name.includes("matrix") || db.name.includes("crypto") || db.name.includes("rust-sdk"))) {
        deletions.push(new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(db.name!);
          req.onsuccess = () => { resolve(); };
          req.onerror = () => { console.warn("[Sion] Error deleting IndexedDB:", db.name); resolve(); };
          req.onblocked = () => {
            console.warn("[Sion] IndexedDB deletion blocked:", db.name, "— will retry after timeout");
            // The DB is blocked by an open connection. Resolve to avoid hanging,
            // the deletion will complete once the connection is closed.
            setTimeout(resolve, 2000);
          };
        }));
      }
    }
    await Promise.all(deletions);
  } catch (err) {
    console.warn("[Sion] Failed to clear crypto stores:", err);
  }
}

export async function restoreKeyBackup(recoveryKey: string): Promise<number> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const crypto = matrixClient.getCrypto();
  if (!crypto) {
    const client = matrixClient as unknown as Record<string, unknown>;
    if (client.__sionCryptoFailed) {
      const errorMsg = client.__sionCryptoError || "Unknown error";
      throw new Error(`Crypto initialization failed: ${errorMsg}. Try reloading the page.`);
    }
    throw new Error("Crypto not initialized. Please wait for the client to fully load and try again.");
  }

  // 1. Decode the recovery key (base58 format like "EsT9 M5a5 ...") to raw bytes
  const { decodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key");
  const privateKey = decodeRecoveryKey(recoveryKey);

  // 2. Cache the decoded key so the getSecretStorageKey callback can provide it
  cachedSecretStorageKey = privateKey;

  try {
    // 3. Bootstrap cross-signing: loads cross-signing private keys from secret storage
    //    and signs our device. This will call getSecretStorageKey callback.
    await crypto.bootstrapCrossSigning({});

    // 4. Load the backup decryption key from secret storage
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();

    // 5. Now restore the key backup
    const result = await crypto.restoreKeyBackup({});
    return result.imported;
  } finally {
    // Clear the cached key after use
    cachedSecretStorageKey = null;
  }
}

/**
 * Try to restore key backup using secrets already received via cross-device verification
 * (secret gossiping). No recovery key needed if verification was successful.
 *
 * After cross-device verification, the other device sends the backup decryption key
 * via to-device messages (m.secret.send). The SDK stores it in the crypto store.
 * checkKeyBackupAndEnable() picks it up and enables automatic backup restore.
 */
export async function tryAutoRestoreKeyBackup(): Promise<number> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const crypto = matrixClient.getCrypto();
  if (!crypto) throw new Error("Crypto not initialized");

  // Check if key backup exists and if we have the decryption key (from secret gossiping)
  const backupEnabled = await crypto.checkKeyBackupAndEnable();
  if (!backupEnabled) {
    return 0;
  }
  // Try restoring — this works if the backup decryption key is in the crypto store
  const result = await crypto.restoreKeyBackup({});
  return result.imported;
}

export async function requestOwnUserVerification() {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const crypto = matrixClient.getCrypto();
  if (!crypto) {
    const client = matrixClient as unknown as Record<string, unknown>;
    if (client.__sionCryptoFailed) {
      const errorMsg = client.__sionCryptoError || "Unknown error";
      throw new Error(`Crypto initialization failed: ${errorMsg}. Try reloading the page.`);
    }
    throw new Error("Crypto not initialized. Please wait for the client to fully load and try again.");
  }
  return crypto.requestOwnUserVerification();
}

export async function setDisplayName(name: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.setDisplayName(name);
}

export async function setAvatar(file: File): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const mxcUrl = await uploadFile(file);
  await matrixClient.setAvatarUrl(mxcUrl);
  return mxcToHttp(mxcUrl) || "";
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.setPassword(
    { type: "m.login.password", user: matrixClient.getUserId() ?? undefined, password: oldPassword },
    newPassword,
  );
}

export async function fetchDisplayName(userId: string): Promise<string | null> {
  if (!matrixClient) return null;
  try {
    const profile = await matrixClient.getProfileInfo(userId);
    return profile.displayname || null;
  } catch {
    return null;
  }
}

export async function joinRoom(roomId: string) {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  return matrixClient.joinRoom(roomId);
}

export async function leaveRoom(roomId: string) {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  return matrixClient.leave(roomId);
}

/**
 * Announce presence in a MatrixRTC call by sending a call.member state event (MSC4143 per-device format).
 * Element does this before connecting to LiveKit so other clients see us in the call.
 */
export async function sendCallMemberEvent(
  roomId: string,
  livekitServiceUrl: string,
  livekitAlias: string,
): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const userId = matrixClient.getUserId();
  const deviceId = matrixClient.getDeviceId() || "";
  if (!userId) throw new Error("No user ID");

  const stateKey = `_${userId}_${deviceId}_m.call`;
  const content = {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: deviceId,
    expires: 7200000,
    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
    foci_preferred: [
      { livekit_alias: livekitAlias, livekit_service_url: livekitServiceUrl, type: "livekit" },
    ],
    "m.call.intent": "audio",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendStateEvent(roomId, "org.matrix.msc3401.call.member" as any, content, stateKey);
}

/**
 * Remove presence from a MatrixRTC call by sending an empty call.member state event.
 */
export async function removeCallMemberEvent(roomId: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const userId = matrixClient.getUserId();
  const deviceId = matrixClient.getDeviceId() || "";
  if (!userId) throw new Error("No user ID");

  const stateKey = `_${userId}_${deviceId}_m.call`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendStateEvent(roomId, "org.matrix.msc3401.call.member" as any, {}, stateKey);
}

export async function sendTextMessage(roomId: string, body: string) {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  return matrixClient.sendTextMessage(roomId, body);
}

export async function uploadFile(file: File): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const response = await matrixClient.uploadContent(file, { type: file.type });
  return response.content_uri || "";
}

export async function redactMessage(roomId: string, eventId: string) {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  // Use REST API directly to avoid SDK pendingEventOrdering bug
  const baseUrl = matrixClient.getHomeserverUrl();
  const token = matrixClient.getAccessToken();
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const res = await fetch(
    `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Redact failed: ${res.status}`);
  }
}

export async function sendFileMessage(roomId: string, file: File) {
  if (!matrixClient) throw new Error("Matrix client not initialized");

  const contentUri = await uploadFile(file);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");

  let msgtype = "m.file";
  if (isImage) msgtype = "m.image";
  else if (isVideo) msgtype = "m.video";
  else if (isAudio) msgtype = "m.audio";

  const content: Record<string, unknown> = {
    msgtype,
    body: file.name,
    url: contentUri,
    info: {
      mimetype: file.type,
      size: file.size,
    },
  };

  return matrixClient.sendMessage(roomId, content as never);
}

export async function createOrGetDMRoom(userId: string): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");

  // Check existing DMs via m.direct account data
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const directEvent = matrixClient.getAccountData("m.direct" as any);
    if (directEvent) {
      const directContent = directEvent.getContent() as Record<string, string[]>;
      const existingRooms = directContent[userId];
      if (existingRooms && existingRooms.length > 0) {
        // Verify the room still exists in our joined rooms
        for (const roomId of existingRooms) {
          const room = matrixClient.getRoom(roomId);
          if (room) return roomId;
        }
      }
    }
  } catch {
    // No m.direct data yet, proceed to create
  }

  // Create a new DM room
  const { room_id } = await matrixClient.createRoom({
    is_direct: true,
    invite: [userId],
    preset: "trusted_private_chat" as never,
  });

  // Update m.direct account data
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const directEvent = matrixClient.getAccountData("m.direct" as any);
    const directContent = (directEvent?.getContent() as Record<string, string[]>) || {};
    const userRooms = directContent[userId] || [];
    userRooms.push(room_id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (matrixClient as any).setAccountData("m.direct", { ...directContent, [userId]: userRooms });
  } catch (err) {
    console.warn("[Sion] Failed to update m.direct:", err);
  }

  return room_id;
}

export async function editMessage(roomId: string, originalEventId: string, newText: string) {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return matrixClient.sendEvent(roomId, "m.room.message" as any, {
    msgtype: "m.text",
    body: `* ${newText}`,
    "m.new_content": { msgtype: "m.text", body: newText },
    "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
  });
}

export function getUserPowerLevel(roomId: string): number {
  if (!matrixClient) return 0;
  const room = matrixClient.getRoom(roomId);
  if (!room) return 0;
  const userId = matrixClient.getUserId();
  if (!userId) return 0;
  const member = room.getMember(userId);
  return member?.powerLevel ?? 0;
}

export function getStatePowerLevel(roomId: string): number {
  if (!matrixClient) return 50;
  const room = matrixClient.getRoom(roomId);
  if (!room) return 50;
  const plEvent = room.currentState?.getStateEvents?.("m.room.power_levels", "");
  if (!plEvent) return 50;
  const content = plEvent.getContent?.() || {};
  return content.state_default ?? 50;
}

export function getRoomMembers(roomId: string): { userId: string; displayName: string; avatarUrl: string | null }[] {
  if (!matrixClient) return [];
  const room = matrixClient.getRoom(roomId);
  if (!room) return [];
  const members = room.getJoinedMembers();
  return members.map((m) => ({
    userId: m.userId,
    displayName: m.name || m.userId,
    avatarUrl: m.getAvatarUrl(matrixClient!.getHomeserverUrl(), 32, 32, "crop", false, false) || null,
  }));
}

export async function createChannel(name: string, isVoice: boolean, isPublic = true): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialState: any[] = [
    { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    { type: "m.room.join_rules", state_key: "", content: { join_rule: isPublic ? "public" : "invite" } },
  ];
  if (isVoice) {
    initialState.push({ type: "m.room.type", state_key: "", content: { type: "m.voice_channel" } });
    initialState.push({ type: "m.room.topic", state_key: "", content: { topic: "voice" } });
  }
  const { room_id } = await matrixClient.createRoom({
    name,
    visibility: "private" as never,
    preset: (isPublic ? "public_chat" : "private_chat") as never,
    initial_state: initialState,
    power_level_content_override: {
      events: {
        "org.matrix.msc3401.call.member": 0,
      },
    } as never,
  });
  return room_id;
}

export async function setRoomJoinRule(roomId: string, joinRule: "public" | "invite"): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.sendStateEvent(roomId, "m.room.join_rules" as any, { join_rule: joinRule }, "");
}

export async function inviteUser(roomId: string, userId: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.invite(roomId, userId);
}

export async function kickUser(roomId: string, userId: string, reason?: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.kick(roomId, userId, reason);
}

export async function banUser(roomId: string, userId: string, reason?: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.ban(roomId, userId, reason);
}

export async function unbanUser(roomId: string, userId: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.unban(roomId, userId);
}

export async function setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.setPowerLevel(roomId, userId, level);
}

export function getMemberPowerLevel(roomId: string, userId: string): number {
  if (!matrixClient) return 0;
  const room = matrixClient.getRoom(roomId);
  if (!room) return 0;
  const member = room.getMember(userId);
  return member?.powerLevel ?? 0;
}

export async function setRoomName(roomId: string, name: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.setRoomName(roomId, name);
}

export async function setRoomTopic(roomId: string, topic: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  await matrixClient.setRoomTopic(roomId, topic);
}

export async function setRoomAvatar(roomId: string, file: File): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const contentUri = await uploadFile(file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendStateEvent(roomId, "m.room.avatar" as any, { url: contentUri });
}

export function getPinnedEventIds(roomId: string): string[] {
  if (!matrixClient) return [];
  const room = matrixClient.getRoom(roomId);
  if (!room) return [];
  const pinnedEvent = room.currentState?.getStateEvents?.("m.room.pinned_events", "");
  return pinnedEvent?.getContent?.()?.pinned || [];
}

export async function pinMessage(roomId: string, eventId: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const room = matrixClient.getRoom(roomId);
  const pinnedEvent = room?.currentState?.getStateEvents?.("m.room.pinned_events", "");
  const pinned: string[] = pinnedEvent?.getContent?.()?.pinned || [];
  const idx = pinned.indexOf(eventId);
  const newPinned = idx >= 0 ? pinned.filter((id) => id !== eventId) : [...pinned, eventId];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendStateEvent(roomId, "m.room.pinned_events" as any, { pinned: newPinned });
}

export async function sendReaction(roomId: string, eventId: string, emoji: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendEvent(roomId, "m.reaction" as any, {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: eventId,
      key: emoji,
    },
  });
}

export function getReactions(roomId: string, eventId: string): { emoji: string; count: number; userIds: string[] }[] {
  if (!matrixClient) return [];
  const room = matrixClient.getRoom(roomId);
  if (!room) return [];
  const timeline = room.getLiveTimeline().getEvents();
  const reactionMap = new Map<string, string[]>();
  for (const evt of timeline) {
    if (evt.getType?.() !== "m.reaction") continue;
    const rel = evt.getContent?.()?.["m.relates_to"];
    if (rel?.rel_type !== "m.annotation" || rel?.event_id !== eventId) continue;
    const key = rel.key;
    if (!key) continue;
    const senderId = evt.getSender?.() || "";
    if (!reactionMap.has(key)) reactionMap.set(key, []);
    reactionMap.get(key)!.push(senderId);
  }
  return Array.from(reactionMap.entries()).map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

export async function sendReply(roomId: string, inReplyToEventId: string, body: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await matrixClient.sendEvent(roomId, "m.room.message" as any, {
    msgtype: "m.text",
    body,
    "m.relates_to": { "m.in_reply_to": { event_id: inReplyToEventId } },
  });
}

/**
 * Check if Secret Storage and cross-signing need to be bootstrapped (first-time setup).
 * Returns true ONLY if no secret storage exists on the server at all (truly first-time).
 * If SSSS exists but cross-signing isn't ready locally, that's a returning user on a new device
 * — they need verification, not a fresh bootstrap (which would overwrite existing keys).
 */
export async function checkNeedsBootstrap(): Promise<boolean> {
  if (!matrixClient) return false;
  const crypto = matrixClient.getCrypto();
  if (!crypto) return false;
  try {
    // Check if secret storage already exists on the server (account data)
    // If it does, the user has already set up E2EE before — don't re-bootstrap
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultKeyEvent = matrixClient.getAccountData("m.secret_storage.default_key" as any);
    const existingKeyId = defaultKeyEvent?.getContent?.()?.key;
    if (existingKeyId) {
      return false;
    }

    const ssReady = await crypto.isSecretStorageReady();
    const csReady = await crypto.isCrossSigningReady();
    return !ssReady || !csReady;
  } catch (err) {
    console.warn("[Sion] checkNeedsBootstrap error:", err);
    return false;
  }
}

/**
 * Full bootstrap: cross-signing + secret storage + key backup.
 * Returns the encoded recovery key.
 */
export async function bootstrapAll(password?: string): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const crypto = matrixClient.getCrypto();
  if (!crypto) throw new Error("Crypto not initialized");

  // 1. Generate a recovery key
  const recoveryKeyResult = await crypto.createRecoveryKeyFromPassphrase();
  const { privateKey, encodedPrivateKey } = recoveryKeyResult;
  // 2. Cache the private key for the getSecretStorageKey callback
  cachedSecretStorageKey = privateKey;

  try {
    // 3. Bootstrap cross-signing
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: true,
      authUploadDeviceSigningKeys: async (makeRequest) => {
        // UIA callback — try with cached password
        const { getCachedLoginPassword } = await import("../stores/useAuthStore");
        const cachedPassword = getCachedLoginPassword() || password;
        if (cachedPassword) {
          const userId = matrixClient?.getUserId();
          if (!userId) throw new Error("No user ID available for cross-signing auth");
          await makeRequest({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: userId },
            password: cachedPassword,
          });
        } else {
          // No password available — try empty auth (works on some servers)
          await makeRequest({ type: "m.login.password" });
        }
      },
    });
    // 4. Bootstrap secret storage + key backup
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recoveryKeyResult,
      setupNewKeyBackup: true,
      setupNewSecretStorage: true,
    });
    return encodedPrivateKey!;
  } catch (err) {
    cachedSecretStorageKey = null;
    throw err;
  }
}

/**
 * Regenerate recovery key for an already-verified device.
 * Creates new secret storage with a new recovery key.
 */
export async function regenerateRecoveryKey(): Promise<string> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const crypto = matrixClient.getCrypto();
  if (!crypto) throw new Error("Crypto not initialized");

  const recoveryKeyResult = await crypto.createRecoveryKeyFromPassphrase();
  const { privateKey, encodedPrivateKey } = recoveryKeyResult;
  cachedSecretStorageKey = privateKey;

  try {
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recoveryKeyResult,
      setupNewKeyBackup: true,
      setupNewSecretStorage: true,
    });
    return encodedPrivateKey!;
  } catch (err) {
    cachedSecretStorageKey = null;
    throw err;
  }
}

export async function getDevices(): Promise<{ devices: { device_id: string; display_name?: string; last_seen_ts?: number; last_seen_ip?: string }[] }> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  return matrixClient.getDevices();
}

export async function deleteDevice(deviceId: string, password: string): Promise<void> {
  if (!matrixClient) throw new Error("Matrix client not initialized");
  const userId = matrixClient.getUserId();
  if (!userId) throw new Error("No user ID");
  await matrixClient.deleteDevice(deviceId, {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: userId },
    password,
  });
}

export async function logout() {
  if (matrixClient) {
    matrixClient.stopClient();
    try {
      await matrixClient.logout(true);
    } catch (err) {
      console.warn("[Sion] Logout error (ignoring):", err);
    }
    matrixClient = null;
  }
  // Clear stored device/user ID to force crypto store reset on next login
  localStorage.removeItem("sion_device_id");
  localStorage.removeItem("sion_user_id");
  // Small delay to let IndexedDB connections close after stopClient()
  await new Promise((r) => setTimeout(r, 500));
  // Clear crypto stores (IndexedDB) to avoid conflicts on next login
  await clearCryptoStores();
}