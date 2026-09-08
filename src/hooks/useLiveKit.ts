import { useCallback, useRef } from "react";
import type { BaseKeyProvider } from "livekit-client";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import * as livekitService from "../services/livekitService";

/** Pushes overlay en vol par expéditeur (latest-wins : on jette la position
 *  si le push précédent n'a pas fini — voir `publishNativeCursor`). */
const overlayPushInflight = new Set<string>();

export function useLiveKit() {
  const { connected, roomName, participants } = useLiveKitStore();
  const { connect: storeConnect, disconnect: storeDisconnect, setParticipants } = useLiveKitStore();
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdate = useRef<typeof participants | null>(null);
  const cleanupParticipantChange = useRef<(() => void) | null>(null);
  const cleanupNative = useRef<(() => void) | null>(null);
  const cleanupNativeData = useRef<(() => void) | null>(null);
  const nativeAfkHeartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Identité LiveKit locale en mode natif (pour cibler notre partage). */
  const nativeIdentity = useRef<string | null>(null);
  const knownNativeIdentities = useRef<Set<string> | null>(null);

  const pushThrottled = useCallback((updatedParticipants: typeof participants) => {
    // Throttle store updates to max ~4 per second to avoid choking React renders
    pendingUpdate.current = updatedParticipants;
    if (!throttleRef.current) {
      throttleRef.current = setTimeout(() => {
        throttleRef.current = null;
        if (pendingUpdate.current) {
          setParticipants(pendingUpdate.current);
          pendingUpdate.current = null;
        }
      }, 250);
    }
  }, [setParticipants]);

  const connect = useCallback(async (url: string, token: string, room: string, e2eeKeyProvider?: BaseKeyProvider) => {    const lkRoom = await livekitService.connectToRoom(url, token, e2eeKeyProvider);
    storeConnect(room);

    cleanupParticipantChange.current = livekitService.onParticipantChange((updatedParticipants) => {
      pushThrottled(updatedParticipants);
    });

    return lkRoom;
  }, [storeConnect, pushThrottled]);

  /** Chemin natif (chantier no-CEF) : la Room vit en Rust, le store reçoit
   *  la même forme `ParticipantInfo` via `voice-native-participants`. */
  const connectNative = useCallback(async (url: string, token: string, room: string, displayName: string) => {
    console.info(`[Sion][voix-native] join natif ${room} (SDK Rust, pas de livekit-client)`);
    const native = await import("../services/voiceNativeService");
    const status = await native.voiceNativeConnect(url, token, room, displayName);
    nativeIdentity.current = status.identity ?? null;
    storeConnect(room);
    knownNativeIdentities.current = new Set();
    cleanupNative.current = await native.onVoiceNativeParticipants((updatedParticipants) => {
      // Rebroadcast AFK aux nouveaux arrivants (miroir du `rebroadcastOnJoin`
      // JS) : un pair qui rejoint pendant notre sourdine doit l'apprendre.
      const known = knownNativeIdentities.current;
      if (known) {
        const fresh = updatedParticipants.some((p) => !known.has(p.identity));
        updatedParticipants.forEach((p) => known.add(p.identity));
        if (fresh) {
          import("../stores/useAppStore").then(({ useAppStore }) => {
            if (!useAppStore.getState().isDeafened) return;
            import("../services/voiceNativeService").then((svc) => {
              const payload = new TextEncoder().encode(JSON.stringify({ deafened: true }));
              svc.voiceNativePublishData("sion-afk", svc.bytesToB64(payload)).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
        }
      }
      // État voix Matrix (`sion_muted` / `sion_deafened` des call.member) :
      // persistant et sans course, il comble les broadcasts LiveKit manqués
      // (cf. `overlayMatrixVoiceState`). Repli brut si le store est injoignable.
      import("../stores/useMatrixStore").then(({ useMatrixStore }) => {
        const voiceUsers =
          useMatrixStore.getState().channels.find((c) => c.id === room)?.voiceUsers ?? [];
        pushThrottled(native.overlayMatrixVoiceState(updatedParticipants, voiceUsers));
      }).catch(() => pushThrottled(updatedParticipants));
    });
    // Relais data-channel natif → handlers existants (soundboard, curseurs…).
    // Miroir du `RoomEvent.DataReceived` branché dans `livekitService` (JS).
    cleanupNativeData.current = await native.onVoiceNativeData((ev) => {
      if (!ev.topic || !ev.sender) return;
      const sender = ev.sender;
      import("../services/soundboardService").then(({ SOUNDBOARD_TOPIC, handleRemoteBroadcast }) => {
        if (ev.topic !== SOUNDBOARD_TOPIC || !ev.sender) return;
        handleRemoteBroadcast(native.b64ToBytes(ev.payload_b64), ev.sender);
      }).catch(() => {});
      import("../services/livekitService").then(({ CURSOR_TOPIC, CURSOR_CLICK_TOPIC, handleNativeCursorData }) => {
        if ((ev.topic !== CURSOR_TOPIC && ev.topic !== CURSOR_CLICK_TOPIC) || !sender) return;
        const name = native.resolveNativeDisplayName(sender, room);
        handleNativeCursorData(ev.topic, sender, name, native.b64ToBytes(ev.payload_b64));
      }).catch(() => {});
      // Renvoi vers l'overlay quand ON partage en natif (miroir du forward
      // JS conditionné au partage local) : les curseurs des viewers sont
      // projetés sur notre écran, donc capturés dans notre partage.
      // Coords relatives à UN partage : on ne projette que ce qui vise
      // explicitement le nôtre (comme en JS). Latest-wins : un push encore
      // en vol fait sauter la position (la suivante arrive dans 16 ms).
      import("../stores/useAppStore").then(({ useAppStore }) => {
        if (!useAppStore.getState().isScreenSharing) return;
        const selfId = nativeIdentity.current;
        if (!selfId) return;
        import("../services/cursorOverlayService").then((overlay) => {
          try {
            const payload = JSON.parse(
              new TextDecoder().decode(native.b64ToBytes(ev.payload_b64)),
            ) as { x?: number; y?: number; click?: boolean; expire?: boolean; t?: string };
            if (payload.t !== selfId) return;
            // `||` et pas `??` : un nom vide LiveKit doit retomber sur
            // l'identité, sinon la pastille du curseur reste vide.
            const name = native.resolveNativeDisplayName(sender, room);
            if (ev.topic === "sion-cursor-click" && payload.click) {
              overlay.pushCursorClickToOverlay({
                id: `${sender}:${Date.now()}`,
                identity: sender,
                name,
                x: payload.x ?? 0,
                y: payload.y ?? 0,
                expiresAt: Date.now() + 800,
              }).catch(() => {});
            } else if (ev.topic === "sion-cursor") {
              if (payload.expire) {
                overlay.clearCursorFromOverlay(sender).catch(() => {});
              } else if (
                typeof payload.x === "number" &&
                typeof payload.y === "number" &&
                !overlayPushInflight.has(sender)
              ) {
                overlayPushInflight.add(sender);
                overlay.pushCursorToOverlay({
                  identity: sender,
                  name,
                  x: payload.x,
                  y: payload.y,
                  expiresAt: Date.now() + 2000,
                }).catch(() => {}).finally(() => overlayPushInflight.delete(sender));
              }
            }
          } catch { /* ignore malformed */ }
        }).catch(() => {});
      }).catch(() => {});
    });
    // Heartbeat AFK natif (miroir du heartbeat JS) : tout état manqué ou
    // rassis chez les pairs se répare sous 30 s.
    if (nativeAfkHeartbeat.current) clearInterval(nativeAfkHeartbeat.current);
    nativeAfkHeartbeat.current = setInterval(() => {
      import("../stores/useAppStore").then(({ useAppStore }) => {
        const deafened = useAppStore.getState().isDeafened;
        import("../services/voiceNativeService").then((svc) => {
          if (svc.getActiveVoiceEngine() !== "native") return;
          console.log(`[Sion][deafen] AFK tx natif deafened=${deafened}`);
          const payload = new TextEncoder().encode(JSON.stringify({ deafened }));
          svc.voiceNativePublishData("sion-afk", svc.bytesToB64(payload)).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    }, 30_000);
  }, [storeConnect, pushThrottled]);

  const disconnect = useCallback(async () => {
    if (cleanupParticipantChange.current) {
      cleanupParticipantChange.current();
      cleanupParticipantChange.current = null;
    }
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    pendingUpdate.current = null;
    await livekitService.disconnectFromRoom();
    storeDisconnect();
  }, [storeDisconnect]);

  const disconnectNative = useCallback(async () => {
    if (cleanupNative.current) {
      cleanupNative.current();
      cleanupNative.current = null;
    }
    if (cleanupNativeData.current) {
      cleanupNativeData.current();
      cleanupNativeData.current = null;
    }
    if (nativeAfkHeartbeat.current) {
      clearInterval(nativeAfkHeartbeat.current);
      nativeAfkHeartbeat.current = null;
    }
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    pendingUpdate.current = null;
    knownNativeIdentities.current = null;
    nativeIdentity.current = null;
    // Fermer l'overlay de curseurs (ouvert si on partageait) : sinon la
    // fenêtre transparente survit au leave.
    import("../services/cursorOverlayService").then(({ closeCursorOverlay }) => {
      closeCursorOverlay().catch(() => {});
    }).catch(() => {});
    const native = await import("../services/voiceNativeService");
    await native.voiceNativeDisconnect();
    storeDisconnect();
  }, [storeDisconnect]);

  const toggleMic = useCallback(async (enabled: boolean) => {
    await livekitService.toggleMicrophone(enabled);
  }, []);

  const toggleScreenShare = useCallback(async (enabled: boolean) => {
    await livekitService.toggleScreenShare(enabled);
  }, []);

  return {
    connected,
    roomName,
    participants,
    connect,
    disconnect,
    connectNative,
    disconnectNative,
    toggleMic,
    toggleScreenShare,
  };
}
