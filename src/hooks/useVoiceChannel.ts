import { useCallback } from "react";
import { useMatrix } from "./useMatrix";
import { useLiveKit } from "./useLiveKit";
import { useAppStore } from "../stores/useAppStore";
import { useAuthStore } from "../stores/useAuthStore";
import { useMatrixStore } from "../stores/useMatrixStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { generateLiveKitToken, getMatrixRTCToken } from "../services/livekitTokenService";
import { getMatrixClient } from "../services/matrixService";
import { MatrixKeyProvider } from "../services/matrixRTCE2EE";
import { startVoiceService, stopVoiceService } from "../services/androidVoiceService";
import { getCurrentRoom, setReemitKeysCallback } from "../services/livekitService";
import { RoomEvent } from "livekit-client";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc";

// Module-level tracking — survives component unmount/remount
let activeRTCSession: MatrixRTCSession | null = null;
let activeKeyProvider: MatrixKeyProvider | null = null;
// Track E2EE reemit resources for cleanup.
// The old "fire-every-3s-for-15s" interval has been replaced by on-demand
// reemit driven by MissingKey errors in livekitService (see setReemitKeysCallback).
let reemitParticipantHandler: (() => void) | null = null;
let reemitMembershipHandler: (() => void) | null = null;

// Timestamp of the last `setConnectingVoice(roomId)` — lets the double-click
// guard detect a stuck "connecting" state and force-clear it, instead of
// refusing every subsequent join for the rest of the process lifetime.
// Set to 0 when not connecting; updated when we post setConnectingVoice.
let connectingStartedAt = 0;
/** Window during which a duplicate join attempt is swallowed. Longer than a
 *  legitimate join takes end-to-end (~3–8 s on a cold path with Matrix
 *  device-key fetch + LiveKit connect + E2EE ratchet), short enough that a
 *  user re-clicking after a real stall doesn't have to reload the app. */
const CONNECTING_STALE_AFTER_MS = 15_000;

// Best-effort cleanup on page unload (reload, close tab, OS shutdown).
// We send an explicit `room.disconnect()` to the LiveKit SFU so the server
// cleans up our participation server-side. Without this, the SFU only
// notices we're gone via socket timeout (~30s) and meanwhile peers see
// our publication as still active — which after our reconnect leaves them
// with a stale "stuck in desired" RemoteTrackPublication (LiveKit SDK bug).
//
// Both `pagehide` and `beforeunload` are wired:
//  - `beforeunload` fires on Ctrl+R, tab close, window close (most cases)
//  - `pagehide` fires on bfcache + on iOS where beforeunload is unreliable
// Calling disconnect() on both is harmless (idempotent after first call).
function gracefulVoiceShutdown(_reason: string) {
  setReemitKeysCallback(null);
  // Fire-and-forget the LiveKit disconnect — we don't have time to await
  // before the page dies, but the WS leave message usually flushes in time.
  import("../services/livekitService").then(({ getCurrentRoom }) => {
    const room = getCurrentRoom();
    if (room) {
      try { room.disconnect(true); } catch { /* ignore */ }
    }
  }).catch(() => {});
  if (activeRTCSession) {
    activeRTCSession.leaveRoomSession(2000).catch(() => {});
    activeRTCSession = null;
  }
  if (activeKeyProvider) {
    activeKeyProvider.disconnect();
    activeKeyProvider = null;
  }
  reemitParticipantHandler = null;
  reemitMembershipHandler = null;
}
// Skip the graceful-shutdown hooks when this module is loaded inside the
// cursor-overlay webview — main.tsx imports App eagerly, which transitively
// pulls useVoiceChannel into the overlay's module graph. Without this check
// the overlay's `beforeunload` would call `gracefulVoiceShutdown` on close
// and drop the user's voice session just because they closed the overlay.
const __isOverlayWindow = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("overlay") === "cursor";

if (!__isOverlayWindow) {
  window.addEventListener("beforeunload", () => gracefulVoiceShutdown("beforeunload"));
  window.addEventListener("pagehide", () => gracefulVoiceShutdown("pagehide"));

  // Tauri-specific: when the user closes the window via the X / app updater /
  // OS shutdown, the Rust side intercepts the close and emits this event,
  // then waits ~1.5s before destroying the window. That gives us a deterministic
  // window for the LiveKit leave to flush — much more reliable than browser
  // `beforeunload` alone.
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("sion-graceful-shutdown", () => gracefulVoiceShutdown("tauri-close"));
    }).catch(() => { /* not in Tauri */ });
  }
}

async function cleanupActiveSession() {
  // Clear the livekitService → session reemit bridge first so any in-flight
  // backoff timer from MissingKey handling doesn't try to call into a dead
  // session.
  setReemitKeysCallback(null);
  if (reemitParticipantHandler) {
    getCurrentRoom()?.off(RoomEvent.ParticipantConnected, reemitParticipantHandler);
    reemitParticipantHandler = null;
  }
  if (reemitMembershipHandler && activeRTCSession) {
    activeRTCSession.off(MatrixRTCSessionEvent.MembershipsChanged, reemitMembershipHandler);
    reemitMembershipHandler = null;
  }

  if (activeRTCSession) {
    try {
      await activeRTCSession.leaveRoomSession();
    } catch (err) {
      console.warn("[Sion] Failed to leave MatrixRTC session:", err);
    }
    activeRTCSession = null;
  }
  if (activeKeyProvider) {
    activeKeyProvider.disconnect();
    activeKeyProvider = null;
  }
}

/**
 * Full voice cleanup for kick: LiveKit disconnect + MatrixRTC leave + state reset.
 * Exported for use outside React components (e.g. store listeners).
 */
export async function cleanupVoiceOnKick() {
  await cleanupActiveSession();
  const { disconnectFromRoom } = await import("../services/livekitService");
  await disconnectFromRoom();
  useAppStore.getState().disconnectVoice();
}

export function useVoiceChannel() {
  const { joinRoom } = useMatrix();
  const { connect, disconnect, connected, participants } = useLiveKit();
  const setConnectedVoice = useAppStore((s) => s.setConnectedVoice);
  const disconnectVoice = useAppStore((s) => s.disconnectVoice);
  const credentials = useAuthStore((s) => s.credentials);
  const joinMuted = useSettingsStore((s) => s.joinMuted);

  // Toujours true : on tente MatrixRTC en premier, puis les credentials manuels
  const hasLiveKitConfig = true;

  const leaveCurrentVoiceChannel = useCallback(async () => {
    const currentChannel = useAppStore.getState().connectedVoiceChannel;
    if (!currentChannel) return;

    await cleanupActiveSession();
    await disconnect();
    disconnectVoice();
  }, [disconnect, disconnectVoice]);

  const joinVoiceChannel = useCallback(
    async (matrixRoomId: string) => {
      // Déconnecter le canal vocal actif avant d'en rejoindre un autre
      const currentChannel = useAppStore.getState().connectedVoiceChannel;
      if (currentChannel) {
        if (currentChannel === matrixRoomId) {
          return;
        }
        await leaveCurrentVoiceChannel();
      }

      // Double-click / rapid reconnection guard: if a join is already in
      // flight for this room, drop the duplicate call — avoids two concurrent
      // joinRoomSession() publications and their ghost membership.
      //
      // The guard is AGE-BOUNDED: if the "connecting" state is older than
      // CONNECTING_STALE_AFTER_MS the flight most likely hung inside an
      // unresolved await (leaveRoomSession from a dead peer, LK connect
      // with SFU still holding the previous session open post-reload, etc.).
      // Refusing forever would mean the user has to reload to ever rejoin;
      // instead we force-clear and proceed so the retry can succeed.
      const alreadyConnecting = useAppStore.getState().connectingVoiceChannel;
      if (alreadyConnecting === matrixRoomId) {
        const age = connectingStartedAt ? performance.now() - connectingStartedAt : Infinity;
        if (age < CONNECTING_STALE_AFTER_MS) {
          console.warn(`[Sion] joinVoiceChannel called while already connecting (${Math.round(age)}ms ago) — ignoring duplicate`);
          return;
        }
        console.warn(`[Sion] stale connecting state for ${Math.round(age)}ms — treating as failed and retrying`);
        useAppStore.getState().setConnectingVoice(null);
        connectingStartedAt = 0;
      }

      // Systematic cleanup of any lingering session (e.g. a previous join
      // that failed between `session.joinRoomSession()` and `connect()` —
      // see the ghost-leak fix below). Without this, the new join stacks
      // on top of an orphan and we re-create a second membership event in
      // the same room, leaving peers with a double-reference participant.
      if (activeRTCSession) {
        console.warn("[Sion] joinVoiceChannel found a lingering RTC session — cleaning up before new join");
        await cleanupActiveSession();
      }

      useAppStore.getState().setConnectingVoice(matrixRoomId);
      connectingStartedAt = performance.now();
      try {

      // 1. Essayer MatrixRTC (foci_preferred dans org.matrix.msc3401.call)
      const client = getMatrixClient();
      if (client) {
        const rtcResult = await getMatrixRTCToken(client, matrixRoomId);
        if (rtcResult) {
          // Always use MatrixRTC SDK to join — it manages call.member state events
          // and the MembershipManager properly.
          const matrixRoom = client.getRoom(matrixRoomId);
          let keyProvider: MatrixKeyProvider | undefined;

          if (matrixRoom) {
            const session = client.matrixRTC.getRoomSession(matrixRoom);
            const isEncrypted = matrixRoom.hasEncryptionStateEvent();

            if (isEncrypted) {
              // Force download device keys for all room members before E2EE setup
              // This ensures the crypto SDK knows all devices for key distribution
              try {
                const members = matrixRoom.getJoinedMembers().map(m => m.userId);
                const crypto = client.getCrypto();
                if (crypto) {
                  await crypto.getUserDeviceInfo(members, true);
                }
              } catch (e) {
                console.warn("[Sion] Failed to download device keys:", e);
              }

              keyProvider = new MatrixKeyProvider();
              keyProvider.setRTCSession(session);
            }

            const fociPreferred = [{
              type: "livekit" as const,
              livekit_service_url: rtcResult.serviceUrl,
              livekit_alias: rtcResult.livekitAlias,
            }];

            session.joinRoomSession(fociPreferred, undefined, {
              // Short TTL: if app crashes/reloads, membership expires in 60s
              // The MembershipManager will re-publish before expiry to keep it alive
              membershipEventExpiryMs: 3_600_000, // 1 hour — avoid frequent renewals that disrupt audio in background
              useExperimentalToDeviceTransport: true,
              ...(isEncrypted ? { manageMediaKeys: true } : {}),
            });

            activeRTCSession = session;
            activeKeyProvider = keyProvider || null;

            // We deliberately do NOT register an E2EE recovery callback.
            // Element Call's proven approach is to trust LiveKit's ratchet
            // window (set in MatrixKeyProvider) + matrix-js-sdk's to-device
            // retries. Any application-level recovery that rejoins the
            // MatrixRTC session creates a feedback loop: rejoin → peer
            // rotates key → brief drift → new MissingKey → new rejoin.
          }

          await joinRoom(matrixRoomId);
          await connect(rtcResult.url, rtcResult.token, matrixRoomId, keyProvider);

          // Three complementary reemit triggers (all event-driven, no fixed
          // timers). The EncryptionManager may not have been ready when the
          // first to-device key arrived, and the session may gain new keys
          // as peers join or rotate — reemit re-applies them to our local
          // decryptor state.
          //   1. LiveKit participant connect  — new peer published
          //   2. MatrixRTC membership change  — known peer rotated keys
          //   3. On-demand from livekitService — MissingKey error observed
          //      (exponential backoff, replaces the old 15 s × 5 fixed timer)
          if (activeRTCSession && activeKeyProvider) {
            const lkRoom = getCurrentRoom();
            const rtcSession = activeRTCSession;
            if (lkRoom) {
              reemitParticipantHandler = () => {
                rtcSession.reemitEncryptionKeys();
              };
              lkRoom.on(RoomEvent.ParticipantConnected, reemitParticipantHandler);

              reemitMembershipHandler = () => {
                rtcSession.reemitEncryptionKeys();
              };
              rtcSession.on(MatrixRTCSessionEvent.MembershipsChanged, reemitMembershipHandler);

              // Bridge for the MissingKey-driven reemit in livekitService.
              setReemitKeysCallback(() => rtcSession.reemitEncryptionKeys());
            }
          }

          setConnectedVoice(matrixRoomId);
          useAppStore.getState().setConnectingVoice(null);
          connectingStartedAt = 0;
          // Start Android foreground service
          const channelName = useMatrixStore.getState().channels.find(c => c.id === matrixRoomId)?.name || "Voice";
          startVoiceService(channelName, false, false);
          const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
          if (joinMuted || isMobileDevice) {
            // Attendre que le track audio soit publié avant de muter
            await new Promise((r) => setTimeout(r, 500));
            if (!useAppStore.getState().isMuted) {
              useAppStore.getState().toggleMute();
            }
          }
          return;
        }
      }

      // 2. Fallback : credentials LiveKit manuels
      if (!credentials?.livekitUrl || !credentials?.livekitApiKey || !credentials?.livekitApiSecret) {
        console.warn("[Sion] Connexion vocale impossible : pas de MatrixRTC ni de credentials LiveKit configurés");
        useAppStore.getState().setConnectingVoice(null);
        connectingStartedAt = 0;
        return;
      }

      const token = await generateLiveKitToken(
        credentials.livekitApiKey,
        credentials.livekitApiSecret,
        matrixRoomId,
        credentials.displayName || credentials.userId,
      );

      await joinRoom(matrixRoomId);
      await connect(credentials.livekitUrl, token, matrixRoomId);
      setConnectedVoice(matrixRoomId);
      useAppStore.getState().setConnectingVoice(null);
      connectingStartedAt = 0;
      // Start Android foreground service
      const channelName2 = useMatrixStore.getState().channels.find(c => c.id === matrixRoomId)?.name || "Voice";
      startVoiceService(channelName2, false, false);
      const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (joinMuted || isMobileDevice) {
        if (!useAppStore.getState().isMuted) {
          useAppStore.getState().toggleMute();
        }
      }
      } catch (err) {
        // If we got as far as session.joinRoomSession() but then something
        // later (joinRoom / LiveKit connect / ...) threw, the MatrixRTC
        // membership is already published on the server. Without this
        // cleanup, the other participants keep seeing us as a ghost member
        // for the full TTL (currently 1 h) — they open peer connections,
        // push to-device E2EE keys to a dead device, and show a phantom
        // participant in the member list.
        if (activeRTCSession) {
          try {
            await cleanupActiveSession();
          } catch (cleanupErr) {
            console.warn("[Sion] cleanupActiveSession after join failure also failed:", cleanupErr);
          }
        }
        useAppStore.getState().setConnectingVoice(null);
        connectingStartedAt = 0;
        throw err;
      }
    },
    [joinRoom, connect, setConnectedVoice, credentials, joinMuted, leaveCurrentVoiceChannel],
  );

  const leaveVoiceChannel = useCallback(
    async (_matrixRoomId: string) => {
      stopVoiceService();
      await cleanupActiveSession();
      await disconnect();
      disconnectVoice();
    },
    [disconnect, disconnectVoice],
  );

  return {
    joinVoiceChannel,
    leaveVoiceChannel,
    connected,
    participants,
    hasLiveKitConfig,
  };
}
