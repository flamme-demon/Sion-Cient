import { useCallback } from "react";
import { useMatrix } from "./useMatrix";
import { useLiveKit } from "./useLiveKit";
import { useAppStore } from "../stores/useAppStore";
import { useAuthStore } from "../stores/useAuthStore";
import { useMatrixStore } from "../stores/useMatrixStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { generateLiveKitToken, getMatrixRTCToken } from "../services/livekitTokenService";
import { getMatrixClient, getLocalVoiceState, sendCallMemberEvent, removeCallMemberEvent, republishCallMember } from "../services/matrixService";
import { MatrixKeyProvider } from "../services/matrixRTCE2EE";
import { startVoiceService, stopVoiceService } from "../services/androidVoiceService";
import { isVoiceNativeAvailable } from "../services/voiceNativeService";
import { disconnectNativeSession, waitForNativeSessionCleanup } from "../services/nativeVoiceSession";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc";

// Module-level tracking — survives component unmount/remount
let activeRTCSession: MatrixRTCSession | null = null;
let activeKeyProvider: MatrixKeyProvider | null = null;
// Room id of the MatrixRTC session currently active, used by cleanup to
// target the matching matrixService callMemberCache entry. Mirrors
// `activeRTCSession.room.roomId` but stays readable after we null the
// session out during cleanup.
let activeRTCRoomId: string | null = null;
// Track E2EE reemit resources for cleanup.
let reemitMembershipHandler: (() => void) | null = null;

// In-flight join tracking for the double-click guard. These are set ONLY when
// joinVoiceChannel actually starts a join, and always together — so the age is
// never Infinity. We deliberately do NOT key the guard off the store's
// `connectingVoiceChannel`: the auto-join path (useMatrixStore) sets that as a
// UI pre-marker before any real join, and keying off it made the genuine
// pending join look like a stuck duplicate (logged as "stale … Infinityms").
// `connectingRoomId` = the room a join is currently in flight for (null = none).
let connectingRoomId: string | null = null;
let connectingStartedAt = 0;
/** Window during which a duplicate join attempt is swallowed. Longer than a
 *  legitimate join takes end-to-end (~3–8 s on a cold path with Matrix
 *  device-key fetch + LiveKit connect + E2EE ratchet), short enough that a
 *  user re-clicking after a real stall doesn't have to reload the app. */
const CONNECTING_STALE_AFTER_MS = 15_000;

// Best-effort cleanup on page unload (reload, close tab, OS shutdown).
// On demande au moteur Rust de fermer la session LiveKit pour que le SFU
// nous nettoie côté serveur. Sans cet appel, le SFU ne constate notre départ
// qu'au timeout du socket (~30 s) : les pairs nous voient encore publié.
//
// Both `pagehide` and `beforeunload` are wired:
//  - `beforeunload` fires on Ctrl+R, tab close, window close (most cases)
//  - `pagehide` fires on bfcache + on iOS where beforeunload is unreliable
// Calling disconnect() on both is harmless (idempotent after first call).
function gracefulVoiceShutdown(_reason: string) {
  // Le moteur Rust ne reçoit jamais le disconnect du navigateur : sans cet
  // appel, le SFU nous garde en fantôme ~30 s (+ micro/ADM vivants jusqu'à la
  // mort du processus).
  import("../services/voiceNativeService").then(({ voiceNativeDisconnect }) => {
    voiceNativeDisconnect().catch(() => {});
  }).catch(() => {});
  if (activeRTCRoomId) {
    removeCallMemberEvent(activeRTCRoomId);
    activeRTCRoomId = null;
  }
  if (activeRTCSession) {
    activeRTCSession.leaveRoomSession(2000).catch(() => {});
    activeRTCSession = null;
  }
  if (activeKeyProvider) {
    activeKeyProvider.disconnect();
    activeKeyProvider = null;
  }
  reemitMembershipHandler = null;
}

// L'overlay de curseurs est une fenêtre native hors webview : ce module n'est
// chargé que dans la fenêtre principale, les hooks de fermeture sont sûrs.
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

async function cleanupActiveSession() {
  if (reemitMembershipHandler && activeRTCSession) {
    activeRTCSession.off(MatrixRTCSessionEvent.MembershipsChanged, reemitMembershipHandler);
    reemitMembershipHandler = null;
  }

  // Drop the matrixService cache entry before leaveRoomSession so any
  // in-flight debounced publishLocalVoiceState during the leave transition
  // hits an empty cache and no-ops — we don't want a stale rewrite to
  // race leaveRoomSession's empty-state write.
  if (activeRTCRoomId) {
    removeCallMemberEvent(activeRTCRoomId);
    activeRTCRoomId = null;
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
  await disconnectNativeSession();
  // L'overlay de curseurs (partage local) ne se ferme pas tout seul.
  import("../services/cursorOverlayService").then(({ closeCursorOverlay }) => {
    closeCursorOverlay().catch(() => {});
  }).catch(() => {});
  useAppStore.getState().disconnectVoice();
}

/**
 * Manual recovery for "a peer can't hear me": re-publishes our presence in the
 * current voice call WITHOUT leaving/rejoining. Two sender-side steps, both
 * safe under the v0.9.6 model (which only forbids *receiver-side* leave/rejoin
 * recovery loops):
 *   1. Re-write our `call.member` so peers re-evaluate us as a live membership
 *      (fixes the "No matching RTC membership, delaying key addition" stall,
 *      e.g. after dev reloads left zombie memberships from dead devices).
 *   2. Re-emit our encryption keys so peers that just (re)matched our
 *      membership immediately get the key.
 * No-op (returns false) when we're not in a voice call.
 */
export async function republishVoicePresence(): Promise<boolean> {
  let rooms = 0;
  try {
    rooms = await republishCallMember();
  } catch (err) {
    console.warn("[Sion] republishVoicePresence: call.member rewrite failed:", err);
  }
  if (activeRTCSession) {
    try { activeRTCSession.reemitEncryptionKeys(); } catch { /* session ended */ }
  }
  return rooms > 0 || activeRTCSession !== null;
}

async function onNativeSessionDisconnected() {
  try {
    await cleanupActiveSession();
  } finally {
    stopVoiceService();
    useAppStore.getState().disconnectVoice();
  }
}

// Les joins sont sérialisés : un double-clic ou un auto-join + clic ne
// doivent jamais ouvrir deux sessions en parallèle (micro fantôme côté
// natif — cf. connect idempotent côté Rust, ici on évite même la course).
let joinChain: Promise<void> = Promise.resolve();

export function useVoiceChannel() {
  const { joinRoom } = useMatrix();
  const { connectNative, disconnectNative, connected, participants } = useLiveKit();
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
    await disconnectNative();
    disconnectVoice();
  }, [disconnectNative, disconnectVoice]);

  const joinVoiceChannelInner = useCallback(
    async (matrixRoomId: string) => {
      await waitForNativeSessionCleanup();
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
      // Duplicate-join guard keyed on a REAL in-flight join (not the store's
      // UI marker). connectingRoomId/connectingStartedAt are always set
      // together, so `age` is a real number — never Infinity.
      if (connectingRoomId === matrixRoomId) {
        const age = performance.now() - connectingStartedAt;
        if (age < CONNECTING_STALE_AFTER_MS) {
          console.warn(`[Sion] joinVoiceChannel called while already connecting (${Math.round(age)}ms ago) — ignoring duplicate`);
          return;
        }
        console.warn(`[Sion] stale in-flight join for ${Math.round(age)}ms — treating as failed and retrying`);
        connectingRoomId = null;
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
      connectingRoomId = matrixRoomId;
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
              // The MembershipManager re-publishes before expiry to keep the
              // membership alive while we're in the call.
              membershipEventExpiryMs: 3_600_000, // 1 hour — avoid frequent renewals that disrupt audio in background
              // NB: to-device key transport is the default (and only) path since
              // matrix-js-sdk 41.6.0 — the former `useExperimentalToDeviceTransport`
              // opt-in was removed, ToDeviceKeyTransport is now wired unconditionally.
              ...(isEncrypted ? { manageMediaKeys: true } : {}),
            });

            // MSC4143 `call.member` content piggyback for cross-channel
            // mute/deafen visibility. matrix-js-sdk v41 doesn't expose a
            // public hook to inject fields into MembershipManager's content
            // generator, but `makeMyMembership` is `protected` and
            // monkey-patchable on the session's MembershipManager instance.
            // Wrapping it here makes every SDK-scheduled renewal (kept alive
            // by the ActionScheduler at ~expiry/2) carry our two Sion
            // fields. Between renewals, `publishLocalVoiceState` in
            // matrixService writes directly so toggles stay reactive. The
            // patch is instance-scoped — it dies with the session when we
            // null out `activeRTCSession` in cleanup.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mm = (session as any).membershipManager;
            if (mm && typeof mm.makeMyMembership === "function") {
              const original = mm.makeMyMembership.bind(mm);
              mm.makeMyMembership = (expires: number) => {
                const base = original(expires);
                const vs = getLocalVoiceState();
                return { ...base, sion_muted: vs.muted, sion_deafened: vs.deafened };
              };
            } else {
              console.warn("[Sion] MembershipManager.makeMyMembership not found — cross-channel voice state limited to fast-path only; SDK renewals will clobber");
            }

            // Register the room in matrixService so `publishLocalVoiceState`
            // (mute/deafen toggles) has a target to rewrite. The initial
            // call.member write is handled by `joinRoomSession` above — we
            // only populate the cache here.
            sendCallMemberEvent(matrixRoomId, rtcResult.serviceUrl, rtcResult.livekitAlias);

            activeRTCSession = session;
            activeRTCRoomId = matrixRoomId;
            activeKeyProvider = keyProvider || null;

            // We deliberately do NOT register an E2EE recovery callback.
            // Element Call's proven approach is to trust LiveKit's ratchet
            // window (set in MatrixKeyProvider) + matrix-js-sdk's to-device
            // retries. Any application-level recovery that rejoins the
            // MatrixRTC session creates a feedback loop: rejoin → peer
            // rotates key → brief drift → new MissingKey → new rejoin.
          }

          await joinRoom(matrixRoomId);

          // Moteur voix unique : Rust. Sans la feature `native-voice` compilée,
          // aucun moteur de secours JS n'existe plus — on échoue clairement.
          if (!(await isVoiceNativeAvailable())) {
            throw new Error("moteur vocal natif indisponible (build sans --features native-voice)");
          }
          const encryptedHere = client.getRoom(matrixRoomId)?.hasEncryptionStateEvent() ?? false;
          if (encryptedHere) {
            // Pont E2EE natif : chaque clé MatrixRTC (pairs + la nôtre) est
            // transférée au provider Rust, qui déchiffre les frames (voix).
            if (keyProvider) {
              const { bytesToB64, setVoiceNativeE2EEKey } =
                await import("../services/voiceNativeService");
              keyProvider.setNativeForwarder((identity, keyIndex, key) => {
                setVoiceNativeE2EEKey(identity, keyIndex, bytesToB64(key)).catch((err) => {
                  console.error(`[Sion][E2EE] transfert clé native ${identity}:`, err);
                });
              });
              console.info("[Sion][voix-native][E2EE] pont E2EE branché (clés MatrixRTC → Rust)");
            } else {
              console.warn("[Sion][voix-native][E2EE] pas de keyProvider — audio distant muet en salon chiffré");
            }
          }
          const myId = client.getUserId() ?? "";
          const displayName =
            credentials?.displayName
            || client.getUser(myId)?.displayName
            || credentials?.userId
            || myId;
          await connectNative(rtcResult.url, rtcResult.token, matrixRoomId, displayName, encryptedHere, onNativeSessionDisconnected);
          // Clés arrivées AVANT le connect (reemit au attach) : le
          // forwarder n'était pas posé — on rejoue tout le connu.
          if (encryptedHere && keyProvider) {
            const flushed = keyProvider.flushKeysToNative();
            console.info(`[Sion][voix-native][E2EE] ${flushed} clé(s) rejouée(s) après connect`);
          }

          // Reemit MatrixRTC sur changement de membres : un pair qui rejoint
          // ou qui tourne sa clé redéclenche la distribution vers le Rust.
          if (activeRTCSession && activeKeyProvider) {
            const rtcSession = activeRTCSession;
            reemitMembershipHandler = () => {
              try { rtcSession.reemitEncryptionKeys(); } catch { /* session ended */ }
            };
            rtcSession.on(MatrixRTCSessionEvent.MembershipsChanged, reemitMembershipHandler);
          }

          setConnectedVoice(matrixRoomId);
          useAppStore.getState().setConnectingVoice(null);
          connectingStartedAt = 0;
          connectingRoomId = null;
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
        connectingRoomId = null;
        return;
      }

      const token = await generateLiveKitToken(
        credentials.livekitApiKey,
        credentials.livekitApiSecret,
        matrixRoomId,
        credentials.displayName || credentials.userId,
      );

      await joinRoom(matrixRoomId);
      if (!(await isVoiceNativeAvailable())) {
        throw new Error("moteur vocal natif indisponible (build sans --features native-voice)");
      }
      await connectNative(credentials.livekitUrl, token, matrixRoomId, credentials.displayName || credentials.userId, false, onNativeSessionDisconnected);
      setConnectedVoice(matrixRoomId);
      useAppStore.getState().setConnectingVoice(null);
      connectingStartedAt = 0;
      connectingRoomId = null;
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
        await disconnectNativeSession().catch((cleanupError) => {
          console.warn("[Sion] native cleanup after join failure:", cleanupError);
        });
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
        connectingRoomId = null;
        throw err;
      }
    },
    [joinRoom, connectNative, setConnectedVoice, credentials, joinMuted, leaveCurrentVoiceChannel],
  );

  const joinVoiceChannel = useCallback((matrixRoomId: string) => {
    const run = joinChain.catch(() => {}).then(() => joinVoiceChannelInner(matrixRoomId));
    joinChain = run.catch(() => {});
    return run;
  }, [joinVoiceChannelInner]);

  const leaveVoiceChannel = useCallback(
    async (_matrixRoomId: string) => {
      stopVoiceService();
      await cleanupActiveSession();
      await disconnectNative();
      disconnectVoice();
    },
    [disconnectNative, disconnectVoice],
  );

  return {
    joinVoiceChannel,
    leaveVoiceChannel,
    connected,
    participants,
    hasLiveKitConfig,
  };
}
