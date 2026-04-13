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
import { setE2EERecoveryCallback } from "../services/livekitService";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc";

// Module-level tracking — survives component unmount/remount
let activeRTCSession: MatrixRTCSession | null = null;
let activeKeyProvider: MatrixKeyProvider | null = null;
// Track E2EE reemit resources for cleanup
let reemitInterval: ReturnType<typeof setInterval> | null = null;
let reemitParticipantHandler: (() => void) | null = null;

// Best-effort cleanup on page unload (reload, close tab)
window.addEventListener("beforeunload", () => {
  if (activeRTCSession) {
    // Fire-and-forget: leaveRoomSession with a short timeout
    // Even if this doesn't complete, the membership will expire via TTL (60s)
    activeRTCSession.leaveRoomSession(2000).catch(() => {});
    activeRTCSession = null;
  }
  if (activeKeyProvider) {
    activeKeyProvider.disconnect();
    activeKeyProvider = null;
  }
});

async function cleanupActiveSession() {
  // Clean up E2EE reemit resources
  if (reemitInterval) { clearInterval(reemitInterval); reemitInterval = null; }
  if (reemitParticipantHandler) {
    import("../services/livekitService").then(({ getCurrentRoom }) => {
      import("livekit-client").then(({ RoomEvent }) => {
        getCurrentRoom()?.off(RoomEvent.ParticipantConnected, reemitParticipantHandler!);
        reemitParticipantHandler = null;
      });
    }).catch(() => {});
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
      useAppStore.getState().setConnectingVoice(matrixRoomId);
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

            // E2EE recovery: when MissingKey errors pile up, re-emit keys
            // so the other participants can decrypt our stream again.
            if (isEncrypted) {
              setE2EERecoveryCallback(async () => {
                console.warn("[Sion][E2EE] Recovery: re-emitting encryption keys");
                try {
                  session.reemitEncryptionKeys();
                  // Also re-download device keys in case a participant rotated devices
                  const crypto = client.getCrypto();
                  if (crypto) {
                    const memberIds = matrixRoom.getJoinedMembers().map(m => m.userId);
                    await crypto.getUserDeviceInfo(memberIds, true);
                  }
                } catch (err) {
                  console.error("[Sion][E2EE] Recovery reemit failed:", err);
                }
              });
            }
          }

          await joinRoom(matrixRoomId);
          await connect(rtcResult.url, rtcResult.token, matrixRoomId, keyProvider);

          // Re-emit encryption keys aggressively after connect:
          // 1. Multiple re-emits at increasing intervals to handle timing issues
          // 2. Re-emit when new participants join
          // 3. Periodic re-emit every 30s for the first 2 minutes
          if (activeRTCSession && activeKeyProvider) {
            const { getCurrentRoom } = await import("../services/livekitService");
            const { RoomEvent } = await import("livekit-client");
            const lkRoom = getCurrentRoom();
            const rtcSession = activeRTCSession;
            if (lkRoom) {
              for (const delay of [1000, 3000, 6000]) {
                setTimeout(() => rtcSession.reemitEncryptionKeys(), delay);
              }
              reemitParticipantHandler = () => {
                setTimeout(() => rtcSession.reemitEncryptionKeys(), 1000);
              };
              lkRoom.on(RoomEvent.ParticipantConnected, reemitParticipantHandler);
              let reemitCount = 0;
              reemitInterval = setInterval(() => {
                reemitCount++;
                if (reemitCount > 4 || !activeRTCSession) {
                  if (reemitInterval) { clearInterval(reemitInterval); reemitInterval = null; }
                  return;
                }
                rtcSession.reemitEncryptionKeys();
              }, 30_000);
            }
          }

          setConnectedVoice(matrixRoomId);
          useAppStore.getState().setConnectingVoice(null);
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
        useAppStore.getState().setConnectingVoice(null);
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
